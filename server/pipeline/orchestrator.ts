import crypto from 'crypto';
import type {
  ClarificationHistoryItem,
  DatasetMetadata,
  PipelineResponse,
  QueryExecutionResult,
  RetrievedDatabaseContext,
  StructuredIntent,
} from '../../src/types/text2sql';
import { sqliteEngine } from '../db/sqliteEngine';
import { retrieveDatabaseContext } from './contextRetrieval';
import { formatGeminiError, geminiProvider, type LLMProvider } from './geminiClient';
import { validateSqlAgainstDatasetAndIntent } from './sqlValidator';

interface ClarificationSessionState {
  sessionId: string;
  datasetId: string;
  originalQuestion: string;
  clarificationHistory: ClarificationHistoryItem[];
  lastClarificationQuestion: string;
  retrievedContext: RetrievedDatabaseContext;
}

const clarificationSessions = new Map<string, ClarificationSessionState>();

function buildRejectionReason(intent: StructuredIntent, dataset: DatasetMetadata): string {
  if (intent.classification === 'OUT_OF_SCOPE') {
    return (
      intent.reason ||
      `This question is outside the scope of the "${dataset.name}" dataset (${dataset.description}). No SQL query was executed.`
    );
  }
  const missing =
    intent.missingConcepts.length > 0
      ? ` Missing concepts/columns: ${intent.missingConcepts.join(', ')}.`
      : '';
  return (
    (intent.reason ||
      `This question cannot be answered using the available columns in "${dataset.name}".`) +
    missing +
    ` Available columns: ${dataset.columns.map((c) => c.name).join(', ')}.`
  );
}

function formatDeterministicRowSummary(execution: QueryExecutionResult, dataset: DatasetMetadata): string {
  if (execution.rowCount === 0) {
    return `No matching records were found in "${dataset.name}".`;
  }
  if (execution.rowCount === 1 && execution.columns.length === 1) {
    const col = execution.columns[0];
    const val = execution.rows[0][col];
    return `Query executed on "${dataset.name}" and returned ${col} = ${String(val)}.`;
  }
  if (execution.rowCount === 1) {
    const pairs = execution.columns
      .map((c) => `${c}: ${String(execution.rows[0][c])}`)
      .join(', ');
    return `Query returned 1 record from "${dataset.name}": ${pairs}.`;
  }
  return `Query executed on "${dataset.name}" and returned ${execution.rowCount} records (shown in the table below).`;
}

async function validateRepairAndExecute(params: {
  sessionId: string;
  dataset: DatasetMetadata;
  originalQuestion: string;
  resolvedQuestion: string;
  rewrittenQuestion: string | null;
  retrievedContext: RetrievedDatabaseContext;
  intent: StructuredIntent;
  candidateSql: string | null | undefined;
  clarificationHistory: ClarificationHistoryItem[];
  llm: LLMProvider;
  startTime: number;
}): Promise<PipelineResponse> {
  const {
    sessionId,
    dataset,
    originalQuestion,
    resolvedQuestion,
    rewrittenQuestion,
    retrievedContext,
    intent,
    candidateSql,
    clarificationHistory,
    llm,
    startTime,
  } = params;

  let sql = (candidateSql ?? '').trim();
  let validation = validateSqlAgainstDatasetAndIntent(sql, dataset, intent);
  let repaired = false;
  let repairNotes: string | null = null;

  if (!validation.valid) {
    const initialErrors = [...validation.errors];
    sql = await llm.repairSql(resolvedQuestion, intent, sql, initialErrors, retrievedContext);
    validation = validateSqlAgainstDatasetAndIntent(sql, dataset, intent);
    repaired = true;
    repairNotes = `Repaired SQL after validation check(s): ${initialErrors.join(' | ')}`;
  }

  if (!validation.valid) {
    return {
      sessionId,
      datasetId: dataset.id,
      originalQuestion,
      rewrittenQuestion,
      status: 'ERROR',
      classification: intent.classification,
      retrievedContext,
      intent,
      clarificationHistory,
      sql: validation.normalizedSql || sql,
      repaired,
      repairNotes,
      validation,
      execution: null,
      naturalLanguageAnswer: `Generated SQL failed safety or semantic validation and was blocked from execution: ${validation.errors.join(' ')}`,
      errorMessage: validation.errors.join(' '),
      latencyMs: Math.round(performance.now() - startTime),
    };
  }

  const execution = sqliteEngine.executeReadOnlyQuery(dataset.tableName, validation.normalizedSql);

  let naturalLanguageAnswer: string;
  const isSingleScalarResult =
    execution.rowCount === 1 &&
    execution.columns.length === 1 &&
    (intent.queryType === 'dataset_count' || intent.queryType === 'aggregation');

  if (execution.rowCount === 0) {
    naturalLanguageAnswer = `No matching records were found in "${dataset.name}".`;
  } else if (isSingleScalarResult) {
    const col = execution.columns[0];
    const rawVal = execution.rows[0][col];
    const formattedVal =
      typeof rawVal === 'number' && !Number.isInteger(rawVal) ? rawVal.toFixed(2) : String(rawVal);
    if (intent.queryType === 'dataset_count') {
      naturalLanguageAnswer = `There are ${formattedVal} total records in "${dataset.name}".`;
    } else {
      const fnLabel = intent.aggregationFunction ?? 'Computed';
      const metricLabel = intent.metricColumns[0] ?? col;
      naturalLanguageAnswer = `The ${fnLabel.toLowerCase()} of ${metricLabel} in "${dataset.name}" is ${formattedVal}.`;
    }
  } else {
    try {
      naturalLanguageAnswer = await llm.generateNaturalLanguageAnswer(
        resolvedQuestion,
        validation.normalizedSql,
        execution,
        retrievedContext
      );
    } catch {
      // SQL already passed AST validation and executed safely against SQLite;
      // format verified rows cleanly if the final prose summarization call fails.
      naturalLanguageAnswer = formatDeterministicRowSummary(execution, dataset);
    }
  }

  return {
    sessionId,
    datasetId: dataset.id,
    originalQuestion,
    rewrittenQuestion,
    status: 'COMPLETED',
    classification: intent.classification,
    retrievedContext,
    intent,
    clarificationHistory,
    sql: validation.normalizedSql,
    repaired,
    repairNotes,
    validation,
    execution,
    naturalLanguageAnswer,
    errorMessage: null,
    latencyMs: Math.round(performance.now() - startTime),
  };
}

