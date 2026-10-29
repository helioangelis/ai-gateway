'use strict';

// Ordem = prioridade padrão do fallback.
// Nomes de modelos gratuitos mudam com frequência. Para ver o que cada provedor
// oferece agora:   node server.js --discover   (ou /api/discover/<provedor>)
// e ajuste em config.json / segredo GATEWAY_CONFIG (sem mexer neste arquivo).
//
// code: true  → o modelo é priorizado quando você usa o perfil "auto-code".
// maxChars    → limite de histórico enviado a esse provedor (contexto pequeno).
// keyUrl      → página onde o usuário entra e cria a chave (botão "Conectar" do app).
// oauth       → provedor com login de verdade: o app abre o login e recebe a chave sozinho.
// fields      → campos que o app pede ao conectar (padrão: só a chave).

module.exports = [
  {
    id: 'groq',
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    keyEnv: 'GROQ_API_KEY',
    keyUrl: 'https://console.groq.com/keys',
    models: [
      { id: 'openai/gpt-oss-120b', code: true },
      { id: 'qwen/qwen3-32b', code: true },
      { id: 'llama-3.3-70b-versatile' },
    ],
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyEnv: 'GEMINI_API_KEY',
    keyUrl: 'https://aistudio.google.com/apikey',
    models: [
      { id: 'gemini-2.5-flash', code: true },
      { id: 'gemini-2.5-flash-lite' },
    ],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter (:free)',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyEnv: 'OPENROUTER_API_KEY',
    keyUrl: 'https://openrouter.ai/keys',
    oauth: {
      authUrl: 'https://openrouter.ai/auth',
      tokenUrl: 'https://openrouter.ai/api/v1/auth/keys',
    },
    headers: { 'X-Title': 'AI Gateway' },
    models: [
      { id: 'qwen/qwen3-coder:free', code: true },
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
    hint: 'No site, entre na conta e use "Get API Key" em qualquer modelo.',
    models: [
      { id: 'qwen/qwen3-coder-480b-a35b-instruct', code: true },
      { id: 'meta/llama-3.3-70b-instruct' },
    ],
  },
  {
    id: 'cerebras',
    name: 'Cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    keyEnv: 'CEREBRAS_API_KEY',
    keyUrl: 'https://cloud.cerebras.ai/',
    hint: 'No painel, abra "API Keys" e toque em "Generate API Key".',
    maxChars: 16000, // contexto do plano gratuito é pequeno (~8k tokens)
    models: [
      { id: 'gpt-oss-120b', code: true },
      { id: 'llama-3.3-70b' },
    ],
  },
  {
    id: 'mistral',
    name: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    keyEnv: 'MISTRAL_API_KEY',
    keyUrl: 'https://console.mistral.ai/api-keys',
    models: [
      { id: 'mistral-small-latest' },
      { id: 'codestral-latest', code: true },
    ],
  },
  {
    id: 'opencode',
    name: 'OpenCode Zen',
    baseUrl: 'https://opencode.ai/zen/v1',
    keyEnv: 'OPENCODE_API_KEY',
    keyUrl: 'https://opencode.ai/zen',
    models: [
      { id: 'big-pickle', code: true },
    ],
  },
  {
    id: 'cloudflare',
    name: 'Cloudflare Workers AI',
    baseUrl: (env) => `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai/v1`,
    keyEnv: 'CLOUDFLARE_API_KEY',
    requires: ['CLOUDFLARE_ACCOUNT_ID'],
    keyUrl: 'https://dash.cloudflare.com/profile/api-tokens',
    hint: 'Crie um token com a permissão "Workers AI". O ID da conta aparece na página inicial do painel.',
    fields: [
      { name: 'CLOUDFLARE_API_KEY', label: 'Token de API (Workers AI)', secret: true },
      { name: 'CLOUDFLARE_ACCOUNT_ID', label: 'ID da conta', secret: false },
    ],
    maxChars: 24000,
    models: [
      { id: '@cf/qwen/qwen2.5-coder-32b-instruct', code: true },
      { id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' },
    ],
  },
];
