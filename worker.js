// Entrada do Cloudflare Workers. A lógica toda está em core.js.
// O Actions publica este arquivo com `wrangler deploy` (veja wrangler.toml).
import { createGateway, parseConfig } from './core.js';
import providers from './providers.js';

let gateway;

// Cooldowns dos provedores (um registro só) e chaves conectadas pelo app.
function kvPersist(kv) {
  return {
    read: () => kv.get('state', 'json'),
    write: (snapshot) => kv.put('state', JSON.stringify(snapshot), { expirationTtl: 86400 }),
  };
}

function kvStore(kv) {
  return {
    get: (k) => kv.get(k),
    put: (k, v, ttl) => kv.put(k, v, ttl ? { expirationTtl: Math.max(60, ttl) } : undefined),
    del: (k) => kv.delete(k),
  };
}

export default {
  async fetch(request, env, ctx) {
    if (!gateway) {
      gateway = createGateway({
        providers,
        env,
        config: parseConfig(env.GATEWAY_CONFIG),
        persist: env.STATE ? kvPersist(env.STATE) : null,
        store: env.STATE ? kvStore(env.STATE) : null,
        refreshMs: 15000,       // relê esperas e chaves do KV a cada 15 s (várias instâncias compartilham)
        persistStats: false,    // o KV grátis só aceita ~1000 escritas por dia
        requireToken: true,     // nunca expõe o gateway sem senha
      });
    }
    return gateway.fetch(request, ctx);
  },
};
