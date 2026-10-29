'use strict';
// Junta os segredos do GitHub que existem (não vazios) em secrets.json,
// para o `wrangler secret bulk` enviar ao Worker.
const fs = require('fs');

const NAMES = [
  'GATEWAY_TOKEN',
  'GROQ_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY',
  'CEREBRAS_API_KEY', 'MISTRAL_API_KEY', 'OPENCODE_API_KEY',
  'CLOUDFLARE_API_KEY', 'CLOUDFLARE_ACCOUNT_ID',
  'GATEWAY_CONFIG',
];

const out = {};
for (const n of NAMES) if (process.env[n]) out[n] = process.env[n];
fs.writeFileSync('secrets.json', JSON.stringify(out));
console.log('Segredos que serão enviados ao Worker:', Object.keys(out).join(', ') || '(nenhum)');
