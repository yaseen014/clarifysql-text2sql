# ClarifySQL

**Schema-Generalizable, Ambiguity-Aware, and AST-Validated Text-to-SQL Workspace with Safe Failure Guarantees**

ClarifySQL is a full-stack natural-language-to-SQL (NL2SQL) system built with React, TypeScript, Express, WebAssembly SQLite (`sql.js`), `node-sql-parser`, and the Google Gemini API (`@google/genai`). Unlike zero-shot prompt wrappers that silently guess SQL or crash when schemas or prompts are ambiguous, ClarifySQL enforces a five-stage verification and clarification pipeline—stopping safely with zero SQL executed whenever intent cannot be grounded in the active dataset.

---

## Problems Solved

Naive LLM Text-to-SQL pipelines routinely exhibit five silent failure modes in real interactive workloads:

1. **False Rejections on Dataset-Level Cardinality Queries**: Rejecting `"How many records are in this dataset?"` or `"Count all records"` because `"records"` / `"rows"` does not match a single column name. ClarifySQL explicitly models `dataset_count` as a `CLEAR` intent and generates `SELECT COUNT(*)`.
2. **Silent Guessing on Ambiguous Prompts**: Guessing an arbitrary column or threshold when asked `"Who are the best students?"` or `"Which orders are high value?"`. ClarifySQL pauses at `NEEDS_CLARIFICATION`, surfaces competing columns/cutoffs with clickable database-grounded options, and rewrites the clarified question into unambiguous SQL.
3. **Correlated Extremum Inversion**: Returning `SELECT MAX(age)` when asked `"What is the age of the student with the highest exam score?"`. ClarifySQL's AST + semantic validator catches the inversion and repairs it to rank/filter by `exam_score`.
4. **Schema Hallucinations & Unsafe SQL**: Running fabricated column names or unsafe statements on missing attributes (`"What is the average salary of students?"`) or unrelated prompts (`"Give me the name of five apples"`). ClarifySQL classifies these as `UNANSWERABLE` or `OUT_OF_SCOPE` and executes **zero SQL**.
5. **Quota Exhaustion & Uncaught API Failures**: Silently returning fallback queries or raw stack traces on `429 RESOURCE_EXHAUSTED`. ClarifySQL performs automatic cross-model failover (`gemini-4-hydrogen` → `gemini-3.1-flash-lite`), tracks daily per-model usage in the UI, and fails safely without executing guessed SQL.

---

## Core Features

- **Database-Aware Context Retrieval (Stage 1)**: Ranks schema columns using lexical tokenization, precomputed column statistics (`min`, `max`, `avg`, `distinctCount`), and live SQLite `LIKE` probes against `TEXT` columns.
- **Unified Single-Call Intent & SQL Planner (Stage 2)**: Classifies every query into `CLEAR`, `AMBIGUOUS`, `UNANSWERABLE`, or `OUT_OF_SCOPE` and plans candidate SQLite `SELECT` SQL in one structured-JSON LLM call.
- **Interactive Multi-Turn Clarification & Question Rewriting (Stage 3)**: Supports up to 2 database-grounded clarification rounds, synthesizing a self-contained `rewrittenQuestion` before SQL generation.
- **5-Gate AST & Semantic Intent Validation + Repair (Stage 4)**: Uses `node-sql-parser` to enforce read-only keywords, single-`SELECT` AST parsing, strict table authorization (blocking `sqlite_master` and cross-table reads), column grounding, and semantic alignment—with automated repair on failure.
- **Read-Only SQLite Execution Sandbox (Stage 5)**: Runs queries under `PRAGMA query_only = ON` with a 500-row result limit and microsecond/millisecond execution timing.
- **Zero-Code Arbitrary CSV/XLSX Upload & Profiling**: Drag-and-drop `.csv`, `.tsv`, `.xlsx`, or `.xls` files (parsed via SheetJS) with automatic SQL identifier sanitization, `INTEGER` / `REAL` / `TEXT` type inference, statistical profiling, and live schema preview.
- **Workspace Productivity**:
  - **Model Usage Today**: Live sidebar tracker (`GET /api/quota`) showing primary/failover model call counts and exhaustion cooldowns.
  - **Recent Queries**: Persists the last 5 successful natural-language queries per dataset in `localStorage` for one-click re-execution.
  - **Quick Start Tour Modal**: Interactive walkthrough for CSV uploads, dataset-level counts, and ambiguity clarification.
  - **Regression Verification Panel**: Built-in 9-scenario benchmark suite runnable in deterministic (0 API credits) or live mode.

