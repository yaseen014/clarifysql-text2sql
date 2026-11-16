import type {
  ColumnProfile,
  DatasetMetadata,
  RetrievedColumnContext,
  RetrievedDatabaseContext,
} from '../../src/types/text2sql';
import { sqliteEngine } from '../db/sqliteEngine';

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'in', 'of', 'for', 'to', 'and', 'or',
  'what', 'which', 'who', 'whom', 'how', 'many', 'much', 'give', 'me', 'show', 'list',
  'find', 'get', 'tell', 'all', 'this', 'that', 'these', 'those', 'with', 'from', 'by',
  'on', 'at', 'as', 'there', 'records', 'record', 'rows', 'row', 'entries', 'entry',
  'data', 'dataset', 'table', 'total', 'number', 'count', 'average', 'avg', 'sum',
  'minimum', 'min', 'maximum', 'max', 'highest', 'lowest', 'top', 'best', 'good',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
}

function singularize(token: string): string {
  if (token.endsWith('ies') && token.length > 4) return token.slice(0, -3) + 'y';
  if (token.endsWith('s') && token.length > 3) return token.slice(0, -1);
  return token;
}

function formatStatsSummary(col: ColumnProfile): string {
  if (col.type === 'INTEGER' || col.type === 'REAL') {
    const parts: string[] = [];
    if (col.minValue !== null && col.minValue !== undefined) parts.push(`min=${col.minValue}`);
    if (col.maxValue !== null && col.maxValue !== undefined) parts.push(`max=${col.maxValue}`);
    if (col.avgValue !== null && col.avgValue !== undefined) parts.push(`avg=${col.avgValue}`);
    parts.push(`distinct=${col.distinctCount}`);
    return parts.join(', ');
  }
  return `distinct=${col.distinctCount}, nulls=${col.nullCount}`;
}

export function retrieveDatabaseContext(
  question: string,
  dataset: DatasetMetadata,
  searchLiveDbValues = true
): RetrievedDatabaseContext {
  const rawTokens = tokenize(question);
  const queryTokens = Array.from(new Set(rawTokens.flatMap((t) => [t, singularize(t)])));

  const scoredColumns: RetrievedColumnContext[] = dataset.columns.map((col) => {
    let score = 0;
    const reasons: string[] = [];
    const matchedValues: Array<string | number> = [];

    const colNameLower = col.name.toLowerCase();
    const origLower = col.originalName.toLowerCase();
    const colParts = colNameLower.split('_').flatMap((p) => [p, singularize(p)]);

    // 1. Schema name matching
    for (const token of queryTokens) {
      if (colNameLower === token || origLower === token) {
        score += 10;
        reasons.push(`Exact column match "${token}"`);
      } else if (colParts.includes(token)) {
        score += 7;
        reasons.push(`Column token match "${token}"`);
      } else if (colNameLower.includes(token) || token.includes(colNameLower)) {
        score += 4;
        reasons.push(`Partial column match "${token}"`);
      }
    }

    // 2. DB Values matching (against top values and live SQLite LIKE lookup)
    for (const tv of col.topValues) {
      const valStr = String(tv.value).toLowerCase();
      for (const token of queryTokens) {
        if (valStr === token || valStr.includes(token)) {
          score += 8;
          if (!matchedValues.includes(tv.value)) matchedValues.push(tv.value);
          reasons.push(`Value match "${tv.value}"`);
        }
      }
    }

    if (searchLiveDbValues && col.type === 'TEXT' && queryTokens.length > 0) {
      for (const token of queryTokens) {
        if (token.length < 3) continue;
        try {
          const hits = sqliteEngine.searchColumnValues(dataset.tableName, col.name, token, 4);
          for (const hit of hits) {
            if (!matchedValues.includes(hit)) {
              matchedValues.push(hit);
              score += 7;
              reasons.push(`Live DB value match "${hit}"`);
            }
          }
        } catch {
          // Ignore live lookup issues in isolated unit tests without DB init
        }
      }
    }

    // 3. Preserve key identifier and numeric metric columns so ambiguity across metrics is visible
    if (col.name.endsWith('_id') || col.name.includes('name') || col.name === 'title') {
      score += 2;
      if (reasons.length === 0) reasons.push('Primary entity identifier');
    }
    if (col.type === 'INTEGER' || col.type === 'REAL') {
      score += 1.5;
      if (reasons.length === 0) reasons.push('Numeric metric / attribute');
    }
    if (col.distinctCount > 1 && col.distinctCount <= 12 && col.type === 'TEXT') {
      score += 1;
      if (reasons.length === 0) reasons.push('Low-cardinality categorical attribute');
    }

    const sampleValues = col.topValues.slice(0, 6).map((v) => v.value);

    return {
      name: col.name,
      type: col.type,
      relevanceScore: Number(score.toFixed(1)),
      relevanceReason: reasons.length > 0 ? Array.from(new Set(reasons)).slice(0, 3).join('; ') : 'Schema context',
      statsSummary: formatStatsSummary(col),
      matchedValues: matchedValues.slice(0, 5),
      sampleValues,
    };
  });

  scoredColumns.sort((a, b) => b.relevanceScore - a.relevanceScore);

  // For compact schemas (<= 16 cols), include all columns ranked by relevance so ambiguity and missing-column checks have full visibility;
  // for wide schemas (> 16 cols), select top 14 highest-scoring columns.
  const selectedColumns = dataset.columns.length <= 16 ? scoredColumns : scoredColumns.slice(0, 14);

  return {
    datasetId: dataset.id,
    datasetName: dataset.name,
    tableName: dataset.tableName,
    entityNoun: dataset.entityNoun,
    totalRowCount: dataset.rowCount,
    retrievedColumns: selectedColumns,
    allColumnNames: dataset.columns.map((c) => c.name),
    retrievalMethod:
      dataset.columns.length <= 16
        ? 'Ranked schema + live DB value probing (all columns retained for ambiguity visibility)'
        : 'Top-14 ranked schema + live DB value probing',
  };
}
