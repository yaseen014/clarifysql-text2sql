import pkg from 'node-sql-parser';
import type {
  DatasetMetadata,
  SqlValidationReport,
  StructuredIntent,
  ValidationCheckItem,
} from '../../src/types/text2sql';

const { Parser } = pkg;
const parser = new Parser();

const FORBIDDEN_KEYWORDS_REGEX =
  /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|TRUNCATE|ATTACH|DETACH|PRAGMA|VACUUM|REINDEX|EXEC|EXECUTE|MERGE|GRANT|REVOKE)\b/i;

const FORBIDDEN_SYSTEM_TABLES = new Set([
  'sqlite_master',
  'sqlite_schema',
  'sqlite_temp_master',
  'sqlite_temp_schema',
  'sqlite_sequence',
]);

export function cleanSqlMarkdown(rawSql: string): string {
  let sql = rawSql.trim();
  const fenced = sql.match(/```(?:sql)?\s*([\s\S]*?)```/i);
  if (fenced && fenced[1]) {
    sql = fenced[1].trim();
  }
  sql = sql.replace(/;+\s*$/, '').trim();
  return sql;
}

function extractCteNames(astNode: Record<string, unknown>): Set<string> {
  const cteNames = new Set<string>();
  const withClause = astNode.with;
  if (Array.isArray(withClause)) {
    for (const item of withClause) {
      if (item && typeof item === 'object' && 'name' in item) {
        const nameObj = (item as { name?: { value?: string } | string }).name;
        if (typeof nameObj === 'string') {
          cteNames.add(nameObj.toLowerCase());
        } else if (nameObj && typeof nameObj === 'object' && typeof nameObj.value === 'string') {
          cteNames.add(nameObj.value.toLowerCase());
        }
      }
    }
  }
  return cteNames;
}

function extractSelectAliases(astNode: Record<string, unknown>): Set<string> {
  const aliases = new Set<string>();
  const cols = astNode.columns;
  if (Array.isArray(cols)) {
    for (const col of cols) {
      if (col && typeof col === 'object' && 'as' in col && typeof (col as { as?: unknown }).as === 'string') {
        aliases.add(((col as { as: string }).as).toLowerCase());
      }
    }
  }
  return aliases;
}

