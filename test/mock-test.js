'use strict';
// Sobe provedores falsos e o gateway de verdade, e confere: fallback, cooldown,
// streaming, corte de contexto, token, conexão de chaves pelo app (colar chave
// e login OAuth com PKCE) e se as chaves sobrevivem a um reinício, criptografadas.

const http = require('http');
const net = require('net');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');
const { spawn } = require('child_process');

const hits = { a: 0, b: 0, c: 0, d: 0, e: 0 };
let lastC = null;
let lastChallenge = '';

function mock(id, handler) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        hits[id]++;
        handler(req, res, body ? JSON.parse(body) : {});
      });
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

const freePort = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});

const reply = (res, status, obj, headers) => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...(headers || {}) });
  res.end(JSON.stringify(obj));
};

(async () => {
  const A = await mock('a', (req, res) => reply(res, 429, { error: { message: 'Rate limit reached for tokens per minute' } }, { 'Retry-After': '120' }));
  const B = await mock('b', (req, res) => reply(res, 402, { error: { message: 'Insufficient credits' } }));
  const C = await mock('c', (req, res, body) => {
    lastC = body;
    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'ol' } }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'á' } }] }) + '\n\n');
      res.end('data: [DONE]\n\n');
    } else reply(res, 200, { choices: [{ message: { role: 'assistant', content: 'olá' } }] });
  });
  // D: provedor que só aceita a chave "goodkey" (para testar colar a chave no app)
  const D = await mock('d', (req, res) => {
    if (req.headers.authorization !== 'Bearer goodkey') return reply(res, 401, { error: { message: 'bad key' } });
    if (req.method === 'GET') return reply(res, 200, { data: [{ id: 'd1' }] });
    reply(res, 200, { choices: [{ message: { role: 'assistant', content: 'dd' } }] });
  });
  // E: provedor com login OAuth (PKCE) + endpoint que troca o código pela chave
  const E = await mock('e', (req, res, body) => {
    if (req.url === '/token') {
      const want = crypto.createHash('sha256').update(String(body.code_verifier)).digest('base64url');
      if (body.code !== 'abc' || body.code_challenge_method !== 'S256' || want !== lastChallenge) {
        return reply(res, 403, { error: { message: 'Invalid code or code_verifier' } });
      }
      return reply(res, 200, { key: 'oauth-key' });
    }
    if (req.headers.authorization !== 'Bearer oauth-key') return reply(res, 401, { error: { message: 'bad key' } });
    reply(res, 200, { choices: [{ message: { role: 'assistant', content: 'ee' } }] });
  });
  const url = (s) => 'http://127.0.0.1:' + s.address().port + '/v1';
  const eRoot = 'http://127.0.0.1:' + E.address().port;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-test-'));
  const provFile = path.join(dir, 'providers.js');
  const storeFile = path.join(dir, 'store.json');
  fs.writeFileSync(provFile, 'module.exports = ' + JSON.stringify([
    { id: 'a', name: 'A', baseUrl: url(A), keyEnv: 'A_KEY', models: [{ id: 'a1' }, { id: 'a2' }] },
    { id: 'b', name: 'B', baseUrl: url(B), keyEnv: 'B_KEY', models: [{ id: 'b1' }] },
    { id: 'c', name: 'C', baseUrl: url(C), keyEnv: 'C_KEY', maxChars: 600, models: [{ id: 'c1', code: true }] },
    { id: 'd', name: 'D sem chave', baseUrl: url(D), keyEnv: 'D_KEY', keyUrl: 'https://example.com/keys', models: [{ id: 'd1' }] },
    { id: 'e', name: 'E com login', baseUrl: url(E), keyEnv: 'E_KEY', keyUrl: 'https://example.com', oauth: { authUrl: eRoot + '/auth', tokenUrl: eRoot + '/token' }, models: [{ id: 'e1' }] },
  ]));

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let log = '';
  let child;

  async function startGateway() {
    child = spawn('node', [path.join(__dirname, '..', 'server.js')], {
      env: {
        ...process.env, PORT: String(port), HOST: '127.0.0.1', GATEWAY_TOKEN: 'segredo',
        PROVIDERS_FILE: provFile, STATE_FILE: path.join(dir, 'state.json'), STORE_FILE: storeFile,
        A_KEY: 'x', B_KEY: 'x', C_KEY: 'x', D_KEY: '', E_KEY: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (d) => (log += d));
    child.stderr.on('data', (d) => (log += d));
    for (let i = 0; i < 60; i++) {
      try { const r = await fetch(base + '/health'); if (r.ok) return; } catch { /* ainda subindo */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('gateway não subiu');
  }
  async function stopGateway() {
    if (!child) return;
    await new Promise((resolve) => { child.once('exit', resolve); child.kill(); });
  }

  const H = { 'Content-Type': 'application/json', Authorization: 'Bearer segredo' };
  const chat = (body, headers = H) => fetch(base + '/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify(body) });
  const post = (p, body, headers = H) => fetch(base + p, { method: 'POST', headers, body: JSON.stringify(body || {}) });
  const status = async () => (await (await fetch(base + '/api/status', { headers: H })).json());
  const prov = (st, id) => st.providers.find((p) => p.id === id);
  const msgs = [{ role: 'user', content: 'oi' }];

  let n = 0;
  const ok = (name) => { console.log(`  ✓ ${name}`); n++; };

  await startGateway();
  try {
    // 1. token
    let r = await chat({ messages: msgs }, { 'Content-Type': 'application/json' });
    assert.strictEqual(r.status, 401); ok('sem token → 401');

    // 2. fallback A(429, 2 modelos) → B(402) → C(ok)
    r = await chat({ messages: msgs });
    let j = await r.json();
    assert.strictEqual(r.status, 200, JSON.stringify(j));
    assert.strictEqual(j.gateway.provider, 'c');
    assert.strictEqual(j.choices[0].message.content, 'olá');
    assert.strictEqual(r.headers.get('x-provider'), 'c');
    assert.deepStrictEqual(j.gateway.attempts.map((a) => a.provider + ':' + a.status), ['a:429', 'a:429', 'b:402']);
    ok('429 (2 modelos do A) e 402 (B) passam adiante e o C responde');

    // 3. cooldown
    const before = { ...hits };
    r = await chat({ messages: msgs });
    j = await r.json();
    assert.strictEqual(j.gateway.provider, 'c');
    assert.strictEqual(hits.a, before.a); assert.strictEqual(hits.b, before.b);
    assert.strictEqual(hits.c, before.c + 1);
    ok('provedores esgotados são pulados sem nova chamada');

    // 4. status
    let st = await status();
    const pa = prov(st, 'a');
    assert.ok(pa.models.every((m) => m.cooldown && m.cooldown.seconds > 60));
    assert.ok(prov(st, 'b').cooldown);
    assert.strictEqual(prov(st, 'd').configured, false);
    assert.strictEqual(prov(st, 'c').source, 'env');
    assert.strictEqual(prov(st, 'e').login, 'oauth');
    assert.strictEqual(prov(st, 'd').login, 'key');
    assert.strictEqual(prov(st, 'd').fields[0].name, 'D_KEY');
    ok('/api/status reflete cooldowns, origem da chave e tipo de login');

    // 5. streaming
    r = await chat({ messages: msgs, stream: true });
    const txt = await r.text();
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers.get('x-provider'), 'c');
    assert.ok(txt.includes('"ol"') && txt.includes('[DONE]'));
    ok('streaming repassa os eventos e informa o provedor');

    // 6. corte de contexto
    const long = [{ role: 'system', content: 'sys' }];
    for (let i = 0; i < 12; i++) long.push({ role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(200) + i });
    long.push({ role: 'user', content: 'ultima' });
    await chat({ messages: long });
    assert.ok(lastC.messages.length < long.length, 'não cortou');
    assert.strictEqual(lastC.messages[0].role, 'system');
    assert.strictEqual(lastC.messages[lastC.messages.length - 1].content, 'ultima');
    assert.notStrictEqual(lastC.messages[1].role, 'assistant');
    ok('histórico longo é cortado mantendo sistema e última mensagem');

    // 7. fixar provedor
    const hc = hits.c;
    r = await chat({ model: 'c:c1', messages: msgs });
    j = await r.json();
    assert.strictEqual(j.gateway.provider, 'c'); assert.strictEqual(hits.c, hc + 1);
    r = await chat({ model: 'a:a1', messages: msgs });
    assert.strictEqual(r.status, 503);
    r = await chat({ model: 'd', messages: msgs });
    assert.strictEqual(r.status, 400);
    ok('modelo fixado não faz fallback; provedor sem chave dá 400');

    // 8. nome desconhecido
    r = await chat({ model: 'gpt-4o', messages: msgs });
    assert.strictEqual((await r.json()).gateway.provider, 'c');
    ok('nome de modelo desconhecido usa o automático');

    // 9. reset
    await post('/api/reset');
    const ha = hits.a;
    await chat({ messages: msgs });
    assert.ok(hits.a > ha);
    ok('/api/reset libera os provedores em espera');

    // 10. modelos
    r = await fetch(base + '/v1/models', { headers: H });
    const ids = (await r.json()).data.map((m) => m.id);
    assert.ok(ids.includes('auto') && ids.includes('auto-code') && ids.includes('c:c1') && !ids.includes('d:d1'));
    ok('/v1/models lista só provedores configurados');

    // ---------- conectar pelo app: colar a chave ----------
    // 11. segurança dos campos
    r = await post('/api/keys', { provider: 'd', values: { GATEWAY_TOKEN: 'hack' } });
    assert.strictEqual(r.status, 400);
    r = await post('/api/keys', { provider: 'd', values: { D_KEY: 'com espaco' } });
    assert.strictEqual(r.status, 400);
    r = await post('/api/keys', { provider: 'd', values: {} });
    assert.strictEqual(r.status, 400);
    r = await post('/api/keys', { provider: 'nao-existe', values: { X: '1' } });
    assert.strictEqual(r.status, 404);
    r = await post('/api/keys', { provider: 'd', values: { D_KEY: 'goodkey' } }, { 'Content-Type': 'application/json' });
    assert.strictEqual(r.status, 401);
    ok('só aceita os campos do provedor, sem espaços, e exige o token');

    // 12. chave errada
    r = await post('/api/keys', { provider: 'd', values: { D_KEY: 'wrongkey' } });
    j = await r.json();
    assert.strictEqual(r.status, 400, JSON.stringify(j));
    assert.strictEqual(j.error.type, 'key_rejected');
    assert.strictEqual(prov(await status(), 'd').configured, false);
    ok('chave recusada pelo provedor não é salva');

    // 13. chave certa
    r = await post('/api/keys', { provider: 'd', values: { D_KEY: 'goodkey' } });
    j = await r.json();
    assert.strictEqual(r.status, 200, JSON.stringify(j));
    st = await status();
    assert.strictEqual(prov(st, 'd').configured, true);
    assert.strictEqual(prov(st, 'd').source, 'app');
    assert.strictEqual(st.persistent, true);
    r = await chat({ model: 'd:d1', messages: msgs });
    j = await r.json();
    assert.strictEqual(j.gateway.provider, 'd');
    assert.strictEqual(j.choices[0].message.content, 'dd');
    ok('chave certa é salva e passa a ser usada');

    // 14. segredo não vaza
    assert.ok(!JSON.stringify(st).includes('goodkey'));
    ok('/api/status nunca devolve a chave');

    // ---------- conectar pelo app: login OAuth ----------
    // 15. início exige token
    r = await post('/api/connect/e/start', {}, { 'Content-Type': 'application/json' });
    assert.strictEqual(r.status, 401);
    r = await post('/api/connect/d/start');
    assert.strictEqual(r.status, 404); // d não tem login
    r = await post('/api/connect/e/start');
    j = await r.json();
    assert.strictEqual(r.status, 200, JSON.stringify(j));
    const au = new URL(j.url);
    assert.strictEqual(au.origin + au.pathname, eRoot + '/auth');
    assert.strictEqual(au.searchParams.get('callback_url'), base + '/oauth/e/callback');
    assert.strictEqual(au.searchParams.get('code_challenge_method'), 'S256');
    lastChallenge = au.searchParams.get('code_challenge');
    const state1 = au.searchParams.get('state');
    assert.ok(/^[a-f0-9]{32}$/.test(state1) && lastChallenge.length >= 40);
    ok('login: o app recebe a URL de login com PKCE e state');

    // 16. callback é público, troca o código e guarda a chave
    r = await fetch(base + '/oauth/e/callback?code=abc&state=' + state1);
    const html = await r.text();
    assert.strictEqual(r.status, 200, html);
    assert.ok(html.includes('Conectado'));
    st = await status();
    assert.strictEqual(prov(st, 'e').configured, true);
    assert.strictEqual(prov(st, 'e').source, 'app');
    r = await chat({ model: 'e', messages: msgs });
    assert.strictEqual((await r.json()).gateway.provider, 'e');
    ok('login: o retorno troca o código pela chave e o provedor passa a responder');

    // 17. state é de uso único e inválidos são recusados
    r = await fetch(base + '/oauth/e/callback?code=abc&state=' + state1);
    assert.strictEqual(r.status, 400);
    r = await fetch(base + '/oauth/e/callback?code=abc&state=' + 'f'.repeat(32));
    assert.strictEqual(r.status, 400);
    r = await fetch(base + '/oauth/e/callback?code=abc&state=<script>');
    assert.strictEqual(r.status, 400);
    r = await fetch(base + '/oauth/zzz/callback?code=abc&state=' + state1);
    assert.strictEqual(r.status, 404);
    r = await fetch(base + '/oauth/e/callback?error=access_denied%3Cb%3E');
    const errHtml = await r.text();
    assert.strictEqual(r.status, 400);
    assert.ok(!errHtml.includes('<b>'));
    ok('login: state de uso único; callback inválido ou malicioso é recusado');

    // 18. código errado do provedor
    r = await post('/api/connect/e/start');
    const au2 = new URL((await r.json()).url);
    lastChallenge = au2.searchParams.get('code_challenge');
    r = await fetch(base + '/oauth/e/callback?code=errado&state=' + au2.searchParams.get('state'));
    assert.strictEqual(r.status, 400);
    ok('login: código recusado pelo provedor não conecta nada novo');

    // 19. persiste, criptografado, e sobrevive a reinício
    const raw = fs.readFileSync(storeFile, 'utf8');
    assert.ok(!raw.includes('goodkey') && !raw.includes('oauth-key'), 'chave em texto puro no arquivo');
    await stopGateway();
    await startGateway();
    st = await status();
    assert.strictEqual(prov(st, 'd').source, 'app');
    assert.strictEqual(prov(st, 'e').source, 'app');
    r = await chat({ model: 'd:d1', messages: msgs });
    assert.strictEqual((await r.json()).gateway.provider, 'd');
    ok('chaves ficam criptografadas no disco e sobrevivem ao reinício');

    // 20. remover
    r = await post('/api/keys/remove', { provider: 'd' });
    assert.strictEqual(r.status, 200);
    st = await status();
    assert.strictEqual(prov(st, 'd').configured, false);
    assert.strictEqual(prov(st, 'd').source, null);
    assert.strictEqual(prov(st, 'e').configured, true);
    r = await chat({ model: 'd', messages: msgs });
    assert.strictEqual(r.status, 400);
    ok('remover desconecta só aquele provedor');

    console.log(`\n${n}/20 testes passaram`);
    assert.strictEqual(n, 20);
  } catch (e) {
    console.error('\n✗ FALHOU:', e.message, '\n--- log do gateway ---\n' + log);
    process.exitCode = 1;
  } finally {
    await stopGateway();
    [A, B, C, D, E].forEach((s) => s.close());
  }
})();