---

## Pipeline Architecture

```text
Natural-Language Question + Active Dataset
   │
   ▼
[Stage 1] Database-Aware Retrieval
   │  • Ranked schema columns & numeric stats (min/max/avg)
   │  • Live SQLite LIKE probes for categorical cell values
   ▼
[Stage 2] Unified Intent & SQL Planner (Gemini 4 Hydrogen -> 3.1 Flash-Lite failover)
   ├── CLEAR ──────────────────────────────────────────┐
   ├── AMBIGUOUS ──► [Stage 3a] Clarification UI       │
   │                    │ (User chooses option/text)   │
   │                    ▼                              │
   │                 [Stage 3b] Question Rewriting ────┤
   └── UNANSWERABLE / OUT_OF_SCOPE                     │
         │                                             ▼
         ▼                                      [Stage 4] 5-Gate AST & Semantic Validator
  Safe Rejection (0 SQL Executed)                      │ (Repairs semantic errors if needed)
                                                       ▼
                                                [Stage 5] Read-Only SQLite Execution
                                                       │ (PRAGMA query_only = ON, <=500 rows)
                                                       ▼
                                                Answer Summary + Data Table + Trace
```

---

## Tech Stack

- **Frontend**: React 19, TypeScript, Tailwind CSS v4, Lucide Icons, Motion
- **Backend**: Node.js, Express, `tsx`, Multer, SheetJS (`xlsx`)
- **Database & Validation**: `sql.js` (in-memory WebAssembly SQLite), `node-sql-parser`
- **AI & Failover**: `@google/genai` (`gemini-4-hydrogen` primary, `gemini-3.1-flash-lite` automatic failover)
- **Testing**: Vitest (`tests/text2sql.test.ts`)

---

## Project Structure

```text
├── server.ts                         # Express + Vite middleware entry point (port 3000)
├── server/
│   ├── db/
│   │   ├── datasets.ts               # Built-in datasets & CSV/XLSX table definitions
│   │   └── sqliteEngine.ts           # sql.js runtime, schema profiling, LIKE probes, safe execution
│   └── pipeline/
│       ├── contextRetrieval.ts       # Stage 1: lexical + live DB value context retriever
│       ├── geminiClient.ts           # Stage 2: unified structured planner, repair & NL answer
│       ├── orchestrator.ts           # 5-stage state machine & multi-turn clarification sessions
│       ├── quotaTracker.ts           # Per-model daily usage counter & 429 cooldown failover
│       ├── regressionSuite.ts        # 9-scenario verification suite (deterministic & live modes)
│       └── sqlValidator.ts           # Stage 4: AST syntax, table/column auth & semantic validator
├── src/
│   ├── App.tsx                       # Main query workspace, Recent Queries & sidebar controls
│   ├── types/text2sql.ts             # Shared TypeScript interfaces across client & server
│   └── components/
│       ├── DatasetExplorer.tsx       # Schema inspector, sample stats & live row preview
│       ├── PipelineTurnCard.tsx      # Execution trace, SQL viewer, clarification UI & result table
│       ├── QuickStartModal.tsx       # Interactive onboarding tour modal
│       ├── UploadModal.tsx           # Arbitrary CSV/TSV/XLSX upload modal
│       └── VerificationSuite.tsx     # Interactive 9-scenario regression runner UI
├── tests/
│   └── text2sql.test.ts              # Vitest unit & integration test suite (9 tests)
└── public/
    └── ClarifySQL_IEEE_Research_Paper.docx
```

---

