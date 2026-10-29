#!/usr/bin/env node
'use strict';

/*
 * AI Gateway (versão Node) — roda no Termux ou em qualquer máquina com Node 18+.
 * A mesma lógica roda no Cloudflare Workers (worker.js); o Actions publica lá.
 *
 *   node server.js             inicia o servidor local
 *   node server.js --check     testa cada chave com uma chamada curta
 *   node server.js --discover  lista os modelos que cada provedor oferece agora
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { Readable, pipeline } = require('stream');
const { createGateway, parseConfig } = require('./core.js');

function loadEnv(file) {
  let txt;
  try { txt = fs.readFileSync(file, 'utf8'); } catch { return; }
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
loadEnv(path.join(__dirname, '.env'));

const env = process.env;
const PORT = Number(env.PORT) || 8787;
const HOST = env.HOST || '127.0.0.1';
const STATE_FILE = env.STATE_FILE || path.join(__dirname, '.state.json');
const PROVIDERS_FILE = env.PROVIDERS_FILE ? path.resolve(env.PROVIDERS_FILE) : path.join(__dirname, 'providers.js');
const MAX_BODY = 4 * 1024 * 1024;
const INDEX_DIR = path.join(__dirname, 'public');

let cfgText = env.GATEWAY_CONFIG || '';
try { cfgText = fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'); } catch { /* opcional */ }

const STORE_FILE = env.STORE_FILE || path.join(__dirname, '.store.json');

// Guarda (em arquivo) as chaves conectadas pelo app e os códigos temporários do login.
function fileStore(file) {
  let data = {};
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* arquivo novo */ }
  const save = () => fs.promises.writeFile(file, JSON.stringify(data), { mode: 0o600 });
  const live = (k) => {
    const e = data[k];
    if (!e) return null;
    if (e.exp && Date.now() > e.exp) { delete data[k]; return null; }
    return e;
  };
  return {
    async get(k) { const e = live(k); return e ? e.v : null; },
    async put(k, v, ttl) { data[k] = { v, exp: ttl ? Date.now() + ttl * 1000 : 0 }; await save(); },
    async del(k) { if (data[k]) { delete data[k]; await save(); } },
  };
}

const gw = createGateway({
  providers: require(PROVIDERS_FILE),
  env,
  config: parseConfig(cfgText),
  log: (m) => console.log(m),
  store: fileStore(STORE_FILE),
  persist: {
    read: async () => JSON.parse(await fs.promises.readFile(STATE_FILE, 'utf8')),
    write: (s) => fs.promises.writeFile(STATE_FILE, JSON.stringify(s)),
  },
});

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('corpo grande demais'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const STATIC = { '/': 'index.html', '/index.html': 'index.html', '/config.js': 'config.js' };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && STATIC[url.pathname]) {
      const file = path.join(INDEX_DIR, STATIC[url.pathname]);
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)], 'Cache-Control': 'no-cache' });
      return res.end(fs.readFileSync(file));
    }

    const ctrl = new AbortController();
    res.on('close', () => { if (!res.writableEnded) ctrl.abort(); });
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    const request = new Request('http://' + (req.headers.host || 'localhost') + req.url, {
      method: req.method,
      headers: req.headers,
      body: hasBody ? await readBody(req) : undefined,
      signal: ctrl.signal,
    });

    const response = await gw.fetch(request, null);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (!response.body) return res.end();
    pipeline(Readable.fromWeb(response.body), res, () => {});
  } catch (e) {
    if (res.headersSent) return res.end();
    res.writeHead(e.status || 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: String(e.message || e), type: 'internal' } }));
  }
});

if (process.argv.includes('--check')) {
  console.log('Testando cada provedor com uma chamada curta...\n');
  gw.init().then(() => gw.check()).then((lines) => {
    console.log(lines.join('\n'));
    console.log('\nModelo com erro 404/400? Rode: node server.js --discover  e ajuste o config.json.');
    process.exit(0);
  });
} else if (process.argv.includes('--discover')) {
  (async () => {
    await gw.init();
    const only = process.argv[process.argv.indexOf('--discover') + 1];
    for (const p of gw.providers) {
      if (only && !only.startsWith('--') && only !== p.id) continue;
      console.log(`\n== ${p.name} (${p.id}) ==`);
      try { console.log((await gw.discover(p)).join('\n')); } catch (e) { console.log('  ' + e.message); }
    }
    process.exit(0);
  })();
} else {
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(HOST);
  if (!loopback && !env.GATEWAY_TOKEN) {
    console.error('Recusando iniciar: HOST=' + HOST + ' expõe o servidor na rede. Defina GATEWAY_TOKEN no .env.');
    process.exit(1);
  }
  gw.init().then(() => server.listen(PORT, HOST, () => {
    const shown = HOST === '127.0.0.1' ? 'localhost' : HOST;
    console.log(`AI Gateway em http://${shown}:${PORT}${env.GATEWAY_TOKEN ? '  (com token)' : ''}\n`);
    for (const p of gw.providers) {
      const how = p.source === 'app' ? ' (conectado pelo app)' : '';
      console.log(`${p.configured ? '✓' : '–'} ${p.name.padEnd(24)} ${p.configured ? p.models.length + ' modelo(s)' + how : 'não conectado'}`);
    }
    if (!gw.providers.some((p) => p.configured)) console.log(`\nNenhuma IA conectada: abra http://${shown}:${PORT}, toque em Ajustes e use "Conectar".`);
  }));
}
