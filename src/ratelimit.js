'use strict';

// Contadores de cota por (provedor, modelo, chave): RPM/RPD/TPM/TPD.
// Janela de minuto em memória (reinicia com o processo); totais diários
// persistem em state.daily via Store. Os tetos vêm do catálogo e são
// refinados com os headers que o provedor devolve.

function today() {
  return new Date().toISOString().slice(0, 10);
}

function secondsUntilTomorrow() {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return Math.max(1, Math.ceil((next - now) / 1000));
}

function createLimiter(store) {
  const mem = new Map();

  function slot(id) {
    let s = mem.get(id);
    if (!s) {
      s = { stamps: [], tokensMin: 0, day: today(), reqDay: 0, tokensDay: 0 };
      mem.set(id, s);
    }
    if (s.day !== today()) {
      s.day = today();
      s.reqDay = 0;
      s.tokensDay = 0;
    }
    const cutoff = Date.now() - 60000;
    while (s.stamps.length && s.stamps[0] < cutoff) s.stamps.shift();
    return s;
  }

  function limitsFor(base, id) {
    const learned = (store.state.learned || {})[id] || {};
    return {
      rpm: learned.rpm || base.rpm,
      rpd: learned.rpd || base.rpd,
      tpm: learned.tpm || base.tpm,
      tpd: learned.tpd || base.tpd,
    };
  }

  function check(id, base) {
    const s = slot(id);
    const l = limitsFor(base || {}, id);
    if (l.rpm && s.stamps.length >= l.rpm) {
      const wait = Math.ceil((s.stamps[0] + 60000 - Date.now()) / 1000);
      return { ok: false, waitS: Math.max(1, wait), reason: 'rpm' };
    }
    if (l.rpd && s.reqDay >= l.rpd) return { ok: false, waitS: secondsUntilTomorrow(), reason: 'rpd' };
    if (l.tpm && s.tokensMin >= l.tpm) return { ok: false, waitS: 60, reason: 'tpm' };
    if (l.tpd && s.tokensDay >= l.tpd) return { ok: false, waitS: secondsUntilTomorrow(), reason: 'tpd' };
    return { ok: true };
  }

  function begin(id) {
    const s = slot(id);
    s.stamps.push(Date.now());
    s.reqDay++;
  }

  function record(id, tokens) {
    if (!tokens) return;
    const s = slot(id);
    s.tokensMin += tokens;
    s.tokensDay += tokens;
  }

  // Aprende tetos a partir dos headers padrão de rate limit.
  function learn(id, headers) {
    if (!headers) return;
    const get = (n) => {
      const v = typeof headers.get === 'function' ? headers.get(n) : headers[n];
      const num = Number(v);
      return Number.isFinite(num) && num > 0 ? num : 0;
    };
    const rpm = get('x-ratelimit-limit-requests') || get('ratelimit-limit');
    const tpm = get('x-ratelimit-limit-tokens') || get('x-ratelimit-limit-tokens-minute');
    if (rpm || tpm) store.learnLimits(id, { rpm, tpm });
  }

  function snapshot() {
    const out = {};
    for (const [id, s] of mem) {
      out[id] = { minuteRequests: s.stamps.length, dayRequests: s.reqDay, dayTokens: s.tokensDay };
    }
    return out;
  }

  return { check, begin, record, learn, snapshot };
}

module.exports = { createLimiter, secondsUntilTomorrow, today };
