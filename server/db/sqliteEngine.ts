import initSqlJs, { Database, SqlValue } from 'sql.js';
import * as XLSX from 'xlsx';
import { BUILTIN_DATASETS } from './datasets';
import type {
  ColumnProfile,
  DatasetMetadata,
  QueryExecutionResult,
  SqlDataType,
} from '../../src/types/text2sql';

const MAX_EXECUTION_ROWS = 500;

function sanitizeIdentifier(raw: string, fallbackPrefix: string, index: number): string {
  if (/^__EMPTY(?:_\d+)?$/i.test(raw.trim())) {
    return `${fallbackPrefix}_${index + 1}`;
  }
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!cleaned) {
    return `${fallbackPrefix}_${index + 1}`;
  }
  if (/^[0-9]/.test(cleaned)) {
    return `${fallbackPrefix}_${cleaned}`;
  }
  const reserved = new Set(['select', 'from', 'where', 'group', 'order', 'table', 'index', 'limit', 'join', 'on', 'as', 'null', 'true', 'false']);
  if (reserved.has(cleaned)) {
    return `${cleaned}_col`;
  }
  return cleaned;
}

function filterNonEmptyRows(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return rows.filter((row) =>
    Object.values(row).some((v) => v !== null && v !== undefined && String(v).trim() !== '')
  );
}

