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

function stemVariants(token: string): string[] {
  const variants = new Set<string>([token]);
  if (token.endsWith('ies') && token.length > 4) variants.add(token.slice(0, -3) + 'y');
  if (token.endsWith('s') && token.length > 3) variants.add(token.slice(0, -1));
  if (token.endsWith('ed') && token.length > 4) {
    variants.add(token.slice(0, -2));
    variants.add(token.slice(0, -1));
  }
  if (token.endsWith('ing') && token.length > 5) {
    variants.add(token.slice(0, -3));
    variants.add(token.slice(0, -3) + 'e');
  }
  return Array.from(variants);
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
  const queryTokens = Array.from(new Set(rawTokens.flatMap((t) => stemVariants(t))));

  const scoredColumns: RetrievedColumnContext[] = dataset.columns.map((col) => {
    let score = 0;
    const reasons: string[] = [];
    const matchedValues: Array<string | number> = [];

    const colNameLower = col.name.toLowerCase();
    const origLower = col.originalName.toLowerCase();
    const colParts = colNameLower.split('_').flatMap((p) => stemVariants(p));

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

    // 3. Preserve key identifiers, summary metrics, and categorical outcomes across wide schemas
    if (col.name.endsWith('_id') || col.name.includes('name') || col.name === 'title') {
      score += 2;
      if (reasons.length === 0) reasons.push('Primary entity identifier');
    }
    if (
      /^(sgpa|cgpa|gpa|result|status|outcome|grade|rank|percentage|pct|score)$/i.test(colNameLower) ||
      colNameLower.startsWith('total_')
    ) {
      score += 2.5;
      if (reasons.length === 0) reasons.push('Overall summary / outcome attribute');
    }
    if (col.type === 'INTEGER' || col.type === 'REAL') {
      score += 1.5;
      if (reasons.length === 0) reasons.push('Numeric metric / attribute');
    }
    if (col.distinctCount >= 1 && col.distinctCount <= 12 && col.type === 'TEXT') {
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

  // For schemas up to 45 columns (including wide multi-subject sheets), retain all columns ranked by relevance
  // so ambiguity across metrics and summary columns like SGPA/result are fully visible; for ultra-wide schemas (> 45), select top 24.
  const selectedColumns = dataset.columns.length <= 45 ? scoredColumns : scoredColumns.slice(0, 24);

  return {
    datasetId: dataset.id,
    datasetName: dataset.name,
    tableName: dataset.tableName,
    entityNoun: dataset.entityNoun,
    totalRowCount: dataset.rowCount,
    retrievedColumns: selectedColumns,
    allColumnNames: dataset.columns.map((c) => c.name),
    retrievalMethod:
      dataset.columns.length <= 45
        ? 'Ranked schema + live DB value probing (all columns retained for ambiguity visibility)'
        : 'Top-24 ranked schema + live DB value probing',
  };
}
