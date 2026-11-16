import type {
  ClarificationHistoryItem,
  QueryExecutionResult,
  RegressionTestResult,
  RetrievedDatabaseContext,
} from '../../src/types/text2sql';
import { geminiProvider, type LLMProvider, type UnifiedAnalysisResult } from './geminiClient';
import { runClarificationResume, runInitialQuery } from './orchestrator';

interface RegressionCaseDef {
  id: string;
  name: string;
  datasetId: string;
  question: string;
  followUpClarification?: string;
  expectedClassification: RegressionTestResult['expectedClassification'];
  expectedStatus: RegressionTestResult['expectedStatus'];
  assertSqlAndResult: (sql: string | null | undefined, rows: Array<Record<string, unknown>>) => { ok: boolean; note: string };
}

const REGRESSION_CASES: RegressionCaseDef[] = [
  {
    id: 'reg-1',
    name: 'Dataset-level total record count (named dataset)',
    datasetId: 'student_performance_data',
    question: 'What is the total number of records in Student Performance Data?',
    expectedClassification: 'CLEAR',
    expectedStatus: 'COMPLETED',
    assertSqlAndResult: (sql, rows) => {
      const hasCount = Boolean(sql && /\bCOUNT\s*\(/i.test(sql));
      const firstVal = rows[0] ? Object.values(rows[0])[0] : null;
      return {
        ok: hasCount && Number(firstVal) === 60,
        note: `Expected COUNT(*) = 60, got ${String(firstVal)}`,
      };
    },
  },
  {
    id: 'reg-2',
    name: 'Dataset-level row count (generic phrasing)',
    datasetId: 'student_performance_data',
    question: 'How many rows are in this dataset?',
    expectedClassification: 'CLEAR',
    expectedStatus: 'COMPLETED',
    assertSqlAndResult: (sql, rows) => {
      const hasCount = Boolean(sql && /\bCOUNT\s*\(/i.test(sql));
      const firstVal = rows[0] ? Object.values(rows[0])[0] : null;
      return {
        ok: hasCount && Number(firstVal) === 60,
        note: `Expected COUNT(*) = 60, got ${String(firstVal)}`,
      };
    },
  },
  {
    id: 'reg-3',
    name: 'Imperative record count ("Count all records.")',
    datasetId: 'student_performance_data',
    question: 'Count all records.',
    expectedClassification: 'CLEAR',
    expectedStatus: 'COMPLETED',
    assertSqlAndResult: (sql, rows) => {
      const hasCount = Boolean(sql && /\bCOUNT\s*\(/i.test(sql));
      const firstVal = rows[0] ? Object.values(rows[0])[0] : null;
      return {
        ok: hasCount && Number(firstVal) === 60,
        note: `Expected COUNT(*) = 60, got ${String(firstVal)}`,
      };
    },
  },
  {
    id: 'reg-4',
    name: 'Entity-noun count ("How many students are there?")',
    datasetId: 'student_performance_data',
    question: 'How many students are there?',
    expectedClassification: 'CLEAR',
    expectedStatus: 'COMPLETED',
    assertSqlAndResult: (sql, rows) => {
      const hasCount = Boolean(sql && /\bCOUNT\s*\(/i.test(sql));
      const firstVal = rows[0] ? Object.values(rows[0])[0] : null;
      return {
        ok: hasCount && Number(firstVal) === 60,
        note: `Expected COUNT(*) = 60, got ${String(firstVal)}`,
      };
    },
  },
  {
    id: 'reg-5',
    name: 'Numeric aggregation ("What is the average age?")',
    datasetId: 'student_performance_data',
    question: 'What is the average age?',
    expectedClassification: 'CLEAR',
    expectedStatus: 'COMPLETED',
    assertSqlAndResult: (sql, rows) => {
      const hasAvg = Boolean(sql && /\bAVG\s*\(\s*["'`]?age["'`]?\s*\)/i.test(sql));
      const firstVal = rows[0] ? Object.values(rows[0])[0] : null;
      const numericOk = typeof firstVal === 'number' && firstVal > 18 && firstVal < 25;
      return {
        ok: hasAvg && numericOk,
        note: `Expected AVG(age), got ${String(firstVal)}`,
      };
    },
  },
  {
    id: 'reg-6',
    name: 'Correlated extremum ("Age of student with highest exam score")',
    datasetId: 'student_performance_data',
    question: 'What is the age of the student with the highest exam score?',
    expectedClassification: 'CLEAR',
    expectedStatus: 'COMPLETED',
    assertSqlAndResult: (sql, rows) => {
      const avoidsMaxAge = Boolean(sql && !/\bMAX\s*\(\s*["'`]?age["'`]?\s*\)/i.test(sql));
      const referencesExamScore = Boolean(sql && /exam_score/i.test(sql));
      const ageVal = rows[0] && ('age' in rows[0] ? rows[0].age : Object.values(rows[0])[0]);
      return {
        ok: avoidsMaxAge && referencesExamScore && rows.length === 1 && Number(ageVal) === 19,
        note: `Avoids MAX(age), returns age=${String(ageVal)} for top scorer`,
      };
    },
  },
  {
    id: 'reg-7',
    name: 'Ambiguity detection + multi-turn clarification resume',
    datasetId: 'student_performance_data',
    question: 'Who are the best students?',
    followUpClarification: 'Top 5 students by highest exam_score',
    expectedClassification: 'AMBIGUOUS',
    expectedStatus: 'COMPLETED',
    assertSqlAndResult: (sql, rows) => {
      const ordersByScore = Boolean(sql && /ORDER\s+BY[\s\S]*exam_score\s+DESC/i.test(sql));
      return {
        ok: ordersByScore && rows.length === 5,
        note: `Clarified to top 5 by exam_score; returned ${rows.length} rows`,
      };
    },
  },
  {
    id: 'reg-8',
    name: 'Out-of-scope rejection ("Give me the name of five apples")',
    datasetId: 'student_performance_data',
    question: 'Give me the name of five apples',
    expectedClassification: 'OUT_OF_SCOPE',
    expectedStatus: 'REJECTED',
    assertSqlAndResult: (sql) => ({
      ok: !sql,
      note: !sql ? 'Rejected safely with zero SQL executed' : 'Unexpectedly generated SQL',
    }),
  },
  {
    id: 'reg-9',
    name: 'Missing column rejection ("What is the average salary of students?")',
    datasetId: 'student_performance_data',
    question: 'What is the average salary of students?',
    expectedClassification: 'UNANSWERABLE',
    expectedStatus: 'REJECTED',
    assertSqlAndResult: (sql) => ({
      ok: !sql,
      note: !sql ? 'Rejected missing salary column without guessing SQL' : 'Unexpectedly generated SQL',
    }),
  },
];

function createDeterministicSuiteProvider(): LLMProvider {
  return {
    async analyzeAndPlan(
      question: string,
      context: RetrievedDatabaseContext,
      history: ClarificationHistoryItem[]
    ): Promise<UnifiedAnalysisResult> {
      const combined = history.length > 0 ? `${question} ${history.map((h) => h.answer).join(' ')}` : question;
      const q = combined.toLowerCase();

      if (/total number of records|how many rows|count all records|how many students/.test(q)) {
        return {
          intent: {
            classification: 'CLEAR',
            queryType: 'dataset_count',
            reason: 'Dataset-level row count request.',
            requestedOutputs: [],
            metricColumns: [],
            filterColumns: [],
            aggregationFunction: 'COUNT',
            missingConcepts: [],
            ambiguityReasons: [],
            clarificationOptions: [],
          },
          sql: `SELECT COUNT(*) AS total_records FROM ${context.tableName}`,
        };
      }
      if (q.includes('apple')) {
        return {
          intent: {
            classification: 'OUT_OF_SCOPE',
            queryType: 'unknown',
            reason: 'Apples are unrelated to Student Performance Data.',
            requestedOutputs: [],
            metricColumns: [],
            filterColumns: [],
            missingConcepts: ['apples'],
            ambiguityReasons: [],
            clarificationOptions: [],
          },
          sql: null,
        };
      }
      if (q.includes('salary')) {
        return {
          intent: {
            classification: 'UNANSWERABLE',
            queryType: 'unknown',
            reason: 'No salary column exists in Student Performance Data.',
            requestedOutputs: ['salary'],
            metricColumns: [],
            filterColumns: [],
            missingConcepts: ['salary'],
            ambiguityReasons: [],
            clarificationOptions: [],
          },
          sql: null,
        };
      }
      if (q.includes('average age')) {
        return {
          intent: {
            classification: 'CLEAR',
            queryType: 'aggregation',
            reason: 'Computes AVG(age).',
            requestedOutputs: ['age'],
            metricColumns: ['age'],
            filterColumns: [],
            aggregationFunction: 'AVG',
            missingConcepts: [],
            ambiguityReasons: [],
            clarificationOptions: [],
          },
          sql: `SELECT AVG(age) AS average_age FROM ${context.tableName}`,
        };
      }
      if (q.includes('age') && q.includes('highest') && q.includes('score')) {
        return {
          intent: {
            classification: 'CLEAR',
            queryType: 'correlated_extremum',
            reason: 'Finds age of student with highest exam_score.',
            requestedOutputs: ['age'],
            metricColumns: ['exam_score'],
            filterColumns: [],
            orderByColumn: 'exam_score',
            orderDirection: 'DESC',
            limit: 1,
            missingConcepts: [],
            ambiguityReasons: [],
            clarificationOptions: [],
          },
          sql: `SELECT full_name, age, exam_score FROM ${context.tableName} ORDER BY exam_score DESC LIMIT 1`,
        };
      }
      if (q.includes('best') && history.length === 0) {
        return {
          intent: {
            classification: 'AMBIGUOUS',
            queryType: 'ranking',
            reason: 'Multiple metrics (gpa vs exam_score) can define "best".',
            requestedOutputs: ['full_name'],
            metricColumns: ['gpa', 'exam_score'],
            filterColumns: [],
            missingConcepts: [],
            ambiguityReasons: ['Ambiguous metric: gpa vs exam_score', 'Missing top-N limit'],
            clarificationQuestion: 'Which metric defines best students and how many should be listed?',
            clarificationOptions: ['Top 5 students by highest exam_score', 'Top 5 students by highest gpa'],
          },
          sql: null,
        };
      }
      return {
        rewrittenQuestion: history.length > 0 ? combined : null,
        intent: {
          classification: 'CLEAR',
          queryType: 'ranking',
          reason: 'Clarified top 5 by exam_score.',
          requestedOutputs: ['full_name', 'department', 'exam_score'],
          metricColumns: ['exam_score'],
          filterColumns: [],
          orderByColumn: 'exam_score',
          orderDirection: 'DESC',
          limit: 5,
          missingConcepts: [],
          ambiguityReasons: [],
          clarificationOptions: [],
        },
        sql: `SELECT full_name, department, exam_score FROM ${context.tableName} ORDER BY exam_score DESC LIMIT 5`,
      };
    },
    async repairSql(_q, _i, failedSql) {
      return failedSql;
    },
    async generateNaturalLanguageAnswer(_q, _sql, execution: QueryExecutionResult) {
      return `Verified SQLite result (${execution.rowCount} row(s)): ${JSON.stringify(execution.rows[0] ?? {})}`;
    },
  };
}

export async function runRegressionSuite(mode: 'deterministic' | 'live' = 'deterministic'): Promise<RegressionTestResult[]> {
  const llm = mode === 'live' ? geminiProvider : createDeterministicSuiteProvider();
  const results: RegressionTestResult[] = [];

  for (const tc of REGRESSION_CASES) {
    try {
      const initial = await runInitialQuery(tc.datasetId, tc.question, llm);
      let finalRes = initial;

      if (tc.followUpClarification && initial.status === 'NEEDS_CLARIFICATION') {
        finalRes = await runClarificationResume(initial.sessionId, tc.followUpClarification, llm);
      }

      const rows = finalRes.execution?.rows ?? [];
      const check = tc.assertSqlAndResult(finalRes.sql, rows);
      const classificationMatches = initial.classification === tc.expectedClassification;
      const statusMatches = finalRes.status === tc.expectedStatus;
      const passed = classificationMatches && statusMatches && check.ok;

      let summary = 'No rows';
      if (finalRes.status === 'REJECTED') {
        summary = `Rejected (${finalRes.classification})`;
      } else if (rows.length === 1) {
        summary = JSON.stringify(rows[0]);
      } else if (rows.length > 1) {
        summary = `${rows.length} rows returned`;
      } else if (finalRes.errorMessage) {
        summary = `Error: ${finalRes.errorMessage}`;
      }

      results.push({
        id: tc.id,
        name: tc.name,
        datasetId: tc.datasetId,
        question: tc.question,
        followUpClarification: tc.followUpClarification,
        expectedClassification: tc.expectedClassification,
        actualClassification: initial.classification,
        expectedStatus: tc.expectedStatus,
        actualStatus: finalRes.status,
        generatedSql: finalRes.sql,
        returnedValueSummary: summary,
        passed,
        notes: passed
          ? check.note
          : `Expected (${tc.expectedClassification} -> ${tc.expectedStatus}), got (${initial.classification} -> ${finalRes.status}). ${check.note}`,
      });
    } catch (err) {
      results.push({
        id: tc.id,
        name: tc.name,
        datasetId: tc.datasetId,
        question: tc.question,
        followUpClarification: tc.followUpClarification,
        expectedClassification: tc.expectedClassification,
        actualClassification: 'UNANSWERABLE',
        expectedStatus: tc.expectedStatus,
        actualStatus: 'ERROR',
        generatedSql: null,
        returnedValueSummary: 'Exception',
        passed: false,
        notes: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}
