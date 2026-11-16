import { useEffect, useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import type { DatasetMetadata } from '../types/text2sql';

interface DatasetExplorerProps {
  dataset: DatasetMetadata | null;
}

export function DatasetExplorer({ dataset }: DatasetExplorerProps) {
  const [rows, setRows] = useState<Array<Record<string, string | number | null>>>([]);
  const [columns, setColumns] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [activeTab, setActiveTab] = useState<'rows' | 'profile'>('rows');

  useEffect(() => {
    if (!dataset) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/datasets/${encodeURIComponent(dataset.id)}/preview?limit=100`)
      .then(async (res) => {
        if (!res.ok) throw new Error(await res.text());
        return res.json();
      })
      .then((data) => {
        if (cancelled) return;
        setColumns(data.columns ?? []);
        setRows(data.rows ?? []);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [dataset?.id]);

  const filteredRows = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((row) =>
      columns.some((col) => String(row[col] ?? '').toLowerCase().includes(q))
    );
  }, [rows, columns, searchTerm]);

  if (!dataset) {
    return (
      <div className="bg-white border border-slate-200 rounded-lg p-8 text-center text-sm text-slate-500">
        Select or upload a dataset from the sidebar to explore its schema and records.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header & Controls */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">{dataset.name}</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Table <span className="font-mono text-slate-700">{dataset.tableName}</span>
            <span className="mx-1.5" aria-hidden="true">·</span>
            <span className="tabular-nums">{dataset.rowCount} rows</span>
            <span className="mx-1.5" aria-hidden="true">·</span>
            <span className="tabular-nums">{dataset.columns.length} columns</span>
          </p>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-md">
            <button
              type="button"
              onClick={() => setActiveTab('rows')}
              className={`px-3 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                activeTab === 'rows'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Data Preview
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('profile')}
              className={`px-3 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                activeTab === 'profile'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Column Profiles
            </button>
          </div>
        </div>
      </div>

      {activeTab === 'rows' ? (
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between gap-4">
            <div className="relative flex-1 max-w-sm">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="Filter visible rows..."
                className="w-full pl-9 pr-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-md text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-blue-600 focus:bg-white"
              />
            </div>
            <span className="text-xs text-slate-500 tabular-nums whitespace-nowrap">
              Showing {filteredRows.length} of {dataset.rowCount} records
            </span>
          </div>

          {loading ? (
            <div className="p-6 space-y-2.5">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="h-8 bg-slate-100 rounded animate-pulse" />
              ))}
            </div>
          ) : error ? (
            <div className="p-6 text-sm text-rose-700">{error}</div>
          ) : (
            <div className="overflow-x-auto max-h-[540px]">
              <table className="w-full text-left border-collapse text-xs">
                <thead className="bg-slate-50 border-b border-slate-200 sticky top-0">
                  <tr>
                    {columns.map((col) => (
                      <th
                        key={col}
                        className="px-3.5 py-2.5 font-mono font-medium text-slate-600 whitespace-nowrap"
                      >
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredRows.map((row, idx) => (
                    <tr key={idx} className="hover:bg-slate-50/70">
                      {columns.map((col) => {
                        const val = row[col];
                        const isNum = typeof val === 'number';
                        return (
                          <td
                            key={col}
                            className={`px-3.5 py-2.5 whitespace-nowrap ${
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
          )}
        </div>
      ) : (
        <div className="bg-white border border-slate-200 rounded-lg overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="px-4 py-2.5 font-medium text-slate-600">Column</th>
                <th className="px-4 py-2.5 font-medium text-slate-600">SQL Type</th>
                <th className="px-4 py-2.5 font-medium text-slate-600 text-right">Distinct</th>
                <th className="px-4 py-2.5 font-medium text-slate-600 text-right">Nulls</th>
                <th className="px-4 py-2.5 font-medium text-slate-600">Range / Average</th>
                <th className="px-4 py-2.5 font-medium text-slate-600">Top DB Values</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {dataset.columns.map((col) => (
                <tr key={col.name} className="hover:bg-slate-50/70">
                  <td className="px-4 py-2.5 font-mono font-medium text-slate-900 whitespace-nowrap">
                    {col.name}
                  </td>
                  <td className="px-4 py-2.5 font-mono text-slate-500 whitespace-nowrap">{col.type}</td>
                  <td className="px-4 py-2.5 font-mono tabular-nums text-right text-slate-700">
                    {col.distinctCount}
                  </td>
                  <td className="px-4 py-2.5 font-mono tabular-nums text-right text-slate-700">
                    {col.nullCount}
                  </td>
                  <td className="px-4 py-2.5 font-mono tabular-nums text-slate-700 whitespace-nowrap">
                    {col.type === 'TEXT'
                      ? `${String(col.minValue ?? '—')} … ${String(col.maxValue ?? '—')}`
                      : `min ${col.minValue ?? '—'} · max ${col.maxValue ?? '—'}${
                          col.avgValue != null ? ` · avg ${col.avgValue}` : ''
                        }`}
                  </td>
                  <td className="px-4 py-2.5 text-slate-600">
                    {col.topValues
                      .slice(0, 4)
                      .map((v) => `${v.value} (${v.count})`)
                      .join(', ')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
