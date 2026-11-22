#!/usr/bin/env node
'use strict';

/*
 * AI Gateway — servidor local, compatível com a API da OpenAI.
 *
 *   node src/index.js                 sobe em http://127.0.0.1:8787
 *   node src/index.js --check         testa cada provedor conectado
 *   node src/index.js --discover      lista os modelos de cada provedor
 *   node src/index.js --no-open       não abre o navegador
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { Readable, pipeline } = require('node:stream');
const { Store } = require('./store');
const { createGateway, errObj } = require('./gateway');
const { fieldsOf } = require('./catalog');
const { safeEqual } = require('./crypto');

// ------------------------------------------------------------------- ambiente
function loadEnv(file) {
  let txt;
  try {
    txt = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 1) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

function isSea() {
  try {
    return require('node:sea').isSea();
  } catch {
    return false;
  }
}

const ROOT = isSea() ? path.dirname(process.execPath) : path.join(__dirname, '..');
loadEnv(path.join(ROOT, '.env'));

const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const WEB_DIR = path.join(ROOT, 'web');
const MAX_BODY = 4 * 1024 * 1024;

const store = new Store(DATA_DIR);
const gw = createGateway({ store, log: (m) => console.log(m) });

// ------------------------------------------------------------------- estáticos
let embedded = null;
try {
  embedded = require('./web-assets.js');
} catch {
  /* rodando do código-fonte: usa a pasta web/ */
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(pathname, res) {
  const name = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  if (!/^[\w./-]+$/.test(name) || name.includes('..')) return false;

  let body = null;
  let type = TYPES[path.extname(name)] || 'application/octet-stream';

  if (embedded && embedded[name] != null) {
    body = Buffer.from(embedded[name], 'utf8');
  } else {
    const file = path.join(WEB_DIR, name);
    try {
      body = fs.readFileSync(file);
    } catch {
      return false;
    }
  }

  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
  res.end(body);
  return true;
}

// ---------------------------------------------------------------------- http
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('corpo grande demais'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const text = (await readBody(req)).toString('utf8');
  if (text.length > MAX_BODY) throw Object.assign(new Error('corpo grande demais'), { status: 413 });
  try {
    return JSON.parse(text || '{}');
  } catch {
    throw Object.assign(new Error('JSON inválido'), { status: 400 });
  }
}

function sendJson(res, status, obj, headers) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...(headers || {}) });
  res.end(JSON.stringify(obj));
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, x-api-key',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Expose-Headers': 'X-Provider, X-Model, X-Attempts, X-Key, Retry-After',
};

