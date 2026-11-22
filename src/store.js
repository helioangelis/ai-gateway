'use strict';

// Persistência em JSON com escrita atômica (tmp + rename).
// Escolha deliberada: roda em Node 18+ (inclusive nodejs-mobile no APK futuro),
// sem dependências nativas. A interface abaixo isola o resto do código caso
// depois queiramos trocar por SQLite.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { seal, open, newSecret } = require('./crypto');
const { fieldsOf } = require('./catalog');

const DAY = 86400000;

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeAtomic(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function defaultSettings() {
  return {
    version: 2,
    strategy: 'balanced',
    order: ['groq', 'gemini', 'openrouter', 'nvidia', 'cerebras', 'mistral', 'opencode', 'cloudflare'],
    disabled: [],
    models: {},
    limits: {},
    custom: [],
    maxAttempts: 16,
    timeoutMs: 60000,
    maxContextChars: 48000,
    autoOffMinutes: 5,
  };
}

function defaultState() {
  return {
    cooldowns: {},
    stats: {},
    daily: {},
    recent: [],
    learned: {},
  };
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

class Store {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });

    this.secret = this._loadSecret();
    this.token = this._loadToken();
    this.settings = { ...defaultSettings(), ...readJson(path.join(dir, 'settings.json'), {}) };
    this.state = { ...defaultState(), ...readJson(path.join(dir, 'state.json'), {}) };
    this.keys = this._loadKeys();

    this._timers = new Map();
    this._dirty = new Set();
  }

  // ---------------------------------------------------------------- segredos
  _loadSecret() {
    if (process.env.ENCRYPTION_KEY) return process.env.ENCRYPTION_KEY;
    const file = path.join(this.dir, '.secret');
    try {
      const s = fs.readFileSync(file, 'utf8').trim();
      if (s) return s;
    } catch { /* primeira execução */ }
    const s = newSecret();
    fs.writeFileSync(file, s, { mode: 0o600 });
    return s;
  }

  _loadToken() {
    if (process.env.GATEWAY_TOKEN) return process.env.GATEWAY_TOKEN;
    const file = path.join(this.dir, '.token');
    try {
      const t = fs.readFileSync(file, 'utf8').trim();
      if (t) return t;
    } catch { /* primeira execução */ }
    const t = 'agw-' + crypto.randomBytes(20).toString('hex');
    fs.writeFileSync(file, t, { mode: 0o600 });
    return t;
  }

  // ------------------------------------------------------------------ chaves
  _loadKeys() {
    const file = path.join(this.dir, 'keys.enc.json');
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      const list = open(raw, this.secret);
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  _saveKeys() {
    const file = path.join(this.dir, 'keys.enc.json');
    writeAtomic(file, seal(this.keys, this.secret));
  }

  /** Chaves utilizáveis de um provedor: variáveis de ambiente + cadastradas. */
  keysFor(provider) {
    const fields = fieldsOf(provider);
    const out = [];

    const envValues = {};
    for (const f of fields) if (process.env[f.name]) envValues[f.name] = process.env[f.name];
    if (fields.every((f) => envValues[f.name])) {
      out.push({ id: 'env:' + provider.id, source: 'env', label: 'Ambiente (.env)', values: envValues });
    }

    for (const k of this.keys) {
      if (k.provider !== provider.id || k.disabled) continue;
      if (!fields.every((f) => k.values && k.values[f.name])) continue;
      out.push({ id: k.id, source: 'app', label: k.label || 'Chave', values: k.values });
    }
    return out;
  }

  listKeys() {
    return this.keys.map((k) => ({
      id: k.id,
      provider: k.provider,
      label: k.label,
      masked: Object.fromEntries(
        Object.entries(k.values || {}).map(([name, value]) => [
          name,
          name.endsWith('_ACCOUNT_ID') ? value : String(value).slice(0, 5) + '••••' + String(value).slice(-4),
        ])
      ),
      createdAt: k.createdAt,
      disabled: !!k.disabled,
      status: k.status || null,
    }));
  }

  addKey({ provider, label, values }) {
    const id = 'k_' + crypto.randomBytes(6).toString('hex');
    this.keys.push({
      id,
      provider,
      label: label || 'Chave',
      values,
      createdAt: Date.now(),
      disabled: false,
      status: null,
    });
    this._saveKeys();
    return id;
  }

  removeKey(id) {
    const before = this.keys.length;
    this.keys = this.keys.filter((k) => k.id !== id);
    if (this.keys.length !== before) this._saveKeys();
    return before !== this.keys.length;
  }

  setKeyStatus(id, ok, error) {
    const k = this.keys.find((x) => x.id === id);
    if (!k) return;
    k.status = { ok, error: error || null, at: Date.now() };
    if (!ok) k.disabled = true;
    this._saveKeys();
  }

  setKeyDisabled(id, disabled) {
    const k = this.keys.find((x) => x.id === id);
    if (!k) return;
    k.disabled = !!disabled;
    if (!disabled) k.status = null;
    this._saveKeys();
  }

  // --------------------------------------------------------------- settings
  updateSettings(patch) {
    const allowed = Object.keys(defaultSettings());
    for (const [k, v] of Object.entries(patch || {})) {
      if (!allowed.includes(k)) continue;
      this.settings[k] = v;
    }
    this._schedule('settings');
    return this.settings;
  }

  // ------------------------------------------------------------------ estado
  cooldown(key) {
    const c = this.state.cooldowns[key];
    if (!c) return null;
    if (c.until <= Date.now()) {
      delete this.state.cooldowns[key];
      return null;
    }
    return c;
  }

  setCooldown(key, ms, reason) {
    this.state.cooldowns[key] = { until: Date.now() + ms, reason };
    this._schedule('state');
  }

  clearCooldowns() {
    this.state.cooldowns = {};
    this._schedule('state');
  }

  touchStats(providerId, modelId, { ok, ms, status, reason, detail }) {
    const st = (this.state.stats[providerId] = this.state.stats[providerId] || {
      ok: 0,
      fail: 0,
      lastOk: 0,
      lastError: null,
      lastModel: null,
      latency: 0,
    });
    if (ok) {
      st.ok++;
      st.lastOk = Date.now();
      st.lastModel = modelId;
      st.latency = st.latency ? Math.round(st.latency * 0.7 + ms * 0.3) : ms;
    } else {
      st.fail++;
      st.lastError = { at: Date.now(), model: modelId, status, reason, detail: String(detail || '').slice(0, 240) };
    }
    this._schedule('state');
  }

  recordUsage({ provider, model, tokens, ms, ok, reason }) {
    const d = today();
    const day = (this.state.daily[d] = this.state.daily[d] || { requests: 0, tokens: 0, byProvider: {} });
    day.requests++;
    day.tokens += tokens || 0;
    day.byProvider[provider] = (day.byProvider[provider] || 0) + 1;

    this.state.recent.unshift({ at: Date.now(), provider, model, tokens: tokens || 0, ms, ok, reason: reason || null });
    if (this.state.recent.length > 200) this.state.recent.length = 200;

    // guarda 30 dias
    const cutoff = new Date(Date.now() - 30 * DAY).toISOString().slice(0, 10);
    for (const key of Object.keys(this.state.daily)) if (key < cutoff) delete this.state.daily[key];

    this._schedule('state');
  }

  learnLimits(key, { rpm, tpm }) {
    const cur = (this.state.learned[key] = this.state.learned[key] || {});
    if (rpm) cur.rpm = rpm;
    if (tpm) cur.tpm = tpm;
    this._schedule('state');
  }

  // -------------------------------------------------------------- persistência
  _schedule(name) {
    this._dirty.add(name);
    if (this._timers.has(name)) return;
    this._timers.set(
      name,
      setTimeout(() => {
        this._timers.delete(name);
        this._flushOne(name);
      }, 400)
    );
  }

  _flushOne(name) {
    if (!this._dirty.has(name)) return;
    this._dirty.delete(name);
    try {
      if (name === 'settings') writeAtomic(path.join(this.dir, 'settings.json'), this.settings);
      if (name === 'state') writeAtomic(path.join(this.dir, 'state.json'), this.state);
    } catch (e) {
      console.error('[store] falha ao salvar ' + name + ': ' + e.message);
    }
  }

  flush() {
    for (const name of [...this._dirty]) this._flushOne(name);
    for (const t of this._timers.values()) clearTimeout(t);
    this._timers.clear();
  }
}

module.exports = { Store, defaultSettings, defaultState, today };
