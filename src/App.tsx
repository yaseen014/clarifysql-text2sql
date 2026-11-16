import { useEffect, useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Database,
  Play,
  RotateCcw,
  Table2,
  Upload,
} from 'lucide-react';
import { DatasetExplorer } from './components/DatasetExplorer';
import { PipelineTurnCard } from './components/PipelineTurnCard';
import { QuickStartModal } from './components/QuickStartModal';
import { UploadModal } from './components/UploadModal';
import { VerificationSuite } from './components/VerificationSuite';
import type { DatasetMetadata, PipelineResponse, QuotaStatusResponse } from './types/text2sql';

type ActiveView = 'studio' | 'explorer' | 'verify';

const RECENT_QUERIES_STORAGE_KEY = 'clarifysql_recent_queries_v1';
const MAX_RECENT_QUERIES = 5;

function loadRecentQueries(): Record<string, string[]> {
  try {
    const raw = window.localStorage.getItem(RECENT_QUERIES_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const sanitized: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (Array.isArray(value)) {
        sanitized[key] = value
          .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
          .slice(0, MAX_RECENT_QUERIES);
      }
    }
    return sanitized;
  } catch {
    return {};
  }
}

function saveRecentQueries(map: Record<string, string[]>): void {
  try {
    window.localStorage.setItem(RECENT_QUERIES_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Ignore storage quota or private-mode restrictions
  }
}

function getStarterQuestions(dataset: DatasetMetadata | null): string[] {
  if (!dataset) return [];
  if (dataset.id === 'student_performance_data') {
    return [
      'What is the total number of records in Student Performance Data?',
      'What is the average age?',
      'What is the age of the student with the highest exam score?',
      'Who are the best students?',
      'Give me the name of five apples',
      'What is the average salary of students?',
    ];
  }
  if (dataset.id === 'ecommerce_orders') {
    return [
      'How many rows are in this dataset?',
      'What is the total order amount by region?',
      'Which orders are high value?',
      'What is the customer name for the highest order amount?',
      'List five varieties of bananas',
    ];
  }
  if (dataset.id === 'clinical_trials') {
    return [
      'Count all records.',
      'What is the average systolic blood pressure by treatment arm?',
      'Which patients showed good outcomes?',
      'What is the age of the patient with the highest outcome score?',
    ];
  }

  const numericCol = dataset.columns.find((c) => c.type === 'INTEGER' || c.type === 'REAL');
  const textCol = dataset.columns.find((c) => c.type === 'TEXT');
  const dynamicPrompts = [
    `What is the total number of records in ${dataset.name}?`,
  ];
  if (numericCol) {
    dynamicPrompts.push(`What is the average ${numericCol.name.replace(/_/g, ' ')}?`);
    dynamicPrompts.push(`Show the top 5 records by ${numericCol.name.replace(/_/g, ' ')}`);
  }
  if (textCol) {
    dynamicPrompts.push(`Count records grouped by ${textCol.name.replace(/_/g, ' ')}`);
  }
  return dynamicPrompts;
}

export default function App() {
  const [activeView, setActiveView] = useState<ActiveView>('studio');
  const [datasets, setDatasets] = useState<DatasetMetadata[]>([]);
  const [activeDatasetId, setActiveDatasetId] = useState<string>('student_performance_data');
  const [loadingDatasets, setLoadingDatasets] = useState(true);
  const [expandedCol, setExpandedCol] = useState<string | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [quickStartOpen, setQuickStartOpen] = useState(false);

  const [questionInput, setQuestionInput] = useState('');
  const [submittingQuery, setSubmittingQuery] = useState(false);
  const [clarifyingSessionId, setClarifyingSessionId] = useState<string | null>(null);
  const [turns, setTurns] = useState<PipelineResponse[]>([]);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [quotaStatus, setQuotaStatus] = useState<QuotaStatusResponse | null>(null);
  const [recentQueriesByDataset, setRecentQueriesByDataset] = useState<Record<string, string[]>>(() =>
    loadRecentQueries()
  );

  const recordSuccessfulQuery = (datasetId: string, question: string) => {
    const normalized = question.trim();
    if (!normalized) return;
    setRecentQueriesByDataset((prev) => {
      const existing = prev[datasetId] ?? [];
      const deduped = existing.filter(
        (item) => item.toLowerCase() !== normalized.toLowerCase()
      );
      const nextList = [normalized, ...deduped].slice(0, MAX_RECENT_QUERIES);
      const nextMap = { ...prev, [datasetId]: nextList };
      saveRecentQueries(nextMap);
      return nextMap;
    });
  };

  const clearRecentQueriesForDataset = (datasetId: string) => {
    setRecentQueriesByDataset((prev) => {
      const nextMap = { ...prev };
      delete nextMap[datasetId];
      saveRecentQueries(nextMap);
      return nextMap;
    });
  };

  const refreshQuota = () => {
    fetch('/api/quota')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data) setQuotaStatus(data as QuotaStatusResponse);
      })
      .catch(() => {
        // Non-fatal
      });
  };

  useEffect(() => {
    fetch('/api/datasets')
      .then((r) => r.json())
      .then((data) => {
        const list = (data.datasets ?? []) as DatasetMetadata[];
        setDatasets(list);
        if (list.length > 0 && !list.some((d) => d.id === activeDatasetId)) {
          setActiveDatasetId(list[0].id);
        }
      })
      .catch((err) => {
        setRequestError(err instanceof Error ? err.message : 'Failed to load datasets.');
      })
      .finally(() => setLoadingDatasets(false));

    refreshQuota();
  }, []);

  const activeDataset = useMemo(
    () => datasets.find((d) => d.id === activeDatasetId) ?? null,
    [datasets, activeDatasetId]
  );

  const starterQuestions = useMemo(() => getStarterQuestions(activeDataset), [activeDataset]);

  const recentQueries = useMemo(
    () => (activeDataset ? recentQueriesByDataset[activeDataset.id] ?? [] : []),
    [activeDataset, recentQueriesByDataset]
  );

  const submitQueryText = async (rawQuestion: string, datasetIdOverride?: string) => {
    const q = rawQuestion.trim();
    const targetDatasetId = datasetIdOverride ?? activeDataset?.id;
    if (!q || !targetDatasetId || submittingQuery) return;
    setActiveView('studio');
    setSubmittingQuery(true);
    setRequestError(null);

    try {
      const res = await fetch('/api/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ datasetId: targetDatasetId, question: q }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Query request failed.');
      }
      const pipelineResult = data as PipelineResponse;
      setTurns((prev) => [pipelineResult, ...prev]);
      setQuestionInput('');
      if (pipelineResult.status === 'COMPLETED') {
        recordSuccessfulQuery(pipelineResult.datasetId, pipelineResult.originalQuestion);
      }
    } catch (err) {
      setRequestError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmittingQuery(false);
      refreshQuota();
    }
  };

  const handleSubmitClarification = async (sessionId: string, answer: string) => {
    setClarifyingSessionId(sessionId);
    setRequestError(null);
    try {
      const res = await fetch('/api/query/clarify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, answer }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Clarification resume failed.');
      }
      const pipelineResult = data as PipelineResponse;
      setTurns((prev) =>
        prev.map((t) => (t.sessionId === sessionId ? pipelineResult : t))
      );
      if (pipelineResult.status === 'COMPLETED') {
        recordSuccessfulQuery(pipelineResult.datasetId, pipelineResult.originalQuestion);
      }
    } catch (err) {
      setRequestError(err instanceof Error ? err.message : String(err));
    } finally {
      setClarifyingSessionId(null);
      refreshQuota();
    }
  };

  const handleDatasetUploaded = (newDataset: DatasetMetadata) => {
    setDatasets((prev) => [...prev, newDataset]);
    setActiveDatasetId(newDataset.id);
    setActiveView('studio');
  };

  const handleLoadTourPrompt = (datasetId: string, question: string, autoRun: boolean) => {
    setActiveDatasetId(datasetId);
    setExpandedCol(null);
    setActiveView('studio');
    setQuestionInput(question);
    if (autoRun) {
      void submitQueryText(question, datasetId);
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900">
      {/* Top Bar Contract: 3 zones separated by gap-8 */}
      <header className="bg-white border-b border-slate-200 px-6 h-14 flex items-center justify-between gap-8 sticky top-0 z-30">
        <a
          href="#top"
          onClick={(e) => {
            e.preventDefault();
            setActiveView('studio');
          }}
          className="text-lg font-bold tracking-tight text-slate-900 font-display whitespace-nowrap shrink-0"
        >
          ClarifySQL
        </a>

        <nav className="flex items-center gap-6 text-sm font-medium">
          <button
            type="button"
            onClick={() => setActiveView('studio')}
            className={`py-4 border-b-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              activeView === 'studio'
                ? 'border-blue-600 text-slate-900'
                : 'border-transparent text-slate-500 hover:text-slate-900'
            }`}
          >
            Query Studio
          </button>
          <button
            type="button"
            onClick={() => setActiveView('explorer')}
            className={`py-4 border-b-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              activeView === 'explorer'
                ? 'border-blue-600 text-slate-900'
                : 'border-transparent text-slate-500 hover:text-slate-900'
            }`}
          >
            Dataset Explorer
          </button>
          <button
            type="button"
            onClick={() => setActiveView('verify')}
            className={`py-4 border-b-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              activeView === 'verify'
                ? 'border-blue-600 text-slate-900'
                : 'border-transparent text-slate-500 hover:text-slate-900'
            }`}
          >
            Verification Suite
          </button>
          <button
            type="button"
            onClick={() => setQuickStartOpen(true)}
            className="py-4 border-b-2 border-transparent text-slate-500 hover:text-slate-900 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            Quick Start
          </button>
        </nav>

        <div className="shrink-0">
          <button
            type="button"
            onClick={() => setUploadOpen(true)}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-md hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Upload className="w-3.5 h-3.5" />
            <span>Upload Dataset</span>
          </button>
        </div>
      </header>

      {/* Main Workspace */}
      <div className="flex-1 max-w-[1440px] w-full mx-auto flex flex-col lg:flex-row">
        {/* Left Sidebar: Dataset Selector & Active Schema */}
        <aside className="w-full lg:w-72 shrink-0 bg-white border-b lg:border-b-0 lg:border-r border-slate-200 p-5 space-y-6">
          <section className="space-y-2.5">
            <div className="flex items-center justify-between">
              <h2 className="text-xs font-semibold text-slate-500">Datasets</h2>
              <span className="text-xs text-slate-400 tabular-nums">{datasets.length}</span>
            </div>

            {loadingDatasets ? (
              <div className="space-y-2">
                <div className="h-12 bg-slate-100 rounded animate-pulse" />
                <div className="h-12 bg-slate-100 rounded animate-pulse" />
              </div>
            ) : (
              <div className="space-y-1">
                {datasets.map((ds) => {
                  const selected = ds.id === activeDatasetId;
                  return (
                    <button
                      key={ds.id}
                      type="button"
                      onClick={() => {
                        setActiveDatasetId(ds.id);
                        setExpandedCol(null);
                      }}
                      className={`w-full text-left px-3 py-2.5 rounded-md border transition-colors cursor-pointer ${
                        selected
                          ? 'bg-blue-50/70 border-blue-200 text-slate-900'
                          : 'bg-white border-transparent hover:bg-slate-50 text-slate-700'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <Database
                          className={`w-3.5 h-3.5 shrink-0 ${
                            selected ? 'text-blue-600' : 'text-slate-400'
                          }`}
                        />
                        <span className="text-xs font-semibold truncate">{ds.name}</span>
                      </div>
                      <div className="mt-1 pl-5.5 text-[11px] text-slate-500 tabular-nums">
                        {ds.rowCount} rows · {ds.columns.length} cols
                        {!ds.isBuiltin && ' · Uploaded'}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </section>

          {activeDataset && (
            <section className="space-y-2.5 pt-4 border-t border-slate-200">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-xs font-semibold text-slate-500">Recent Queries</h2>
                {recentQueries.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => clearRecentQueriesForDataset(activeDataset.id)}
                    className="text-[11px] font-medium text-slate-400 hover:text-slate-700 transition-colors cursor-pointer"
                  >
                    Clear
                  </button>
                ) : (
                  <span className="text-[11px] text-slate-400 tabular-nums">0 / 5</span>
                )}
              </div>

              {recentQueries.length === 0 ? (
                <p className="text-[11px] text-slate-500 leading-relaxed">
                  Your last 5 successful questions for {activeDataset.name} will appear here for one-click re-run.
                </p>
              ) : (
                <div className="space-y-1">
                  {recentQueries.map((query) => (
                    <button
                      key={query}
                      type="button"
                      disabled={submittingQuery}
                      onClick={() => submitQueryText(query)}
                      title={`Re-run: ${query}`}
                      className="w-full text-left px-2.5 py-2 rounded-md border border-slate-200 bg-slate-50/70 hover:bg-blue-50/60 hover:border-blue-200 text-xs text-slate-700 hover:text-slate-900 transition-colors flex items-start justify-between gap-2 cursor-pointer disabled:opacity-50"
                    >
                      <span className="line-clamp-2 leading-snug">{query}</span>
                      <Play className="w-3 h-3 text-slate-400 shrink-0 mt-0.5" />
                    </button>
                  ))}
                </div>
              )}
            </section>
          )}

          {activeDataset && (
            <section className="space-y-2.5 pt-4 border-t border-slate-200">
              <div className="flex items-center justify-between">
                <h2 className="text-xs font-semibold text-slate-500">Active Schema</h2>
                <span className="font-mono text-[11px] text-slate-400 truncate max-w-[140px]">
                  {activeDataset.tableName}
                </span>
              </div>

              <div className="divide-y divide-slate-100 border border-slate-200 rounded-md bg-white">
                {activeDataset.columns.map((col) => {
                  const isOpen = expandedCol === col.name;
                  return (
                    <div key={col.name} className="text-xs">
                      <button
                        type="button"
                        onClick={() => setExpandedCol(isOpen ? null : col.name)}
                        className="w-full px-3 py-2 flex items-center justify-between gap-2 hover:bg-slate-50 text-left cursor-pointer"
                      >
                        <div className="flex items-center gap-1.5 min-w-0">
                          {isOpen ? (
                            <ChevronDown className="w-3 h-3 text-slate-400 shrink-0" />
                          ) : (
                            <ChevronRight className="w-3 h-3 text-slate-400 shrink-0" />
                          )}
                          <span className="font-mono text-slate-800 truncate">{col.name}</span>
                        </div>
                        <span className="font-mono text-[10px] text-slate-400 shrink-0">
                          {col.type}
                        </span>
                      </button>

                      {isOpen && (
                        <div className="px-3 pb-2.5 pt-1 bg-slate-50/70 space-y-1 text-[11px] text-slate-600">
                          <div className="font-mono tabular-nums">
                            distinct: {col.distinctCount} · nulls: {col.nullCount}
                          </div>
                          {(col.type === 'INTEGER' || col.type === 'REAL') && (
                            <div className="font-mono tabular-nums">
                              min: {col.minValue} · max: {col.maxValue}
                              {col.avgValue != null ? ` · avg: ${col.avgValue}` : ''}
                            </div>
                          )}
                          {col.topValues.length > 0 && (
                            <div className="text-slate-500">
                              Samples: {col.topValues.slice(0, 4).map((v) => v.value).join(', ')}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {quotaStatus && (
            <section className="space-y-2.5 pt-4 border-t border-slate-200">
              <div className="flex items-center justify-between">
                <h2 className="text-xs font-semibold text-slate-500">Model Usage Today</h2>
                <span className="font-mono text-[11px] text-slate-400 tabular-nums">
                  {quotaStatus.dateKey}
                </span>
              </div>

              <div className="space-y-2 text-xs">
                {quotaStatus.models.map((m) => {
                  const isActive = quotaStatus.activeModel === m.model;
                  return (
                    <div
                      key={m.model}
                      className="px-3 py-2 border border-slate-200 rounded-md bg-slate-50/60 space-y-1"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-[11px] font-medium text-slate-800 truncate">
                          {m.model}
                        </span>
                        <span
                          className={`text-[11px] font-medium whitespace-nowrap ${
                            m.exhausted
                              ? 'text-rose-700'
                              : isActive
                              ? 'text-emerald-700'
                              : 'text-slate-500'
                          }`}
                        >
                          {m.exhausted ? 'Quota Reached' : isActive ? 'Active' : 'Standby'}
                        </span>
                      </div>
                      <div className="flex items-center justify-between text-[11px] text-slate-500 tabular-nums">
                        <span>{m.role}</span>
                        <span className="font-mono">
                          {m.freeTierDailyReference != null
                            ? `${m.observedCallsToday} / ${m.freeTierDailyReference} app calls`
                            : `${m.observedCallsToday} app calls`}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>

              <p className="text-[11px] text-slate-500 leading-relaxed">
                Tracks calls sent by this app today (1–2 calls per question). Account-wide quota is managed in Google AI Studio (<span className="font-mono">ai.dev/rate-limit</span>).
              </p>
            </section>
          )}
        </aside>

        {/* Main Viewport */}
        <main className="flex-1 min-w-0 p-6 lg:p-8">
          {activeView === 'explorer' && <DatasetExplorer dataset={activeDataset} />}

          {activeView === 'verify' && <VerificationSuite />}

          {activeView === 'studio' && (
            <div className="max-w-4xl mx-auto space-y-6">
              {/* Active Dataset Summary + Input */}
              <section className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <h1 className="text-xl font-semibold text-slate-900">
                      Database-Aware Text-to-SQL Studio
                    </h1>
                    {activeDataset && (
                      <p className="text-xs text-slate-500 mt-1">
                        Querying <span className="font-medium text-slate-800">{activeDataset.name}</span>
                        <span className="mx-1.5" aria-hidden="true">·</span>
                        <span className="tabular-nums">{activeDataset.rowCount} records</span>
                        <span className="mx-1.5" aria-hidden="true">·</span>
                        <span className="tabular-nums">{activeDataset.columns.length} columns</span>
                        <span className="mx-1.5" aria-hidden="true">·</span>
                        <span>Read-only SQLite execution</span>
                      </p>
                    )}
                  </div>

                  {turns.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setTurns([])}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-600 hover:text-slate-900 border border-slate-200 rounded-md self-start cursor-pointer"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      <span>Clear Thread</span>
                    </button>
                  )}
                </div>

                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    submitQueryText(questionInput);
                  }}
                  className="flex flex-col sm:flex-row gap-2.5"
                >
                  <input
                    type="text"
                    value={questionInput}
                    onChange={(e) => setQuestionInput(e.target.value)}
                    placeholder={
                      activeDataset
                        ? `Ask a natural-language question about ${activeDataset.name}...`
                        : 'Select a dataset first...'
                    }
                    disabled={!activeDataset || submittingQuery}
                    className="flex-1 min-w-0 px-3.5 py-2.5 text-sm bg-slate-50 border border-slate-300 rounded-md text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-600 focus:bg-white"
                  />
                  <button
                    type="submit"
                    disabled={!activeDataset || !questionInput.trim() || submittingQuery}
                    className="inline-flex items-center justify-center gap-2 px-5 py-2.5 text-xs font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <Play className="w-3.5 h-3.5" />
                    <span>{submittingQuery ? 'Analyzing...' : 'Run Query'}</span>
                  </button>
                </form>

                {starterQuestions.length > 0 && (
                  <div className="space-y-1.5">
                    <div className="text-xs text-slate-500">Sample queries for {activeDataset?.name}:</div>
                    <div className="flex flex-wrap gap-1.5">
                      {starterQuestions.map((sample) => (
                        <button
                          key={sample}
                          type="button"
                          disabled={submittingQuery}
                          onClick={() => submitQueryText(sample)}
                          className="px-2.5 py-1.5 text-xs text-slate-700 bg-slate-100 hover:bg-slate-200/80 hover:text-slate-900 rounded-md transition-colors text-left cursor-pointer disabled:opacity-50"
                        >
                          {sample}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </section>

              {requestError && (
                <div className="p-4 bg-rose-50 border border-rose-200 rounded-md text-xs text-rose-800">
                  {requestError}
                </div>
              )}

              {submittingQuery && (
                <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-3">
                  <div className="text-xs font-medium text-slate-600">
                    Retrieving schema and database values, detecting ambiguity, and validating SQL...
                  </div>
                  <div className="h-4 bg-slate-100 rounded w-3/4 animate-pulse" />
                  <div className="h-16 bg-slate-100 rounded animate-pulse" />
                </div>
              )}

              {turns.length === 0 && !submittingQuery && (
                <div className="bg-white border border-slate-200 rounded-lg p-8 space-y-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex items-center gap-2.5 text-slate-800">
                      <Table2 className="w-5 h-5 text-blue-600" />
                      <h2 className="text-sm font-semibold">How the Database-Aware Clarification Pipeline Works</h2>
                    </div>
                    <button
                      type="button"
                      onClick={() => setQuickStartOpen(true)}
                      className="px-3 py-1.5 text-xs font-medium text-blue-700 bg-blue-50 border border-blue-200 rounded-md hover:bg-blue-100/70 transition-colors self-start sm:self-auto whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      Open Quick Start Tour
                    </button>
                  </div>
                  <ol className="grid grid-cols-1 md:grid-cols-5 gap-3 text-xs">
                    <li className="p-3 bg-slate-50 border border-slate-200/80 rounded-md space-y-1">
                      <div className="font-semibold text-slate-900">1. Context Retrieval</div>
                      <p className="text-slate-600 leading-relaxed">
                        Retrieves relevant schema columns, statistics, and matching database values.
                      </p>
                    </li>
                    <li className="p-3 bg-slate-50 border border-slate-200/80 rounded-md space-y-1">
                      <div className="font-semibold text-slate-900">2. Ambiguity Check</div>
                      <p className="text-slate-600 leading-relaxed">
                        Distinguishes clear queries, dataset counts, vague terms, and out-of-scope requests.
                      </p>
                    </li>
                    <li className="p-3 bg-slate-50 border border-slate-200/80 rounded-md space-y-1">
                      <div className="font-semibold text-slate-900">3. Clarification</div>
                      <p className="text-slate-600 leading-relaxed">
                        Asks targeted follow-up questions and rewrites intent before SQL generation.
                      </p>
                    </li>
                    <li className="p-3 bg-slate-50 border border-slate-200/80 rounded-md space-y-1">
                      <div className="font-semibold text-slate-900">4. AST Validation</div>
                      <p className="text-slate-600 leading-relaxed">
                        Verifies read-only safety, table authorization, and semantic intent alignment.
                      </p>
                    </li>
                    <li className="p-3 bg-slate-50 border border-slate-200/80 rounded-md space-y-1">
                      <div className="font-semibold text-slate-900">5. Safe Execution</div>
                      <p className="text-slate-600 leading-relaxed">
                        Runs read-only SQLite queries and summarizes verified rows in plain language.
                      </p>
                    </li>
                  </ol>
                </div>
              )}

              <div className="space-y-5">
                {turns.map((turn) => (
                  <PipelineTurnCard
                    key={turn.sessionId}
                    turn={turn}
                    isSubmittingClarification={clarifyingSessionId === turn.sessionId}
                    onSubmitClarification={handleSubmitClarification}
                  />
                ))}
              </div>
            </div>
          )}
        </main>
      </div>

      <UploadModal
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        onUploaded={handleDatasetUploaded}
      />

      <QuickStartModal
        open={quickStartOpen}
        onClose={() => setQuickStartOpen(false)}
        onOpenUpload={() => setUploadOpen(true)}
        onLoadPrompt={handleLoadTourPrompt}
        onOpenVerification={() => setActiveView('verify')}
      />
    </div>
  );
}
