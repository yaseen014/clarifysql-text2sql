import { useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  Database,
  Download,
  HelpCircle,
  Send,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import type { PipelineResponse } from '../types/text2sql';

interface PipelineTurnCardProps {
  turn: PipelineResponse;
  isSubmittingClarification: boolean;
  onSubmitClarification: (sessionId: string, answer: string) => void;
}

const CLASSIFICATION_STYLES: Record<
  PipelineResponse['classification'],
  { label: string; colorClass: string; icon: typeof CheckCircle2 }
> = {
  CLEAR: {
    label: 'Clear Intent',
    colorClass: 'text-emerald-700 bg-emerald-50 border-emerald-200',
    icon: CheckCircle2,
  },
  AMBIGUOUS: {
    label: 'Ambiguous — Clarification Required',
    colorClass: 'text-amber-700 bg-amber-50 border-amber-200',
    icon: HelpCircle,
  },
  OUT_OF_SCOPE: {
    label: 'Out of Scope',
    colorClass: 'text-rose-700 bg-rose-50 border-rose-200',
    icon: XCircle,
  },
  UNANSWERABLE: {
    label: 'Unanswerable from Schema',
    colorClass: 'text-rose-700 bg-rose-50 border-rose-200',
    icon: AlertTriangle,
  },
};

export function PipelineTurnCard({
  turn,
  isSubmittingClarification,
  onSubmitClarification,
}: PipelineTurnCardProps) {
  const [showContext, setShowContext] = useState(false);
  const [showValidation, setShowValidation] = useState(false);
  const [customClarification, setCustomClarification] = useState('');
  const [copiedSql, setCopiedSql] = useState(false);

  const badge = CLASSIFICATION_STYLES[turn.classification] ?? CLASSIFICATION_STYLES.CLEAR;
  const StatusIcon = badge.icon;

  const handleCopySql = async () => {
    if (!turn.sql) return;
    await navigator.clipboard.writeText(turn.sql);
    setCopiedSql(true);
    setTimeout(() => setCopiedSql(false), 1800);
  };

  const handleDownloadCsv = () => {
    if (!turn.execution || turn.execution.rows.length === 0) return;
    const cols = turn.execution.columns;
    const escapeCell = (val: unknown) => {
      const str = val === null || val === undefined ? '' : String(val);
      return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
    };
    const csv = [
      cols.map(escapeCell).join(','),
      ...turn.execution.rows.map((r) => cols.map((c) => escapeCell(r[c])).join(',')),
    ].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${turn.datasetId}_query_result.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const handleCustomSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!customClarification.trim() || isSubmittingClarification) return;
    onSubmitClarification(turn.sessionId, customClarification.trim());
    setCustomClarification('');
  };

  return (
    <article className="bg-white border border-slate-200 rounded-lg divide-y divide-slate-200">
      {/* Question & Status Header */}
      <div className="p-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1.5 min-w-0">
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <span>User Question</span>
            <span aria-hidden="true">·</span>
            <span>{turn.retrievedContext.datasetName}</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono tabular-nums">{turn.latencyMs} ms</span>
          </div>
          <h3 className="text-base font-semibold text-slate-900 leading-snug">
            {turn.originalQuestion}
          </h3>
        </div>
        <div
          className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-xs font-medium whitespace-nowrap shrink-0 ${badge.colorClass}`}
        >
          <StatusIcon className="w-3.5 h-3.5 shrink-0" />
          <span>{badge.label}</span>
        </div>
      </div>

      {/* Stage 1 & 2: Retrieved Database Context + Intent Breakdown */}
      <div className="px-5 py-3.5 bg-slate-50/60 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => setShowContext((v) => !v)}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-700 hover:text-slate-900 transition-colors cursor-pointer"
          >
            {showContext ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
            <Database className="w-3.5 h-3.5 text-slate-500" />
            <span>
              Retrieved Database Context ({turn.retrievedContext.retrievedColumns.length} columns ·{' '}
              <span className="tabular-nums">{turn.retrievedContext.totalRowCount}</span> rows)
            </span>
          </button>

          <div className="flex items-center gap-2 text-xs text-slate-500">
            <span>Intent:</span>
            <span className="font-mono text-slate-800">{turn.intent.queryType}</span>
            {turn.intent.aggregationFunction && (
              <>
                <span aria-hidden="true">·</span>
                <span className="font-mono text-slate-800">{turn.intent.aggregationFunction}</span>
              </>
            )}
            {turn.intent.limit != null && (
              <>
                <span aria-hidden="true">·</span>
                <span className="font-mono text-slate-800 tabular-nums">LIMIT {turn.intent.limit}</span>
              </>
            )}
          </div>
        </div>

        {turn.intent.reason && (
          <p className="text-xs text-slate-600 leading-relaxed">{turn.intent.reason}</p>
        )}

        {showContext && (
          <div className="pt-2 border-t border-slate-200 overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-200 text-slate-500">
                  <th className="py-1.5 pr-3 font-medium">Column</th>
                  <th className="py-1.5 pr-3 font-medium">Type</th>
                  <th className="py-1.5 pr-3 font-medium text-right">Score</th>
                  <th className="py-1.5 pr-3 font-medium">Profile & Sample DB Values</th>
                  <th className="py-1.5 font-medium">Matched Values</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {turn.retrievedContext.retrievedColumns.map((col) => (
                  <tr key={col.name}>
                    <td className="py-1.5 pr-3 font-mono text-slate-900 whitespace-nowrap">{col.name}</td>
                    <td className="py-1.5 pr-3 font-mono text-slate-500 whitespace-nowrap">{col.type}</td>
                    <td className="py-1.5 pr-3 font-mono tabular-nums text-right text-slate-700">
                      {col.relevanceScore.toFixed(1)}
                    </td>
                    <td className="py-1.5 pr-3 text-slate-600">
                      <span className="font-mono text-[11px] text-slate-500">{col.statsSummary}</span>
                      {col.sampleValues.length > 0 && (
                        <span className="ml-2 text-slate-700">
                          [{col.sampleValues.slice(0, 4).join(', ')}]
                        </span>
                      )}
                    </td>
                    <td className="py-1.5 text-blue-700 font-mono text-[11px]">
                      {col.matchedValues.length > 0 ? col.matchedValues.join(', ') : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Stage 3: Clarification History & Rewritten Query OR Interactive Clarification Prompt */}
      {(turn.clarificationHistory.length > 0 || turn.status === 'NEEDS_CLARIFICATION') && (
        <div className="p-5 space-y-4 bg-amber-50/35">
          {turn.clarificationHistory.map((item, idx) => (
            <div key={idx} className="space-y-1 text-sm">
              <div className="text-xs font-medium text-slate-500">
                Clarification Round {idx + 1}
              </div>
              <p className="text-slate-800 font-medium">{item.question}</p>
              <p className="text-slate-700">
                <span className="text-xs text-slate-500 mr-2">Your Answer:</span>
                {item.answer}
              </p>
            </div>
          ))}

          {turn.rewrittenQuestion && (
            <div className="pt-2 border-t border-amber-200/70 space-y-1">
              <div className="text-xs font-medium text-slate-500">Rewritten Database-Aware Query</div>
              <p className="text-sm font-medium text-slate-900">{turn.rewrittenQuestion}</p>
            </div>
          )}

          {turn.status === 'NEEDS_CLARIFICATION' && (
            <div className="space-y-3">
              <div className="space-y-1">
                <div className="text-xs font-medium text-amber-800">Clarification Question</div>
                <p className="text-sm font-semibold text-slate-900">{turn.naturalLanguageAnswer}</p>
                {turn.intent.ambiguityReasons.length > 0 && (
                  <ul className="text-xs text-slate-600 list-disc pl-4 space-y-0.5 pt-1">
                    {turn.intent.ambiguityReasons.map((reason, i) => (
                      <li key={i}>{reason}</li>
                    ))}
                  </ul>
                )}
              </div>

              {turn.intent.clarificationOptions.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {turn.intent.clarificationOptions.map((option) => (
                    <button
                      key={option}
                      type="button"
                      disabled={isSubmittingClarification}
                      onClick={() => onSubmitClarification(turn.sessionId, option)}
                      className="px-3 py-2 text-xs font-medium text-slate-800 bg-white border border-slate-300 rounded-md hover:border-blue-500 hover:text-blue-700 transition-colors cursor-pointer disabled:opacity-50"
                    >
                      {option}
                    </button>
                  ))}
                </div>
              )}

              <form onSubmit={handleCustomSubmit} className="flex gap-2">
                <input
                  type="text"
                  value={customClarification}
                  onChange={(e) => setCustomClarification(e.target.value)}
                  disabled={isSubmittingClarification}
                  placeholder="Or enter a specific column, metric, or filter threshold..."
                  className="flex-1 min-w-0 px-3 py-2 text-sm bg-white border border-slate-300 rounded-md text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-600"
                />
                <button
                  type="submit"
                  disabled={!customClarification.trim() || isSubmittingClarification}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <Send className="w-3.5 h-3.5" />
                  <span>{isSubmittingClarification ? 'Applying...' : 'Apply Clarification'}</span>
                </button>
              </form>
            </div>
          )}
        </div>
      )}

      {/* Stage 4: Generated SQL & AST Validation */}
      {turn.sql && (
        <div className="p-5 space-y-3">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3 text-xs">
              <span className="font-medium text-slate-700">Generated SQLite Query</span>
              {turn.repaired && (
                <span className="text-amber-700 font-medium">
                  · Repaired for intent alignment
                </span>
              )}
              {turn.validation && (
                <button
                  type="button"
                  onClick={() => setShowValidation((v) => !v)}
                  className="inline-flex items-center gap-1 text-emerald-700 hover:text-emerald-800 font-medium cursor-pointer"
                >
                  <ShieldCheck className="w-3.5 h-3.5" />
                  <span>
                    {turn.validation.valid ? 'AST & Semantic Checks Passed' : 'Validation Failed'}
                  </span>
                </button>
              )}
            </div>

            <button
              type="button"
              onClick={handleCopySql}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-slate-600 hover:text-slate-900 border border-slate-200 rounded-md bg-white transition-colors cursor-pointer"
            >
              {copiedSql ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
              <span>{copiedSql ? 'Copied' : 'Copy SQL'}</span>
            </button>
          </div>

          <pre className="p-3.5 bg-slate-950 text-slate-100 rounded-md text-xs font-mono overflow-x-auto leading-relaxed">
            <code>{turn.sql}</code>
          </pre>

          {turn.repairNotes && (
            <p className="text-xs text-amber-800">{turn.repairNotes}</p>
          )}

          {showValidation && turn.validation && (
            <div className="pt-2 space-y-1.5">
              {turn.validation.checks.map((chk) => (
                <div key={chk.name} className="flex items-start gap-2 text-xs">
                  {chk.passed ? (
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 mt-0.5 shrink-0" />
                  ) : (
                    <XCircle className="w-3.5 h-3.5 text-rose-600 mt-0.5 shrink-0" />
                  )}
                  <div>
                    <span className="font-medium text-slate-800">{chk.name}: </span>
                    <span className="text-slate-600">{chk.detail}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Stage 5: Natural Language Answer & Result Table */}
      {turn.status !== 'NEEDS_CLARIFICATION' && (
        <div className="p-5 space-y-4">
          <div className="space-y-1">
            <div className="text-xs font-medium text-slate-500">
              {turn.status === 'REJECTED'
                ? 'Safe Rejection Explanation'
                : turn.status === 'ERROR'
                ? 'Pipeline Error Notice'
                : 'Natural Language Answer'}
            </div>
            <p
              className={`text-sm leading-relaxed ${
                turn.status === 'ERROR' ? 'text-rose-700' : 'text-slate-900'
              }`}
            >
              {turn.naturalLanguageAnswer}
            </p>
          </div>

          {turn.execution && (
            <div className="space-y-2.5">
              <div className="flex items-center justify-between gap-3 text-xs text-slate-500">
                <div className="flex items-center gap-2">
                  <span className="tabular-nums font-medium text-slate-700">
                    {turn.execution.rowCount} {turn.execution.rowCount === 1 ? 'row' : 'rows'} returned
                  </span>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono tabular-nums">{turn.execution.executionTimeMs} ms</span>
                  {turn.execution.truncated && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="text-amber-700">Capped at 500 rows</span>
                    </>
                  )}
                </div>

                {turn.execution.rows.length > 0 && (
                  <button
                    type="button"
                    onClick={handleDownloadCsv}
                    className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 hover:text-slate-900 cursor-pointer"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>Export CSV</span>
                  </button>
                )}
              </div>

              {turn.execution.rows.length > 0 ? (
                <div className="border border-slate-200 rounded-md overflow-x-auto max-h-80">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead className="bg-slate-50 border-b border-slate-200 sticky top-0">
                      <tr>
                        {turn.execution.columns.map((col) => (
                          <th
                            key={col}
                            className="px-3 py-2 font-mono font-medium text-slate-600 whitespace-nowrap"
                          >
                            {col}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {turn.execution.rows.map((row, rIdx) => (
                        <tr key={rIdx} className="hover:bg-slate-50/80">
                          {turn.execution!.columns.map((col) => {
                            const val = row[col];
                            const isNum = typeof val === 'number';
                            return (
                              <td
                                key={col}
                                className={`px-3 py-2 whitespace-nowrap ${
                                  isNum ? 'font-mono tabular-nums text-slate-900' : 'text-slate-700'
                                }`}
                              >
                                {val === null || val === undefined ? (
                                  <span className="text-slate-400">NULL</span>
                                ) : (
                                  String(val)
                                )}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="px-4 py-3 text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded-md">
                  The query executed validly and returned 0 matching rows.
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </article>
  );
}
