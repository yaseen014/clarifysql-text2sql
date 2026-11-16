import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import type {
  ClarificationHistoryItem,
  QueryExecutionResult,
  RetrievedDatabaseContext,
  StructuredIntent,
} from '../../src/types/text2sql';
import { quotaTracker } from './quotaTracker';

export interface UnifiedAnalysisResult {
  intent: StructuredIntent;
  rewrittenQuestion?: string | null;
  sql?: string | null;
}

export interface LLMProvider {
  analyzeAndPlan(
    originalQuestion: string,
    context: RetrievedDatabaseContext,
    history: ClarificationHistoryItem[]
  ): Promise<UnifiedAnalysisResult>;

  repairSql(
    resolvedQuestion: string,
    intent: StructuredIntent,
    failedSql: string,
    validationErrors: string[],
    context: RetrievedDatabaseContext
  ): Promise<string>;

  generateNaturalLanguageAnswer(
    question: string,
    sql: string,
    execution: QueryExecutionResult,
    context: RetrievedDatabaseContext
  ): Promise<string>;
}

const PRIMARY_MODEL = 'gemini-4-hydrogen';
const FALLBACK_MODEL = 'gemini-3.1-flash-lite';

export function formatGeminiError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (/429|RESOURCE_EXHAUSTED|quota/i.test(raw)) {
    const isDaily = /per day|PerDay|retryDelay/i.test(raw);
    return isDaily
      ? 'Gemini API daily free-tier quota reached (429 RESOURCE_EXHAUSTED). Enable Pay-as-you-go billing on your Google Cloud project or update GEMINI_API_KEY in Settings > Secrets for higher limits.'
      : 'Gemini API rate limit reached (429 RESOURCE_EXHAUSTED). Please wait a moment and try again, or select a billed API key in Settings > Secrets.';
  }
  if (/403|PERMISSION_DENIED|API_KEY_INVALID|400/i.test(raw) && /key|permission|api/i.test(raw)) {
    return 'Gemini API authentication failed. Please verify GEMINI_API_KEY in Settings > Secrets.';
  }
  if (/404|NOT_FOUND/i.test(raw)) {
    return 'Requested Gemini model was not found or is unavailable.';
  }
  return raw.length > 260 ? `${raw.slice(0, 260)}...` : raw;
}

function formatContextPrompt(context: RetrievedDatabaseContext): string {
  const colLines = context.retrievedColumns.map((col) => {
    const matched = col.matchedValues.length > 0 ? ` | matched_values=[${col.matchedValues.join(', ')}]` : '';
    const samples = col.sampleValues.length > 0 ? ` | sample_values=[${col.sampleValues.join(', ')}]` : '';
    return `- ${col.name} (${col.type}): ${col.statsSummary}${matched}${samples}`;
  });

  return [
    `Active Dataset: "${context.datasetName}"`,
    `Authorized SQLite Table Name: "${context.tableName}"`,
    `Row Entity Noun: "${context.entityNoun}"`,
    `Total Records in Dataset: ${context.totalRowCount}`,
    `All Valid Columns: [${context.allColumnNames.join(', ')}]`,
    `Retrieved Schema & Database Values:`,
    ...colLines,
  ].join('\n');
}

async function generateWithModelFailover<T>(
  runForModel: (model: string, thinkingLevel: ThinkingLevel) => Promise<T>
): Promise<T> {
  if (!quotaTracker.isModelKnownExhausted(PRIMARY_MODEL)) {
    try {
      const res = await runForModel(PRIMARY_MODEL, ThinkingLevel.LOW);
      quotaTracker.recordSuccess(PRIMARY_MODEL);
      return res;
    } catch (primaryErr) {
      const msg = primaryErr instanceof Error ? primaryErr.message : String(primaryErr);
      const isQuota = /429|RESOURCE_EXHAUSTED|quota/i.test(msg);
      if (isQuota) {
        quotaTracker.recordRateLimit(PRIMARY_MODEL, msg);
      }
      const shouldFailover = isQuota || /503|UNAVAILABLE/i.test(msg);
      if (!shouldFailover) {
        throw primaryErr;
      }
    }
  }

  try {
    const res = await runForModel(FALLBACK_MODEL, ThinkingLevel.MINIMAL);
    quotaTracker.recordSuccess(FALLBACK_MODEL);
    return res;
  } catch (fallbackErr) {
    const msg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
    if (/429|RESOURCE_EXHAUSTED|quota/i.test(msg)) {
      quotaTracker.recordRateLimit(FALLBACK_MODEL, msg);
    }
    throw fallbackErr;
  }
}