export async function runInitialQuery(
  datasetId: string,
  question: string,
  llm: LLMProvider = geminiProvider
): Promise<PipelineResponse> {
  const startTime = performance.now();
  const sessionId = crypto.randomUUID();
  const trimmedQuestion = question.trim();

  const dataset = sqliteEngine.getDataset(datasetId);
  if (!dataset) {
    throw new Error(`Dataset "${datasetId}" not found.`);
  }

  const retrievedContext = retrieveDatabaseContext(trimmedQuestion, dataset, true);

  try {
    const plan = await llm.analyzeAndPlan(trimmedQuestion, retrievedContext, []);
    const { intent } = plan;

    if (intent.classification === 'OUT_OF_SCOPE' || intent.classification === 'UNANSWERABLE') {
      const explanation = buildRejectionReason(intent, dataset);
      return {
        sessionId,
        datasetId: dataset.id,
        originalQuestion: trimmedQuestion,
        rewrittenQuestion: null,
        status: 'REJECTED',
        classification: intent.classification,
        retrievedContext,
        intent,
        clarificationHistory: [],
        sql: null,
        validation: null,
        execution: null,
        naturalLanguageAnswer: explanation,
        errorMessage: null,
        latencyMs: Math.round(performance.now() - startTime),
      };
    }

    if (intent.classification === 'AMBIGUOUS') {
      const clarificationQ =
        intent.clarificationQuestion?.trim() ||
        'Your question has multiple possible interpretations. Could you clarify which column or criteria you would like to use?';

      clarificationSessions.set(sessionId, {
        sessionId,
        datasetId: dataset.id,
        originalQuestion: trimmedQuestion,
        clarificationHistory: [],
        lastClarificationQuestion: clarificationQ,
        retrievedContext,
      });

      return {
        sessionId,
        datasetId: dataset.id,
        originalQuestion: trimmedQuestion,
        rewrittenQuestion: null,
        status: 'NEEDS_CLARIFICATION',
        classification: 'AMBIGUOUS',
        retrievedContext,
        intent: {
          ...intent,
          clarificationQuestion: clarificationQ,
        },
        clarificationHistory: [],
        sql: null,
        validation: null,
        execution: null,
        naturalLanguageAnswer: clarificationQ,
        errorMessage: null,
        latencyMs: Math.round(performance.now() - startTime),
      };
    }

    return await validateRepairAndExecute({
      sessionId,
      dataset,
      originalQuestion: trimmedQuestion,
      resolvedQuestion: trimmedQuestion,
      rewrittenQuestion: null,
      retrievedContext,
      intent,
      candidateSql: plan.sql,
      clarificationHistory: [],
      llm,
      startTime,
    });
  } catch (err) {
    const cleanError = formatGeminiError(err);
    // Safe failure: never generate guessed or arbitrary SQL on LLM failure
    return {
      sessionId,
      datasetId: dataset.id,
      originalQuestion: trimmedQuestion,
      rewrittenQuestion: null,
      status: 'ERROR',
      classification: 'UNANSWERABLE',
      retrievedContext,
      intent: {
        classification: 'UNANSWERABLE',
        queryType: 'unknown',
        reason: 'Pipeline halted safely due to AI service error.',
        requestedOutputs: [],
        metricColumns: [],
        filterColumns: [],
        missingConcepts: [],
        ambiguityReasons: [],
        clarificationOptions: [],
      },
      clarificationHistory: [],
      sql: null,
      validation: null,
      execution: null,
      naturalLanguageAnswer: `Unable to process query safely: ${cleanError} No SQL was generated or executed.`,
      errorMessage: cleanError,
      latencyMs: Math.round(performance.now() - startTime),
    };
  }
}

