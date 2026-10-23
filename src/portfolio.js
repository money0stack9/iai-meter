import { period, usd, demoSnapshot } from './core.js';
import { createMeter } from './provider.js';

const USD_RE = /^\d{1,92}\.\d{6}$/;
const ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const ENV_RE = /^[A-Z_][A-Z0-9_]*$/;
const OK_STATES = new Set(['ready', 'partial']);
const COUNT_KEYS = ['requests', 'totalTokens', 'promptTokens', 'completionTokens'];

function safeError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function validDate(now) {
  return now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
}

function dayOf(iso) {
  if (typeof iso !== 'string' || iso.length > 40) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}

function currentPeriod(now) {
  const day = now.toISOString().slice(0, 10);
  const reset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();
  try {
    const p = period(now);
    if (p && p.creditDayUtc === day && typeof p.resetsAt === 'string' && dayOf(p.resetsAt)) {
      return { creditDayUtc: day, resetsAt: p.resetsAt };
    }
  } catch { /* fall back */ }
  return { creditDayUtc: day, resetsAt: reset };
}

function isUsd(v) {
  return typeof v === 'string' && v.length <= 100 && USD_RE.test(v);
}

function toMicro(v) {
  const neg = v.startsWith('-');
  const [i, f] = (neg ? v.slice(1) : v).split('.');
  const m = BigInt(i) * 1000000n + BigInt(f);
  return neg ? -m : m;
}

function fmtMicro(m) {
  try {
    const out = usd(m.toString());
    if (isUsd(out) && toMicro(out) === m) return out;
  } catch { /* fall back */ }
  const neg = m < 0n;
  const a = neg ? -m : m;
  return `${neg ? '-' : ''}${a / 1000000n}.${(a % 1000000n).toString().padStart(6, '0')}`;
}

function isCount(v) {
  return Number.isSafeInteger(v) && v >= 0;
}

function hasSourceError(snap, source) {
  if (!Array.isArray(snap.errors)) return true;
  return snap.errors.some((e) => e && typeof e === 'object' && e.source === source);
}

function errorSnapshot(now, state = 'error', code = 'unexpected', message = 'Account status unavailable') {
  const iso = now.toISOString();
  const p = currentPeriod(now);
  return {
    schema: 'iai-meter.v1', state, observedAt: iso, lastSuccessAt: null,
    creditDayUtc: p.creditDayUtc, resetsAt: p.resetsAt,
    balanceObservedAt: null, usageObservedAt: null, modelsObservedAt: null,
    balance: null, usage: null, models: [],
    errors: state === 'error' ? [{ source: 'account', code, message }] : [],
    dailyAllowanceUsd: null,
  };
}

function cleanSnapshot(snap, now) {
  if (!snap || typeof snap !== 'object' || Array.isArray(snap)) return errorSnapshot(now, 'error', 'malformed', 'Malformed account snapshot');
  try {
    const s = JSON.parse(JSON.stringify(snap));
    if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error('bad');
    return s;
  } catch {
    return errorSnapshot(now, 'error', 'malformed', 'Malformed account snapshot');
  }
}

function balanceOk(s, day) {
  const b = s.balance;
  return !!b && typeof b === 'object' && isUsd(b.reportedCreditUsd) && isUsd(b.conservativeAvailableUsd)
    && dayOf(s.balanceObservedAt) === day && !hasSourceError(s, 'balance');
}

function usageOk(s, day) {
  const u = s.usage;
  return !!u && typeof u === 'object' && isUsd(u.costUsd) && COUNT_KEYS.every((k) => isCount(u[k]))
    && dayOf(s.usageObservedAt) === day && !hasSourceError(s, 'usage');
}

