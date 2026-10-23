import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const URI = 'ui://iai-meter/widget.html';
const MIME = 'text/html;profile=mcp-app';
const MAX_BODY = 64 * 1024;
const UI_META = { 'openai/ui': { entrypoints: [{ type: 'global' }, { type: 'thread' }] } };

function loadHtml() {
  const html = readFileSync(new URL('../public/widget.html', import.meta.url), 'utf8');
  return html.replace('data-mode="http"', 'data-mode="mcp"');
}

const isStr = (v) => typeof v === 'string' && v.length > 0 && v.length < 64;

function summarize(p) {
  const state = isStr(p?.state) ? p.state : 'unknown';
  const totals = p?.totals && typeof p.totals === 'object' ? p.totals : {};
  const credits = Object.entries(totals)
    .filter(([k, v]) => /^[\w.-]{1,40}$/.test(k) && typeof v === 'string' && /^\d+(\.\d+)?$/.test(v))
    .map(([k, v]) => `${k} ${/usd/i.test(k) ? '$' + v : v}`);
  const n = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0);
  const okDate = (r) => isStr(r) && !Number.isNaN(Date.parse(r));
  let reset = okDate(p?.resetsAt) ? p.resetsAt : null;
  if (!reset) {
    for (const a of Array.isArray(p?.accounts) ? p.accounts : []) {
      const r = a?.snapshot?.resetsAt;
      if (okDate(r) && (!reset || Date.parse(r) < Date.parse(reset))) reset = r;
    }
  }
  return [
    `iAI Meter 상태: ${state}`,
    `크레딧/합계: ${credits.length ? credits.join(', ') : '정보 없음'}`,
    `계정 커버리지: 전체 ${n(p?.accountCount)}개 (잔액 ${n(p?.balanceAccountCount)}개, 사용량 ${n(p?.usageAccountCount)}개)`,
    `다음 리셋: ${reset ?? '정보 없음'}`
  ].join('\n');
}

export async function createMcpServer(meter, opts = {}) {
  const html = typeof opts.html === 'string' ? opts.html : loadHtml();
  const server = new McpServer({ name: 'iai-meter', version: '0.1.0' });

  server.registerResource('iai-meter-widget', URI, {
    title: 'iAI Meter',
    description: 'iAI Meter portfolio widget',
    mimeType: MIME,
    _meta: UI_META
  }, async (uri) => ({
    contents: [{
      uri: uri.href,
      mimeType: MIME,
      text: html,
      _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } }, ...UI_META }
    }]
  }));

  server.registerTool('iai_meter_status', {
    title: 'iAI Meter status',
    description: 'Read-only AI credit/usage portfolio snapshot (no credentials).',
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    _meta: { ui: { resourceUri: URI }, 'openai/outputTemplate': URI }
  }, async () => {
    try {
      const portfolio = await meter.getStatus();
      return { structuredContent: portfolio, content: [{ type: 'text', text: summarize(portfolio) }] };
    } catch {
      return { isError: true, content: [{ type: 'text', text: 'iAI Meter 상태를 가져오지 못했습니다. 잠시 후 다시 시도하세요.' }] };
    }
  });

  return server;
}

export async function startStdio(meter) {
  const server = await createMcpServer(meter);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}

function sendErr(res, status, code, message) {
  if (res.headersSent) { try { res.end(); } catch {} return; }
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0, done = false;
    const chunks = [];
    const fail = (e) => { if (!done) { done = true; reject(e); } };
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > MAX_BODY) { fail(Object.assign(new Error('too large'), { status: 413 })); req.resume(); }
      else chunks.push(c);
    });
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks).toString('utf8')); } });
    req.on('error', () => fail(Object.assign(new Error('read'), { status: 400 })));
  });
}

export function createHttpHandler(meter) {
  let html;
  return async function mcpHttpHandler(req, res) {
    try {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return sendErr(res, 405, -32000, 'Method not allowed');
      }
      const cl = Number(req.headers['content-length']);
      if (Number.isFinite(cl) && cl > MAX_BODY) return sendErr(res, 413, -32000, 'Payload too large');
      let raw;
      try { raw = await readBody(req); }
      catch (e) { return e.status === 413 ? sendErr(res, 413, -32000, 'Payload too large') : sendErr(res, 400, -32700, 'Bad request'); }
      let body;
      try { body = JSON.parse(raw); } catch { return sendErr(res, 400, -32700, 'Parse error'); }
      if (body === null || typeof body !== 'object') return sendErr(res, 400, -32600, 'Invalid request');
      html ??= loadHtml();
      const server = await createMcpServer(meter, { html });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => {
        transport.close().catch(() => {});
        server.close().catch(() => {});
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch {
      sendErr(res, 500, -32603, 'Internal error');
    }
  };
}
