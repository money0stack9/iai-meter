import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const BIND = new Set(['127.0.0.1', '::1']);
const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";
const BASE = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' };

function send(res, code, type, body, extra = {}) {
  if (res.headersSent) return;
  res.writeHead(code, { ...BASE, 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), ...extra });
  res.end(body);
}
const json = (res, code, obj, extra) => send(res, code, 'application/json; charset=utf-8', JSON.stringify(obj), extra);
const fail = (res, code, error, message, extra) => json(res, code, { ok: false, error, message }, extra);

function models(status) {
  return {
    accounts: (status?.accounts ?? []).map((a) => ({
      id: a.id,
      label: a.label,
      models: (Array.isArray(a.snapshot?.models) ? a.snapshot.models : []).map((m) => ({
        id: m.id, inputUsdPerToken: m.inputUsdPerToken ?? null, outputUsdPerToken: m.outputUsdPerToken ?? null,
      })),
    })),
  };
}

export async function startHttp({ meter, port = 8787, host = '127.0.0.1', mcpHandler } = {}) {
  if (!meter || typeof meter.getStatus !== 'function') throw new Error('meter가 필요합니다.');
  if (!BIND.has(host)) throw new Error('루프백 주소(127.0.0.1 또는 ::1)에만 바인딩할 수 있습니다.');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('포트가 올바르지 않습니다.');
  let html = null;
  try { html = await readFile(new URL('../public/widget.html', import.meta.url), 'utf8'); } catch { html = null; }
  let allowedHosts = new Set();

  const server = createServer(async (req, res) => {
    try {
      const h = req.headers.host;
      if (!h || !allowedHosts.has(h.toLowerCase())) return fail(res, 421, 'bad_host', '허용되지 않은 Host입니다.');
      const origin = req.headers.origin;
      if (origin !== undefined && origin !== `http://${h.toLowerCase()}`) return fail(res, 403, 'bad_origin', '허용되지 않은 Origin입니다.');
      if (String(req.headers['sec-fetch-site'] ?? '').toLowerCase() === 'cross-site') return fail(res, 403, 'cross_site', '교차 사이트 요청은 허용되지 않습니다.');
      let path;
      try { path = new URL(req.url, 'http://local').pathname; } catch { return fail(res, 400, 'bad_request', '잘못된 요청입니다.'); }
      if (path === '/mcp' && mcpHandler) {
        if (req.method !== 'GET' && req.method !== 'POST') return fail(res, 405, 'method_not_allowed', '허용되지 않은 메서드입니다.', { Allow: 'GET, POST' });
        return await mcpHandler(req, res);
      }
      if (req.method !== 'GET') return fail(res, 405, 'method_not_allowed', 'GET 요청만 허용됩니다.', { Allow: 'GET' });
      if (path === '/healthz') return json(res, 200, { ok: true });
      if (path === '/api/v1/status' || path === '/api/v1/models') {
        let status;
        try { status = await meter.getStatus(); } catch { return fail(res, 503, 'status_unavailable', '상태를 가져오지 못했습니다.'); }
        return json(res, 200, path === '/api/v1/status' ? status : models(status));
      }
      if (path === '/' || path === '/widget') {
        if (html === null) return fail(res, 503, 'widget_unavailable', '위젯 파일을 사용할 수 없습니다.');
        return send(res, 200, 'text/html; charset=utf-8', html, { 'Content-Security-Policy': CSP });
      }
      return fail(res, 404, 'not_found', '찾을 수 없습니다.');
    } catch {
      fail(res, 503, 'internal_error', '요청을 처리하지 못했습니다.');
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.setTimeout(30000);

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(); });
  });
  const actual = server.address().port;
  allowedHosts = new Set([`localhost:${actual}`, `127.0.0.1:${actual}`, `[::1]:${actual}`]);
  const url = `http://${host === '::1' ? '[::1]' : host}:${actual}/`;
  let closed = false;
  return {
    server,
    url,
    close: async () => {
      if (closed) return;
      closed = true;
      await new Promise((r) => { server.close(() => r()); server.closeAllConnections?.(); });
    },
  };
}
