import test from 'node:test';
import assert from 'node:assert/strict';
import { createMeter } from '../src/provider.js';

const BASE = 'https://router-api.0g.ai/v1';
const SECRET = 'sk-TESTSECRET123';
const BAL = { currency: 'usd', credit_balance: '10500000', deposit_balance: '0', pending_charge: '0' };
const USE = { currency: 'usd', total_cost: '10000', total_requests: 3, total_tokens: 30, prompt_tokens: 10, completion_tokens: 20 };
const MOD = { data: [{ id: 'm1', type: 'chatbot', pricing_usd: { prompt: '0.000004', completion: '0.00002' } }] };

function rig(start = '2025-01-15T12:00:00.000Z', key = SECRET) {
  const s = { t: Date.parse(start), calls: [], mode: {}, hook: null };
  s.now = () => new Date(s.t);
  s.fetch = async (url, init) => {
    s.calls.push({ url, init });
    const k = url.includes('/balance') ? 'balance' : url.includes('/usage') ? 'usage' : 'models';
    s.hook?.(k);
    const m = s.mode[k];
    if (m?.status) return new Response('{}', { status: m.status, headers: m.headers || {} });
    const body = m?.body ?? (k === 'balance' ? BAL : k === 'usage' ? USE : MOD);
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  s.count = (k) => s.calls.filter((c) => c.url.includes(k)).length;
  s.meter = createMeter({ key, fetchImpl: s.fetch, now: s.now });
  return s;
}

test('empty key: unconfigured, no fetch', async () => {
  const s = rig(undefined, '');
  const r = await s.meter.getStatus();
  assert.equal(r.state, 'unconfigured');
  assert.equal(s.calls.length, 0);
});

test('GET, auth only on account routes, redirect error, fixed origin', async () => {
  const s = rig();
  const r = await s.meter.getStatus();
  assert.equal(r.state, 'ready');
  assert.ok(r.balance);
  for (const c of s.calls) {
    assert.ok(c.url.startsWith(BASE + '/'));
    assert.equal(c.init.method, 'GET');
    assert.equal(c.init.redirect, 'error');
    if (c.url.includes('/models')) assert.equal(c.init.headers.authorization, undefined);
    else assert.equal(c.init.headers.authorization, 'Bearer ' + SECRET);
  }
  assert.ok(s.calls.find((c) => c.url.includes('start_date=2025-01-15')));
});

test('concurrency dedupe, 60s cache, mutation isolation', async () => {
  const s = rig();
  const rs = await Promise.all([s.meter.getStatus(), s.meter.getStatus(), s.meter.getStatus()]);
  assert.equal(s.count('/balance'), 1);
  assert.notEqual(rs[0], rs[1]);
  const models = s.count('/models');
  rs[0].balance = null; rs[1].errors.push('x');
  s.t += 1000;
  const r = await s.meter.getStatus();
  assert.ok(r.balance);
  assert.deepEqual(r.errors, []);
  assert.equal(s.count('/balance'), 1);
  s.t += 60000;
  await s.meter.getStatus();
  assert.equal(s.count('/balance'), 2);
  assert.equal(s.count('/models'), models);
});

test('401 yields stale with preserved lastSuccessAt, no secret', async () => {
  const s = rig();
  const first = await s.meter.getStatus();
  s.mode.balance = { status: 401 };
  s.t += 61000;
  const r = await s.meter.getStatus();
  assert.equal(r.state, 'stale');
  assert.equal(r.lastSuccessAt, first.lastSuccessAt);
  assert.ok(r.errors.some((e) => e.source === 'balance' && e.code === 'auth'));
  assert.ok(!JSON.stringify(r).includes(SECRET));
});

test('429 retry-after blocks requests for 120s', async () => {
  const s = rig();
  s.mode.balance = { status: 429, headers: { 'retry-after': '120' } };
  const r = await s.meter.getStatus();
  assert.equal(r.state, 'error');
  assert.ok(r.errors.some((e) => e.code === 'rate_limited'));
  const n = s.calls.length;
  s.t += 61000;
  await s.meter.getStatus();
  assert.equal(s.calls.length, n);
  s.t += 60000;
  await s.meter.getStatus();
  assert.ok(s.calls.length > n);
});

test('invalid balance is error, never zero', async () => {
  const s = rig();
  s.mode.balance = { body: { balance: 'abc', currency: 'USD' } };
  const r = await s.meter.getStatus();
  assert.equal(r.state, 'error');
  assert.equal(r.balance, null);
  assert.ok(r.errors.some((e) => e.source === 'balance'));
});

test('midnight crossing discards results', async () => {
  const s = rig('2025-01-15T23:59:59.900Z');
  s.hook = (k) => { if (k === 'balance') s.t = Date.parse('2025-01-16T00:00:00.100Z'); };
  const r = await s.meter.getStatus();
  assert.ok(r.errors.some((e) => e.code === 'day_changed'));
  assert.equal(r.balance, null);
  assert.equal(r.usage, null);
});
