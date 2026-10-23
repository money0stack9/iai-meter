import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadMeter, validateConfig } from '../src/config.js';
import { createPortfolio } from '../src/portfolio.js';
import { startHttp } from '../src/http.js';
import { createHttpHandler } from '../src/mcp.js';
import { formatStatus, parseArgs } from '../src/cli.js';

const URI = 'ui://iai-meter/widget.html';
const MIME = 'text/html;profile=mcp-app';
const SECRET = 'sk-test-SHOULD-NOT-LEAK-1234567890';
const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
let srv, meter;

before(async () => {
  meter = await loadMeter({ demo: true, env: { OPENAI_API_KEY: SECRET } });
  srv = await startHttp({ meter, port: 0, mcpHandler: createHttpHandler(meter) });
});
after(async () => { await srv?.close(); });

function raw(path, { method = 'GET', headers = {}, body } = {}) {
  const u = new URL(path, srv.url);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method, headers, agent: false }, (res) => {
      let d = ''; res.setEncoding('utf8'); res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d }));
    });
    req.on('error', reject); req.end(body);
  });
}

test('config rejects raw secrets, unknown fields, duplicates', () => {
  assert.throws(() => validateConfig({ accounts: [{ id: 'a', provider: 'openai', apiKey: SECRET }] }));
  assert.throws(() => validateConfig({ accounts: [], bogusField: true }));
  assert.throws(() => validateConfig({ accounts: [{ id: 'a', label: 'A1', keyEnv: 'K1' }, { id: 'a', label: 'A2', keyEnv: 'K2' }] }));
});

test('CLI format uses $ and real credit values', async () => {
  const p = await createPortfolio({ demo: true }).getStatus();
  assert.equal(p.totals.reportedCreditUsd, '24.691356');
  const s = formatStatus(p);
  assert.equal(typeof s, 'string');
  assert.match(s, /\$24\.691356/);
  assert.match(s, /24\.000000/);
  assert.doesNotMatch(s, /\$\s*-|credit[^\n]*:\s*-\s*$/im);
});

test('CLI rejects bad port and unknown flags', () => {
  for (const p of ['abc', '-1', '70000', '1.5']) assert.throws(() => parseArgs(['serve', '--port', p]));
  assert.throws(() => parseArgs(['--definitely-unknown']));
});

test('HTTP status/health/html and guards', async () => {
  const st = await raw('/api/v1/status');
  assert.equal(st.status, 200);
  assert.ok(!st.body.includes(SECRET));
  const j = JSON.parse(st.body);
  assert.equal(j.totals.reportedCreditUsd, '24.691356');
  assert.equal(j.totals.totalTokens, '246912');
  const h = await raw('/healthz');
  assert.equal(h.status, 200);
  assert.ok(Object.keys(JSON.parse(h.body)).length <= 2);
  assert.ok(!h.body.includes(SECRET));
  assert.equal((await raw('/api/v1/status', { headers: { Host: 'evil.example' } })).status, 421);
  assert.equal((await raw('/api/v1/status', { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await raw('/api/v1/status', { headers: { Origin: 'null' } })).status, 403);
  assert.equal((await raw('/api/v1/status', { method: 'DELETE' })).status, 405);
  const page = await raw('/');
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /^text\/html/);
  assert.ok(page.headers['content-security-policy']);
});

test('MCP HTTP rejects invalid JSON and oversized bodies', async () => {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  assert.equal((await raw('/mcp', { method: 'POST', headers, body: '{bad' })).status, 400);
  assert.equal((await raw('/mcp', { method: 'POST', headers, body: JSON.stringify({ x: 'a'.repeat(70 * 1024) }) })).status, 413);
});

async function exercise(client) {
  const { tools } = await client.listTools();
  const tool = tools.find((t) => t.name === 'iai_meter_status');
  assert.ok(tool);
  assert.equal(tool._meta?.ui?.resourceUri, URI);
  const r = await client.callTool({ name: 'iai_meter_status', arguments: {} });
  assert.ok(!r.isError);
  const sc = r.structuredContent;
  assert.deepEqual(sc.totals, (await createPortfolio({ demo: true }).getStatus()).totals);
  const text = r.content.find((c) => c.type === 'text').text;
  assert.ok(sc.resetsAt && text.includes(sc.resetsAt));
  assert.doesNotMatch(text, /다음 리셋: 정보 없음/);
  assert.ok(!JSON.stringify(r).includes(SECRET));
  const res = await client.readResource({ uri: URI });
  const c = res.contents[0];
  assert.equal(c.mimeType, MIME);
  assert.match(c.text, /data-mode="mcp"/);
  assert.deepEqual(c._meta.ui.csp.connectDomains, []);
}

test('real SDK HTTP client', async () => {
  const client = new Client({ name: 'it', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', srv.url));
  try { await client.connect(transport); await exercise(client); }
  finally { await client.close().catch(() => {}); await transport.close().catch(() => {}); }
});

test('real SDK stdio client (demo, no keys)', async () => {
  const client = new Client({ name: 'it', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, 'mcp', '--demo'], env: { PATH: process.env.PATH ?? '' }, stderr: 'ignore' });
  try { await client.connect(transport); await exercise(client); }
  finally { await client.close().catch(() => {}); }
});
