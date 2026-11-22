'use strict';

// Núcleo do gateway: escolhe modelo, chave e provedor; aplica cotas; cai para
// o próximo em caso de falha; registra uso. Fala a API da OpenAI e devolve
// objetos Response (Web), para rodar igual no Node e, no futuro, no APK.

const { buildCatalog, fieldsOf, baseUrlOf } = require('./catalog');
const { createLimiter } = require('./ratelimit');

const HOUR = 3600000;

function errObj(message, type, extra) {
  return { error: { message, type, ...(extra || {}) } };
}

function json(status, obj, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...(headers || {}) },
  });
}

function shortErr(text) {
  const s = String(text || '');
  try {
    const j = JSON.parse(s);
    const m = (j.error && (j.error.message || j.error)) || j.message || (Array.isArray(j) && j[0] && j[0].error && j[0].error.message);
    if (m) return String(typeof m === 'string' ? m : JSON.stringify(m)).slice(0, 240);
  } catch { /* texto puro */ }
  return s.replace(/\s+/g, ' ').slice(0, 240);
}

function contentLen(m) {
  return typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content || '').length;
}

// Mantém as mensagens de sistema e o fim da conversa, cortando o que não cabe.
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

function headerNum(headers, name) {
  if (!headers) return 0;
  const v = typeof headers.get === 'function' ? headers.get(name) : headers[name];
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// Decide o que colocar em espera depois de um erro.
function classify(status, text, headers) {
  const t = String(text || '').toLowerCase();
  const retry = headerNum(headers, 'retry-after');
  if (status === 429) {
    const ms = retry ? Math.min(retry * 1000, 6 * HOUR) : 60e3;
    return { scope: 'keymodel', ms, reason: retry > 3600 ? 'cota diária' : 'limite de requisições' };
  }
  if (status === 401) return { scope: 'key', ms: 12 * HOUR, reason: 'chave inválida' };
  if (status === 402) return { scope: 'provider', ms: 6 * HOUR, reason: 'sem crédito' };
  if (status === 403) return { scope: 'provider', ms: 3 * HOUR, reason: 'acesso negado' };
  if (status === 404) return { scope: 'model', ms: HOUR, reason: 'modelo indisponível' };
  if (status === 413) return { scope: 'model', ms: 5 * 60e3, reason: 'contexto grande' };
  if (status === 400 || status === 422) {
    if (/context|token|too long|maximum|exceed/.test(t)) return { scope: 'model', ms: 5 * 60e3, reason: 'contexto grande' };
    return { scope: null, ms: 0, reason: 'requisição recusada' };
  }
  if (status >= 500) return { scope: 'model', ms: 60e3, reason: 'erro do provedor' };
  if (!status) return { scope: 'model', ms: 60e3, reason: 'rede ou timeout' };
  return { scope: null, ms: 0, reason: 'erro' };
}

function createGateway({ store, log = () => {} }) {
  const limiter = createLimiter(store);

  function providers() {
    return buildCatalog(store.settings).map((p) => {
      const keys = store.keysFor(p);
      const models = (p.models || []).filter((m) => m.enabled !== false);
      return { ...p, keys, models };
    });
  }

  const cd = (k) => store.cooldown(k);
  const active = (list) => list.filter((p) => p.enabled !== false);

  function blocked(provider, model, key) {
    return (
      cd(`p:${provider.id}`) ||
      cd(`m:${provider.id}::${model.id}`) ||
      cd(`k:${key.id}`) ||
      cd(`km:${key.id}::${model.id}`) ||
      null
    );
  }

  function parseModel(requested, list) {
    const s = String(requested || 'auto').trim();
    if (!s || s === 'auto') return { mode: 'auto', code: false };
    if (s === 'auto-code') return { mode: 'auto', code: true };

    const i = s.indexOf(':');
    if (i > 0) {
      const p = list.find((x) => x.id === s.slice(0, i));
      if (p) return { mode: 'pin', provider: p, model: s.slice(i + 1) || null };
    }
    const p = list.find((x) => x.id === s);
    if (p) return { mode: 'pin', provider: p, model: null };

    const hits = list.filter((x) => x.models.some((m) => m.id === s));
    if (hits.length) return { mode: 'unified', modelId: s, providers: hits };

    return { mode: 'auto', code: false };
  }

  function candidatesFor(sel, list) {
    const out = [];
    const push = (p, models) => {
      for (const m of models) if (p.keys.length) out.push({ provider: p, model: m });
    };

    if (sel.mode === 'pin') {
      const models = sel.model ? [{ id: sel.model }] : sel.provider.models;
      push(sel.provider, models);
    } else if (sel.mode === 'unified') {
      for (const p of sel.providers) push(p, p.models.filter((m) => m.id === sel.modelId));
    } else {
      for (const p of list) push(p, p.models);
      if (sel.code) out.sort((a, b) => (b.model.code ? 1 : 0) - (a.model.code ? 1 : 0));
    }
    return out;
  }

  function rank(cands) {
    const strategy = store.settings.strategy || 'balanced';
    if (strategy === 'priority' || !cands.length) return cands;

    const info = (c) => {
      const st = store.state.stats[c.provider.id] || {};
      const total = (st.ok || 0) + (st.fail || 0);
      return {
        reliability: total ? st.ok / total : 0.5,
        speed: st.latency ? Math.max(0, 1 - st.latency / 20000) : 0.5,
        latency: st.latency || 99999,
      };
    };

    const score = (c) => {
      const i = info(c);
      return i.reliability * 0.6 + i.speed * 0.4;
    };

    const copy = [...cands];
    if (strategy === 'fastest') copy.sort((a, b) => info(a).latency - info(b).latency);
    else if (strategy === 'reliable') copy.sort((a, b) => info(b).reliability - info(a).reliability);
    else copy.sort((a, b) => score(b) - score(a));
    return copy;
  }

  function limitId(provider, model, key) {
    return `${provider.id}|${model.id}|${key.id}`;
  }

  async function callUpstream({ provider, model, key, body, stream, signal }) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('timeout')), Number(store.settings.timeoutMs) || 60000);
    const onAbort = () => ctrl.abort(new Error('cliente desconectou'));
    if (signal) signal.addEventListener('abort', onAbort);

    const cleanup = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    };

    const payload = {
      ...body,
      model: model.id,
      stream,
      messages: trimMessages(body.messages, provider.maxChars || Number(store.settings.maxContextChars) || 48000),
    };
    if (!stream) delete payload.stream_options;

    const base = baseUrlOf(provider, key.values);
    try {
      const r = await fetch(base + '/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + key.values[provider.keyEnv],
          ...(provider.headers || {}),
        },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      return { r, base, cleanup };
    } catch (e) {
      cleanup();
      throw e;
    }
  }

  function applyCooldown(provider, model, key, cl) {
    if (!cl.ms) return;
    if (cl.scope === 'provider') store.setCooldown(`p:${provider.id}`, cl.ms, cl.reason);
    else if (cl.scope === 'model') store.setCooldown(`m:${provider.id}::${model.id}`, cl.ms, cl.reason);
    else if (cl.scope === 'key') store.setCooldown(`k:${key.id}`, cl.ms, cl.reason);
    else if (cl.scope === 'keymodel') store.setCooldown(`km:${key.id}::${model.id}`, cl.ms, cl.reason);
  }

  function nextAvailableIn() {
    let min = Infinity;
    const now = Date.now();
    for (const c of Object.values(store.state.cooldowns)) {
      const d = c.until - now;
      if (d > 0 && d < min) min = d;
    }
    return Number.isFinite(min) ? Math.max(1, Math.ceil(min / 1000)) : null;
  }

  async function chat(body, opts = {}) {
    if (!Array.isArray(body.messages) || !body.messages.length) {
      return json(400, errObj('"messages" é obrigatório', 'invalid_request'));
    }

    const list = active(providers());
    const sel = parseModel(body.model, list);
    const stream = body.stream === true;

    if (sel.mode === 'pin' && !sel.provider.keys.length) {
      return json(
        400,
        errObj(`O provedor "${sel.provider.id}" não tem chave configurada.`, 'not_configured')
      );
    }

    let cands = candidatesFor(sel, list);
    if (sel.mode === 'auto') cands = rank(cands);
    cands = cands.filter((c) => !cd(`p:${c.provider.id}`) && !cd(`m:${c.provider.id}::${c.model.id}`));

    if (!cands.length) {
      const any = list.some((p) => p.keys.length);
      const wait = nextAvailableIn();
      return json(
        503,
        errObj(
          any ? 'Todos os provedores estão em espera (cota esgotada).' : 'Nenhum provedor configurado. Adicione uma chave no painel.',
          any ? 'gateway_exhausted' : 'not_configured',
          { retry_in_s: wait }
        ),
        wait ? { 'Retry-After': String(wait) } : undefined
      );
    }

    const attempts = [];
    let calls = 0;
    const max = Math.max(1, Number(store.settings.maxAttempts) || 16);
    let lastDetail = '';

    for (const cand of cands) {
      if (calls >= max) break;
      if (opts.signal && opts.signal.aborted) return new Response(null, { status: 499 });

      for (const key of cand.provider.keys) {
        if (calls >= max) break;
        const wait = blocked(cand.provider, cand.model, key);
        if (wait) {
          attempts.push({ provider: cand.provider.id, model: cand.model.id, status: 0, reason: 'em espera', detail: wait.reason });
          continue;
        }

        const id = limitId(cand.provider, cand.model, key);
        const quota = limiter.check(id, cand.provider.limits);
        if (!quota.ok) {
          attempts.push({
            provider: cand.provider.id,
            model: cand.model.id,
            status: 0,
            reason: 'cota ' + quota.reason,
            detail: `aguarde ${quota.waitS}s`,
          });
          continue;
        }

        calls++;
        limiter.begin(id);
        const t0 = Date.now();
        let up;
        try {
          up = await callUpstream({ ...cand, key, body, stream, signal: opts.signal });
          const r = up.r;

          if (!r.ok) {
            const text = await r.text().catch(() => '');
            throw Object.assign(new Error('http ' + r.status), { status: r.status, body: text, headers: r.headers });
          }

          limiter.learn(id, r.headers);
          const meta = {
            'X-Provider': cand.provider.id,
            'X-Model': cand.model.id,
            'X-Attempts': String(attempts.length + 1),
            'X-Key': key.source,
          };

          if (stream) {
            const ms = Date.now() - t0;
            store.touchStats(cand.provider.id, cand.model.id, { ok: true, ms });
            store.recordUsage({ provider: cand.provider.id, model: cand.model.id, tokens: 0, ms, ok: true });
            up.cleanup();

            let chars = 0;
            const counter = new TransformStream({
              transform(chunk, ctrl) {
                chars += chunk.length;
                ctrl.enqueue(chunk);
              },
              flush() {
                limiter.record(id, Math.ceil(chars / 4));
              },
            });

            return new Response(r.body.pipeThrough(counter), {
              status: 200,
              headers: {
                ...meta,
                'Content-Type': 'text/event-stream; charset=utf-8',
                'Cache-Control': 'no-cache',
                'X-Accel-Buffering': 'no',
              },
            });
          }

          const text = await r.text();
          up.cleanup();

          let data;
          try {
            data = JSON.parse(text);
          } catch {
            throw Object.assign(new Error('resposta inválida'), { status: 502, body: text, headers: r.headers });
          }
          if (data && data.error && !data.choices) {
            throw Object.assign(new Error('erro do provedor'), {
              status: 502,
              body: JSON.stringify(data.error),
              headers: r.headers,
            });
          }

          const usage = data.usage || {};
          const tokens = Number(usage.total_tokens) || (Number(usage.prompt_tokens) || 0) + (Number(usage.completion_tokens) || 0);
          limiter.record(id, tokens);

          const ms = Date.now() - t0;
          store.touchStats(cand.provider.id, cand.model.id, { ok: true, ms });
          store.recordUsage({ provider: cand.provider.id, model: cand.model.id, tokens, ms, ok: true });

          data.gateway = {
            provider: cand.provider.id,
            provider_name: cand.provider.name,
            model: cand.model.id,
            key: key.source,
            attempts,
          };
          return json(200, data, meta);
        } catch (e) {
          if (up) up.cleanup();
          if (opts.signal && opts.signal.aborted) return new Response(null, { status: 499 });

          const status = e.status || 0;
          const text = e.body || (e.cause && e.cause.message) || e.message || String(e);
          const cl = classify(status, text, e.headers);
          applyCooldown(cand.provider, cand.model, key, cl);

          const detail = shortErr(text);
          lastDetail = detail;
          attempts.push({ provider: cand.provider.id, model: cand.model.id, status, reason: cl.reason, detail });
          store.touchStats(cand.provider.id, cand.model.id, { ok: false, status, reason: cl.reason, detail });
          log(`[fallback] ${cand.provider.id}/${cand.model.id} → ${cl.reason}${status ? ' (' + status + ')' : ''}`);
        }
      }
    }

    store.recordUsage({ provider: '—', model: body.model || 'auto', tokens: 0, ms: 0, ok: false, reason: 'todas as tentativas falharam' });

    const allBad = attempts.length && attempts.every((a) => a.status === 400 || a.status === 422);
    const wait = nextAvailableIn();
    return json(
      allBad ? 400 : 503,
      errObj(
        allBad ? 'Os provedores recusaram a requisição: ' + lastDetail : 'Todos os provedores falharam ou estão sem cota.',
        allBad ? 'invalid_request' : 'gateway_exhausted',
        { attempts, retry_in_s: wait }
      ),
      !allBad && wait ? { 'Retry-After': String(wait) } : undefined
    );
  }

  function modelList() {
    const list = active(providers());
    const out = [{ id: 'auto' }, { id: 'auto-code' }];
    const seen = new Set();
    for (const p of list) {
      for (const m of p.models) {
        if (!seen.has(m.id)) {
          seen.add(m.id);
          out.push({ id: m.id, owned_by: 'auto' });
        }
      }
    }
    for (const p of list) {
      for (const m of p.models) out.push({ id: `${p.id}:${m.id}`, owned_by: p.id });
    }
    return out.map((d) => ({ ...d, object: 'model', owned_by: d.owned_by || 'ai-gateway' }));
  }

  function status() {
    const list = providers();
    const cooldown = (k) => {
      const c = cd(k);
      return c ? { reason: c.reason, seconds: Math.max(0, Math.ceil((c.until - Date.now()) / 1000)) } : null;
    };

    return {
      strategy: store.settings.strategy,
      settings: {
        maxAttempts: store.settings.maxAttempts,
        timeoutMs: store.settings.timeoutMs,
        maxContextChars: store.settings.maxContextChars,
        autoOffMinutes: store.settings.autoOffMinutes,
      },
      today: store.state.daily[new Date().toISOString().slice(0, 10)] || { requests: 0, tokens: 0, byProvider: {} },
      providers: list.map((p) => ({
        id: p.id,
        name: p.name,
        custom: !!p.custom,
        enabled: p.enabled !== false,
        configured: p.keys.length > 0,
        keys: p.keys.map((k) => ({ id: k.id, source: k.source, label: k.label })),
        keyUrl: p.keyUrl || '',
        hint: p.hint || '',
        fields: fieldsOf(p),
        limits: p.limits,
        cooldown: cooldown(`p:${p.id}`),
        models: p.models.map((m) => ({
          id: m.id,
          code: !!m.code,
          tools: !!m.tools,
          vision: !!m.vision,
          enabled: m.enabled !== false,
          cooldown: cooldown(`m:${p.id}::${m.id}`),
        })),
        stats: store.state.stats[p.id] || { ok: 0, fail: 0 },
      })),
      recent: store.state.recent.slice(0, 50),
    };
  }

  function usage() {
    const daily = Object.entries(store.state.daily)
      .sort(([a], [b]) => (a < b ? 1 : -1))
      .slice(0, 30)
      .map(([date, v]) => ({ date, ...v }));
    return { daily, recent: store.state.recent.slice(0, 100), limits: limiter.snapshot() };
  }

  async function check() {
    const list = active(providers());
    return Promise.all(
      list.map(async (p) => {
        if (!p.keys.length) return { provider: p.id, name: p.name, ok: false, line: `–  ${p.name}: sem chave` };
        const model = p.models[0];
        if (!model) return { provider: p.id, name: p.name, ok: false, line: `–  ${p.name}: sem modelo habilitado` };
        const key = p.keys[0];
        const t0 = Date.now();
        try {
          const up = await callUpstream({
            provider: p,
            model,
            key,
            body: { messages: [{ role: 'user', content: 'Responda apenas: ok' }], max_tokens: 32 },
            stream: false,
            signal: null,
          });
          const text = await up.r.text();
          up.cleanup();
          if (!up.r.ok) {
            return { provider: p.id, name: p.name, ok: false, line: `✗  ${p.name} (${model.id}): HTTP ${up.r.status} — ${shortErr(text)}` };
          }
          return { provider: p.id, name: p.name, ok: true, line: `✓  ${p.name} (${model.id}): ok em ${Date.now() - t0} ms` };
        } catch (e) {
          return { provider: p.id, name: p.name, ok: false, line: `✗  ${p.name}: ${(e.cause && e.cause.message) || e.message}` };
        }
      })
    );
  }

  async function discover(providerId) {
    const p = providers().find((x) => x.id === providerId);
    if (!p) throw new Error('provedor desconhecido');
    if (!p.keys.length) throw new Error('sem chave (falta ' + fieldsOf(p).map((f) => f.label).join(', ') + ')');
    const key = p.keys[0];
    const r = await fetch(baseUrlOf(p, key.values) + '/models', {
      headers: { Authorization: 'Bearer ' + key.values[p.keyEnv], ...(p.headers || {}) },
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

  return { chat, modelList, status, usage, check, discover, providers, limiter };
}

module.exports = { createGateway, classify, trimMessages, shortErr, errObj, json };
