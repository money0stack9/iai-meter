import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateAccounts, createPortfolio } from '../src/portfolio.js';
import { demoSnapshot } from '../src/core.js';

const NOW = new Date('2025-01-15T12:00:00.000Z');
const ISO = NOW.toISOString();
function snap(o = {}, b = {}, u = {}) {
  const d = structuredClone(demoSnapshot(NOW));
  return { ...d, state: 'ready', creditDayUtc: '2025-01-15', observedAt: ISO, balanceObservedAt: ISO, usageObservedAt: ISO, errors: [],
    balance: { ...(d.balance || {}), reportedCreditUsd: '1.500000', conservativeAvailableUsd: '1.000000', ...b },
    usage: { ...(d.usage || {}), costUsd: '0.100000', requests: 1, totalTokens: 10, promptTokens: 4, completionTokens: 6, ...u }, ...o };
}
const agg = (...ss) => aggregateAccounts(ss.map((s, i) => ({ id: 'a' + i, label: 'A' + i, snapshot: s })), NOW);

test('two accounts exact sums', () => {
  const r = agg(snap(), snap({}, { reportedCreditUsd: '2.250000', conservativeAvailableUsd: '0.000001' }, { costUsd: '0.200000', requests: 2 }));
  assert.equal(r.state, 'ready');
  assert.equal(r.totals.reportedCreditUsd, '3.750000');
  assert.equal(r.totals.conservativeAvailableUsd, '1.000001');
  assert.equal(r.totals.costUsd, '0.300000');
  assert.equal(r.totals.requests, '3');
  assert.equal(r.totals.totalTokens, '20');
});

test('missing account excluded; partial not zero', () => {
  const r = agg(snap(), { ...snap(), balance: null, usage: null, state: 'error' });
  assert.equal(r.state, 'partial');
  assert.equal(r.totals.reportedCreditUsd, '1.500000');
  const e = agg({ ...snap(), state: 'error', balance: null, usage: null });
  assert.equal(e.state, 'error');
  assert.equal(e.totals.reportedCreditUsd, null);
  assert.equal(e.totals.requests, null);
});

test('stale and old UTC day excluded', () => {
  const old = '2025-01-14T23:00:00.000Z';
  const r = agg(snap({ state: 'stale' }), snap({ creditDayUtc: '2025-01-14', balanceObservedAt: old, usageObservedAt: old }), snap({ balanceObservedAt: old, usageObservedAt: old }));
  assert.equal(r.balanceAccountCount, 0);
  assert.equal(r.usageAccountCount, 0);
  assert.equal(r.totals.costUsd, null);
});

test('latest usage error excludes retained usage', () => {
  const r = agg(snap({ state: 'partial', errors: [{ source: 'usage', code: 'rate_limited' }] }));
  assert.equal(r.accounts[0].balanceIncluded, true);
  assert.equal(r.accounts[0].usageIncluded, false);
  assert.equal(r.totals.costUsd, null);
  assert.equal(r.state, 'partial');
});

test('negative and invalid amounts excluded', () => {
  const r = agg(snap({}, { reportedCreditUsd: '-1.000000' }), snap({}, { conservativeAvailableUsd: '1.0' }, { costUsd: '-0.100000' }), snap({}, {}, { requests: -1 }), snap({}, {}, { totalTokens: 1.5 }));
  assert.equal(r.balanceAccountCount, 2);
  assert.equal(r.usageAccountCount, 1);
  assert.equal(r.totals.reportedCreditUsd, '3.000000');
});

test('counts beyond safe integer stay strings', () => {
  const M = Number.MAX_SAFE_INTEGER;
  const r = agg(snap({}, {}, { requests: M, totalTokens: M }), snap({}, {}, { requests: M, totalTokens: M }));
  assert.equal(r.totals.requests, '18014398509481982');
  assert.equal(typeof r.totals.totalTokens, 'string');
});

test('duplicate ids and shared credentials rejected without secret', () => {
  const f = () => ({ getStatus: async () => snap() });
  assert.throws(() => createPortfolio({ accounts: [{ id: 'a', label: 'A', keyEnv: 'K1' }, { id: 'a', label: 'B', keyEnv: 'K2' }], env: {}, meterFactory: f }), { code: 'invalid_config' });
  try {
    createPortfolio({ accounts: [{ id: 'a', label: 'A', keyEnv: 'K1' }, { id: 'b', label: 'B', keyEnv: 'K2' }], env: { K1: 'sk-SECRET9', K2: ' sk-SECRET9 ' }, meterFactory: f });
    assert.fail('should throw');
  } catch (e) { assert.equal(e.code, 'invalid_config'); assert.ok(!e.message.includes('sk-SECRET9')); }
});

test('meter errors never leak secret', async () => {
  const p = createPortfolio({ accounts: [{ id: 'a', label: 'A', keyEnv: 'K1' }], env: { K1: 'sk-SECRET9' }, now: () => NOW,
    meterFactory: ({ key }) => ({ getStatus: async () => { throw new Error('boom ' + key); } }) });
  const r = await p.getStatus();
  assert.equal(r.state, 'error');
  assert.ok(!JSON.stringify(r).includes('sk-SECRET9'));
});

test('demo uses no factory or network', async (t) => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network'); };
  t.after(() => { globalThis.fetch = orig; });
  const p = createPortfolio({ demo: true, now: () => NOW, meterFactory: () => { throw new Error('factory'); } });
  const r = await p.getStatus();
  assert.equal(r.state, 'demo');
  assert.equal(r.accountCount, 2);
});
