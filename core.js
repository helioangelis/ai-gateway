'use strict';

/*
 * core.js — a lógica do gateway, escrita só com APIs Web (Request, Response, fetch).
 * Roda igual no Node 18+ (server.js) e no Cloudflare Workers (worker.js).
 */

const MIN = 60e3;
const HOUR = 3600e3;
const MAX_BODY = 4 * 1024 * 1024;
const enc = new TextEncoder();

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Expose-Headers': 'X-Provider, X-Model, X-Gateway-Attempts, Retry-After',
};

function safeEqual(a, b) {
  const x = enc.encode(String(a));
  const y = enc.encode(String(b));
  if (x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

function parseConfig(raw) {
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

// ----------------------------------------------------------- provedores
// ------------------------------------------------ chaves: cripto e utilidades
const subtle = () => globalThis.crypto.subtle;
const rand = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));
const toB64 = (u8) => { let s = ''; for (const b of u8) s += String.fromCharCode(b); return btoa(s); };
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64url = (u8) => toB64(u8).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, '0')).join('');
const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
async function sha256(str) { return new Uint8Array(await subtle().digest('SHA-256', enc.encode(str))); }
async function aesKey(secret) {
  return subtle().importKey('raw', await sha256('ai-gateway-keys:' + secret), 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function seal(obj, secret) {
  const iv = rand(12);
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv }, await aesKey(secret), enc.encode(JSON.stringify(obj))));
  return JSON.stringify({ v: 1, iv: toB64(iv), d: toB64(ct) });
}
async function openSealed(raw, secret) {
  const o = JSON.parse(raw);
  const pt = await subtle().decrypt({ name: 'AES-GCM', iv: fromB64(o.iv) }, await aesKey(secret), fromB64(o.d));
  return JSON.parse(new TextDecoder().decode(pt));
}

// Armazenamento simples chave→texto (com validade). Em memória por padrão;
// o Node usa arquivo e o Cloudflare usa KV (veja server.js e worker.js).
function memoryStore() {
  const m = new Map();
  return {
    async get(k) {
      const e = m.get(k);
      if (!e) return null;
      if (e.exp && Date.now() > e.exp) { m.delete(k); return null; }
      return e.v;
    },
    async put(k, v, ttl) { m.set(k, { v, exp: ttl ? Date.now() + ttl * 1000 : 0 }); },
    async del(k) { m.delete(k); },
  };
}

// Campos que o usuário pode preencher para conectar um provedor.
const fieldsOf = (p) => p.fields || [
  { name: p.keyEnv, label: 'Chave de API', secret: true },
  ...(p.requires || []).map((n) => ({ name: n, label: n, secret: false })),
];

// Junta as variáveis do servidor com as chaves conectadas pelo app.
// Só os campos do próprio provedor entram (nunca GATEWAY_TOKEN etc.).
function buildProvider(p, env, stored) {
  const scoped = { ...env };
  let fromApp = false;
  for (const f of fieldsOf(p)) {
    if (stored && stored[f.name]) { scoped[f.name] = stored[f.name]; if (f.name === p.keyEnv) fromApp = true; }
  }
  const missing = [p.keyEnv, ...(p.requires || [])].filter((k) => !scoped[k]);
  const base = env[p.id.toUpperCase() + '_BASE_URL'] || (typeof p.baseUrl === 'function' ? p.baseUrl(scoped) : p.baseUrl);
  return {
    key: scoped[p.keyEnv] || '',
    base: String(base || '').replace(/\/+$/, ''),
    missing,
    configured: missing.length === 0,
    source: fromApp ? 'app' : env[p.keyEnv] ? 'env' : null,
  };
}

// ----------------------------------------------------------- provedores
function resolveProviders(list, env, cfg) {
  let out = list.map((p) => ({ ...p }));
  if (Array.isArray(cfg.extraProviders)) out = out.concat(cfg.extraProviders);
  if (Array.isArray(cfg.disabled)) out = out.filter((p) => !cfg.disabled.includes(p.id));
  if (Array.isArray(cfg.order)) {
    const rank = (id) => { const i = cfg.order.indexOf(id); return i < 0 ? 999 : i; };
    out.sort((a, b) => rank(a.id) - rank(b.id));
  }
  return out.map((p) => {
    const override = cfg.models && cfg.models[p.id];
    const models = (override || p.models || []).map((m) => (typeof m === 'string' ? { id: m, code: false } : m));
    return { ...p, models, ...buildProvider(p, env, null) };
  });
}

