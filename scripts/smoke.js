#!/usr/bin/env node
'use strict';

// Smoke test real: sobe o servidor numa pasta temporária e confere as rotas
// principais. Não simula provedores — valida só o que existe sem chave.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-smoke-'));
const port = 8790 + Math.floor(Math.random() * 90);
const token = 'test-token';
const base = `http://127.0.0.1:${port}`;

const child = spawn(process.execPath, [path.join(ROOT, 'src', 'index.js'), '--no-open'], {
  env: { ...process.env, PORT: String(port), DATA_DIR: data, GATEWAY_TOKEN: token },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
child.stdout.on('data', (d) => (output += d));
child.stderr.on('data', (d) => (output += d));

async function wait(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function main() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(base + '/health');
      if (r.ok) break;
    } catch { /* ainda subindo */ }
    await wait(150);
  }

  const health = await (await fetch(base + '/health')).json();
  if (!health.ok) throw new Error('health falhou');

  const noAuth = await fetch(base + '/v1/models');
  if (noAuth.status !== 401) throw new Error('esperava 401 sem token, veio ' + noAuth.status);

  const models = await (
    await fetch(base + '/v1/models', { headers: { Authorization: 'Bearer ' + token } })
  ).json();
  if (!Array.isArray(models.data) || !models.data.some((m) => m.id === 'auto')) throw new Error('/v1/models inválido');

  const status = await (
    await fetch(base + '/api/status', { headers: { Authorization: 'Bearer ' + token } })
  ).json();
  if (!Array.isArray(status.providers) || !status.providers.length) throw new Error('/api/status inválido');

  const chat = await fetch(base + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'oi' }] }),
  });
  if (chat.status !== 503) throw new Error('sem chaves, esperava 503, veio ' + chat.status);

  const index = await fetch(base + '/');
  const html = await index.text();
  if (!html.includes('AI Gateway')) throw new Error('painel não servido');

  console.log('smoke ok: health, auth, models, status, 503 sem chave, painel');
}

main()
  .catch((e) => {
    console.error('smoke falhou:', e.message);
    console.error(output);
    process.exitCode = 1;
  })
  .finally(() => {
    child.kill();
    setTimeout(() => {
      fs.rmSync(data, { recursive: true, force: true });
      process.exit(process.exitCode || 0);
    }, 300);
  });
