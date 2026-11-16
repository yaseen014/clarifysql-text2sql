import fs from 'fs';
import path from 'path';
import type { ModelQuotaInfo, QuotaStatusResponse } from '../../src/types/text2sql';

const PRIMARY_MODEL = 'gemini-4-hydrogen';
const FALLBACK_MODEL = 'gemini-3.1-flash-lite';
const STATE_FILE = path.resolve('/tmp', 'clarifysql_quota_state.json');

interface PersistedQuotaState {
  dateKey: string;
  models: Record<string, ModelQuotaInfo>;
}

function getTodayDateKey(): string {
  // Gemini free-tier daily quotas reset around midnight Pacific Time
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function createInitialState(dateKey: string): PersistedQuotaState {
  return {
    dateKey,
    models: {
      [PRIMARY_MODEL]: {
        model: PRIMARY_MODEL,
        role: 'Primary',
        observedCallsToday: 0,
        freeTierDailyReference: 20,
        exhausted: false,
        retryAtIso: null,
        lastError: null,
      },
      [FALLBACK_MODEL]: {
        model: FALLBACK_MODEL,
        role: 'Failover',
        observedCallsToday: 0,
        freeTierDailyReference: null,
        exhausted: false,
        retryAtIso: null,
        lastError: null,
      },
    },
  };
}

class QuotaTracker {
  private state: PersistedQuotaState;

  constructor() {
    this.state = this.loadState();
  }

  private loadState(): PersistedQuotaState {
    const today = getTodayDateKey();
    try {
      if (fs.existsSync(STATE_FILE)) {
        const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) as PersistedQuotaState;
        if (parsed.dateKey === today && parsed.models?.[PRIMARY_MODEL] && parsed.models?.[FALLBACK_MODEL]) {
          return parsed;
        }
      }
    } catch {
      // Ignore corrupt temp file and reinitialize
    }
    return createInitialState(today);
  }

  private ensureToday(): void {
    const today = getTodayDateKey();
    if (this.state.dateKey !== today) {
      this.state = createInitialState(today);
      this.saveState();
    }
  }

  private saveState(): void {
    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify(this.state), 'utf-8');
    } catch {
      // Non-fatal if /tmp is read-only
    }
  }

  private clearExpiredCooldowns(): void {
    const now = Date.now();
    for (const info of Object.values(this.state.models)) {
      if (info.exhausted && info.retryAtIso) {
        const retryTime = Date.parse(info.retryAtIso);
        if (Number.isFinite(retryTime) && now >= retryTime) {
          info.exhausted = false;
          info.retryAtIso = null;
          info.lastError = null;
        }
      }
    }
  }

  isModelKnownExhausted(model: string): boolean {
    this.ensureToday();
    this.clearExpiredCooldowns();
    return Boolean(this.state.models[model]?.exhausted);
  }

  recordSuccess(model: string): void {
    this.ensureToday();
    const entry = this.state.models[model];
    if (entry) {
      entry.observedCallsToday += 1;
      entry.exhausted = false;
      entry.retryAtIso = null;
      entry.lastError = null;
      this.saveState();
    }
  }

  recordRateLimit(model: string, rawMessage: string): void {
    this.ensureToday();
    const entry = this.state.models[model];
    if (!entry) return;

    let retryAtIso: string | null = null;
    const delayMatch = rawMessage.match(/"retryDelay"\s*:\s*"(\d+)s"/i);
    if (delayMatch && delayMatch[1]) {
      const sec = Number(delayMatch[1]);
      if (Number.isFinite(sec) && sec > 0) {
        retryAtIso = new Date(Date.now() + sec * 1000).toISOString();
      }
    } else if (/per day|PerDay/i.test(rawMessage)) {
      retryAtIso = new Date(Date.now() + 3600 * 1000).toISOString();
    }

    const limitMatch = rawMessage.match(/"quotaValue"\s*:\s*"(\d+)"/);
    if (limitMatch && limitMatch[1]) {
      const parsedLimit = Number(limitMatch[1]);
      if (Number.isFinite(parsedLimit) && parsedLimit > 0) {
        entry.freeTierDailyReference = parsedLimit;
      }
    }

    entry.exhausted = true;
    entry.retryAtIso = retryAtIso;
    entry.lastError = '429 RESOURCE_EXHAUSTED';
    this.saveState();
  }

  getStatus(): QuotaStatusResponse {
    this.ensureToday();
    this.clearExpiredCooldowns();
    const models = [this.state.models[PRIMARY_MODEL], this.state.models[FALLBACK_MODEL]];
    const activeModel = models.find((m) => !m.exhausted)?.model ?? null;
    return {
      dateKey: this.state.dateKey,
      activeModel,
      allExhausted: activeModel === null,
      models,
      note: 'Tracks observed API calls made by this server today. Gemini API does not expose account-wide remaining credits via API key.',
    };
  }
}

export const quotaTracker = new QuotaTracker();
