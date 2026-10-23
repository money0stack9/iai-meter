import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMicro, usd, period, normalizeBalance, normalizeUsage, normalizeModels, estimateTokens, demoSnapshot } from '../src/core.js';

const code = (c) => (e) => e.code === c;
const bal = (o = {}) => ({ currency: 'usd', credit_balance: '2000000', deposit_balance: '7000000', pending_charge: '500000', unsettled_charge: '250000', ...o });
const use = (o = {}) => ({ currency: 'usd', total_cost: '1', total_requests: 1, total_tokens: 3, prompt_tokens: 1, completion_tokens: 2, ...o });

test('exact micro precision', () => {
  assert.equal(usd('1'), '0.000001');
  assert.equal(usd('12345678'), '12.345678');
  assert.equal(usd('123456789012345678901234567890'), '123456789012345678901234.567890');
  assert.equal(usd(1000000n), '1.000000');
  assert.equal(parseMicro('42'), 42n);
  for (const v of ['1.5', '-1', '', ' 1', '1e6', 5, null, '9'.repeat(101)]) assert.throws(() => usd(v), code('invalid_response'));
  assert.throws(() => usd(-1n), code('invalid_response'));
});

test('balance math, unknown unsettled, invalid currency/money', () => {
  const b = normalizeBalance(bal());
  assert.equal(b.conservativeAvailableUsd, '1.250000');
  assert.equal(b.depositUsd, '7.000000');
  assert.equal(normalizeBalance(bal({ unsettled_charge: undefined })).unsettledUsd, null);
  assert.equal(normalizeBalance(bal({ pending_charge: '9000000' })).conservativeAvailableUsd, '0.000000');
  assert.throws(() => normalizeBalance(bal({ currency: 'USD' })), (e) => e.code === 'unsupported_currency' && !e.message.includes('USD'));
  assert.throws(() => normalizeBalance(bal({ credit_balance: '1.0EVIL' })), (e) => e.code === 'invalid_response' && !e.message.includes('EVIL'));
  assert.throws(() => normalizeBalance(null), code('invalid_response'));
});

test('usage counts validated', () => {
  assert.equal(normalizeUsage(use()).costUsd, '0.000001');
  for (const v of [1.5, -1, '5', NaN, 2 ** 53]) assert.throws(() => normalizeUsage(use({ total_requests: v })), code('invalid_response'));
  assert.throws(() => normalizeUsage(use({ currency: 'eur' })), code('unsupported_currency'));
});

test('UTC day boundary', () => {
  const a = period(new Date('2024-03-31T23:59:59.999Z'));
  assert.equal(a.creditDayUtc, '2024-03-31');
  assert.equal(a.resetsAt, '2024-04-01T00:00:00.000Z');
  const b = period(new Date('2024-12-31T00:00:00.000Z'));
  assert.equal(b.creditDayUtc, '2024-12-31');
  assert.equal(b.resetsAt, '2025-01-01T00:00:00.000Z');
  assert.throws(() => period(new Date('x')), code('invalid_date'));
  assert.throws(() => period('2024-01-01'), code('invalid_date'));
});

test('models filter chatbot and valid prices', () => {
  const m = normalizeModels({ data: [
    { id: 'a', type: 'chatbot', pricing_usd: { prompt: '0.000004', completion: '0.00002' } },
    { id: 'b', type: 'embedding', pricing_usd: { prompt: '0.1', completion: '0.1' } },
    { id: 'c', pricing_usd: { prompt: '0.1', completion: '0.1' } },
    { id: 'd', type: 'chatbot', pricing_usd: { prompt: '0', completion: '0.1' } },
    null
  ] });
  assert.deepEqual(m.map((x) => x.id), ['a']);
  assert.throws(() => normalizeModels({}), code('invalid_response'));
});

test('estimates exact with fractional prices and input cost', () => {
  const b = { conservativeAvailableUsd: '1.000000' };
  const m = { id: 'm', inputUsdPerToken: '0.000004', outputUsdPerToken: '0.00002' };
  assert.equal(estimateTokens(b, m).outputTokens, '50000');
  const r = estimateTokens(b, m, '100000');
  assert.equal(r.outputTokens, '30000');
  assert.equal(r.assumedInputTokens, '100000');
  assert.equal(r.isEstimate, true);
  assert.equal(estimateTokens(b, m, '250000').outputTokens, '0');
  assert.equal(estimateTokens(b, m, '999999999').outputTokens, '0');
  assert.equal(estimateTokens(b, { ...m, outputUsdPerToken: '0.000003' }).outputTokens, '333333');
  assert.equal(estimateTokens({ conservativeAvailableUsd: '0.000001' }, { ...m, outputUsdPerToken: '0.0000003' }).outputTokens, '3');
  for (const t of ['1.5', '-1', 5, '']) assert.throws(() => estimateTokens(b, m, t), code('invalid_input'));
  assert.throws(() => estimateTokens(b, { ...m, inputUsdPerToken: '0' }), code('invalid_input'));
  assert.throws(() => estimateTokens(b, { ...m, id: '' }), code('invalid_input'));
  assert.throws(() => estimateTokens({ conservativeAvailableUsd: 'x' }, m), code('invalid_input'));
});

test('demo snapshot is labeled demo', () => {
  const d = demoSnapshot(new Date('2024-05-05T12:00:00Z'));
  assert.equal(d.state, 'demo');
  assert.equal(d.schema, 'iai-meter.v1');
  assert.equal(d.creditDayUtc, '2024-05-05');
  assert.equal(d.balance.conservativeAvailableUsd, '12.000000');
  assert.equal(d.models.length, 1);
  assert.equal(d.models[0].id, 'demo-model');
  assert.equal(d.dailyAllowanceUsd, null);
});
