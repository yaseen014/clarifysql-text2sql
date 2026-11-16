import { useState } from 'react';
import { CheckCircle2, Play, XCircle } from 'lucide-react';
import type { RegressionTestResult } from '../types/text2sql';

export function VerificationSuite() {
  const [runningMode, setRunningMode] = useState<'deterministic' | 'live' | null>(null);
  const [lastMode, setLastMode] = useState<'deterministic' | 'live' | null>(null);
  const [results, setResults] = useState<RegressionTestResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleRunSuite = async (mode: 'deterministic' | 'live') => {
    setRunningMode(mode);
    setLastMode(mode);
    setError(null);
    try {
      const res = await fetch('/api/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Verification failed.');
      }
      setResults(data.results ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunningMode(null);
    }
  };

  const passedCount = results ? results.filter((r) => r.passed).length : 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Regression &amp; Safety Verification Suite</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Verifies record counts, aggregations, correlated extremums, ambiguity clarification, AST safety, and out-of-scope rejection across 9 scenarios.
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => handleRunSuite('deterministic')}
            disabled={runningMode !== null}
            className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-medium text-slate-800 bg-white border border-slate-300 rounded-md hover:bg-slate-50 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Play className="w-3.5 h-3.5" />
            <span>{runningMode === 'deterministic' ? 'Running Engine Checks...' : 'Run Engine Checks'}</span>
          </button>

          <button
            type="button"
            onClick={() => handleRunSuite('live')}
            disabled={runningMode !== null}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Play className="w-3.5 h-3.5" />
            <span>{runningMode === 'live' ? 'Running Live Gemini...' : 'Run Live Gemini Suite'}</span>
          </button>
        </div>
      </div>

      {error && (
        <div className="p-4 bg-rose-50 border border-rose-200 rounded-md text-xs text-rose-800">
          {error}
        </div>
      )}

      {!results && !runningMode && (
        <div className="bg-white border border-slate-200 rounded-lg p-8 text-center space-y-2">
          <p className="text-sm font-medium text-slate-800">Ready to verify the Text-to-SQL pipeline</p>
          <p className="text-xs text-slate-500 max-w-xl mx-auto">
            Use &ldquo;Run Engine Checks&rdquo; to validate SQLite execution, AST validation, and multi-turn orchestration without consuming Gemini API quota, or &ldquo;Run Live Gemini Suite&rdquo; to test end-to-end with Gemini 4 Hydrogen.
          </p>
        </div>
      )}

      {runningMode && (
        <div className="bg-white border border-slate-200 rounded-lg p-6 space-y-3">
          <p className="text-xs font-medium text-slate-600">
            Running 9 {runningMode === 'live' ? 'live Gemini + SQLite' : 'SQLite + AST engine'} checks...
          </p>
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-9 bg-slate-100 rounded animate-pulse" />
          ))}
        </div>
      )}

      {results && !runningMode && (
        <div className="space-y-4">
          <div className="flex items-center gap-3 text-xs">
            <span className="font-semibold text-slate-900 tabular-nums">
              {passedCount} / {results.length} Passed
            </span>
            <span aria-hidden="true" className="text-slate-300">·</span>
            <span className="text-slate-500">
              Mode: {lastMode === 'live' ? 'Live Gemini 4 Hydrogen' : 'Deterministic Engine'}
            </span>
            <span aria-hidden="true" className="text-slate-300">·</span>
            <span className={passedCount === results.length ? 'text-emerald-700 font-medium' : 'text-rose-700 font-medium'}>
              {passedCount === results.length ? 'All regression checks passed' : `${results.length - passedCount} check(s) failed`}
            </span>
          </div>

          <div className="bg-white border border-slate-200 rounded-lg overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  <th className="px-4 py-2.5 font-medium text-slate-600">Result</th>
                  <th className="px-4 py-2.5 font-medium text-slate-600">Scenario & Question</th>
                  <th className="px-4 py-2.5 font-medium text-slate-600">Classification</th>
                  <th className="px-4 py-2.5 font-medium text-slate-600">Generated SQL</th>
                  <th className="px-4 py-2.5 font-medium text-slate-600">Returned Output / Notes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {results.map((r) => (
                  <tr key={r.id} className="align-top hover:bg-slate-50/70">
                    <td className="px-4 py-3 whitespace-nowrap">
                      {r.passed ? (
                        <span className="inline-flex items-center gap-1 text-emerald-700 font-medium">
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          <span>Pass</span>
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-rose-700 font-medium">
                          <XCircle className="w-3.5 h-3.5" />
                          <span>Fail</span>
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 space-y-1 max-w-xs">
                      <div className="font-medium text-slate-900">{r.name}</div>
                      <div className="text-slate-600">&ldquo;{r.question}&rdquo;</div>
                      {r.followUpClarification && (
                        <div className="text-[11px] text-amber-800">
                          Clarification: &ldquo;{r.followUpClarification}&rdquo;
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 font-mono text-slate-700 whitespace-nowrap">
                      {r.actualClassification}
                    </td>
                    <td className="px-4 py-3 font-mono text-[11px] text-slate-800 max-w-xs break-all">
                      {r.generatedSql ?? '— (none executed)'}
                    </td>
                    <td className="px-4 py-3 text-slate-600 space-y-1 max-w-xs">
                      <div className="font-mono text-[11px] text-slate-800 break-all">{r.returnedValueSummary}</div>
                      <div>{r.notes}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
