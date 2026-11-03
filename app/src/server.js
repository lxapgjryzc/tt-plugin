// The local HTTP server (requirements R9.11, R9.12): the queue page, its static files and
// the API, on 127.0.0.1 only.
//
// Safety: every request must name this server in `Host` (defeats DNS rebinding), and every
// /api/ request must carry the app's secret key in `X-Chamber-Key`. A custom header makes
// browsers send a CORS preflight, which is refused and never answered with
// Access-Control-* headers, so other web pages can neither read the API nor post to it.
// The key reaches the queue page embedded in its HTML, which other origins cannot read.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { extname, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const STATIC_DIRS = ['ui', 'src', '_locales', 'icons'];
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
};
const PAGE = '/ui/options.html';
const MAX_JSON = 48 * 1024 * 1024; // three 10 MB images as data URLs from the site
const MAX_IMAGE = 11 * 1024 * 1024;
const MAX_THUMB = 2 * 1024 * 1024;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const sameKey = (a, b) => {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && timingSafeEqual(x, y);
};

const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...BASE_HEADERS, 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}
const json = (res, status, value) => send(res, status, JSON.stringify(value ?? null), { 'Content-Type': 'application/json; charset=utf-8' });

// `getApp()` returns the app, or null while it is starting (answered 503), so the port
// can be taken before the database is opened.
export function makeServer(getApp, { port }) {
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

  async function serveStatic(app, res, path) {
    const rel = normalize(decodeURIComponent(path)).replace(/^[/\\]+/, '');
    const top = rel.split(sep)[0];
    if (!STATIC_DIRS.includes(top) || rel.includes('..')) throw new HttpError(404, 'not found');
    let body;
    try {
      body = await readFile(ROOT + rel);
    } catch {
      throw new HttpError(404, 'not found');
    }
    const type = TYPES[extname(rel)] || 'application/octet-stream';
    if (`/${rel.split(sep).join('/')}` === PAGE) {
      // The page learns the key from its own HTML (and so does the extension, R9.17).
      body = Buffer.from(body.toString('utf8').replace('<head>', `<head>\n  <meta name="chamber-key" content="${app.appKey}">`));
      return send(res, 200, body, { 'Content-Type': type, 'Content-Security-Policy': "frame-ancestors 'none'", 'X-Frame-Options': 'DENY' });
    }
    return send(res, 200, body, { 'Content-Type': type });
  }

  async function serveApi(app, req, res, url) {
    const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
    const [, area, name, sub] = parts;
    const body = async () => {
      const raw = await readBody(req, MAX_JSON);
      if (!raw.length) return {};
      try { return JSON.parse(raw.toString('utf8')); } catch { throw new HttpError(400, 'bad json'); }
    };

    if (req.method === 'POST' && (area === 'call' || area === 'site')) {
      const table = area === 'call' ? app.page : app.site;
      if (!Object.hasOwn(table, name)) throw new HttpError(404, 'no such call');
      return json(res, 200, await table[name](await body()));
    }

    if (area === 'images') {
      if (req.method === 'POST' && !name) {
        const bytes = await readBody(req, MAX_IMAGE);
        const mime = String(req.headers['content-type'] || '').split(';')[0].trim();
        let fileName = 'image';
        try { fileName = decodeURIComponent(String(req.headers['x-file-name'] || 'image')); } catch { /* keep default */ }
        const [id] = await app.store.stageImages([{ data: bytes, mime, name: fileName.slice(0, 200) }]);
        return json(res, 200, { id });
      }
      if (req.method === 'GET' && name) {
        const img = app.store.imageBytes(name, sub === 'thumb' ? 'thumb' : 'data');
        if (!img) throw new HttpError(404, 'not found');
        return send(res, 200, img.bytes, { 'Content-Type': img.mime || 'application/octet-stream' });
      }
      if (req.method === 'PUT' && name && sub === 'thumb') {
        if (!(await app.store.hasImage(name))) throw new HttpError(404, 'not found');
        await app.store.setThumb(name, await readBody(req, MAX_THUMB));
        return json(res, 200, { ok: true });
      }
    }

    if (req.method === 'GET' && area === 'events') {
      res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(': hello\n\n');
      const off = app.subscribe(() => res.write('data: changed\n\n'));
      const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
      req.on('close', () => { off(); clearInterval(ping); });
      return undefined;
    }

    if (req.method === 'GET' && area === 'probe') return json(res, 200, await app.probe());
    throw new HttpError(404, 'not found');
  }

  const server = createServer(async (req, res) => {
    try {
      if (!hosts.has(String(req.headers.host || '').toLowerCase())) throw new HttpError(421, 'wrong host');
      const app = getApp();
      if (!app) throw new HttpError(503, 'starting');
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname.startsWith('/api/')) {
        // Preflights are refused: no other origin may call the API.
        if (req.method === 'OPTIONS') throw new HttpError(403, 'forbidden');
        if (!sameKey(req.headers['x-chamber-key'], app.appKey)) throw new HttpError(403, 'forbidden');
        return await serveApi(app, req, res, url);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method not allowed');
      if (url.pathname === '/') return send(res, 302, '', { Location: `${PAGE}${url.search}` });
      return await serveStatic(app, res, url.pathname);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (!res.headersSent) json(res, status, { error: e?.message || String(e) });
      else res.end();
    }
  });
  return server;
}