export function aggregateAccounts(entries, now = new Date(), { demo = false } = {}) {
  const at = validDate(now);
  const p = currentPeriod(at);
  const list = Array.isArray(entries) ? entries.slice(0, 100) : [];
  const sums = { reportedCreditUsd: 0n, conservativeAvailableUsd: 0n, costUsd: 0n };
  const counts = { requests: 0n, totalTokens: 0n, promptTokens: 0n, completionTokens: 0n };
  let balanceN = 0, usageN = 0, unconfiguredN = 0, bothN = 0;
  const accounts = [];

  list.forEach((entry, i) => {
    let id = `account-${i + 1}`, label = id, snap;
    try {
      const e = entry && typeof entry === 'object' ? entry : {};
      if (typeof e.id === 'string' && ID_RE.test(e.id)) id = e.id;
      if (typeof e.label === 'string' && e.label.trim().length >= 1) label = e.label.trim().slice(0, 80);
      snap = cleanSnapshot(e.snapshot, at);
    } catch {
      snap = errorSnapshot(at, 'error', 'malformed', 'Malformed account snapshot');
    }
    let bIn = false, uIn = false;
    try {
      if (snap.state === 'unconfigured') unconfiguredN++;
      const eligible = (OK_STATES.has(snap.state) || (demo && snap.state === 'demo'))
        && snap.creditDayUtc === p.creditDayUtc;
      if (eligible && balanceOk(snap, p.creditDayUtc)) {
        const r = toMicro(snap.balance.reportedCreditUsd), c = toMicro(snap.balance.conservativeAvailableUsd);
        sums.reportedCreditUsd += r; sums.conservativeAvailableUsd += c; bIn = true;
      }
      if (eligible && usageOk(snap, p.creditDayUtc)) {
        sums.costUsd += toMicro(snap.usage.costUsd);
        for (const k of COUNT_KEYS) counts[k] += BigInt(snap.usage[k]);
        uIn = true;
      }
    } catch { bIn = false; uIn = false; }
    if (bIn) balanceN++;
    if (uIn) usageN++;
    if (bIn && uIn) bothN++;
    accounts.push({ id, label, balanceIncluded: bIn, usageIncluded: uIn, snapshot: snap });
  });

  const n = accounts.length;
  let state;
  if (demo) state = 'demo';
  else if (n === 0 || unconfiguredN === n) state = 'unconfigured';
  else if (bothN === n) state = 'ready';
  else if (balanceN > 0 || usageN > 0) state = 'partial';
  else state = 'error';

  return {
    schema: 'iai-meter.portfolio.v1',
    state,
    generatedAt: at.toISOString(),
    creditDayUtc: p.creditDayUtc,
    resetsAt: p.resetsAt,
    resetBasis: 'utc-midnight',
    accountCount: n,
    balanceAccountCount: balanceN,
    usageAccountCount: usageN,
    totals: {
      reportedCreditUsd: balanceN ? fmtMicro(sums.reportedCreditUsd) : null,
      conservativeAvailableUsd: balanceN ? fmtMicro(sums.conservativeAvailableUsd) : null,
      costUsd: usageN ? fmtMicro(sums.costUsd) : null,
      requests: usageN ? counts.requests.toString() : null,
      totalTokens: usageN ? counts.totalTokens.toString() : null,
      promptTokens: usageN ? counts.promptTokens.toString() : null,
      completionTokens: usageN ? counts.completionTokens.toString() : null,
    },
    accounts,
    dailyAllowanceUsd: null,
  };
}

function validateConfig(accounts, env) {
  if (!Array.isArray(accounts)) throw safeError('invalid_config', 'accounts must be an array');
  if (accounts.length > 20) throw safeError('invalid_config', 'At most 20 accounts are allowed');
  const ids = new Set();
  const keys = new Map();
  return accounts.map((a, i) => {
    const where = `accounts[${i}]`;
    if (!a || typeof a !== 'object' || Array.isArray(a)) throw safeError('invalid_config', `${where} must be an object`);
    if (typeof a.id !== 'string' || !ID_RE.test(a.id)) throw safeError('invalid_config', `${where}.id is invalid`);
    if (ids.has(a.id)) throw safeError('invalid_config', `Duplicate account id: ${a.id}`);
    ids.add(a.id);
    const label = typeof a.label === 'string' ? a.label.trim() : '';
    if (label.length < 1 || label.length > 80) throw safeError('invalid_config', `${where}.label must be 1-80 characters`);
    if (typeof a.keyEnv !== 'string' || a.keyEnv.length > 128 || !ENV_RE.test(a.keyEnv)) throw safeError('invalid_config', `${where}.keyEnv is invalid`);
    const raw = env && typeof env === 'object' ? env[a.keyEnv] : undefined;
    const key = typeof raw === 'string' ? raw.trim() : '';
    if (key) {
      if (keys.has(key)) throw safeError('invalid_config', `Accounts ${keys.get(key)} and ${a.id} use the same credential`);
      keys.set(key, a.id);
    }
    return { id: a.id, label, key };
  });
}

export function createPortfolio({ accounts = [], env = process.env, now = () => new Date(), meterFactory = createMeter, demo = false } = {}) {
  const clock = () => { try { return validDate(now()); } catch { return new Date(); } };

  if (demo) {
    return {
      async getStatus() {
        const at = clock();
        const rows = [['demo-primary', 'Demo account A'], ['demo-secondary', 'Demo account B']].map(([id, label]) => {
          let snapshot;
          try { snapshot = { ...demoSnapshot(at), state: 'demo' }; } catch { snapshot = errorSnapshot(at); }
          return { id, label, snapshot };
        });
        return aggregateAccounts(rows, at, { demo: true });
      },
    };
  }

  const configs = validateConfig(accounts, env);
  const meters = configs.map((c) => {
    let meter = null;
    try { meter = meterFactory({ key: c.key || '', now: clock }); } catch { meter = null; }
    return { id: c.id, label: c.label, meter };
  });

  return {
    async getStatus() {
      const rows = await Promise.all(meters.map(async ({ id, label, meter }) => {
        let snapshot;
        try {
          if (!meter || typeof meter.getStatus !== 'function') throw new Error('no meter');
          snapshot = await meter.getStatus();
        } catch {
          snapshot = errorSnapshot(clock(), 'error', 'unexpected', 'Account status failed');
        }
        return { id, label, snapshot };
      }));
      return aggregateAccounts(rows, clock());
    },
  };
}
