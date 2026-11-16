export type SqlDataType = 'INTEGER' | 'REAL' | 'TEXT';

export interface ColumnProfile {
  name: string;
  originalName: string;
  type: SqlDataType;
  nullable: boolean;
  distinctCount: number;
  nullCount: number;
  minValue?: string | number | null;
  maxValue?: string | number | null;
  avgValue?: number | null;
  topValues: Array<{ value: string | number; count: number }>;
}

export interface DatasetMetadata {
  id: string;
  name: string;
  tableName: string;
  description: string;
  entityNoun: string;
  rowCount: number;
  columns: ColumnProfile[];
  isBuiltin: boolean;
  createdAt: string;
}

export interface RetrievedColumnContext {
  name: string;
  type: SqlDataType;
  relevanceScore: number;
  relevanceReason: string;
  statsSummary: string;
  matchedValues: Array<string | number>;
  sampleValues: Array<string | number>;
}

export interface RetrievedDatabaseContext {
  datasetId: string;
  datasetName: string;
  tableName: string;
  entityNoun: string;
  totalRowCount: number;
  retrievedColumns: RetrievedColumnContext[];
  allColumnNames: string[];
  retrievalMethod: string;
}

export type QueryClassification = 'CLEAR' | 'AMBIGUOUS' | 'OUT_OF_SCOPE' | 'UNANSWERABLE';

export type IntentQueryType =
  | 'dataset_count'
  | 'aggregation'
  | 'correlated_extremum'
  | 'ranking'
  | 'lookup_filter'
  | 'grouping'
  | 'unknown';

export interface StructuredIntent {
  classification: QueryClassification;
  queryType: IntentQueryType;
  reason: string;
  requestedOutputs: string[];
  metricColumns: string[];
  filterColumns: string[];
  orderByColumn?: string | null;
  orderDirection?: 'ASC' | 'DESC' | null;
  limit?: number | null;
  aggregationFunction?: 'COUNT' | 'AVG' | 'SUM' | 'MIN' | 'MAX' | null;
  missingConcepts: string[];
  ambiguityReasons: string[];
  clarificationQuestion?: string | null;
  clarificationOptions: string[];
}

export interface ValidationCheckItem {
  name: string;
  passed: boolean;
  detail: string;
}

export interface SqlValidationReport {
  valid: boolean;
  astValid: boolean;
  semanticValid: boolean;
  readOnlySafe: boolean;
  authorizedTablesOnly: boolean;
  authorizedColumnsOnly: boolean;
  checks: ValidationCheckItem[];
  errors: string[];
  normalizedSql: string;
}

export interface QueryExecutionResult {
  columns: string[];
  rows: Array<Record<string, string | number | null>>;
  rowCount: number;
  executionTimeMs: number;
  truncated: boolean;
}

export interface ClarificationHistoryItem {
  question: string;
  answer: string;
}

export interface PipelineResponse {
  sessionId: string;
  datasetId: string;
  originalQuestion: string;
  rewrittenQuestion?: string | null;
  status: 'COMPLETED' | 'NEEDS_CLARIFICATION' | 'REJECTED' | 'ERROR';
  classification: QueryClassification;
  retrievedContext: RetrievedDatabaseContext;
  intent: StructuredIntent;
  clarificationHistory: ClarificationHistoryItem[];
  sql?: string | null;
  repaired?: boolean;
  repairNotes?: string | null;
  validation?: SqlValidationReport | null;
  execution?: QueryExecutionResult | null;
  naturalLanguageAnswer: string;
  errorMessage?: string | null;
  latencyMs: number;
}

export interface RegressionTestResult {
  id: string;
  name: string;
  datasetId: string;
  question: string;
  followUpClarification?: string;
  expectedClassification: QueryClassification;
  actualClassification: QueryClassification;
  expectedStatus: PipelineResponse['status'];
  actualStatus: PipelineResponse['status'];
  generatedSql?: string | null;
  returnedValueSummary: string;
  passed: boolean;
  notes: string;
}

export interface ModelQuotaInfo {
  model: string;
  role: 'Primary' | 'Failover';
  observedCallsToday: number;
  freeTierDailyReference: number | null;
  exhausted: boolean;
  retryAtIso: string | null;
  lastError: string | null;
}

export interface QuotaStatusResponse {
  dateKey: string;
  activeModel: string | null;
  allExhausted: boolean;
  models: ModelQuotaInfo[];
  note: string;
}

