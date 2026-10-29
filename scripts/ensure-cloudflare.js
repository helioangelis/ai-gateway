'use strict';
// Prepara a conta Cloudflare antes do deploy (roda dentro do GitHub Actions):
//   1. garante que existe um subdomínio workers.dev
//   2. cria (ou reaproveita) o namespace KV que guarda as esperas dos provedores
//   3. grava o id do KV no wrangler.toml e a URL final em $GITHUB_OUTPUT
const fs = require('fs');

const token = process.env.CLOUDFLARE_API_TOKEN;
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const API = 'https://api.cloudflare.com/client/v4';

async function cf(path, init = {}) {
  const r = await fetch(API + path, {
    ...init,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
  });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok && j.success !== false, status: r.status, j };
}
const why = (r) => JSON.stringify(r.j.errors || r.j).slice(0, 300);

(async () => {
  let toml = fs.readFileSync('wrangler.toml', 'utf8');
  const worker = (toml.match(/^name\s*=\s*"([^"]+)"/m) || [])[1] || 'ai-gateway';

  // 1. subdomínio workers.dev
  let sub = '';
  let r = await cf(`/accounts/${account}/workers/subdomain`);
  if (r.ok && r.j.result && r.j.result.subdomain) {
    sub = r.j.result.subdomain;
  } else {
    for (let i = 0; i < 5 && !sub; i++) {
      const name = 'aigw-' + Math.random().toString(36).slice(2, 8);
      const p = await cf(`/accounts/${account}/workers/subdomain`, { method: 'PUT', body: JSON.stringify({ subdomain: name }) });
      if (p.ok) { sub = name; console.log('Subdomínio workers.dev criado:', name); } else if (i === 4) console.log('::warning::Não consegui criar o subdomínio workers.dev: ' + why(p));
    }
  }

  // 2. KV
  const title = worker + '-STATE';
  let nsId = '';
  const list = await cf(`/accounts/${account}/storage/kv/namespaces?per_page=100`);
  if (list.ok) {
    let ns = (list.j.result || []).find((n) => n.title === title);
    if (!ns) {
      const c = await cf(`/accounts/${account}/storage/kv/namespaces`, { method: 'POST', body: JSON.stringify({ title }) });
      if (c.ok) ns = c.j.result; else console.log('::warning::Não consegui criar o KV: ' + why(c));
    }
    if (ns) nsId = ns.id;
  } else {
    console.log('::warning::Sem acesso ao KV (' + why(list) + '). O token precisa da permissão "Workers KV Storage: Edit".');
  }

  if (nsId) {
    toml = toml.replace(/(binding = "STATE"\s*\nid = ")[^"]*(")/, `$1${nsId}$2`);
    console.log('KV pronto:', title);
  } else {
    // sem KV o gateway ainda funciona, só não lembra das esperas entre instâncias
    toml = toml.replace(/\[\[kv_namespaces\]\][\s\S]*?(?=\n\[|\n*$)/, '');
    console.log('::warning::Publicando sem KV (esperas ficam só na memória).');
  }
  fs.writeFileSync('wrangler.toml', toml);

  const url = sub ? `https://${worker}.${sub}.workers.dev` : '';
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `url=${url}\n`);
  console.log('URL do gateway:', url || '(descubra no painel da Cloudflare)');
})().catch((e) => { console.error('::error::' + e.message); process.exit(1); });
