// Local web app: `npm start`, then open http://localhost:5180
//
// Security:
//  - listens on 127.0.0.1 only
//  - serves a fixed whitelist of files (never the keys folder)
//  - secret keys are written to disk and never sent to the browser

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { availableParallelism } from 'node:os';
import { Search, defaultThreads } from './src/search.js';
import { difficulty, validate } from './src/pattern.js';

const root = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT) || 5180;
const host = '127.0.0.1';

const FONTS = ['sans-latin-400-normal', 'sans-latin-400-italic', 'sans-latin-500-normal', 'sans-latin-600-normal',
  'mono-latin-400-normal', 'mono-latin-500-normal', 'mono-latin-600-normal'].map((f) => `/assets/fonts/ibm-plex-${f}.woff2`);
const PUBLIC = new Set([
  '/index.html', '/web/app.js', '/web/style.css', '/assets/logo.svg',
  '/src/grover.js', '/src/pattern.js', '/src/base58.js', ...FONTS,
]);
const TYPES = { '.woff2': 'font/woff2', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

let search = null;
const clients = new Set();
const send = (event, data) => {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
};
const pub = (s) => ({ ...s, difficulty: { ...s.difficulty, classical: s.difficulty.classical, naive: s.difficulty.naive } });

async function body(req) {
  let s = '';
  for await (const chunk of req) {
    s += chunk;
    if (s.length > 4096) throw new Error('body too large');
  }
  return s ? JSON.parse(s) : {};
}

const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
};

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${host}`);
  const path = url.pathname === '/' ? '/index.html' : url.pathname;
  try {
    if (path === '/api/info') {
      return json(res, 200, { cores: availableParallelism?.() ?? 2, threads: defaultThreads(), running: !!search?.running, stats: search ? pub(search.stats()) : null });
    }
    if (path === '/api/estimate') {
      const opts = { prefix: url.searchParams.get('prefix') || '', suffix: url.searchParams.get('suffix') || '', ignoreCase: url.searchParams.get('ic') === '1' };
      return json(res, 200, { errors: validate(opts), ...difficulty(opts) });
    }
    if (path === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(': connected\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (path === '/api/start' && req.method === 'POST') {
      if (search?.running) return json(res, 409, { error: 'a search is already running' });
      const b = await body(req);
      const opts = {
        prefix: String(b.prefix || '').slice(0, 10),
        suffix: String(b.suffix || '').slice(0, 10),
        ignoreCase: !!b.ignoreCase,
        threads: Math.max(1, Math.min(availableParallelism?.() ?? 2, parseInt(b.threads, 10) || defaultThreads())),
        count: Math.max(1, Math.min(20, parseInt(b.count, 10) || 1)),
        outDir: join(root, 'keys'),
      };
      const errors = validate(opts);
      if (errors.length) return json(res, 400, { errors });
      search = new Search(opts);
      search.on('progress', (s) => send('progress', pub(s)));
      search.on('found', (h) => send('found', { address: h.address, file: relative(root, h.file), tries: h.tries, seconds: h.seconds }));
      search.on('stop', (s) => send('stop', pub(s)));
      search.start();
      return json(res, 200, { ok: true, difficulty: search.diff, threads: opts.threads });
    }
    if (path === '/api/stop' && req.method === 'POST') {
      if (search?.running) await search.stop('stopped');
      return json(res, 200, { ok: true });
    }
    if (!PUBLIC.has(path)) { res.writeHead(404).end('not found'); return; }
    const file = join(root, path);
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  } catch (e) {
    json(res, 500, { error: String(e.message || e) });
  }
}).listen(port, host, () => {
  console.log(`\n  QUANTUM VANITY\n  open http://localhost:${port}\n  keys are saved to ./keys and never leave this machine\n`);
});

process.on('SIGINT', async () => {
  if (search?.running) await search.stop('shutdown');
  process.exit(0);
});