export class GeminiLLMProvider implements LLMProvider {
  private getClient(): GoogleGenAI {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
      throw new Error('GEMINI_API_KEY is not configured on the server.');
    }
    return new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }

  async analyzeAndPlan(
    originalQuestion: string,
    context: RetrievedDatabaseContext,
    history: ClarificationHistoryItem[]
  ): Promise<UnifiedAnalysisResult> {
    const ai = this.getClient();
    const contextBlock = formatContextPrompt(context);
    const hasHistory = history.length > 0;
    const historyBlock = hasHistory
      ? `\nClarification Turns Already Answered by User:\n${history
          .map((h, i) => `Turn ${i + 1}:\n  Clarification Asked: "${h.question}"\n  User Answer: "${h.answer}"`)
          .join('\n')}`
      : '';

    const systemInstruction = `You are a unified Database-Aware Intent Analyzer, Ambiguity Detector, Question Rewriter, and SQLite SQL Generator.
Perform all steps consistently so classification, structured intent, and SQL never disagree.

CLASSIFICATION RULES:
1. DATASET-LEVEL QUESTIONS ARE ALWAYS "CLEAR":
   - Questions asking for the total number of records, row count, number of entries, total rows, dataset size, or count of the dataset's primary entity (e.g. "What is the total number of records in Student Performance Data?", "How many rows are in this dataset?", "Count all records", "How many students are there?") are VALID and CLEAR.
   - Set queryType="dataset_count", aggregationFunction="COUNT", and sql="SELECT COUNT(*) AS total_records FROM ${context.tableName}".
   - Dataset-level counts do NOT require a matching column name. NEVER mark them OUT_OF_SCOPE or UNANSWERABLE.

2. AMBIGUITY DETECTION ("AMBIGUOUS"):
   - Mark AMBIGUOUS when the user uses vague qualitative terms ("best", "top-performing", "good", "high", "low", "poor", "recent", "large", "expensive", "popular", "worst") AND either:
     a) Multiple schema columns could represent the metric (e.g., "gpa" vs "exam_score" vs "attendance_pct", or "order_amount" vs "customer_rating"), OR
     b) No numeric threshold or top-N limit is given.
   - Also mark AMBIGUOUS when an entity/filter value or time range is genuinely ambiguous across the retrieved DB values.
   - Do NOT mark AMBIGUOUS when the metric, operation, and scope are clear (e.g., "What is the average age?", "What is the age of the student with the highest exam score?", "Top 5 students by exam_score").
   - If AMBIGUOUS: set sql=null, write a concise targeted "clarificationQuestion", and give 2-4 concrete "clarificationOptions" grounded in actual columns/values.

3. OUT OF SCOPE ("OUT_OF_SCOPE") & MISSING COLUMNS ("UNANSWERABLE"):
   - OUT_OF_SCOPE: Completely unrelated subject/entities absent from the dataset (e.g., "Give me the name of five apples" on student data). Set sql=null.
   - UNANSWERABLE: References specific attributes/columns absent from the schema (e.g., "average salary", "home address") with no matching column. Explain which concepts are missing in missingConcepts. Set sql=null. Never guess unrelated columns.

4. QUESTION REWRITING (when Clarification Turns exist):
   - Combine Original Question + User Answer(s) + exact schema/value names into a clear, unambiguous "rewrittenQuestion" preserving all original constraints, then classify and generate SQL for that rewritten question.

5. SQL GENERATION RULES (when CLEAR):
   - Only query table "${context.tableName}" using columns in [${context.allColumnNames.join(', ')}].
   - Aggregations ("What is the average age?"): MUST use AVG(age) etc., never return raw rows.
   - Correlated extremum ("What is the age of the student with the highest exam score?"): NEVER use MAX(age)! Select the requested column(s) (e.g., full_name, age, exam_score) with ORDER BY exam_score DESC LIMIT 1.
   - Always preserve requested columns, filters, ordering, and LIMIT.`;

    const response = await generateWithModelFailover((model, thinkingLevel) =>
      ai.models.generateContent({
        model,
        contents: `${contextBlock}${historyBlock}\n\nOriginal User Question: "${originalQuestion}"`,
        config: {
          systemInstruction,
          thinkingConfig: { thinkingLevel },
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              rewrittenQuestion: { type: Type.STRING, nullable: true },
              classification: {
                type: Type.STRING,
                enum: ['CLEAR', 'AMBIGUOUS', 'OUT_OF_SCOPE', 'UNANSWERABLE'],
              },
              queryType: {
                type: Type.STRING,
                enum: [
                  'dataset_count',
                  'aggregation',
                  'correlated_extremum',
                  'ranking',
                  'lookup_filter',
                  'grouping',
                  'unknown',
                ],
              },
              reason: { type: Type.STRING },
              requestedOutputs: { type: Type.ARRAY, items: { type: Type.STRING } },
              metricColumns: { type: Type.ARRAY, items: { type: Type.STRING } },
              filterColumns: { type: Type.ARRAY, items: { type: Type.STRING } },
              orderByColumn: { type: Type.STRING, nullable: true },
              orderDirection: { type: Type.STRING, enum: ['ASC', 'DESC'], nullable: true },
              limit: { type: Type.INTEGER, nullable: true },
              aggregationFunction: {
                type: Type.STRING,
                enum: ['COUNT', 'AVG', 'SUM', 'MIN', 'MAX'],
                nullable: true,
              },
              missingConcepts: { type: Type.ARRAY, items: { type: Type.STRING } },
              ambiguityReasons: { type: Type.ARRAY, items: { type: Type.STRING } },
              clarificationQuestion: { type: Type.STRING, nullable: true },
              clarificationOptions: { type: Type.ARRAY, items: { type: Type.STRING } },
              sql: { type: Type.STRING, nullable: true },
            },
            required: [
              'classification',
              'queryType',
              'reason',
              'requestedOutputs',
              'metricColumns',
              'filterColumns',
              'missingConcepts',
              'ambiguityReasons',
              'clarificationOptions',
            ],
          },
        },
      })
    );

    const parsed = JSON.parse((response.text ?? '{}').trim()) as StructuredIntent & {
      rewrittenQuestion?: string | null;
      sql?: string | null;
    };

    const intent: StructuredIntent = {
      classification: parsed.classification,
      queryType: parsed.queryType ?? 'unknown',
      reason: parsed.reason ?? '',
      requestedOutputs: parsed.requestedOutputs ?? [],
      metricColumns: parsed.metricColumns ?? [],
      filterColumns: parsed.filterColumns ?? [],
      orderByColumn: parsed.orderByColumn ?? null,
      orderDirection: parsed.orderDirection ?? null,
      limit: parsed.limit ?? null,
      aggregationFunction: parsed.aggregationFunction ?? null,
      missingConcepts: parsed.missingConcepts ?? [],
      ambiguityReasons: parsed.ambiguityReasons ?? [],
      clarificationQuestion: parsed.clarificationQuestion ?? null,
      clarificationOptions: parsed.clarificationOptions ?? [],
    };

    return {
      intent,
      rewrittenQuestion: parsed.rewrittenQuestion ?? null,
      sql: parsed.sql ?? null,
    };
  }

  async repairSql(
    resolvedQuestion: string,
    intent: StructuredIntent,
    failedSql: string,
    validationErrors: string[],
    context: RetrievedDatabaseContext
  ): Promise<string> {
    const ai = this.getClient();
    const contextBlock = formatContextPrompt(context);

    const response = await generateWithModelFailover((model, thinkingLevel) =>
      ai.models.generateContent({
        model,
        contents: `${contextBlock}\n\nQuestion: "${resolvedQuestion}"\n\nStructured Intent:\n${JSON.stringify(
          intent,
          null,
          2
        )}\n\nInvalid SQL:\n${failedSql}\n\nValidation Errors to Fix:\n- ${validationErrors.join('\n- ')}`,
        config: {
          systemInstruction:
            `Repair the SQLite SELECT query to fix all listed validation errors while strictly preserving the user's original intent, requested columns, filters, ordering, and LIMIT. Only use table "${context.tableName}" and valid schema columns. Return JSON with field "sql".`,
          thinkingConfig: { thinkingLevel },
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              sql: { type: Type.STRING },
            },
            required: ['sql'],
          },
        },
      })
    );

    const parsed = JSON.parse((response.text ?? '{}').trim()) as { sql?: string };
    if (!parsed.sql?.trim()) {
      throw new Error('SQL repair produced an empty SQL string.');
    }
    return parsed.sql.trim();
  }

  async generateNaturalLanguageAnswer(
    question: string,
    sql: string,
    execution: QueryExecutionResult,
    context: RetrievedDatabaseContext
  ): Promise<string> {
    const ai = this.getClient();
    const previewRows = execution.rows.slice(0, 25);

    const response = await generateWithModelFailover((model, thinkingLevel) =>
      ai.models.generateContent({
        model,
        contents: `Dataset: ${context.datasetName}\nUser Question: "${question}"\nExecuted SQL: ${sql}\nReturned Row Count: ${execution.rowCount}${
          execution.truncated ? ' (truncated to 500)' : ''
        }\nResult Rows (JSON):\n${JSON.stringify(previewRows, null, 2)}`,
        config: {
          systemInstruction:
            'Summarize the SQL query result in 1 to 3 clear, accurate, factual sentences directly answering the user question. Cite exact numbers and names from the Result Rows. Do not invent values not present in Result Rows.',
          thinkingConfig: { thinkingLevel },
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              answer: { type: Type.STRING },
            },
            required: ['answer'],
          },
        },
      })
    );

    const parsed = JSON.parse((response.text ?? '{}').trim()) as { answer?: string };
    return parsed.answer?.trim() || 'Query executed successfully. See the result table below.';
  }
}

export const geminiProvider = new GeminiLLMProvider();