// ---------------------------------------------------------------- estado
class State {
  constructor(persist, refreshMs, persistStats) {
    this.persist = persist;
    this.refreshMs = refreshMs;
    this.persistStats = persistStats;
    this.cool = new Map();   // chave -> { until, reason }
    this.stats = {};         // provedor -> { ok, fail, lastOk, lastError, lastModel }
    this.loadedAt = 0;
    this.dirty = false;
    this.chain = Promise.resolve();
  }

  async load() {
    if (!this.persist) return;
    const now = Date.now();
    if (this.loadedAt && now - this.loadedAt < this.refreshMs) return;
    this.loadedAt = now;
    if (this.dirty) return;
    try {
      const s = await this.persist.read();
      if (!s) return;
      this.cool = new Map((s.cool || []).filter(([, v]) => v && v.until > now));
      if (s.stats && this.persistStats) this.stats = s.stats;
    } catch { /* primeira execução ou armazenamento indisponível */ }
  }

  async flush() {
    if (!this.persist || !this.dirty) return;
    this.dirty = false;
    const now = Date.now();
    const snap = {
      cool: [...this.cool].filter(([, v]) => v.until > now),
      ...(this.persistStats ? { stats: this.stats } : {}),
    };
    this.chain = this.chain.then(() => this.persist.write(snap)).catch(() => {});
    return this.chain;
  }

  setCool(key, ms, reason) { this.cool.set(key, { until: Date.now() + ms, reason }); this.dirty = true; }
  info(key) {
    const c = this.cool.get(key);
    if (!c) return null;
    if (Date.now() >= c.until) { this.cool.delete(key); return null; }
    return c;
  }
  touchStats() { if (this.persistStats) this.dirty = true; }
}

// -------------------------------------------------- classificar erros
function parseRetryAfter(h) {
  if (!h) return null;
  const n = Number(h);
  if (Number.isFinite(n)) return n * 1000;
  const d = Date.parse(h);
  return Number.isFinite(d) ? Math.max(0, d - Date.now()) : null;
}

function classify(status, text, headers) {
  const t = String(text || '').toLowerCase();
  const ra = parseRetryAfter(headers && headers.get ? headers.get('retry-after') : null);
  const clamp = (ms) => Math.min(Math.max(ms, 5e3), 24 * HOUR);

  if (status === 401) return { scope: 'provider', ms: 12 * HOUR, reason: 'chave inválida' };
  if (status === 402) return { scope: 'provider', ms: 6 * HOUR, reason: 'créditos esgotados' };
  if (status === 403) return { scope: 'provider', ms: 3 * HOUR, reason: 'acesso negado (403)' };
  if (status === 429) {
    const perMin = /per ?minute|\brpm\b|\btpm\b|per ?second/.test(t);
    const daily = /per ?day|daily|\btpd\b|\brpd\b/.test(t) || (!perMin && /quota|exhausted|insufficient|credit|billing/.test(t));
    return {
      scope: 'model',
      ms: clamp(ra != null ? ra : daily ? 3 * HOUR : MIN),
      reason: daily ? 'cota diária esgotada' : 'limite por minuto',
    };
  }
  if (status === 404) return { scope: 'model', ms: HOUR, reason: 'modelo indisponível (404)' };
  if (status === 413 || /context.{0,20}(length|window)|too (large|long)|maximum context/.test(t)) {
    return { scope: 'model', ms: 5 * MIN, reason: 'contexto grande demais' };
  }
  if (status === 400 || status === 422) return { scope: null, ms: 0, reason: `requisição recusada (${status})` };
  return { scope: 'model', ms: MIN, reason: status ? `erro ${status}` : 'falha de rede/timeout' };
}

function shortErr(text) {
  try {
    const j = JSON.parse(text);
    const m = (j.error && (j.error.message || j.error)) || j.message || (Array.isArray(j) && j[0] && j[0].error && j[0].error.message);
    if (m) return String(typeof m === 'string' ? m : JSON.stringify(m)).slice(0, 240);
  } catch { /* texto puro */ }
  return String(text || '').replace(/\s+/g, ' ').slice(0, 240);
}