function normalizeCellValue(val: unknown): string | number | null {
  if (val === undefined || val === null) return null;
  if (typeof val === 'number') {
    return Number.isFinite(val) ? val : null;
  }
  if (typeof val === 'boolean') {
    return val ? 1 : 0;
  }
  if (val instanceof Date) {
    return val.toISOString().slice(0, 10);
  }
  const str = String(val).trim();
  if (str === '' || str.toLowerCase() === 'null' || str.toLowerCase() === 'n/a' || str.toLowerCase() === 'na') {
    return null;
  }
  if (/^-?\d+$/.test(str)) {
    const parsed = Number(str);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  if (/^-?\d+\.\d+$/.test(str)) {
    const parsed = Number(str);
    if (Number.isFinite(parsed)) return parsed;
  }
  return str;
}

function inferColumnType(values: Array<string | number | null>): SqlDataType {
  const nonNull = values.filter((v): v is string | number => v !== null);
  if (nonNull.length === 0) return 'TEXT';

  let allInt = true;
  let allNum = true;
  for (const v of nonNull) {
    if (typeof v === 'number') {
      if (!Number.isInteger(v)) allInt = false;
    } else {
      allInt = false;
      allNum = false;
      break;
    }
  }
  if (allInt) return 'INTEGER';
  if (allNum) return 'REAL';
  return 'TEXT';
}

function inferEntityNoun(datasetName: string, columns: ColumnProfile[]): string {
  const lowerName = datasetName.toLowerCase();
  if (lowerName.includes('student')) return 'student';
  if (lowerName.includes('order')) return 'order';
  if (lowerName.includes('patient') || lowerName.includes('clinical')) return 'patient';
  if (lowerName.includes('employee') || lowerName.includes('staff')) return 'employee';
  if (lowerName.includes('product')) return 'product';
  if (lowerName.includes('customer')) return 'customer';

  for (const col of columns) {
    if (col.name.endsWith('_id')) {
      return col.name.slice(0, -3).replace(/_/g, ' ');
    }
  }
  return 'record';
}

export class SqliteDatasetEngine {
  private db!: Database;
  private datasets = new Map<string, DatasetMetadata>();
  private initialized = false;

  async init(): Promise<void> {
    if (this.initialized) return;
    const SQL = await initSqlJs();
    this.db = new SQL.Database();

    for (const seed of BUILTIN_DATASETS) {
      this.registerTableFromRows({
        id: seed.id,
        name: seed.name,
        tableName: seed.tableName,
        description: seed.description,
        entityNoun: seed.entityNoun,
        rows: seed.rows,
        isBuiltin: true,
      });
    }

    this.initialized = true;
  }

  private registerTableFromRows(params: {
    id: string;
    name: string;
    tableName: string;
    description: string;
    entityNoun?: string;
    rows: Array<Record<string, unknown>>;
    isBuiltin: boolean;
  }): DatasetMetadata {
    const { id, name, tableName, description, rows, isBuiltin } = params;
    if (!rows || rows.length === 0) {
      throw new Error('Dataset contains no rows.');
    }

    const rawHeaders = Array.from(
      rows.reduce((set, row) => {
        Object.keys(row).forEach((k) => set.add(k));
        return set;
      }, new Set<string>())
    );

    if (rawHeaders.length === 0) {
      throw new Error('Dataset contains no columns.');
    }

    const usedColNames = new Set<string>();
    const columnMappings: Array<{ original: string; sqlName: string; type: SqlDataType; values: Array<string | number | null> }> = [];

    rawHeaders.forEach((orig, idx) => {
      let candidate = sanitizeIdentifier(orig, 'col', idx);
      while (usedColNames.has(candidate)) {
        candidate = `${candidate}_${idx + 1}`;
      }
      usedColNames.add(candidate);

      const normalizedValues = rows.map((r) => normalizeCellValue(r[orig]));
      const inferredType = inferColumnType(normalizedValues);
      columnMappings.push({
        original: orig,
        sqlName: candidate,
        type: inferredType,
        values: normalizedValues,
      });
    });

    // Drop existing table if re-importing same id
    this.db.run(`DROP TABLE IF EXISTS "${tableName}"`);

    const colDefs = columnMappings.map((c) => `"${c.sqlName}" ${c.type}`).join(', ');
    this.db.run(`CREATE TABLE "${tableName}" (${colDefs})`);

    const placeholders = columnMappings.map(() => '?').join(', ');
    const insertSql = `INSERT INTO "${tableName}" (${columnMappings.map((c) => `"${c.sqlName}"`).join(', ')}) VALUES (${placeholders})`;

    this.db.run('BEGIN TRANSACTION');
    const stmt = this.db.prepare(insertSql);
    try {
      for (let r = 0; r < rows.length; r++) {
        const bindValues: SqlValue[] = columnMappings.map((c) => c.values[r]);
        stmt.run(bindValues);
      }
      this.db.run('COMMIT');
    } catch (err) {
      this.db.run('ROLLBACK');
      throw err;
    } finally {
      stmt.free();
    }

    const profiles = this.profileTableColumns(tableName, columnMappings);
    const meta: DatasetMetadata = {
      id,
      name,
      tableName,
      description,
      entityNoun: params.entityNoun || inferEntityNoun(name, profiles),
      rowCount: rows.length,
      columns: profiles,
      isBuiltin,
      createdAt: new Date().toISOString(),
    };
    this.datasets.set(id, meta);
    return meta;
  }

  private profileTableColumns(
    tableName: string,
    mappings: Array<{ original: string; sqlName: string; type: SqlDataType }>
  ): ColumnProfile[] {
    return mappings.map((col) => {
      const statsRes = this.db.exec(
        `SELECT COUNT(*) AS total_cnt,
                COUNT("${col.sqlName}") AS non_null_cnt,
                COUNT(DISTINCT "${col.sqlName}") AS distinct_cnt,
                MIN("${col.sqlName}") AS min_val,
                MAX("${col.sqlName}") AS max_val
         FROM "${tableName}"`
      );
      const row = statsRes[0]?.values[0] ?? [0, 0, 0, null, null];
      const totalCnt = Number(row[0] ?? 0);
      const nonNullCnt = Number(row[1] ?? 0);
      const distinctCnt = Number(row[2] ?? 0);
      const minVal = (row[3] as string | number | null) ?? null;
      const maxVal = (row[4] as string | number | null) ?? null;

      let avgValue: number | null = null;
      if (col.type === 'INTEGER' || col.type === 'REAL') {
        const avgRes = this.db.exec(`SELECT AVG("${col.sqlName}") FROM "${tableName}"`);
        const rawAvg = avgRes[0]?.values[0]?.[0];
        if (typeof rawAvg === 'number' && Number.isFinite(rawAvg)) {
          avgValue = Number(rawAvg.toFixed(2));
        }
      }

      const topRes = this.db.exec(
        `SELECT "${col.sqlName}" AS val, COUNT(*) AS cnt
         FROM "${tableName}"
         WHERE "${col.sqlName}" IS NOT NULL
         GROUP BY "${col.sqlName}"
         ORDER BY cnt DESC, val ASC
         LIMIT 8`
      );
      const topValues = (topRes[0]?.values ?? []).map((v) => ({
        value: v[0] as string | number,
        count: Number(v[1]),
      }));

      return {
        name: col.sqlName,
        originalName: col.original,
        type: col.type,
        nullable: totalCnt !== nonNullCnt,
        distinctCount: distinctCnt,
        nullCount: totalCnt - nonNullCnt,
        minValue: minVal,
        maxValue: maxVal,
        avgValue,
        topValues,
      };
    });
  }

  importParsedRows(
    fileName: string,
    rawRows: Array<Record<string, unknown>>,
    sheetName?: string
  ): DatasetMetadata {
    const rows = filterNonEmptyRows(rawRows);
    if (rows.length === 0) {
      throw new Error('Uploaded dataset is empty. Provide at least 1 non-empty data row and a header row.');
    }

    const rawBaseName = fileName.replace(/\.(csv|tsv|xlsx|xls)$/i, '').trim() || 'Uploaded Dataset';
    const baseName = sheetName && sheetName !== 'Sheet1' ? `${rawBaseName} (${sheetName})` : rawBaseName;
    const baseSlug = sanitizeIdentifier(rawBaseName, 'dataset', this.datasets.size);
    let uniqueId = baseSlug;
    let counter = 2;
    while (this.datasets.has(uniqueId)) {
      uniqueId = `${baseSlug}_${counter++}`;
    }

    return this.registerTableFromRows({
      id: uniqueId,
      name: baseName,
      tableName: uniqueId,
      description: `Uploaded dataset from ${fileName}${sheetName ? ` [sheet: ${sheetName}]` : ''} (${rows.length} rows).`,
      rows,
      isBuiltin: false,
    });
  }

  importUploadedFile(fileName: string, buffer: Buffer, preferredSheetName?: string): DatasetMetadata {
    const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
    if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
      throw new Error('Uploaded file has no readable sheets.');
    }

    const sheetsToTry = preferredSheetName && workbook.SheetNames.includes(preferredSheetName)
      ? [preferredSheetName]
      : workbook.SheetNames;

    let selectedSheetName: string | undefined;
    let selectedRows: Array<Record<string, unknown>> = [];

    for (const candidateName of sheetsToTry) {
      const sheet = workbook.Sheets[candidateName];
      if (!sheet) continue;
      const parsed = filterNonEmptyRows(
        XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: null, raw: true })
      );
      if (parsed.length > 0) {
        selectedSheetName = candidateName;
        selectedRows = parsed;
        break;
      }
    }

    if (!selectedSheetName || selectedRows.length === 0) {
      throw new Error('Uploaded dataset is empty. Provide at least 1 data row and a header row.');
    }

    return this.importParsedRows(
      fileName,
      selectedRows,
      workbook.SheetNames.length > 1 ? selectedSheetName : undefined
    );
  }

  listDatasets(): DatasetMetadata[] {
    return Array.from(this.datasets.values());
  }

  getDataset(datasetId: string): DatasetMetadata | undefined {
    return this.datasets.get(datasetId);
  }

  getPreviewRows(datasetId: string, limit = 100, offset = 0): {
    columns: string[];
    rows: Array<Record<string, string | number | null>>;
    totalRows: number;
  } {
    const meta = this.datasets.get(datasetId);
    if (!meta) {
      throw new Error(`Dataset not found: ${datasetId}`);
    }
    const safeLimit = Math.max(1, Math.min(200, limit));
    const safeOffset = Math.max(0, offset);
    const execResult = this.executeReadOnlyQuery(
      meta.tableName,
      `SELECT * FROM "${meta.tableName}" LIMIT ${safeLimit} OFFSET ${safeOffset}`
    );
    return {
      columns: execResult.columns,
      rows: execResult.rows,
      totalRows: meta.rowCount,
    };
  }

  searchColumnValues(tableName: string, columnName: string, searchToken: string, limit = 5): Array<string | number> {
    const stmt = this.db.prepare(
      `SELECT DISTINCT "${columnName}" AS val
       FROM "${tableName}"
       WHERE LOWER(CAST("${columnName}" AS TEXT)) LIKE ?
       LIMIT ?`
    );
    const results: Array<string | number> = [];
    try {
      stmt.bind([`%${searchToken.toLowerCase()}%`, limit]);
      while (stmt.step()) {
        const row = stmt.getAsObject();
        if (row.val !== null && row.val !== undefined) {
          results.push(row.val as string | number);
        }
      }
    } finally {
      stmt.free();
    }
    return results;
  }

  executeReadOnlyQuery(authorizedTableName: string, sql: string): QueryExecutionResult {
    const meta = Array.from(this.datasets.values()).find((d) => d.tableName === authorizedTableName);
    if (!meta) {
      throw new Error(`Unauthorized table access: ${authorizedTableName}`);
    }

    const start = performance.now();
    // Enforce read-only mode during query execution
    this.db.run('PRAGMA query_only = ON');
    try {
      const results = this.db.exec(sql);
      const elapsed = Number((performance.now() - start).toFixed(2));

      if (!results || results.length === 0) {
        return {
          columns: [],
          rows: [],
          rowCount: 0,
          executionTimeMs: elapsed,
          truncated: false,
        };
      }

      const firstSet = results[0];
      const columns = firstSet.columns;
      const truncated = firstSet.values.length > MAX_EXECUTION_ROWS;
      const sliced = firstSet.values.slice(0, MAX_EXECUTION_ROWS);

      const rows = sliced.map((vals) => {
        const record: Record<string, string | number | null> = {};
        columns.forEach((colName, idx) => {
          const val = vals[idx];
          record[colName] = val === undefined ? null : (val as string | number | null);
        });
        return record;
      });

      return {
        columns,
        rows,
        rowCount: rows.length,
        executionTimeMs: elapsed,
        truncated,
      };
    } finally {
      this.db.run('PRAGMA query_only = OFF');
    }
  }
}

export const sqliteEngine = new SqliteDatasetEngine();
