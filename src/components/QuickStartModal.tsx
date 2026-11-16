import { useEffect, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Database,
  Download,
  HelpCircle,
  Play,
  ShieldCheck,
  Upload,
  X,
} from 'lucide-react';

interface QuickStartModalProps {
  open: boolean;
  onClose: () => void;
  onOpenUpload: () => void;
  onLoadPrompt: (datasetId: string, question: string, autoRun: boolean) => void;
  onOpenVerification: () => void;
}

interface TourStep {
  id: string;
  numberLabel: string;
  shortTitle: string;
  title: string;
  summary: string;
  highlights: string[];
  exampleDatasetId?: string;
  exampleQuestion?: string;
  expectedOutcome?: string;
}

const TOUR_STEPS: TourStep[] = [
  {
    id: 'upload-csv',
    numberLabel: '01',
    shortTitle: 'Upload CSV',
    title: '01. Upload Any CSV or Excel Dataset',
    summary:
      'Import your own spreadsheet without configuring schemas manually. ClarifySQL parses headers into valid SQLite identifiers, infers INTEGER, REAL, and TEXT types, and profiles column ranges and frequent values automatically.',
    highlights: [
      'Supports .csv, .tsv, .xlsx, and .xls files up to 10 MB.',
      'Computes distinct counts, null counts, min/max/avg, and top sample values on upload.',
      'Every query probes live database values so schema and value ambiguity work on unseen data.',
    ],
  },
  {
    id: 'dataset-count',
    numberLabel: '02',
    shortTitle: 'Dataset Counts',
    title: '02. Dataset-Level Record Count Questions',
    summary:
      'Questions about the size of an entire dataset do not map to a single column name. ClarifySQL explicitly classifies dataset-level counts as CLEAR and resolves the authorized table through dataset metadata.',
    highlights: [
      'Recognizes phrasings like "What is the total number of records in Student Performance Data?", "How many rows are in this dataset?", and "Count all records."',
      'Generates SELECT COUNT(*) AS total_records FROM <authorized_table> without hardcoding dataset IDs.',
      'Passes read-only AST validation and returns the exact SQLite row count (60 records).',
    ],
    exampleDatasetId: 'student_performance_data',
    exampleQuestion: 'What is the total number of records in Student Performance Data?',
    expectedOutcome:
      'Classified as CLEAR (dataset_count) -> executes SELECT COUNT(*) AS total_records FROM student_performance_data -> returns 60.',
  },
  {
    id: 'clarification',
    numberLabel: '03',
    shortTitle: 'Clarification',
    title: '03. Ambiguity Detection & Clarification Prompts',
    summary:
      'When a question uses vague criteria (like "best", "top-performing", or "high value") across multiple candidate columns, ClarifySQL pauses before generating SQL and asks a concise, database-grounded follow-up question.',
    highlights: [
      'Inspects competing numeric metrics (e.g., gpa vs exam_score vs attendance_pct) and missing top-N limits.',
      'Presents clickable database-grounded options plus a free-text input to resolve intent.',
      'Combines your original question, clarification answer, and DB context into a Rewritten Query before generating SQL.',
    ],
    exampleDatasetId: 'student_performance_data',
    exampleQuestion: 'Who are the best students?',
    expectedOutcome:
      'Pauses at NEEDS_CLARIFICATION -> asks metric (gpa vs exam_score) & limit -> after you answer, rewrites intent and returns the exact ranked rows.',
  },
  {
    id: 'safety-verify',
    numberLabel: '04',
    shortTitle: 'Safety & Verify',
    title: '04. Safe Rejections, AST Validation & Verification',
    summary:
      'Requests outside the dataset domain or referencing absent columns are rejected with zero SQL executed. All generated SQL is AST-checked and semantically validated before running in read-only SQLite.',
    highlights: [
      'Rejects missing columns ("What is the average salary of students?") as UNANSWERABLE without guessing.',
      'Rejects unrelated prompts ("Give me the name of five apples") as OUT_OF_SCOPE.',
      'Use Verification Suite -> Run Engine Checks anytime to verify all 9 regression scenarios with zero API quota.',
    ],
    exampleDatasetId: 'student_performance_data',
    exampleQuestion: 'What is the average salary of students?',
    expectedOutcome:
      'Classified as UNANSWERABLE -> explains that "salary" is missing and lists valid schema columns -> executes zero SQL.',
  },
];

function downloadSampleCsv() {
  const csv = [
    'employee_id,full_name,department,performance_score,projects_completed,annual_bonus,tenure_years',
    'EMP-101,Ava Morales,Engineering,94,12,8500,4',
    'EMP-102,Liam Patel,Product,88,9,6200,3',
    'EMP-103,Sophia Chen,Engineering,97,15,10500,6',
    'EMP-104,Noah Brooks,Design,82,7,4800,2',
    'EMP-105,Maya Nair,Data Science,91,11,7900,5',
    'EMP-106,Ethan Kim,Data Science,79,6,4100,1',
  ].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'sample_team_performance.csv';
  a.click();
  URL.revokeObjectURL(url);
}