function httpError(status, body, headers) {
  const e = new Error('http ' + status);
  e.status = status; e.body = body; e.headers = headers;
  return e;
}

// ----------------------------------------------- cortar histórico longo
function contentLen(m) {
  return typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content || '').length;
}
function trimMessages(messages, maxChars) {
  const sys = messages.filter((m) => m.role === 'system');
  const rest = messages.filter((m) => m.role !== 'system');
  let total = sys.reduce((n, m) => n + contentLen(m), 0);
  const keep = [];
  for (let i = rest.length - 1; i >= 0; i--) {
    const c = contentLen(rest[i]);
    if (keep.length && total + c > maxChars) break;
    keep.unshift(rest[i]);
    total += c;
  }
  while (keep.length > 1 && keep[0].role === 'assistant') keep.shift();
  return [...sys, ...keep];
}

const errObj = (message, type, extra) => ({ error: { message, type, ...(extra || {}) } });
function json(status, obj, headers) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...(headers || {}) } });
}

// ------------------------------------------------------------- gateway
function createGateway(opts) {
  const env = opts.env || {};
  const cfg = opts.config || {};
  const TOKEN = env.GATEWAY_TOKEN || '';
  const TIMEOUT_MS = Number(env.UPSTREAM_TIMEOUT_MS) || 60000;
  const MAX_ATTEMPTS = Number(env.MAX_ATTEMPTS) || 16;
  const DEFAULT_MAX_CHARS = Number(env.MAX_CONTEXT_CHARS) || 48000;
  const requireToken = !!opts.requireToken;

  const providers = resolveProviders(opts.providers, env, cfg);
  const byId = (id) => providers.find((p) => p.id === id);
  const state = new State(opts.persist || null, opts.refreshMs == null ? Infinity : opts.refreshMs, opts.persistStats !== false);
  const modelKey = (p, m) => `${p.id}::${m.id}`;

  // ---- chaves conectadas pelo app (guardadas criptografadas no store)
  const store = opts.store || memoryStore();
  const persistentStore = !!opts.store;
  const keysRefreshMs = opts.refreshMs == null ? Infinity : opts.refreshMs;
  const keySecret = TOKEN || 'local-only';
  let storedKeys = {};
  let keysLoadedAt = 0;

  function applyKeys(stored) {
    for (const p of providers) Object.assign(p, buildProvider(p, env, stored));
  }
  function clearCool(id) {
    for (const k of [...state.cool.keys()]) if (k === id || k.startsWith(id + '::')) state.cool.delete(k);
    state.dirty = true;
  }
  async function loadKeys() {
    const now = Date.now();
    if (keysLoadedAt && now - keysLoadedAt < keysRefreshMs) return;
    keysLoadedAt = now;
    let raw;
    try { raw = await store.get('keys'); } catch { return; }
    try { storedKeys = raw ? await openSealed(raw, keySecret) : {}; } catch { storedKeys = {}; }
    applyKeys(storedKeys);
  }
  async function saveKeys(next) {
    await store.put('keys', await seal(next, keySecret));
    storedKeys = next;
    keysLoadedAt = Date.now();
    applyKeys(storedKeys);
  }

  function parseModel(requested) {
    const s = String(requested || 'auto').trim();
    if (s === '' || s === 'auto') return { mode: 'auto' };
    if (s === 'auto-code') return { mode: 'code' };
    const i = s.indexOf(':');
    const p = byId(i < 0 ? s : s.slice(0, i));
    if (p) return { mode: 'pin', provider: p, model: i < 0 ? null : s.slice(i + 1) };
    return { mode: 'auto' }; // nome desconhecido (ex.: "gpt-4o") → automático
  }

  function pickCandidates(sel) {
    if (sel.mode === 'pin') {
      const p = sel.provider;
      if (!p.configured) return [];
      const ms = sel.model ? [{ id: sel.model }] : p.models;
      return ms.map((m) => ({ p, m, pinned: true }));
    }
    const out = [];
    for (const p of providers) {
      if (!p.configured || state.info(p.id)) continue;
      for (const m of p.models) if (!state.info(modelKey(p, m))) out.push({ p, m });
    }
    if (sel.mode === 'code') out.sort((a, b) => (b.m.code ? 1 : 0) - (a.m.code ? 1 : 0));
    return out;
  }

  function nextAvailableIn() {
    let min = Infinity;
    const ids = new Set(providers.filter((p) => p.configured).map((p) => p.id));
    for (const [k, v] of state.cool) if (ids.has(k.split('::')[0])) min = Math.min(min, v.until - Date.now());
    return Number.isFinite(min) ? Math.max(1, Math.ceil(min / 1000)) : null;
  }

  async function upstream(c, body, stream, clientSignal) {
    const { p, m } = c;
    const payload = { ...body, model: m.id, stream, messages: trimMessages(body.messages, p.maxChars || DEFAULT_MAX_CHARS) };
    if (!stream) delete payload.stream_options;

    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort(new Error('cliente desconectou'));
    if (clientSignal) clientSignal.addEventListener('abort', onAbort);
    const timer = setTimeout(() => ctrl.abort(new Error('timeout')), TIMEOUT_MS);
    const handle = {
      stopTimer: () => clearTimeout(timer),
      release: () => { clearTimeout(timer); if (clientSignal) clientSignal.removeEventListener('abort', onAbort); },
    };
    try {
      handle.r = await fetch(p.base + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + p.key, ...(p.headers || {}) },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      return handle;
    } catch (e) {
      handle.release();
      throw e;
    }
  }

  async function handleChat(request) {
    let body;
    try {
      const text = await request.text();
      if (text.length > MAX_BODY) return json(413, errObj('corpo grande demais', 'invalid_request'));
      body = JSON.parse(text || '{}');
    } catch {
      return json(400, errObj('JSON inválido', 'invalid_request'));
    }
    if (!Array.isArray(body.messages) || !body.messages.length) {
      return json(400, errObj('"messages" é obrigatório', 'invalid_request'));
    }

    const stream = body.stream === true;
    const sel = parseModel(body.model);
    if (sel.mode === 'pin' && !sel.provider.configured) {
      return json(400, errObj(`O provedor "${sel.provider.id}" não tem chave configurada (falta ${sel.provider.missing.join(', ')}).`, 'not_configured'));
    }

    const cands = pickCandidates(sel);
    if (!cands.length) {
      const wait = nextAvailableIn();
      const any = providers.some((p) => p.configured);
      return json(503, errObj(
        any ? 'Todos os provedores estão em espera (cota esgotada).' : 'Nenhum provedor configurado. Preencha as chaves.',
        'gateway_exhausted',
        { retry_in_s: wait }
      ), wait ? { 'Retry-After': String(wait) } : undefined);
    }

    const signal = request.signal;
    const attempts = [];
    for (const c of cands.slice(0, MAX_ATTEMPTS)) {
      if (signal && signal.aborted) return new Response(null, { status: 499 });
      if (!c.pinned && (state.info(c.p.id) || state.info(modelKey(c.p, c.m)))) continue;

      const st = (state.stats[c.p.id] = state.stats[c.p.id] || { ok: 0, fail: 0 });
      let up;
      try {
        up = await upstream(c, body, stream, signal);
        const r = up.r;
        if (!r.ok) {
          const text = await r.text().catch(() => '');
          up.release();
          throw httpError(r.status, text, r.headers);
        }
        const meta = { 'X-Provider': c.p.id, 'X-Model': c.m.id, 'X-Gateway-Attempts': String(attempts.length + 1) };

        if (stream) {
          up.stopTimer();
          st.ok++; st.lastOk = Date.now(); st.lastModel = c.m.id; state.touchStats();
          return new Response(r.body, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no', ...meta },
          });
        }

        const text = await r.text();
        up.release();
        let data;
        try { data = JSON.parse(text); } catch { throw httpError(502, 'resposta inválida do provedor', r.headers); }
        if (data && data.error && !data.choices) {
          const code = Number(data.error.code);
          throw httpError(Number.isInteger(code) && code >= 400 && code < 600 ? code : 502, JSON.stringify(data.error), r.headers);
        }
        data.gateway = { provider: c.p.id, provider_name: c.p.name, model: c.m.id, attempts };
        st.ok++; st.lastOk = Date.now(); st.lastModel = c.m.id; state.touchStats();
        return json(200, data, meta);
      } catch (e) {
        if (up) up.release();
        if (signal && signal.aborted) return new Response(null, { status: 499 });
        const status = e.status || 0;
        const text = e.body || String((e.cause && e.cause.message) || e.message || e);
        const cl = classify(status, text, e.headers);
        if (cl.scope === 'provider') state.setCool(c.p.id, cl.ms, cl.reason);
        else if (cl.scope === 'model') state.setCool(modelKey(c.p, c.m), cl.ms, cl.reason);
        const detail = shortErr(text);
        attempts.push({ provider: c.p.id, model: c.m.id, status, reason: cl.reason, detail });
        st.fail++; st.lastError = { at: Date.now(), model: c.m.id, status, reason: cl.reason, detail };
        state.touchStats(); state.dirty = true;
        if (opts.log) opts.log(`[fallback] ${c.p.id}/${c.m.id} → ${cl.reason}${status ? ' (' + status + ')' : ''}`);
      }
    }

    const allBad = attempts.length && attempts.every((a) => a.status === 400 || a.status === 422);
    const wait = nextAvailableIn();
    return json(
      allBad ? 400 : 503,
      errObj(
        allBad ? 'Os provedores recusaram a requisição: ' + attempts[0].detail : 'Todos os provedores falharam ou estão sem cota.',
        allBad ? 'invalid_request' : 'gateway_exhausted',
        { attempts, retry_in_s: wait }
      ),
      !allBad && wait ? { 'Retry-After': String(wait) } : undefined
    );
  }

  function statusJson() {
    const cd = (info) => (info ? { reason: info.reason, seconds: Math.max(0, Math.ceil((info.until - Date.now()) / 1000)) } : null);
    return {
      persistent: persistentStore,
      providers: providers.map((p) => ({
        id: p.id,
        name: p.name,
        configured: p.configured,
        missing: p.missing,
        source: p.source,
        login: p.oauth ? 'oauth' : 'key',
        keyUrl: p.keyUrl || '',
        hint: p.hint || '',
        fields: fieldsOf(p),
        cooldown: cd(state.info(p.id)),
        models: p.models.map((m) => ({ id: m.id, code: !!m.code, cooldown: cd(state.info(modelKey(p, m))) })),
        stats: state.stats[p.id] || { ok: 0, fail: 0 },
      })),
    };
  }

  async function discover(p) {
    if (!p.configured) throw new Error('sem chave (falta ' + p.missing.join(', ') + ')');
    const r = await fetch(p.base + '/models', {
      headers: { Authorization: 'Bearer ' + p.key, ...(p.headers || {}) },
      signal: AbortSignal.timeout(20000),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${shortErr(text)}`);
    const j = JSON.parse(text);
    let list = j.data || j.models || j.result || [];
    if (p.id === 'openrouter') {
      list = list.filter((m) => /:free$/.test(m.id) || (m.pricing && Number(m.pricing.prompt) === 0 && Number(m.pricing.completion) === 0));
    }
    return list.map((m) => String(m.id || m.name || m).replace(/^models\//, '')).sort();
  }

  async function check() {
    const lines = await Promise.all(providers.map(async (p) => {
      if (!p.configured) return `–  ${p.name}: sem chave (falta ${p.missing.join(', ')})`;
      const m = p.models[0];
      const t0 = Date.now();
      try {
        const up = await upstream({ p, m }, { messages: [{ role: 'user', content: 'Responda apenas: ok' }], max_tokens: 64 }, false, null);
        const text = await up.r.text();
        up.release();
        if (!up.r.ok) return `✗  ${p.name} (${m.id}): HTTP ${up.r.status} — ${shortErr(text)}`;
        return `✓  ${p.name} (${m.id}): ok em ${Date.now() - t0} ms`;
      } catch (e) {
        return `✗  ${p.name} (${m.id}): ${(e.cause && e.cause.message) || e.message}`;
      }
    }));
    return lines;
  }

  // ---------------------------------------------- conectar provedores pelo app
  async function readJson(request) {
    const t = await request.text();
    if (t.length > 20000) throw Object.assign(new Error('corpo grande demais'), { status: 413 });
    try { return JSON.parse(t || '{}'); } catch { throw Object.assign(new Error('JSON inválido'), { status: 400 }); }
  }

  function htmlPage(status, title, msg) {
    const body = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escHtml(title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#0f1115;color:#e8eaf0}main{max-width:420px;padding:24px;text-align:center}h1{font-size:22px}@media(prefers-color-scheme:light){body{background:#f6f7fa;color:#161a23}}</style></head><body><main><h1>${escHtml(title)}</h1><p>${escHtml(msg)}</p></main></body></html>`;
    return new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
  }

  async function saveKeyRoute(request) {
    let body;
    try { body = await readJson(request); } catch (e) { return json(e.status || 400, errObj(e.message, 'invalid_request')); }
    const p = byId(String(body.provider || ''));
    if (!p) return json(404, errObj('provedor desconhecido', 'not_found'));
    const fields = fieldsOf(p);
    const values = body.values && typeof body.values === 'object' ? body.values : {};
    const clean = {};
    for (const [k, v] of Object.entries(values)) {
      if (!fields.some((f) => f.name === k)) return json(400, errObj('Campo não permitido: ' + k, 'invalid_request'));
      const s = String(v == null ? '' : v).trim();
      if (s.length > 600 || /\s/.test(s)) return json(400, errObj('Valor inválido em ' + k + ' (sem espaços, até 600 caracteres).', 'invalid_request'));
      if (s) clean[k] = s;
    }
    const absent = fields.filter((f) => !clean[f.name]).map((f) => f.label);
    if (absent.length) return json(400, errObj('Preencha: ' + absent.join(', ') + '.', 'invalid_request'));

    let warning = '';
    try {
      await discover({ ...p, ...buildProvider(p, env, { ...storedKeys, ...clean }) });
    } catch (e) {
      const m = String((e && e.message) || e);
      const hit = m.match(/HTTP (401|403)\b/);
      if (hit) return json(400, errObj(`O provedor recusou essa chave (${hit[1]}). Confira se copiou inteira.`, 'key_rejected'));
      warning = 'Não consegui validar agora, mas a chave foi salva. O teste real acontece no primeiro uso.';
    }
    try { await saveKeys({ ...storedKeys, ...clean }); } catch (e) {
      return json(500, errObj('Não consegui guardar a chave: ' + String((e && e.message) || e), 'store_failed'));
    }
    clearCool(p.id);
    return json(200, { ok: true, warning });
  }

  async function removeKeyRoute(request) {
    let body;
    try { body = await readJson(request); } catch (e) { return json(e.status || 400, errObj(e.message, 'invalid_request')); }
    const p = byId(String(body.provider || ''));
    if (!p) return json(404, errObj('provedor desconhecido', 'not_found'));
    const next = { ...storedKeys };
    for (const f of fieldsOf(p)) delete next[f.name];
    await saveKeys(next);
    clearCool(p.id);
    return json(200, { ok: true });
  }

  async function oauthStart(id, url) {
    const p = byId(id);
    if (!p || !p.oauth) return json(404, errObj('login não disponível para este provedor', 'not_found'));
    const verifier = b64url(rand(32));
    const challenge = b64url(await sha256(verifier));
    const st = hex(rand(16));
    await store.put('oauth:' + st, JSON.stringify({ id, verifier }), 600);
    const origin = env.PUBLIC_URL ? String(env.PUBLIC_URL).replace(/\/+$/, '') : url.origin;
    const q = new URLSearchParams({
      callback_url: `${origin}/oauth/${id}/callback`,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: st,
      key_label: 'AI Gateway',
    });
    return json(200, { url: `${p.oauth.authUrl}?${q}` });
  }

  async function oauthCallback(id, url) {
    const p = byId(id);
    if (!p || !p.oauth) return htmlPage(404, 'Não encontrado', 'Esse provedor não usa login.');
    const err = url.searchParams.get('error');
    if (err) return htmlPage(400, 'Não conectou', 'O provedor devolveu: ' + err);
    const code = url.searchParams.get('code');
    const st = url.searchParams.get('state') || '';
    if (!code || !/^[a-f0-9]{32}$/.test(st)) return htmlPage(400, 'Link inválido', 'Volte ao app e toque em Entrar de novo.');
    const raw = await store.get('oauth:' + st);
    await store.del('oauth:' + st);
    let saved = null;
    try { saved = raw ? JSON.parse(raw) : null; } catch { /* inválido */ }
    if (!saved || saved.id !== id) return htmlPage(400, 'Link expirado', 'Volte ao app e toque em Entrar de novo.');

    let text;
    let ok = false;
    try {
      const r = await fetch(p.oauth.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, code_verifier: saved.verifier, code_challenge_method: 'S256' }),
        signal: AbortSignal.timeout(20000),
      });
      text = await r.text();
      ok = r.ok;
    } catch (e) {
      return htmlPage(502, 'Não consegui conectar', 'Falha de rede falando com ' + p.name + '. Tente de novo.');
    }
    let j = {};
    try { j = JSON.parse(text); } catch { /* texto puro */ }
    if (!ok || !j.key) return htmlPage(400, 'Não consegui conectar', shortErr(text) || 'Resposta inesperada do provedor.');
    try { await saveKeys({ ...storedKeys, [p.keyEnv]: j.key }); } catch {
      return htmlPage(500, 'Não consegui guardar a chave', 'O gateway recebeu a chave mas não conseguiu salvá-la.');
    }
    clearCool(p.id);
    return htmlPage(200, 'Conectado ✓', p.name + ' conectado. Pode fechar esta janela e voltar ao app.');
  }

  async function route(request) {
    const url = new URL(request.url);
    const method = request.method;

    if (method === 'OPTIONS') return new Response(null, { status: 204 });
    if (method === 'GET' && url.pathname === '/health') return json(200, { ok: true });

    // O navegador volta do login sem cabeçalho de senha; o "state" de uso único
    // (criado por /api/connect/.../start, que exige o token) é quem protege.
    const oauthCb = url.pathname.match(/^\/oauth\/([\w-]+)\/callback$/);
    if (method === 'GET' && oauthCb) return oauthCallback(oauthCb[1], url);

    if (requireToken && !TOKEN) {
      return json(503, errObj('Defina o segredo GATEWAY_TOKEN para usar este gateway.', 'not_configured'));
    }
    if (TOKEN) {
      const got = String(request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
      if (!safeEqual(got, TOKEN)) return json(401, errObj('Token inválido ou ausente.', 'unauthorized'));
    }

    if (method === 'POST' && url.pathname === '/v1/chat/completions') return handleChat(request);

    if (method === 'POST' && url.pathname === '/api/keys') return saveKeyRoute(request);
    if (method === 'POST' && url.pathname === '/api/keys/remove') return removeKeyRoute(request);
    const connect = url.pathname.match(/^\/api\/connect\/([\w-]+)\/start$/);
    if (method === 'POST' && connect) return oauthStart(connect[1], url);

    if (method === 'GET' && url.pathname === '/v1/models') {
      const data = [{ id: 'auto' }, { id: 'auto-code' }];
      for (const p of providers) if (p.configured) for (const m of p.models) data.push({ id: `${p.id}:${m.id}` });
      return json(200, { object: 'list', data: data.map((d) => ({ ...d, object: 'model', owned_by: 'ai-gateway' })) });
    }
    if (method === 'GET' && url.pathname === '/api/status') return json(200, statusJson());
    if (method === 'GET' && url.pathname === '/api/check') return json(200, { lines: await check() });
    if (method === 'POST' && url.pathname === '/api/reset') {
      state.cool.clear(); state.dirty = true;
      return json(200, { ok: true });
    }
    const dm = url.pathname.match(/^\/api\/discover\/([\w-]+)$/);
    if (method === 'GET' && dm) {
      const p = byId(dm[1]);
      if (!p) return json(404, errObj('provedor desconhecido', 'not_found'));
      try { return json(200, { models: await discover(p) }); } catch (e) {
        return json(502, errObj(String(e.message || e), 'discover_failed'));
      }
    }
    return json(404, errObj('rota não encontrada', 'not_found'));
  }

  async function handle(request, ctx) {
    const later = (p) => (ctx && ctx.waitUntil ? ctx.waitUntil(p) : p.catch(() => {}));
    try {
      await state.load();
      await loadKeys();
      const res = await route(request);
      for (const [k, v] of Object.entries(CORS)) res.headers.set(k, v);
      return res;
    } catch (e) {
      const res = json(500, errObj(String((e && e.message) || e), 'internal'));
      for (const [k, v] of Object.entries(CORS)) res.headers.set(k, v);
      return res;
    } finally {
      if (state.dirty) later(state.flush());
    }
  }

  return { fetch: handle, init: loadKeys, providers, state, check, discover, upstream };
}

module.exports = { createGateway, parseConfig, shortErr, safeEqual, memoryStore };
