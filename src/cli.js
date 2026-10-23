#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadMeter } from './config.js';
import { startHttp } from './http.js';

const HELP = `iAI Meter
사용법: iai-meter [명령] [옵션]
  status [--json]            계정 상태 (기본)
  demo [--json]              데모 데이터 상태
  serve [--demo] [--port N]  로컬 HTTP 위젯 (127.0.0.1)
  mcp [--demo]               MCP stdio 서버
  help                       도움말
공통: --config FILE  (키는 환경변수로만 전달)`;

const ALLOWED = { status: ['json'], demo: ['json'], serve: ['demo', 'port'], mcp: ['demo'], help: [] };
class UsageError extends Error {}

export function parseArgs(argv) {
  const out = { cmd: 'status', json: false, demo: false, port: 8787, config: undefined };
  const args = [...argv];
  if (args[0] && !args[0].startsWith('-')) out.cmd = args.shift();
  if (!(out.cmd in ALLOWED)) throw new UsageError('알 수 없는 명령입니다.');
  const seen = new Set();
  while (args.length) {
    const a = args.shift();
    const name = a.startsWith('--') ? a.slice(2) : null;
    if (!name || seen.has(name) || (name !== 'config' && !ALLOWED[out.cmd].includes(name))) throw new UsageError('알 수 없는 인수입니다.');
    seen.add(name);
    if (name === 'json') out.json = true;
    else if (name === 'demo') out.demo = true;
    else if (name === 'port') {
      const v = args.shift();
      if (!v || !/^\d{1,5}$/.test(v) || Number(v) > 65535) throw new UsageError('포트가 올바르지 않습니다.');
      out.port = Number(v);
    } else if (name === 'config') {
      const v = args.shift();
      if (!v || v.startsWith('--')) throw new UsageError('--config 파일 경로가 필요합니다.');
      out.config = v;
    }
  }
  if (out.cmd === 'demo') out.demo = true;
  return out;
}

const usd = (v) => (typeof v === 'string' && /^\d+\.\d{6}$/.test(v) ? `$${v}` : '-');
const STATE = { ready: '정상', partial: '부분', error: '오류', unconfigured: '미설정', demo: '데모' };

export function formatStatus(p) {
  const t = p.totals ?? {};
  const n = p.accountCount ?? 0;
  const lines = [
    `iAI Meter 상태: ${STATE[p.state] ?? p.state}`,
    `범위: 잔액 ${p.balanceAccountCount ?? 0}/${n}개, 사용량 ${p.usageAccountCount ?? 0}/${n}개 계정`,
    `보고 크레딧: ${usd(t.reportedCreditUsd)} · 보수적 사용 가능: ${usd(t.conservativeAvailableUsd)}`,
    `오늘 비용${p.creditDayUtc ? ` (${p.creditDayUtc} UTC)` : ''}: ${usd(t.costUsd)} · 토큰 ${t.totalTokens ?? '-'}`,
    `리셋: ${p.resetsAt ?? '-'}`,
    '계정:',
  ];
  for (const a of p.accounts ?? []) {
    const st = a.snapshot?.state ?? a.state ?? '-';
    lines.push(`  - ${a.label} (${a.id}): ${STATE[st] ?? st} · 잔액 ${a.balanceIncluded ? '포함' : '제외'} · 사용량 ${a.usageIncluded ? '포함' : '제외'}`);
  }
  return lines.join('\n');
}

export async function main(argv = process.argv.slice(2), io = { stdout: process.stdout, stderr: process.stderr }) {
  let opts;
  try { opts = parseArgs(argv); } catch (e) {
    io.stderr.write(`${e instanceof UsageError ? e.message : '인수 오류'}\n${HELP}\n`);
    return 2;
  }
  if (opts.cmd === 'help') { io.stdout.write(`${HELP}\n`); return 0; }
  try {
    const meter = await loadMeter({ configPath: opts.config ?? process.env.IAI_CONFIG_FILE, demo: opts.demo });
    if (opts.cmd === 'mcp') {
      const { startStdio } = await import('./mcp.js');
      await startStdio(meter);
      return null;
    }
    if (opts.cmd === 'serve') {
      const { createHttpHandler } = await import('./mcp.js');
      const srv = await startHttp({ meter, port: opts.port, mcpHandler: createHttpHandler(meter) });
      io.stderr.write(`iAI Meter 위젯: ${srv.url}widget\n`);
      const stop = () => { srv.close().finally(() => process.exit(0)); };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      return null;
    }
    const p = await meter.getStatus();
    io.stdout.write(opts.json ? `${JSON.stringify(p, null, 2)}\n` : `${formatStatus(p)}\n`);
    return p.state === 'error' || p.state === 'unconfigured' ? 1 : 0;
  } catch (e) {
    const message = e?.code === 'invalid_config' ? e.message : '실행 중 오류가 발생했습니다.';
    if (opts.json) io.stdout.write(`${JSON.stringify({ ok: false, error: e?.code === 'invalid_config' ? 'invalid_config' : 'runtime_error', message })}\n`);
    else io.stderr.write(`${message}\n`);
    return 1;
  }
}

function isEntry() {
  try { return !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
}

if (isEntry()) {
  main().then((code) => { if (code !== null) process.exitCode = code; });
}
