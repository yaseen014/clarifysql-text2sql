import { useRef, useState } from 'react';
import { FileSpreadsheet, Upload, X } from 'lucide-react';
import * as XLSX from 'xlsx';
import type { DatasetMetadata } from '../types/text2sql';

interface UploadModalProps {
  open: boolean;
  onClose: () => void;
  onUploaded: (dataset: DatasetMetadata) => void;
}

interface ParsedSheet {
  name: string;
  rows: Array<Record<string, unknown>>;
}

function normalizeClientCell(val: unknown): unknown {
  if (val instanceof Date && !Number.isNaN(val.getTime())) {
    return val.toISOString().slice(0, 10);
  }
  return val;
}

function extractPopulatedSheets(workbook: XLSX.WorkBook): ParsedSheet[] {
  const populated: ParsedSheet[] = [];
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name];
    if (!sheet) continue;
    const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
      defval: null,
      raw: true,
    });
    const cleanRows = rawRows
      .filter((row) =>
        Object.values(row).some((v) => v !== null && v !== undefined && String(v).trim() !== '')
      )
      .map((row) => {
        const next: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(row)) {
          next[k] = normalizeClientCell(v);
        }
        return next;
      });

    if (cleanRows.length > 0) {
      populated.push({ name, rows: cleanRows });
    }
  }
  return populated;
}

export function UploadModal({ open, onClose, onUploaded }: UploadModalProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingFileName, setPendingFileName] = useState<string | null>(null);
  const [pendingSheets, setPendingSheets] = useState<ParsedSheet[]>([]);
  const [selectedSheetName, setSelectedSheetName] = useState<string>('');

  if (!open) return null;

  const resetState = () => {
    setPendingFileName(null);
    setPendingSheets([]);
    setSelectedSheetName('');
    setError(null);
  };

  const handleClose = () => {
    resetState();
    onClose();
  };

  const submitParsedRows = async (
    fileName: string,
    rows: Array<Record<string, unknown>>,
    sheetName?: string
  ) => {
    setUploading(true);
    setError(null);
    try {
      const res = await fetch('/api/datasets/import-json', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName, sheetName, rows }),
      });

      const contentType = res.headers.get('content-type') || '';
      const data = contentType.includes('application/json')
        ? await res.json()
        : { error: `Server returned status ${res.status} (${res.statusText || 'Unexpected response'}).` };

      if (!res.ok) {
        throw new Error(data.error || 'Failed to import dataset.');
      }

      onUploaded(data.dataset);
      resetState();
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/failed to fetch|networkerror|load failed/i.test(msg)) {
        try {
          const health = await fetch('/api/health');
          if (!health.ok) {
            setError('Backend server returned an error. Try refreshing the page and uploading again.');
          } else {
            setError(
              'Upload request was interrupted (the dataset may be too large for one request). Try a smaller sheet or CSV export.'
            );
          }
        } catch {
          setError(
            'Cannot reach the ClarifySQL backend server right now. Please refresh the page or check that the server is running.'
          );
        }
      } else {
        setError(msg);
      }
    } finally {
      setUploading(false);
    }
  };

  const handleFileSelected = async (file: File) => {
    setUploading(true);
    setError(null);
    setPendingFileName(null);
    setPendingSheets([]);

    try {
      if (!/\.(csv|tsv|xlsx|xls)$/i.test(file.name)) {
        throw new Error('Unsupported file format. Upload .csv, .tsv, .xlsx, or .xls.');
      }
      if (file.size > 15 * 1024 * 1024) {
        throw new Error('File exceeds the 15 MB limit.');
      }

      let buffer: ArrayBuffer;
      try {
        buffer = await file.arrayBuffer();
      } catch {
        throw new Error(
          'Could not read the file from disk. If the file is currently open or unsaved in Excel, save & close Excel and try again.'
        );
      }

      const workbook = XLSX.read(buffer, { type: 'array', cellDates: true });
      const populatedSheets = extractPopulatedSheets(workbook);

      if (populatedSheets.length === 0) {
        throw new Error(
          'No non-empty data rows were found in this file. Make sure the sheet has a header row and at least 1 data row.'
        );
      }

      if (populatedSheets.length === 1) {
        await submitParsedRows(
          file.name,
          populatedSheets[0].rows,
          workbook.SheetNames.length > 1 ? populatedSheets[0].name : undefined
        );
      } else {
        setPendingFileName(file.name);
        setPendingSheets(populatedSheets);
        setSelectedSheetName(populatedSheets[0].name);
        setUploading(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setUploading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-[1px] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="upload-modal-title"
    >
      <div className="bg-white border border-slate-200 rounded-lg w-full max-w-md shadow-lg">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
          <h2 id="upload-modal-title" className="text-sm font-semibold text-slate-900">
            Upload CSV or Excel Dataset
          </h2>
          <button
            type="button"
            onClick={handleClose}
            aria-label="Close modal"
            className="p-1 text-slate-400 hover:text-slate-700 rounded cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              const file = e.dataTransfer.files[0];
              if (file) handleFileSelected(file);
            }}
            onClick={() => !uploading && inputRef.current?.click()}
            className={`border border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors ${
              dragging ? 'border-blue-500 bg-blue-50/50' : 'border-slate-300 hover:border-slate-400 bg-slate-50/50'
            }`}
          >
            <input
              ref={inputRef}
              type="file"
              accept=".csv,.tsv,.xlsx,.xls"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) handleFileSelected(file);
              }}
            />
            <FileSpreadsheet className="w-8 h-8 text-slate-400 mx-auto mb-2.5" />
            <p className="text-sm font-medium text-slate-800">
              {uploading ? 'Importing into SQLite & profiling schema...' : 'Drop a CSV or XLSX file here, or browse'}
            </p>
            <p className="text-xs text-slate-500 mt-1">
              Supports .csv, .tsv, .xlsx, .xls up to 15 MB
            </p>
          </div>

          {pendingFileName && pendingSheets.length > 1 && (
            <div className="p-3 bg-slate-50 border border-slate-200 rounded-md space-y-2">
              <p className="text-xs font-medium text-slate-700">
                Multiple sheets detected in <span className="font-semibold">{pendingFileName}</span>. Select a sheet:
              </p>
              <select
                value={selectedSheetName}
                onChange={(e) => setSelectedSheetName(e.target.value)}
                className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-300 rounded-md text-slate-800"
              >
                {pendingSheets.map((s) => (
                  <option key={s.name} value={s.name}>
                    {s.name} ({s.rows.length} rows)
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={uploading}
                onClick={() => {
                  const chosen = pendingSheets.find((s) => s.name === selectedSheetName);
                  if (chosen && pendingFileName) {
                    submitParsedRows(pendingFileName, chosen.rows, chosen.name);
                  }
                }}
                className="w-full py-1.5 text-xs font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50 cursor-pointer"
              >
                Import Selected Sheet
              </button>
            </div>
          )}

          {error && (
            <div className="p-3 bg-rose-50 border border-rose-200 rounded-md text-xs text-rose-800">
              {error}
            </div>
          )}

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={handleClose}
              className="px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-md hover:bg-slate-50 cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={uploading}
              onClick={() => inputRef.current?.click()}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50 cursor-pointer"
            >
              <Upload className="w-3.5 h-3.5" />
              <span>Choose File</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