export async function runClarificationResume(
  sessionId: string,
  userAnswer: string,
  llm: LLMProvider = geminiProvider
): Promise<PipelineResponse> {
  const startTime = performance.now();
  const session = clarificationSessions.get(sessionId);
  if (!session) {
    throw new Error(`Clarification session "${sessionId}" not found or expired.`);
  }

  const dataset = sqliteEngine.getDataset(session.datasetId);
  if (!dataset) {
    throw new Error(`Dataset "${session.datasetId}" not found.`);
  }

  const updatedHistory: ClarificationHistoryItem[] = [
    ...session.clarificationHistory,
    {
      question: session.lastClarificationQuestion,
      answer: userAnswer.trim(),
    },
  ];

  const combinedTextForRetrieval = `${session.originalQuestion} ${updatedHistory.map((h) => h.answer).join(' ')}`;
  const retrievedContext = retrieveDatabaseContext(combinedTextForRetrieval, dataset, true);

  try {
    const plan = await llm.analyzeAndPlan(session.originalQuestion, retrievedContext, updatedHistory);
    const rewrittenQuestion =
      plan.rewrittenQuestion?.trim() ||
      `${session.originalQuestion} (${updatedHistory.map((h) => h.answer).join('; ')})`;
    const { intent } = plan;

    if (intent.classification === 'AMBIGUOUS' && updatedHistory.length < 2) {
      const nextQ =
        intent.clarificationQuestion?.trim() ||
        'Thank you. One additional detail is needed to write an exact SQL query—could you clarify further?';
      clarificationSessions.set(sessionId, {
        ...session,
        clarificationHistory: updatedHistory,
        lastClarificationQuestion: nextQ,
        retrievedContext,
      });

      return {
        sessionId,
        datasetId: dataset.id,
        originalQuestion: session.originalQuestion,
        rewrittenQuestion,
        status: 'NEEDS_CLARIFICATION',
        classification: 'AMBIGUOUS',
        retrievedContext,
        intent: { ...intent, clarificationQuestion: nextQ },
        clarificationHistory: updatedHistory,
        sql: null,
        validation: null,
        execution: null,
        naturalLanguageAnswer: nextQ,
        errorMessage: null,
        latencyMs: Math.round(performance.now() - startTime),
      };
    }

    clarificationSessions.delete(sessionId);

    if (intent.classification === 'OUT_OF_SCOPE' || intent.classification === 'UNANSWERABLE') {
      return {
        sessionId,
        datasetId: dataset.id,
        originalQuestion: session.originalQuestion,
        rewrittenQuestion,
        status: 'REJECTED',
        classification: intent.classification,
        retrievedContext,
        intent,
        clarificationHistory: updatedHistory,
        sql: null,
        validation: null,
        execution: null,
        naturalLanguageAnswer: buildRejectionReason(intent, dataset),
        errorMessage: null,
        latencyMs: Math.round(performance.now() - startTime),
      };
    }

    return await validateRepairAndExecute({
      sessionId,
      dataset,
      originalQuestion: session.originalQuestion,
      resolvedQuestion: rewrittenQuestion,
      rewrittenQuestion,
      retrievedContext,
      intent: { ...intent, classification: 'CLEAR' },
      candidateSql: plan.sql,
      clarificationHistory: updatedHistory,
      llm,
      startTime,
    });
  } catch (err) {
    const cleanError = formatGeminiError(err);
    return {
      sessionId,
      datasetId: dataset.id,
      originalQuestion: session.originalQuestion,
      rewrittenQuestion: null,
      status: 'ERROR',
      classification: 'UNANSWERABLE',
      retrievedContext,
      intent: {
        classification: 'UNANSWERABLE',
        queryType: 'unknown',
        reason: 'Pipeline halted safely due to AI service error during clarification resume.',
        requestedOutputs: [],
        metricColumns: [],
        filterColumns: [],
        missingConcepts: [],
        ambiguityReasons: [],
        clarificationOptions: [],
      },
      clarificationHistory: updatedHistory,
      sql: null,
      validation: null,
      execution: null,
      naturalLanguageAnswer: `Unable to resume clarification safely: ${cleanError} No SQL was generated or executed.`,
      errorMessage: cleanError,
      latencyMs: Math.round(performance.now() - startTime),
    };
  }
}
