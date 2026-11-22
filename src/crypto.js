'use strict';

// Criptografia das chaves em repouso: AES-256-GCM com chave derivada por scrypt.
// O segredo fica em data/.secret (0600) ou em ENCRYPTION_KEY. Trocar o segredo
// torna as chaves salvas ilegíveis — é o comportamento desejado.

const crypto = require('node:crypto');

const SALT = 'ai-gateway/v2/keyring';

function derive(secret) {
  return crypto.scryptSync(String(secret), SALT, 32);
}

function seal(value, secret) {
  const key = derive(secret);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return {
    v: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

function open(sealed, secret) {
  const key = derive(secret);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
  const out = Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()]);
  return JSON.parse(out.toString('utf8'));
}

function newSecret() {
  return crypto.randomBytes(32).toString('hex');
}

function mask(value) {
  const s = String(value || '');
  if (s.length <= 10) return s ? '••••' : '';
  return s.slice(0, 5) + '••••' + s.slice(-4);
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

module.exports = { seal, open, newSecret, mask, safeEqual };
