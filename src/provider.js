import { normalizeBalance, normalizeUsage, normalizeModels, period } from './core.js';

const BASE = 'https://router-api.0g.ai/v1';
const MAX_BYTES = 1024 * 1024;
const MIN_TTL = 60000;
const MODELS_TTL = 600000;
const MAX_RETRY = 3600000;
const CODES = new Set(['auth', 'rate_limited', 'unavailable', 'invalid_response', 'unsupported_currency', 'timeout', 'day_changed']);

const clone = (v) => structuredClone(v);
const safeCode = (e, d = 'invalid_response') => (e && CODES.has(e.code) ? e.code : d);
class Fail extends Error { constructor(code, retryMs) { super(code); this.code = code; this.retryMs = retryMs; } }

function parseRetry(h, nowMs) {
  if (!h) return null;
  const s = String(h).trim();
  let ms = null;
  if (/^\d+$/.test(s)) ms = Number(s) * 1000;
  else { const t = Date.parse(s); if (!Number.isNaN(t)) ms = t - nowMs; }
  if (ms === null || !Number.isFinite(ms)) return null;
  return Math.min(MAX_RETRY, Math.max(0, ms));
}

async function readBounded(res) {
  const len = Number(res.headers?.get?.('content-length'));
  if (Number.isFinite(len) && len > MAX_BYTES) { try { await res.body?.cancel?.(); } catch {} throw new Fail('invalid_response'); }
  if (!res.body || typeof res.body.getReader !== 'function') {
    const t = await res.text();
    if (Buffer.byteLength(t) > MAX_BYTES) throw new Fail('invalid_response');
    return t;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) { try { await reader.cancel(); } catch {} throw new Fail('invalid_response'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

export function createMeter({ key, fetchImpl = fetch, now = () => new Date(), ttlMs = 60000 } = {}) {
  const ttl = Math.max(MIN_TTL, Number(ttlMs) || MIN_TTL);
  const c = { balance: null, usage: null, usageDay: null, models: null, balanceAt: null, usageAt: null, modelsAt: null, modelsMs: 0 };
  let lastGood = null, lastSnap = null, nextAt = 0, inflight = null;

  async function get(path, auth, normalize) {
    const headers = { 'user-agent': 'iai-meter/0.1', accept: 'application/json' };
    if (auth) headers.authorization = `Bearer ${key}`;
    try {
      let res;
      try {
        res = await fetchImpl(BASE + path, { method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(10000) });
      } catch (e) {
        throw new Fail(e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'timeout' : 'unavailable');
      }
      if (!res.ok) {
        try { await res.body?.cancel?.(); } catch {}
        if (res.status === 401 || res.status === 403) throw new Fail('auth');
        if (res.status === 429) throw new Fail('rate_limited', parseRetry(res.headers?.get?.('retry-after'), now().getTime()));
        throw new Fail('unavailable');
      }
      let text;
      try { text = await readBounded(res); } catch (e) {
        if (e instanceof Fail) throw e;
        throw new Fail(e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'timeout' : 'unavailable');
      }
      let raw;
      try { raw = JSON.parse(text); } catch { throw new Fail('invalid_response'); }
      const data = normalize(raw);
      return { ok: true, data, at: now().toISOString() };
    } catch (e) {
      return { ok: false, code: safeCode(e), retryMs: e?.retryMs ?? null };
    }
  }

  function base(p, at) {
    return { schema: 'iai-meter.v1', state: 'error', observedAt: at, lastSuccessAt: null, creditDayUtc: p.creditDayUtc, resetsAt: p.resetsAt, resetBasis: p.resetBasis, balance: null, usage: null, models: [], errors: [], dailyAllowanceUsd: null, balanceObservedAt: null, usageObservedAt: null, modelsObservedAt: null };
  }

  function failed(at, p, errors) {
    if (lastGood) return { ...clone(lastGood), state: 'stale', observedAt: at, errors };
    return { ...base(p, at), errors };
  }

  async function refresh() {
    const start = now();
    const p = period(start);
    const day = p.creditDayUtc;
    const q = `?start_date=${encodeURIComponent(day)}&end_date=${encodeURIComponent(day)}`;
    const needModels = !c.models || start.getTime() - c.modelsMs >= MODELS_TTL;
    const [b, u, m] = await Promise.all([
      get('/account/balance', true, normalizeBalance),
      get('/account/usage/stats' + q, true, normalizeUsage),
      needModels ? get('/models', false, normalizeModels) : Promise.resolve(null),
    ]);
    const end = now();
    const at = end.toISOString();
    nextAt = end.getTime() + ttl;
    const retries = [b, u, m].filter((r) => r && r.code === 'rate_limited').map((r) => r.retryMs ?? ttl);
    if (retries.length) nextAt = Math.max(nextAt, end.getTime() + Math.max(...retries));
    if (period(end).creditDayUtc !== day) return failed(at, p, [{ source: 'meter', code: 'day_changed' }]);

    const errors = [];
    if (m) {
      if (m.ok) { c.models = m.data; c.modelsAt = m.at; c.modelsMs = end.getTime(); }
      else errors.push({ source: 'models', code: m.code });
    }
    if (u.ok) { c.usage = u.data; c.usageAt = u.at; c.usageDay = day; }
    else errors.push({ source: 'usage', code: u.code });
    if (!b.ok) {
      errors.unshift({ source: 'balance', code: b.code });
      return failed(at, p, errors);
    }
    c.balance = b.data; c.balanceAt = b.at;
    const sameDayUsage = c.usageDay === day;
    const modelsValid = m ? m.ok : !!c.models;
    const snap = {
      ...base(p, at),
      state: u.ok && modelsValid ? 'ready' : 'partial',
      lastSuccessAt: at,
      balance: c.balance,
      usage: sameDayUsage ? c.usage : null,
      models: c.models || [],
      errors,
      balanceObservedAt: c.balanceAt,
      usageObservedAt: sameDayUsage ? c.usageAt : null,
      modelsObservedAt: c.models ? c.modelsAt : null,
    };
    lastGood = clone(snap);
    return snap;
  }

  async function getStatus() {
    const t = now();
    if (!key) return { ...base(period(t), t.toISOString()), state: 'unconfigured' };
    if (lastSnap && t.getTime() < nextAt) return clone(lastSnap);
    if (!inflight) {
      inflight = (async () => {
        try { lastSnap = await refresh(); }
        catch {
          const e = now();
          nextAt = e.getTime() + ttl;
          lastSnap = failed(e.toISOString(), period(e), [{ source: 'meter', code: 'unavailable' }]);
        }
        return lastSnap;
      })().finally(() => { inflight = null; });
    }
    return clone(await inflight);
  }

  return { getStatus };
}
