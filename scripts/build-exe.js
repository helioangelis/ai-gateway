#!/usr/bin/env node
'use strict';

// Gera dist/AI-Gateway.exe — executável único, sem dependências em runtime.
//
//   1. embute o painel (web/) como módulo JS
//   2. empacota src/ em um arquivo só (esbuild via npx)
//   3. monta o blob SEA do Node e injeta com postject
//
// Se algo falhar no meio, ainda sobra dist/ com os arquivos para rodar via Node.

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const BUILD = path.join(DIST, 'build');

// execSync passa pelo shell do sistema: resolve npx/.cmd e caminhos com espaço.
function run(cmd, cwd) {
  console.log('> ' + cmd);
  execSync(cmd, { stdio: 'inherit', cwd: cwd || ROOT });
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dst);
    else fs.copyFileSync(src, dst);
  }
}

console.log('Limpando dist/ ...');
fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(BUILD, { recursive: true });

console.log('Embutindo o painel ...');
const assets = {};
for (const name of fs.readdirSync(path.join(ROOT, 'web'))) {
  const file = path.join(ROOT, 'web', name);
  if (fs.statSync(file).isFile()) assets[name] = fs.readFileSync(file, 'utf8');
}

copyDir(path.join(ROOT, 'src'), BUILD);
fs.writeFileSync(path.join(BUILD, 'web-assets.js'), 'module.exports = ' + JSON.stringify(assets) + ';\n');

console.log('Empacotando com esbuild ...');
run('npx --yes esbuild build/index.js --bundle --platform=node --target=node18 --format=cjs --outfile=main.js', DIST);

console.log('Preparando o blob SEA ...');
fs.writeFileSync(
  path.join(DIST, 'sea-config.json'),
  JSON.stringify({ main: 'main.js', output: 'sea.blob', disableExperimentalSEAWarning: true }, null, 2)
);
run(`"${process.execPath}" --experimental-sea-config sea-config.json`, DIST);

const exe = path.join(DIST, process.platform === 'win32' ? 'AI-Gateway.exe' : 'ai-gateway');
fs.copyFileSync(process.execPath, exe);

console.log('Injetando o blob ...');
run(
  'npx --yes postject ' +
    (process.platform === 'win32' ? 'AI-Gateway.exe' : 'ai-gateway') +
    ' NODE_SEA_BLOB sea.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  DIST
);

for (const f of ['README.md', '.env.example']) {
  const src = path.join(ROOT, f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(DIST, path.basename(f)));
}

fs.rmSync(path.join(DIST, 'build'), { recursive: true, force: true });
fs.rmSync(path.join(DIST, 'sea.blob'), { force: true });
fs.rmSync(path.join(DIST, 'sea-config.json'), { force: true });
fs.rmSync(path.join(DIST, 'main.js'), { force: true });

const size = (fs.statSync(exe).size / 1024 / 1024).toFixed(1);
console.log(`\nPronto: ${exe} (${size} MB)`);
console.log('Rode com duplo clique ou: AI-Gateway.exe --no-open');