function tokenFrom(req, url) {
  const auth = String(req.headers.authorization || '');
  if (/^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  if (req.headers['x-api-key']) return String(req.headers['x-api-key']).trim();
  return url.searchParams.get('token') || '';
}

async function sendWeb(res, response) {
  const headers = { ...CORS };
  for (const [k, v] of response.headers) headers[k] = v;
  res.writeHead(response.status, headers);
  if (!response.body) return res.end();
  pipeline(Readable.fromWeb(response.body), res, () => {});
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const method = req.method;

  if (method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }

  if (method === 'GET' && url.pathname === '/health') {
    return sendJson(res, 200, { ok: true, version: 2 });
  }

  // Login do painel: valida o token e não exige cabeçalho.
  if (method === 'POST' && url.pathname === '/api/login') {
    let body;
    try {
      body = await readJson(req);
    } catch (e) {
      return sendJson(res, e.status || 400, errObj(e.message, 'invalid_request'));
    }
    if (!safeEqual(body.token, store.token)) return sendJson(res, 401, errObj('Token inválido.', 'unauthorized'));
    return sendJson(res, 200, { ok: true });
  }

  const isApi = url.pathname.startsWith('/api/') || url.pathname.startsWith('/v1/');
  if (isApi) {
    const got = tokenFrom(req, url);
    if (!safeEqual(got, store.token)) {
      return sendJson(res, 401, errObj('Token inválido ou ausente.', 'unauthorized'));
    }
  }

  // ------------------------------------------------------------- OpenAI API
  if (method === 'POST' && url.pathname === '/v1/chat/completions') {
    let body;
    try {
      body = await readJson(req);
    } catch (e) {
      return sendJson(res, e.status || 400, errObj(e.message, 'invalid_request'));
    }
    const ctrl = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) ctrl.abort();
    });
    const response = await gw.chat(body, { signal: ctrl.signal });
    return sendWeb(res, response);
  }

  if (method === 'GET' && url.pathname === '/v1/models') {
    return sendJson(res, 200, { object: 'list', data: gw.modelList() });
  }

  // ------------------------------------------------------------------ painel
  if (method === 'GET' && url.pathname === '/api/status') return sendJson(res, 200, gw.status());
  if (method === 'GET' && url.pathname === '/api/usage') return sendJson(res, 200, gw.usage());
  if (method === 'GET' && url.pathname === '/api/models') return sendJson(res, 200, { data: gw.modelList() });

  if (method === 'GET' && url.pathname === '/api/keys') {
    return sendJson(res, 200, {
      keys: store.listKeys(),
      tokenMasked: store.token.slice(0, 8) + '••••' + store.token.slice(-4),
    });
  }

  if (method === 'POST' && url.pathname === '/api/keys') {
    let body;
    try {
      body = await readJson(req);
    } catch (e) {
      return sendJson(res, e.status || 400, errObj(e.message, 'invalid_request'));
    }
    const provider = gw.providers().find((p) => p.id === body.provider);
    if (!provider) return sendJson(res, 404, errObj('Provedor desconhecido.', 'not_found'));

    const fields = fieldsOf(provider);
    const values = {};
    for (const f of fields) {
      const v = String((body.values && body.values[f.name]) || '').trim();
      if (!v) return sendJson(res, 400, errObj('Preencha: ' + f.label + '.', 'invalid_request'));
      if (/\s/.test(v) || v.length > 600) return sendJson(res, 400, errObj('Valor inválido em ' + f.label + '.', 'invalid_request'));
      values[f.name] = v;
    }

    const id = store.addKey({ provider: provider.id, label: body.label, values });
    return sendJson(res, 200, { ok: true, id });
  }

  const keyRoute = url.pathname.match(/^\/api\/keys\/([\w:-]+)(?:\/(test|toggle))?$/);
  if (keyRoute) {
    const id = keyRoute[1];
    const action = keyRoute[2];

    if (method === 'DELETE' && !action) {
      const ok = store.removeKey(id);
      return sendJson(res, ok ? 200 : 404, ok ? { ok: true } : errObj('Chave não encontrada.', 'not_found'));
    }

    if (method === 'POST' && action === 'toggle') {
      let body;
      try {
        body = await readJson(req);
      } catch (e) {
        return sendJson(res, e.status || 400, errObj(e.message, 'invalid_request'));
      }
      store.setKeyDisabled(id, body.disabled !== false);
      return sendJson(res, 200, { ok: true });
    }

    if (method === 'POST' && action === 'test') {
      const key = store.keys.find((k) => k.id === id);
      if (!key) return sendJson(res, 404, errObj('Chave não encontrada.', 'not_found'));
      const provider = gw.providers().find((p) => p.id === key.provider);
      if (!provider) return sendJson(res, 404, errObj('Provedor desconhecido.', 'not_found'));
      try {
        const models = await gw.discover(provider.id);
        store.setKeyStatus(id, true, null);
        store.setKeyDisabled(id, false);
        return sendJson(res, 200, { ok: true, models: models.length });
      } catch (e) {
        const msg = String(e.message || e);
        store.setKeyStatus(id, false, msg);
        return sendJson(res, 400, errObj(msg, 'key_rejected'));
      }
    }
  }

  if (method === 'POST' && url.pathname === '/api/discover') {
    let body;
    try {
      body = await readJson(req);
    } catch (e) {
      return sendJson(res, e.status || 400, errObj(e.message, 'invalid_request'));
    }
    try {
      return sendJson(res, 200, { models: await gw.discover(body.provider) });
    } catch (e) {
      return sendJson(res, 502, errObj(String(e.message || e), 'discover_failed'));
    }
  }

  if (method === 'GET' && url.pathname === '/api/settings') {
    return sendJson(res, 200, { ...store.settings, tokenMasked: store.token.slice(0, 8) + '••••' + store.token.slice(-4) });
  }

  if (method === 'PUT' && url.pathname === '/api/settings') {
    let body;
    try {
      body = await readJson(req);
    } catch (e) {
      return sendJson(res, e.status || 400, errObj(e.message, 'invalid_request'));
    }
    return sendJson(res, 200, { ok: true, settings: store.updateSettings(body) });
  }

  if (method === 'POST' && url.pathname === '/api/check') {
    return sendJson(res, 200, { results: await gw.check() });
  }

  if (method === 'POST' && url.pathname === '/api/reset') {
    store.clearCooldowns();
    return sendJson(res, 200, { ok: true });
  }

  if (method === 'GET' && !url.pathname.startsWith('/api/') && !url.pathname.startsWith('/v1/')) {
    if (url.pathname === '/favicon.ico') {
      res.writeHead(204);
      return res.end();
    }
    if (serveStatic(url.pathname, res)) return;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(embedded ? embedded['index.html'] : fs.readFileSync(path.join(WEB_DIR, 'index.html')));
  }

  return sendJson(res, 404, errObj('Rota não encontrada.', 'not_found'));
}

