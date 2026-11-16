import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import multer from 'multer';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { sqliteEngine } from './server/db/sqliteEngine';
import { runClarificationResume, runInitialQuery } from './server/pipeline/orchestrator';
import { quotaTracker } from './server/pipeline/quotaTracker';
import { runRegressionSuite } from './server/pipeline/regressionSuite';

const PORT = 3000;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

export async function createAppServer() {
  await sqliteEngine.init();

  const app = express();
  app.use(express.json({ limit: '2mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      datasetsLoaded: sqliteEngine.listDatasets().length,
      geminiConfigured: Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY'),
      timestamp: new Date().toISOString(),
    });
  });

  app.get('/api/quota', (_req, res) => {
    res.json(quotaTracker.getStatus());
  });

  app.get('/api/datasets', (_req, res) => {
    res.json({ datasets: sqliteEngine.listDatasets() });
  });

  app.get('/api/datasets/:id/preview', (req, res) => {
    try {
      const limit = Number(req.query.limit ?? 100);
      const offset = Number(req.query.offset ?? 0);
      const preview = sqliteEngine.getPreviewRows(req.params.id, limit, offset);
      res.json(preview);
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/datasets/upload', upload.single('file'), (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No file provided. Please upload a CSV or XLSX file.' });
      }
      const allowedExt = /\.(csv|tsv|xlsx|xls)$/i;
      if (!allowedExt.test(req.file.originalname)) {
        return res.status(400).json({ error: 'Unsupported file format. Upload .csv, .tsv, .xlsx, or .xls.' });
      }
      const dataset = sqliteEngine.importUploadedFile(req.file.originalname, req.file.buffer);
      return res.status(201).json({ dataset });
    } catch (err) {
      return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/query', async (req, res) => {
    try {
      const { datasetId, question } = req.body as { datasetId?: string; question?: string };
      if (!datasetId || !question || !question.trim()) {
        return res.status(400).json({ error: 'Both datasetId and a non-empty question are required.' });
      }
      const result = await runInitialQuery(datasetId, question);
      return res.json(result);
    } catch (err) {
      return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/query/clarify', async (req, res) => {
    try {
      const { sessionId, answer } = req.body as { sessionId?: string; answer?: string };
      if (!sessionId || !answer || !answer.trim()) {
        return res.status(400).json({ error: 'Both sessionId and a clarification answer are required.' });
      }
      const result = await runClarificationResume(sessionId, answer);
      return res.json(result);
    } catch (err) {
      return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/verify', async (req, res) => {
    try {
      const mode = req.body?.mode === 'live' ? 'live' : 'deterministic';
      const results = await runRegressionSuite(mode);
      const passedCount = results.filter((r) => r.passed).length;
      res.json({
        total: results.length,
        passed: passedCount,
        failed: results.length - passedCount,
        results,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      const indexPath = path.join(distDir, 'index.html');
      if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
      } else {
        res.status(404).send('Build artifacts not found. Run npm run build.');
      }
    });
  }

  return app;
}

if (process.env.VITEST !== 'true') {
  createAppServer()
    .then((app) => {
      app.listen(PORT, '0.0.0.0', () => {
        console.log(`ClarifySQL server running on http://0.0.0.0:${PORT}`);
      });
    })
    .catch((err) => {
      console.error('Failed to start server:', err);
      process.exit(1);
    });
}