export function QuickStartModal({
  open,
  onClose,
  onOpenUpload,
  onLoadPrompt,
  onOpenVerification,
}: QuickStartModalProps) {
  const [stepIdx, setStepIdx] = useState(0);

  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [open, onClose]);

  if (!open) return null;

  const currentStep = TOUR_STEPS[stepIdx];

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/45 backdrop-blur-[1px] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="quickstart-modal-title"
    >
      <div className="bg-white border border-slate-200 rounded-lg w-full max-w-2xl shadow-lg overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between gap-4">
          <div>
            <h2 id="quickstart-modal-title" className="text-base font-semibold text-slate-900">
              Quick Start Guide
            </h2>
            <p className="text-xs text-slate-500 mt-0.5 tabular-nums">
              Step {stepIdx + 1} of {TOUR_STEPS.length}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close Quick Start modal"
            className="p-1.5 text-slate-400 hover:text-slate-700 rounded-md cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Step Navigation Tabs */}
        <div className="px-6 py-2.5 bg-slate-50 border-b border-slate-200 flex items-center gap-1.5 overflow-x-auto">
          {TOUR_STEPS.map((step, idx) => {
            const active = idx === stepIdx;
            return (
              <button
                key={step.id}
                type="button"
                onClick={() => setStepIdx(idx)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  active
                    ? 'bg-white text-slate-900 border border-slate-200 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900 border border-transparent'
                }`}
              >
                <span className="font-mono text-slate-400 mr-1.5">{step.numberLabel}.</span>
                <span>{step.shortTitle}</span>
              </button>
            );
          })}
        </div>

        {/* Body */}
        <div className="p-6 space-y-5">
          <div className="space-y-2">
            <h3 className="text-lg font-semibold text-slate-900">{currentStep.title}</h3>
            <p className="text-sm text-slate-600 leading-relaxed">{currentStep.summary}</p>
          </div>

          <ul className="space-y-2 text-xs text-slate-700">
            {currentStep.highlights.map((item) => (
              <li key={item} className="flex items-start gap-2">
                <CheckCircle2 className="w-3.5 h-3.5 text-blue-600 mt-0.5 shrink-0" />
                <span className="leading-relaxed">{item}</span>
              </li>
            ))}
          </ul>

          {/* Step 1 Interactive CSV Actions */}
          {currentStep.id === 'upload-csv' && (
            <div className="p-4 bg-slate-50 border border-slate-200 rounded-md flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div className="space-y-0.5">
                <div className="text-xs font-semibold text-slate-900 flex items-center gap-1.5">
                  <Database className="w-3.5 h-3.5 text-slate-500" />
                  <span>Try with a sample or your own file</span>
                </div>
                <p className="text-xs text-slate-500">
                  Download a 6-row sample CSV or upload any CSV/XLSX from your computer.
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={downloadSampleCsv}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Sample CSV</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    onOpenUpload();
                  }}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <Upload className="w-3.5 h-3.5" />
                  <span>Upload CSV</span>
                </button>
              </div>
            </div>
          )}

          {/* Scenario Interactive Box for Steps 2, 3, 4 */}
          {currentStep.exampleQuestion && currentStep.exampleDatasetId && (
            <div className="p-4 bg-slate-50 border border-slate-200 rounded-md space-y-3">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="font-semibold text-slate-800 flex items-center gap-1.5">
                  {currentStep.id === 'clarification' ? (
                    <HelpCircle className="w-3.5 h-3.5 text-amber-600" />
                  ) : currentStep.id === 'safety-verify' ? (
                    <ShieldCheck className="w-3.5 h-3.5 text-slate-600" />
                  ) : (
                    <Database className="w-3.5 h-3.5 text-blue-600" />
                  )}
                  <span>Interactive Scenario</span>
                </span>
                <span className="text-slate-500 font-mono text-[11px]">
                  {currentStep.exampleDatasetId}
                </span>
              </div>

              <div className="px-3 py-2 bg-white border border-slate-200 rounded text-xs font-medium text-slate-900">
                &ldquo;{currentStep.exampleQuestion}&rdquo;
              </div>

              {currentStep.expectedOutcome && (
                <p className="text-xs text-slate-600 leading-relaxed">
                  {currentStep.expectedOutcome}
                </p>
              )}

              <div className="flex flex-wrap items-center gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => {
                    onLoadPrompt(currentStep.exampleDatasetId!, currentStep.exampleQuestion!, false);
                    onClose();
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-800 bg-white border border-slate-300 rounded-md hover:bg-slate-100 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <span>Load into Input</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onLoadPrompt(currentStep.exampleDatasetId!, currentStep.exampleQuestion!, true);
                    onClose();
                  }}
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <Play className="w-3 h-3" />
                  <span>Run Scenario</span>
                </button>
                {currentStep.id === 'safety-verify' && (
                  <button
                    type="button"
                    onClick={() => {
                      onClose();
                      onOpenVerification();
                    }}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-100 whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <span>Open Verification Suite</span>
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-slate-200 bg-slate-50/70 flex items-center justify-between gap-4">
          <button
            type="button"
            disabled={stepIdx === 0}
            onClick={() => setStepIdx((i) => Math.max(0, i - 1))}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-md hover:bg-slate-50 disabled:opacity-40 cursor-pointer"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>Previous</span>
          </button>

          <div className="flex items-center gap-2">
            {stepIdx < TOUR_STEPS.length - 1 ? (
              <button
                type="button"
                onClick={() => setStepIdx((i) => Math.min(TOUR_STEPS.length - 1, i + 1))}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-md hover:bg-slate-800 cursor-pointer"
              >
                <span>Next Step</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            ) : (
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-xs font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 cursor-pointer"
              >
                Finish Tour
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