export function validateSqlAgainstDatasetAndIntent(
  rawSql: string,
  dataset: DatasetMetadata,
  intent: StructuredIntent
): SqlValidationReport {
  const normalizedSql = cleanSqlMarkdown(rawSql);
  const checks: ValidationCheckItem[] = [];
  const errors: string[] = [];

  if (!normalizedSql) {
    return {
      valid: false,
      astValid: false,
      semanticValid: false,
      readOnlySafe: false,
      authorizedTablesOnly: false,
      authorizedColumnsOnly: false,
      checks: [{ name: 'Non-empty SQL', passed: false, detail: 'Generated SQL was empty.' }],
      errors: ['Generated SQL is empty.'],
      normalizedSql: '',
    };
  }

  // 1. Read-only keyword safety check
  const forbiddenMatch = normalizedSql.match(FORBIDDEN_KEYWORDS_REGEX);
  const readOnlyKeywordSafe = !forbiddenMatch;
  checks.push({
    name: 'Read-Only Safety',
    passed: readOnlyKeywordSafe,
    detail: readOnlyKeywordSafe
      ? 'No DML, DDL, or administrative SQL keywords detected.'
      : `Blocked unsafe SQL keyword: ${forbiddenMatch?.[0]}`,
  });
  if (!readOnlyKeywordSafe) {
    errors.push(`Read-only safety violation: forbidden keyword "${forbiddenMatch?.[0]}".`);
  }

  // 2. Parse SQL AST
  let ast: unknown;
  let astValid = false;
  let isSingleSelect = false;
  let cteNames = new Set<string>();
  let selectAliases = new Set<string>();

  try {
    ast = parser.astify(normalizedSql, { database: 'sqlite' });
    const statements = Array.isArray(ast) ? ast : [ast];
    if (statements.length !== 1) {
      errors.push('Stacked / multi-statement SQL is prohibited.');
    } else {
      const firstStmt = statements[0] as Record<string, unknown>;
      if (firstStmt?.type !== 'select') {
        errors.push(`Only SELECT statements are allowed; got "${String(firstStmt?.type)}".`);
      } else {
        astValid = true;
        isSingleSelect = true;
        cteNames = extractCteNames(firstStmt);
        selectAliases = extractSelectAliases(firstStmt);
      }
    }
  } catch (err) {
    errors.push(`SQL AST parse error: ${err instanceof Error ? err.message : String(err)}`);
  }

  checks.push({
    name: 'AST Syntax & Single SELECT',
    passed: astValid && isSingleSelect,
    detail: astValid && isSingleSelect
      ? 'Parsed into a single valid SQLite SELECT AST.'
      : errors[errors.length - 1] || 'Invalid SQL syntax.',
  });

  // 3. Table authorization check
  let authorizedTablesOnly = false;
  if (astValid) {
    try {
      const tableRefs = parser.tableList(normalizedSql, { database: 'sqlite' });
      const unauthorized: string[] = [];
      const allowedTable = dataset.tableName.toLowerCase();

      for (const ref of tableRefs) {
        // node-sql-parser format: "{type}::{db}::{table}"
        const parts = ref.split('::');
        const op = parts[0]?.toLowerCase();
        const tbl = (parts[2] ?? '').replace(/^["'`]|["'`]$/g, '').toLowerCase();

        if (op !== 'select') {
          unauthorized.push(`${op}:${tbl}`);
          continue;
        }
        if (FORBIDDEN_SYSTEM_TABLES.has(tbl)) {
          unauthorized.push(tbl);
          continue;
        }
        if (tbl !== allowedTable && !cteNames.has(tbl)) {
          unauthorized.push(tbl);
        }
      }

      if (tableRefs.length === 0) {
        unauthorized.push('(missing FROM table)');
      }

      authorizedTablesOnly = unauthorized.length === 0;
      if (!authorizedTablesOnly) {
        errors.push(`Unauthorized or invalid table reference(s): ${unauthorized.join(', ')}`);
      }
    } catch (err) {
      errors.push(`Table authorization inspection failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  checks.push({
    name: 'Table Authorization',
    passed: authorizedTablesOnly,
    detail: authorizedTablesOnly
      ? `Restricted strictly to authorized dataset table "${dataset.tableName}".`
      : 'Referenced table is not in the authorized dataset registry.',
  });

  // 4. Column authorization check
  let authorizedColumnsOnly = false;
  if (astValid) {
    try {
      const colRefs = parser.columnList(normalizedSql, { database: 'sqlite' });
      const validCols = new Set(dataset.columns.map((c) => c.name.toLowerCase()));
      const invalidCols: string[] = [];

      for (const ref of colRefs) {
        // node-sql-parser format: "{type}::{table}::{column}"
        const parts = ref.split('::');
        const colName = (parts[2] ?? '').replace(/^["'`]|["'`]$/g, '').toLowerCase();
        if (!colName || colName === '(.*)' || colName === '*') continue;
        if (validCols.has(colName) || selectAliases.has(colName)) continue;
        invalidCols.push(colName);
      }

      authorizedColumnsOnly = invalidCols.length === 0;
      if (!authorizedColumnsOnly) {
        errors.push(`Unknown or non-existent column(s): ${invalidCols.join(', ')}`);
      }
    } catch (err) {
      errors.push(`Column validation failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  checks.push({
    name: 'Schema Column Grounding',
    passed: authorizedColumnsOnly,
    detail: authorizedColumnsOnly
      ? 'All referenced columns exist in the active dataset schema.'
      : 'SQL references columns absent from the active dataset schema.',
  });

  // 5. Semantic Intent Alignment checks
  const semanticErrors: string[] = [];
  const upperSql = normalizedSql.toUpperCase();

  if (intent.queryType === 'dataset_count') {
    if (!/\bCOUNT\s*\(/i.test(normalizedSql)) {
      semanticErrors.push('Dataset record count question must compute COUNT(*), not return raw rows.');
    }
  }

  if (intent.queryType === 'aggregation' && intent.aggregationFunction) {
    const fn = intent.aggregationFunction.toUpperCase();
    const fnRegex = new RegExp(`\\b${fn}\\s*\\(`, 'i');
    if (!fnRegex.test(normalizedSql)) {
      semanticErrors.push(`Aggregation intent requires ${fn}(...) but SQL did not use ${fn}.`);
    }
  }

  if (intent.queryType === 'correlated_extremum' && intent.orderByColumn) {
    const rankCol = intent.orderByColumn.toLowerCase();
    // Prevent MAX(age) when the user asked for the age of the student with the highest exam_score
    for (const outCol of intent.requestedOutputs) {
      const lowerOut = outCol.toLowerCase();
      if (lowerOut !== rankCol) {
        const wrongAggRegex = new RegExp(`\\b(MAX|MIN)\\s*\\(\\s*["'\`]?${lowerOut}["'\`]?\\s*\\)`, 'i');
        if (wrongAggRegex.test(normalizedSql)) {
          semanticErrors.push(
            `Semantic error: SQL uses MAX/MIN(${lowerOut}) instead of finding ${lowerOut} for the record with extreme ${rankCol}. Use ORDER BY ${rankCol} ${intent.orderDirection || 'DESC'} LIMIT 1 or a subquery on ${rankCol}.`
          );
        }
      }
    }
    const usesOrderOrSubquery =
      upperSql.includes('ORDER BY') || /\(\s*SELECT\s+(MAX|MIN)\s*\(/i.test(normalizedSql);
    if (!usesOrderOrSubquery) {
      semanticErrors.push(`Correlated extremum query must rank or filter by "${rankCol}".`);
    }
  }

  if (intent.queryType === 'ranking') {
    if (!upperSql.includes('ORDER BY')) {
      semanticErrors.push('Ranking query is missing an ORDER BY clause.');
    }
    if (intent.limit != null && !upperSql.includes('LIMIT')) {
      semanticErrors.push(`Ranking query requested top ${intent.limit} results, but SQL is missing LIMIT ${intent.limit}.`);
    }
  }

  if (intent.limit != null && intent.limit > 0) {
    const limitMatch = normalizedSql.match(/\bLIMIT\s+(\d+)/i);
    if (!limitMatch && intent.queryType !== 'dataset_count' && intent.queryType !== 'aggregation') {
      semanticErrors.push(`Query requested a limit of ${intent.limit} rows, but SQL lacks LIMIT.`);
    } else if (limitMatch && Number(limitMatch[1]) > 500) {
      semanticErrors.push('LIMIT exceeds safe maximum of 500 rows.');
    }
  }

  const semanticValid = semanticErrors.length === 0;
  errors.push(...semanticErrors);

  checks.push({
    name: 'Semantic Intent Alignment',
    passed: semanticValid,
    detail: semanticValid
      ? 'SQL structure matches interpreted user intent (aggregations, correlations, ordering, limits).'
      : semanticErrors.join(' '),
  });

  const valid =
    readOnlyKeywordSafe &&
    astValid &&
    isSingleSelect &&
    authorizedTablesOnly &&
    authorizedColumnsOnly &&
    semanticValid;

  return {
    valid,
    astValid,
    semanticValid,
    readOnlySafe: readOnlyKeywordSafe,
    authorizedTablesOnly,
    authorizedColumnsOnly,
    checks,
    errors,
    normalizedSql,
  };
}
