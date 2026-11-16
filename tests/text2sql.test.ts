import { beforeAll, describe, expect, it } from 'vitest';
import { sqliteEngine } from '../server/db/sqliteEngine';
import { retrieveDatabaseContext } from '../server/pipeline/contextRetrieval';
import type { LLMProvider, UnifiedAnalysisResult } from '../server/pipeline/geminiClient';
import { runClarificationResume, runInitialQuery } from '../server/pipeline/orchestrator';
import { validateSqlAgainstDatasetAndIntent } from '../server/pipeline/sqlValidator';
import type {
  ClarificationHistoryItem,
  QueryExecutionResult,
  RetrievedDatabaseContext,
  StructuredIntent,
} from '../src/types/text2sql';

export function createDeterministicMockLLM(): LLMProvider {
  return {
    async analyzeAndPlan(
      question: string,
      context: RetrievedDatabaseContext,
      history: ClarificationHistoryItem[]
    ): Promise<UnifiedAnalysisResult> {
      const combined = history.length > 0
        ? `${question} Clarified criteria: ${history.map((h) => h.answer).join('; ')}`
        : question;
      const q = combined.toLowerCase();

      // Dataset-level record counts (no column name required)
      if (
        /total number of records|how many rows|count all records|how many students|how many vehicles|total records|number of entries/.test(
          q
        )
      ) {
        return {
          rewrittenQuestion: history.length > 0 ? combined : null,
          intent: {
            classification: 'CLEAR',
            queryType: 'dataset_count',
            reason: 'Dataset-level total record count request.',
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

      // Out-of-scope
      if (q.includes('apple')) {
        return {
          intent: {
            classification: 'OUT_OF_SCOPE',
            queryType: 'unknown',
            reason: 'Apples are unrelated to the active Student Performance dataset.',
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

      // Missing column
      if (q.includes('salary')) {
        return {
          intent: {
            classification: 'UNANSWERABLE',
            queryType: 'unknown',
            reason: 'The active dataset has no salary or compensation column.',
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

      // Correlated extremum
      if (q.includes('age') && q.includes('highest') && q.includes('score')) {
        return {
          intent: {
            classification: 'CLEAR',
            queryType: 'correlated_extremum',
            reason: 'Requests age of the student with maximum exam_score.',
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

      // Average age / average mileage
      if (q.includes('average age')) {
        return {
          intent: {
            classification: 'CLEAR',
            queryType: 'aggregation',
            reason: 'Computes average of age column.',
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

      if (q.includes('average mileage')) {
        return {
          intent: {
            classification: 'CLEAR',
            queryType: 'aggregation',
            reason: 'Computes average of mileage column.',
            requestedOutputs: ['mileage'],
            metricColumns: ['mileage'],
            filterColumns: [],
            aggregationFunction: 'AVG',
            missingConcepts: [],
            ambiguityReasons: [],
            clarificationOptions: [],
          },
          sql: `SELECT AVG(mileage) AS average_mileage FROM ${context.tableName}`,
        };
      }

      // Ambiguous vague term without metric specified
      if ((q.includes('best') || q.includes('top-performing')) && !q.includes('exam_score') && !q.includes('gpa') && history.length === 0) {
        return {
          intent: {
            classification: 'AMBIGUOUS',
            queryType: 'ranking',
            reason: '"best" is ambiguous across multiple performance metrics (gpa, exam_score, attendance_pct) and lacks a count limit.',
            requestedOutputs: ['full_name'],
            metricColumns: ['gpa', 'exam_score'],
            filterColumns: [],
            missingConcepts: [],
            ambiguityReasons: ['Multiple performance columns exist: gpa and exam_score.', 'Result limit not specified.'],
            clarificationQuestion: 'Which metric should define "best students", and how many would you like to see?',
            clarificationOptions: ['Top 5 by highest exam_score', 'Top 5 by highest gpa', 'Students with gpa >= 3.8'],
          },
          sql: null,
        };
      }

      // Clarified ranking
      if (q.includes('exam_score')) {
        return {
          rewrittenQuestion: history.length > 0 ? combined : null,
          intent: {
            classification: 'CLEAR',
            queryType: 'ranking',
            reason: 'Clarified ranking by exam_score DESC LIMIT 5.',
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
      }

      return {
        rewrittenQuestion: history.length > 0 ? combined : null,
        intent: {
          classification: 'CLEAR',
          queryType: 'lookup_filter',
          reason: 'General clear query.',
          requestedOutputs: context.allColumnNames.slice(0, 3),
          metricColumns: [],
          filterColumns: [],
          limit: 10,
          missingConcepts: [],
          ambiguityReasons: [],
          clarificationOptions: [],
        },
        sql: `SELECT * FROM ${context.tableName} LIMIT 10`,
      };
    },

    async repairSql(_question, intent, _failedSql, _errors, context): Promise<string> {
      if (intent.queryType === 'correlated_extremum') {
        return `SELECT full_name, age, exam_score FROM ${context.tableName} ORDER BY exam_score DESC LIMIT 1`;
      }
      return `SELECT COUNT(*) AS total_records FROM ${context.tableName}`;
    },

    async generateNaturalLanguageAnswer(_q, _sql, execution: QueryExecutionResult): Promise<string> {
      return `Returned ${execution.rowCount} row(s): ${JSON.stringify(execution.rows[0] ?? {})}`;
    },
  };
}

describe('Text-to-SQL Reliability & Ambiguity Pipeline', () => {
  beforeAll(async () => {
    await sqliteEngine.init();
  });

  const mockLlm = createDeterministicMockLLM();

  it('recognizes dataset-level record count questions and returns exact count (60)', async () => {
    const prompts = [
      'What is the total number of records in Student Performance Data?',
      'How many rows are in this dataset?',
      'Count all records.',
      'How many students are there?',
    ];

    for (const q of prompts) {
      const res = await runInitialQuery('student_performance_data', q, mockLlm);
      expect(res.classification).toBe('CLEAR');
      expect(res.status).toBe('COMPLETED');
      expect(res.sql).toMatch(/COUNT\s*\(\s*\*\s*\)/i);
      expect(res.execution?.rows[0]?.total_records).toBe(60);
    }
  });

  it('computes AVG(age) for "What is the average age?" rather than returning raw rows', async () => {
    const res = await runInitialQuery('student_performance_data', 'What is the average age?', mockLlm);
    expect(res.status).toBe('COMPLETED');
    expect(res.sql).toMatch(/AVG\s*\(\s*age\s*\)/i);
    expect(res.execution?.rowCount).toBe(1);
    const avgAge = Number(res.execution?.rows[0]?.average_age);
    expect(avgAge).toBeGreaterThan(18);
    expect(avgAge).toBeLessThan(25);
  });

  it('rejects out-of-scope questions ("Give me the name of five apples") with zero SQL', async () => {
    const res = await runInitialQuery('student_performance_data', 'Give me the name of five apples', mockLlm);
    expect(res.classification).toBe('OUT_OF_SCOPE');
    expect(res.status).toBe('REJECTED');
    expect(res.sql).toBeNull();
    expect(res.execution).toBeNull();
  });

  it('rejects missing-column questions without guessing SQL', async () => {
    const res = await runInitialQuery('student_performance_data', 'What is the average salary of students?', mockLlm);
    expect(res.classification).toBe('UNANSWERABLE');
    expect(res.status).toBe('REJECTED');
    expect(res.sql).toBeNull();
  });

  it('pauses on ambiguous queries ("Who are the best students?") and resumes cleanly with rewritten intent', async () => {
    const step1 = await runInitialQuery('student_performance_data', 'Who are the best students?', mockLlm);
    expect(step1.classification).toBe('AMBIGUOUS');
    expect(step1.status).toBe('NEEDS_CLARIFICATION');
    expect(step1.intent.clarificationOptions.length).toBeGreaterThan(0);
    expect(step1.sql).toBeNull();

    const step2 = await runClarificationResume(step1.sessionId, 'Top 5 by highest exam_score', mockLlm);
    expect(step2.status).toBe('COMPLETED');
    expect(step2.rewrittenQuestion).toContain('Who are the best students?');
    expect(step2.rewrittenQuestion).toContain('exam_score');
    expect(step2.sql).toMatch(/ORDER\s+BY\s+exam_score\s+DESC\s+LIMIT\s+5/i);
    expect(step2.execution?.rowCount).toBe(5);
    expect(step2.execution?.rows[0]?.exam_score).toBe(99);
  });

  it('catches MAX(age) semantic bug on correlated extremum queries and triggers intent-preserving repair', async () => {
    const dataset = sqliteEngine.getDataset('student_performance_data')!;
    const badSql = 'SELECT MAX(age) FROM student_performance_data';
    const intent: StructuredIntent = {
      classification: 'CLEAR',
      queryType: 'correlated_extremum',
      reason: 'Age of student with highest exam_score',
      requestedOutputs: ['age'],
      metricColumns: ['exam_score'],
      filterColumns: [],
      orderByColumn: 'exam_score',
      orderDirection: 'DESC',
      limit: 1,
      missingConcepts: [],
      ambiguityReasons: [],
      clarificationOptions: [],
    };
    const report = validateSqlAgainstDatasetAndIntent(badSql, dataset, intent);
    expect(report.valid).toBe(false);
    expect(report.semanticValid).toBe(false);

    const buggyGeneratorLlm: LLMProvider = {
      ...mockLlm,
      async analyzeAndPlan() {
        return {
          intent,
          sql: 'SELECT MAX(age) AS max_age FROM student_performance_data',
        };
      },
    };
    const repairedRes = await runInitialQuery(
      'student_performance_data',
      'What is the age of the student with the highest exam score?',
      buggyGeneratorLlm
    );
    expect(repairedRes.status).toBe('COMPLETED');
    expect(repairedRes.repaired).toBe(true);
    expect(repairedRes.sql).toMatch(/ORDER\s+BY\s+exam_score\s+DESC\s+LIMIT\s+1/i);
    expect(repairedRes.execution?.rows[0]?.age).toBe(19);
  });

  it('blocks unsafe SQL, unauthorized tables, and unknown columns at AST level', () => {
    const dataset = sqliteEngine.getDataset('student_performance_data')!;
    const clearIntent: StructuredIntent = {
      classification: 'CLEAR',
      queryType: 'lookup_filter',
      reason: 'Lookup',
      requestedOutputs: [],
      metricColumns: [],
      filterColumns: [],
      missingConcepts: [],
      ambiguityReasons: [],
      clarificationOptions: [],
    };

    expect(
      validateSqlAgainstDatasetAndIntent('DROP TABLE student_performance_data', dataset, clearIntent).valid
    ).toBe(false);
    expect(
      validateSqlAgainstDatasetAndIntent('SELECT * FROM sqlite_master', dataset, clearIntent).valid
    ).toBe(false);
    expect(
      validateSqlAgainstDatasetAndIntent('SELECT * FROM ecommerce_orders', dataset, clearIntent).valid
    ).toBe(false);
    expect(
      validateSqlAgainstDatasetAndIntent('SELECT salary FROM student_performance_data', dataset, clearIntent).valid
    ).toBe(false);
    expect(
      validateSqlAgainstDatasetAndIntent('SELECT COUNT(*) FROM student_performance_data; DELETE FROM student_performance_data', dataset, clearIntent).valid
    ).toBe(false);
  });

  it('generalizes across arbitrary uploaded CSV datasets and retrieves live DB values', async () => {
    const csvContent = [
      'vehicle_id,fleet_region,mileage,fuel_type',
      'VH-1,Midwest,42000,Hybrid',
      'VH-2,Northeast,68000,Electric',
      'VH-3,Midwest,55000,Diesel',
    ].join('\n');

    const uploaded = sqliteEngine.importUploadedFile('fleet_vehicles.csv', Buffer.from(csvContent, 'utf-8'));
    expect(uploaded.rowCount).toBe(3);

    const ctx = retrieveDatabaseContext('Show Hybrid vehicles in Midwest', uploaded, true);
    expect(ctx.retrievedColumns.find((c) => c.name === 'fuel_type')?.matchedValues).toContain('Hybrid');

    const countRes = await runInitialQuery(uploaded.id, 'How many rows are in this dataset?', mockLlm);
    expect(countRes.status).toBe('COMPLETED');
    expect(countRes.execution?.rows[0]?.total_records).toBe(3);

    const avgRes = await runInitialQuery(uploaded.id, 'What is the average mileage?', mockLlm);
    expect(avgRes.status).toBe('COMPLETED');
    expect(avgRes.execution?.rows[0]?.average_mileage).toBe(55000);
  });

  it('fails safely without generating guessed SQL when Gemini errors', async () => {
    const failingLlm: LLMProvider = {
      ...mockLlm,
      async analyzeAndPlan() {
        throw new Error('429 RESOURCE_EXHAUSTED');
      },
    };
    const res = await runInitialQuery('student_performance_data', 'What is the average age?', failingLlm);
    expect(res.status).toBe('ERROR');
    expect(res.sql).toBeNull();
    expect(res.execution).toBeNull();
    expect(res.errorMessage).toContain('429');
  });
});
