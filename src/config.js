import { readFile, stat } from 'node:fs/promises';
import { createPortfolio } from './portfolio.js';

const MAX_BYTES = 64 * 1024;
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const ENV_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const TOP = new Set(['accounts']);
const ACC = new Set(['id', 'label', 'keyEnv']);
const RAW = /^(key|apikey|api_key|secret|token|password|managementkey|management_key|authorization|bearer)$/i;

export class ConfigError extends Error {
  constructor(message) { super(message); this.name = 'ConfigError'; this.code = 'invalid_config'; }
}
const bad = (m = '설정 파일 형식이 올바르지 않습니다.') => new ConfigError(m);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function checkFields(o, allowed) {
  for (const k of Object.keys(o)) {
    if (RAW.test(k)) throw bad('설정에 키 원문을 넣을 수 없습니다. keyEnv에 환경변수 이름만 지정하세요.');
    if (!allowed.has(k)) throw bad('설정에 알 수 없는 항목이 있습니다.');
  }
}

export function validateConfig(cfg) {
  if (!isObj(cfg)) throw bad();
  checkFields(cfg, TOP);
  if (!Array.isArray(cfg.accounts) || cfg.accounts.length < 1 || cfg.accounts.length > 16) throw bad('accounts는 1~16개 계정 배열이어야 합니다.');
  const ids = new Set();
  return cfg.accounts.map((a) => {
    if (!isObj(a)) throw bad();
    checkFields(a, ACC);
    if (typeof a.id !== 'string' || !ID_RE.test(a.id)) throw bad('계정 id 형식이 올바르지 않습니다.');
    if (ids.has(a.id)) throw bad('계정 id가 중복되었습니다.');
    ids.add(a.id);
    if (typeof a.label !== 'string' || !a.label.trim() || a.label.length > 64) throw bad('계정 label이 올바르지 않습니다.');
    if (typeof a.keyEnv !== 'string' || !ENV_RE.test(a.keyEnv)) throw bad('keyEnv는 대문자 환경변수 이름이어야 합니다.');
    return { id: a.id, label: a.label.trim(), keyEnv: a.keyEnv };
  });
}

async function readConfig(path) {
  let text;
  try {
    const s = await stat(path);
    if (!s.isFile()) throw bad('설정 파일을 읽을 수 없습니다.');
    if (s.size > MAX_BYTES) throw bad('설정 파일이 너무 큽니다 (최대 64KB).');
    text = await readFile(path, 'utf8');
  } catch (e) {
    if (e instanceof ConfigError) throw e;
    throw bad('설정 파일을 읽을 수 없습니다.');
  }
  if (Buffer.byteLength(text) > MAX_BYTES) throw bad('설정 파일이 너무 큽니다 (최대 64KB).');
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw bad('설정 파일이 올바른 JSON이 아닙니다.'); }
  return validateConfig(parsed);
}

export const DEFAULT_ACCOUNTS = Object.freeze([{ id: 'primary', label: '내 계정', keyEnv: 'IAI_MANAGEMENT_KEY' }]);

export async function loadMeter({ configPath = process.env.IAI_CONFIG_FILE, env = process.env, demo = false } = {}) {
  if (demo) return createPortfolio({ accounts: [], env: {}, demo: true });
  const accounts = configPath ? await readConfig(String(configPath)) : DEFAULT_ACCOUNTS.map((a) => ({ ...a }));
  return createPortfolio({ accounts, env });
}
