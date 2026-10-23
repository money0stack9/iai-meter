// Pure core of iAI Meter: parsing, exact money math, normalization, estimates.
// No network access, no floats for money, safe errors that never echo raw input.

const MAX_LEN = 100;
const MAX_ID_LEN = 200;
const MAX_MODELS = 5000;
const MICRO = 1000000n;

const MESSAGES = {
  invalid_response: '응답 형식이 올바르지 않습니다.',
  unsupported_currency: '지원하지 않는 통화입니다.',
  invalid_input: '입력값이 올바르지 않습니다.',
  invalid_date: '날짜가 올바르지 않습니다.'
};

function fail(code) {
  const err = new Error(MESSAGES[code] ?? MESSAGES.invalid_response);
  err.code = MESSAGES[code] ? code : 'invalid_response';
  return err;
}

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function digits(v, code) {
  if (typeof v !== 'string' || v.length === 0 || v.length > MAX_LEN || !/^\d+$/.test(v)) {
    throw fail(code);
  }
  return BigInt(v);
}

// Parse a strict nonnegative decimal string into an exact rational {n, d}.
function parseDecimal(v, code) {
  if (typeof v !== 'string' || v.length === 0 || v.length > MAX_LEN || !/^\d+(\.\d+)?$/.test(v)) {
    throw fail(code);
  }
  const [i, f = ''] = v.split('.');
  return { n: BigInt(i + f), d: 10n ** BigInt(f.length) };
}

function fmt(micro) {
  const whole = micro / MICRO;
  const frac = (micro % MICRO).toString().padStart(6, '0');
  return `${whole}.${frac}`;
}

export function parseMicro(value) {
  return digits(value, 'invalid_response');
}

export function usd(value) {
  if (typeof value === 'bigint') {
    if (value < 0n) throw fail('invalid_response');
    return fmt(value);
  }
  return fmt(parseMicro(value));
}

export function period(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) throw fail('invalid_date');
  const next = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1));
  return {
    creditDayUtc: date.toISOString().slice(0, 10),
    resetsAt: next.toISOString(),
    resetBasis: 'iAI daily policy 00:00 UTC'
  };
}

function requireUsd(raw) {
  if (!isObj(raw)) throw fail('invalid_response');
  if (raw.currency !== 'usd') throw fail('unsupported_currency');
}

export function normalizeBalance(raw) {
  requireUsd(raw);
  const credit = parseMicro(raw.credit_balance);
  const deposit = parseMicro(raw.deposit_balance);
  const pending = parseMicro(raw.pending_charge);
  // Missing unsettled stays unknown (null); it is never coerced to zero in output.
  const unsettled = raw.unsettled_charge === undefined || raw.unsettled_charge === null
    ? null
    : parseMicro(raw.unsettled_charge);
  let available = credit - pending - (unsettled ?? 0n);
  if (available < 0n) available = 0n;
  // Deposits are intentionally excluded from the conservative figure.
  return {
    reportedCreditUsd: fmt(credit),
    conservativeAvailableUsd: fmt(available),
    depositUsd: fmt(deposit),
    pendingUsd: fmt(pending),
    unsettledUsd: unsettled === null ? null : fmt(unsettled)
  };
}

function count(v) {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw fail('invalid_response');
  return v;
}

export function normalizeUsage(raw) {
  requireUsd(raw);
  return {
    costUsd: fmt(parseMicro(raw.total_cost)),
    requests: count(raw.total_requests),
    totalTokens: count(raw.total_tokens),
    promptTokens: count(raw.prompt_tokens),
    completionTokens: count(raw.completion_tokens),
    scope: '0G Router'
  };
}

function positivePrice(v) {
  const r = parseDecimal(v, 'invalid_response');
  if (r.n <= 0n) throw fail('invalid_response');
  return v;
}

export function normalizeModels(raw) {
  if (!isObj(raw) || !Array.isArray(raw.data) || raw.data.length > MAX_MODELS) {
    throw fail('invalid_response');
  }
  const out = [];
  for (const m of raw.data) {
    try {
      if (!isObj(m) || m.type !== 'chatbot' || !isObj(m.pricing_usd)) continue;
      if (typeof m.id !== 'string' || m.id.length === 0 || m.id.length > MAX_ID_LEN) continue;
      out.push({
        id: m.id,
        inputUsdPerToken: positivePrice(m.pricing_usd.prompt),
        outputUsdPerToken: positivePrice(m.pricing_usd.completion)
      });
    } catch {
      // Malformed entry: skip silently.
    }
  }
  return out;
}

export function estimateTokens(balance, model, inputTokens = '0') {
  if (!isObj(balance) || !isObj(model)) throw fail('invalid_input');
  if (typeof model.id !== 'string' || model.id.length === 0 || model.id.length > MAX_ID_LEN) {
    throw fail('invalid_input');
  }
  const input = digits(inputTokens, 'invalid_input');
  const a = parseDecimal(balance.conservativeAvailableUsd, 'invalid_input');
  const p = parseDecimal(model.inputUsdPerToken, 'invalid_input');
  const o = parseDecimal(model.outputUsdPerToken, 'invalid_input');
  if (p.n <= 0n || o.n <= 0n) throw fail('invalid_input');
  // remaining = a.n/a.d - input*p.n/p.d, as an exact fraction remNum/remDen.
  const remNum = a.n * p.d - input * p.n * a.d;
  const remDen = a.d * p.d;
  const outputTokens = remNum <= 0n ? 0n : (remNum * o.d) / (remDen * o.n);
  return {
    outputTokens: outputTokens.toString(),
    assumedInputTokens: input.toString(),
    modelId: model.id,
    isEstimate: true
  };
}

export function demoSnapshot(date = new Date()) {
  const p = period(date);
  const at = date.toISOString();
  // Invented, visibly demo numbers. Not real account data.
  return {
    schema: 'iai-meter.v1',
    state: 'demo',
    observedAt: at,
    lastSuccessAt: at,
    ...p,
    balanceObservedAt: at,
    usageObservedAt: at,
    modelsObservedAt: at,
    balance: normalizeBalance({
      currency: 'usd',
      credit_balance: '12345678',
      deposit_balance: '5000000',
      pending_charge: '345678',
      unsettled_charge: '0'
    }),
    usage: normalizeUsage({
      currency: 'usd',
      total_cost: '1234567',
      total_requests: 42,
      total_tokens: 123456,
      prompt_tokens: 100000,
      completion_tokens: 23456
    }),
    models: normalizeModels({
      data: [{ id: 'demo-model', type: 'chatbot', pricing_usd: { prompt: '0.000004', completion: '0.00002' } }]
    }),
    errors: [],
    dailyAllowanceUsd: null
  };
}