## Getting Started

### Prerequisites

- **Node.js** `v20+` (or `v22+`)
- A **Google Gemini API Key** (`GEMINI_API_KEY`)

### Installation & Local Development

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Configure environment variables:**
   Create a `.env` file based on `.env.example`:
   ```env
   GEMINI_API_KEY="your_gemini_api_key_here"
   ```

3. **Start the development server (runs Express + Vite on port `3000`):**
   ```bash
   npm run dev
   ```
   Open `http://localhost:3000` in your browser.

### Scripts

| Command | Description |
| :--- | :--- |
| `npm run dev` | Start full-stack Express + Vite development server on port `3000` |
| `npm test` | Run the 9-test Vitest unit & integration suite (`tests/text2sql.test.ts`) |
| `npm run lint` | Type-check TypeScript across client, server, and tests (`tsc --noEmit`) |
| `npm run build` | Build production React bundle into `dist/` |
| `npm start` | Run production Express server serving `dist/` |

---

## Built-in Datasets & Example Showcase Queries

ClarifySQL initializes three realistic tabular datasets automatically on startup:

1. **Student Performance Data** (`student_performance_data`, 60 rows, 11 columns)
2. **E-Commerce Orders** (`ecommerce_orders`, 45 rows, 9 columns)
3. **Clinical Trials Cohort** (`clinical_trials`, 40 rows, 9 columns)

### Example Queries to Showcase Pipeline Behavior

| Behavior Demonstrated | Example Prompt | Expected Outcome |
| :--- | :--- | :--- |
| **Dataset Cardinality (`CLEAR`)** | `What is the total number of records in Student Performance Data?` | `SELECT COUNT(*) ...` → `60` |
| **Correlated Extremum Repair (`CLEAR`)** | `What is the age of the student with the highest exam score?` | Avoids `MAX(age)`; returns `age = 19` (Elijah Chen, score `99`) |
| **Ambiguity Detection (`AMBIGUOUS`)** | `Who are the best students?` | Pauses at `NEEDS_CLARIFICATION` (`gpa` vs `exam_score`, missing `LIMIT`) |
| **Threshold Ambiguity (`AMBIGUOUS`)** | `Which orders are high value?` | Prompts user to define cutoff (e.g., `total_amount > 1000`) |
| **Missing Column (`UNANSWERABLE`)** | `What is the average salary of students?` | Explains missing `salary` concept, lists valid columns, executes **0 SQL** |
| **Unrelated Domain (`OUT_OF_SCOPE`)** | `Give me the name of five apples` | Explains domain mismatch, executes **0 SQL** |

---

## API Reference

| Endpoint | Method | Purpose |
| :--- | :--- | :--- |
| `/api/health` | `GET` | Health status, loaded dataset count, and Gemini key configuration state |
| `/api/quota` | `GET` | Daily observed calls, active model, and failover status |
| `/api/datasets` | `GET` | List all active datasets and profiled column metadata |
| `/api/datasets/:id/preview` | `GET` | Paginated preview rows (`?limit=100&offset=0`) |
| `/api/datasets/upload` | `POST` | Multipart `.csv`/`.tsv`/`.xlsx`/`.xls` upload & automatic SQLite profiling |
| `/api/query` | `POST` | Run Stages 1–5 for `{ datasetId, question }` |
| `/api/query/clarify` | `POST` | Resume an ambiguous session with `{ sessionId, answer }` |
| `/api/verify` | `POST` | Run the 9-scenario regression suite (`{ mode: "deterministic" \| "live" }`) |

---

## Verification

Run the automated test suite anytime (uses zero Gemini API credits):

```bash
npm test
npm run lint
```

- **9/9 Vitest checks** verify dataset-level `COUNT(*)` recognition, ambiguity pause & clarification rewrite, semantic `MAX(age)` catching, SQL injection/DDL blocking, safe rejection of `UNANSWERABLE`/`OUT_OF_SCOPE` prompts, safe handling of `429 RESOURCE_EXHAUSTED`, and zero-code CSV upload querying.