// ---------------------------------------------------------------------- boot
async function main() {
  if (process.argv.includes('--check')) {
    const results = await gw.check();
    for (const r of results) console.log(r.line);
    store.flush();
    process.exit(0);
  }

  if (process.argv.includes('--discover')) {
    const i = process.argv.indexOf('--discover');
    const only = process.argv[i + 1];
    for (const p of gw.providers()) {
      if (only && !only.startsWith('--') && only !== p.id) continue;
      console.log(`\n== ${p.name} (${p.id}) ==`);
      try {
        console.log((await gw.discover(p.id)).join('\n'));
      } catch (e) {
        console.log('  ' + e.message);
      }
    }
    store.flush();
    process.exit(0);
  }

  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(HOST);
  if (!loopback && !process.env.GATEWAY_TOKEN) {
    console.error('Recusando iniciar: HOST=' + HOST + ' expõe o gateway na rede. Defina GATEWAY_TOKEN no .env.');
    process.exit(1);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (res.headersSent) return res.end();
      sendJson(res, e.status || 500, errObj(String(e.message || e), 'internal'));
    });
  });

  server.listen(PORT, HOST, () => {
    const shown = HOST === '127.0.0.1' ? 'localhost' : HOST;
    const url = `http://${shown}:${PORT}`;
    console.log(`\nAI Gateway v2 em ${url}`);
    console.log(`Chave do gateway: ${store.token}\n`);
    for (const p of gw.providers()) {
      const how = p.keys.some((k) => k.source === 'app') ? ' (pelo painel)' : p.keys.length ? ' (.env)' : '';
      console.log(`${p.keys.length ? '✓' : '–'} ${p.name.padEnd(24)} ${p.keys.length ? p.models.length + ' modelo(s)' + how : 'não conectado'}`);
    }
    if (!gw.providers().some((p) => p.keys.length)) console.log('\nAbra o painel e conecte pelo menos uma IA.');

    if (!process.argv.includes('--no-open')) {
      const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
      require('node:child_process').exec(cmd, () => {});
    }
  });

  const shutdown = () => {
    store.flush();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
