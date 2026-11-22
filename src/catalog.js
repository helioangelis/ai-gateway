'use strict';

// Catálogo de provedores gratuitos. Nomes de modelos mudam com frequência:
// a lista abaixo é só o ponto de partida. Use "Descobrir" no painel (ou
// `node src/index.js --discover`) para listar o que cada provedor serve agora
// e habilite o que quiser em settings.models.
//
// code: true  → priorizado no perfil "auto-code"
// maxChars    → corte de histórico para contextos pequenos
// keyUrl      → página onde o usuário cria a chave (botão "Conectar")
// limits      → tetos gratuitos conhecidos (RPM/RPD/TPM/TPD); podem ser
//               ajustados em settings.limits e são refinados com os headers
//               que cada provedor devolve.

const PROVIDERS = [
  {
    id: 'groq',
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    keyEnv: 'GROQ_API_KEY',
    keyUrl: 'https://console.groq.com/keys',
    hint: 'Entre com Google/GitHub e crie uma API key.',
    limits: { rpm: 30, rpd: 1000, tpm: 6000, tpd: 500000 },
    models: [
      { id: 'openai/gpt-oss-120b', code: true, tools: true },
      { id: 'qwen/qwen3-32b', code: true, tools: true },
      { id: 'llama-3.3-70b-versatile', tools: true },
    ],
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyEnv: 'GEMINI_API_KEY',
    keyUrl: 'https://aistudio.google.com/apikey',
    hint: 'Crie a chave no AI Studio (não precisa de cartão).',
    limits: { rpm: 15, rpd: 1500, tpm: 1000000, tpd: 1500000 },
    models: [
      { id: 'gemini-2.5-flash', code: true, tools: true, vision: true, context: 1000000 },
      { id: 'gemini-2.5-flash-lite', tools: true, vision: true, context: 1000000 },
    ],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter (:free)',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyEnv: 'OPENROUTER_API_KEY',
    keyUrl: 'https://openrouter.ai/keys',
    hint: 'Modelos com sufixo :free não gastam crédito.',
    headers: { 'X-Title': 'AI Gateway' },
    limits: { rpm: 20, rpd: 50, tpm: 20000, tpd: 200000 },
    oauth: {
      authUrl: 'https://openrouter.ai/auth',
      tokenUrl: 'https://openrouter.ai/api/v1/auth/keys',
    },
    models: [
      { id: 'qwen/qwen3-coder:free', code: true, tools: true },
      { id: 'nvidia/nemotron-3-super-120b-a12b:free', code: true },
      { id: 'openrouter/free' },
    ],
  },
  {
    id: 'nvidia',
    name: 'NVIDIA NIM',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    keyEnv: 'NVIDIA_API_KEY',
    keyUrl: 'https://build.nvidia.com/',
    hint: 'Entre na conta e use "Get API Key" em qualquer modelo.',
    limits: { rpm: 40, rpd: 1000 },
    models: [
      { id: 'qwen/qwen3-coder-480b-a35b-instruct', code: true, tools: true },
      { id: 'meta/llama-3.3-70b-instruct', tools: true },
    ],
  },
  {
    id: 'cerebras',
    name: 'Cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    keyEnv: 'CEREBRAS_API_KEY',
    keyUrl: 'https://cloud.cerebras.ai/',
    hint: 'Painel → API Keys → Generate API Key.',
    maxChars: 16000,
    limits: { rpm: 30, rpd: 900, tpm: 60000, tpd: 1000000 },
    models: [
      { id: 'gpt-oss-120b', code: true, tools: true },
      { id: 'llama-3.3-70b', tools: true },
    ],
  },
  {
    id: 'mistral',
    name: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    keyEnv: 'MISTRAL_API_KEY',
    keyUrl: 'https://console.mistral.ai/api-keys',
    limits: { rpm: 60, rpd: 1000 },
    models: [
      { id: 'mistral-small-latest', tools: true },
      { id: 'codestral-latest', code: true, tools: true },
    ],
  },
  {
    id: 'opencode',
    name: 'OpenCode Zen',
    baseUrl: 'https://opencode.ai/zen/v1',
    keyEnv: 'OPENCODE_API_KEY',
    keyUrl: 'https://opencode.ai/zen',
    limits: { rpm: 30, rpd: 1000 },
    models: [{ id: 'big-pickle', code: true, tools: true }],
  },
  {
    id: 'cloudflare',
    name: 'Cloudflare Workers AI',
    baseUrl: 'https://api.cloudflare.com/client/v4/accounts/{account}/ai/v1',
    keyEnv: 'CLOUDFLARE_API_KEY',
    keyUrl: 'https://dash.cloudflare.com/profile/api-tokens',
    hint: 'Token com permissão "Workers AI"; o ID da conta aparece no painel.',
    requires: ['CLOUDFLARE_ACCOUNT_ID'],
    fields: [
      { name: 'CLOUDFLARE_API_KEY', label: 'Token de API (Workers AI)', secret: true },
      { name: 'CLOUDFLARE_ACCOUNT_ID', label: 'ID da conta', secret: false },
    ],
    maxChars: 24000,
    limits: { rpm: 300, rpd: 10000 },
    models: [
      { id: '@cf/qwen/qwen2.5-coder-32b-instruct', code: true },
      { id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' },
    ],
  },
];

function fieldsOf(p) {
  return p.fields || [
    { name: p.keyEnv, label: 'Chave de API', secret: true },
    ...(p.requires || []).map((n) => ({ name: n, label: n, secret: false })),
  ];
}

function baseUrlOf(p, credentials) {
  const raw = typeof p.baseUrl === 'function' ? p.baseUrl(credentials) : p.baseUrl;
  return String(raw || '')
    .replace('{account}', credentials.CLOUDFLARE_ACCOUNT_ID || '')
    .replace(/\/+$/, '');
}

// Junta catálogo fixo + provedores custom + overrides do settings.
function buildCatalog(settings) {
  const custom = (settings.custom || []).map((c) => ({
    id: c.id,
    name: c.name || c.id,
    baseUrl: c.baseUrl,
    keyEnv: 'CUSTOM_KEY',
    keyUrl: '',
    hint: 'Endpoint compatível com OpenAI.',
    custom: true,
    limits: c.limits || { rpm: 60, rpd: 2000 },
    models: (c.models || []).map((m) => (typeof m === 'string' ? { id: m } : m)),
  }));

  let list = [...PROVIDERS, ...custom];
  const disabled = new Set(settings.disabled || []);

  const rank = (id) => {
    const i = (settings.order || []).indexOf(id);
    return i < 0 ? 999 : i;
  };
  list.sort((a, b) => rank(a.id) - rank(b.id));

  return list.map((p) => {
    const override = settings.models && settings.models[p.id];
    const models = (override || p.models || []).map((m) =>
      typeof m === 'string' ? { id: m } : m
    );
    const limits = { ...(p.limits || {}), ...((settings.limits || {})[p.id] || {}) };
    return { ...p, models, limits, enabled: !disabled.has(p.id) };
  });
}

module.exports = { PROVIDERS, buildCatalog, fieldsOf, baseUrlOf };
