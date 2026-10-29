#!/usr/bin/env bash
# Faz tudo de uma vez: cria o repositório no GitHub, envia as chaves como segredos,
# dispara o Actions (testa, publica no Cloudflare e gera o APK) e mostra os links.
#
# Uso:  bash setup-termux.sh [nome-do-repo]
set -euo pipefail
cd "$(dirname "$0")"

REPO_NAME="${1:-ai-gateway}"
VISIBILITY="${VISIBILITY:-public}"   # public deixa o link do APK baixável direto

if ! command -v gh >/dev/null 2>&1; then
  echo "Instalando o GitHub CLI..."
  pkg install -y gh git
fi

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Criei o .env. Preencha (nano .env) e rode de novo: bash setup-termux.sh"
  exit 0
fi

# carrega o .env sem exportar lixo
get() { grep -E "^$1=" .env | head -1 | cut -d= -f2- | sed -e 's/^["'\'']//' -e 's/["'\'']$//'; }

faltando=""
for v in CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID; do
  [ -n "$(get $v)" ] || faltando="$faltando $v"
done
if [ -n "$faltando" ]; then
  echo "Faltam no .env:$faltando"
  exit 1
fi

# A senha do gateway é criada sozinha se você não definiu uma.
if [ -z "$(get GATEWAY_TOKEN)" ]; then
  NOVO="$(head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 28)"
  if grep -q '^GATEWAY_TOKEN=' .env; then
    sed -i "s|^GATEWAY_TOKEN=.*|GATEWAY_TOKEN=$NOVO|" .env
  else
    echo "GATEWAY_TOKEN=$NOVO" >> .env
  fi
  echo "Criei a senha do gateway (guardada no .env)."
fi

# As IAs não precisam de chave aqui: você conecta cada uma pelo botão "Conectar" no app.

gh auth status >/dev/null 2>&1 || gh auth login

OWNER="$(gh api user -q .login)"
ID="$(gh api user -q .id)"

if [ ! -d .git ]; then git init -q -b main; fi
git config user.name  >/dev/null 2>&1 || git config user.name  "$OWNER"
git config user.email >/dev/null 2>&1 || git config user.email "${ID}+${OWNER}@users.noreply.github.com"
git add -A
git commit -q -m "AI Gateway" 2>/dev/null || true

if gh repo view "$OWNER/$REPO_NAME" >/dev/null 2>&1; then
  echo "Repositório $OWNER/$REPO_NAME já existe; vou atualizar."
  git remote get-url origin >/dev/null 2>&1 || git remote add origin "https://github.com/$OWNER/$REPO_NAME.git"
else
  gh repo create "$OWNER/$REPO_NAME" "--$VISIBILITY" --source=. --remote=origin >/dev/null
  echo "Repositório criado: https://github.com/$OWNER/$REPO_NAME"
fi

echo "Enviando os segredos (antes do código, para o Actions já achá-los)..."
for v in GATEWAY_TOKEN CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID \
         GROQ_API_KEY GEMINI_API_KEY OPENROUTER_API_KEY NVIDIA_API_KEY \
         CEREBRAS_API_KEY MISTRAL_API_KEY OPENCODE_API_KEY CLOUDFLARE_API_KEY; do
  val="$(get $v)"
  if [ -n "$val" ]; then
    gh secret set "$v" --repo "$OWNER/$REPO_NAME" --body "$val" >/dev/null
    echo "  ok $v"
  fi
done

git push -q -u origin main
echo "Código enviado. O Actions começou (testes, Cloudflare e APK)."

sleep 6
RUN="$(gh run list --repo "$OWNER/$REPO_NAME" --limit 1 --json databaseId -q '.[0].databaseId')"
gh run watch "$RUN" --repo "$OWNER/$REPO_NAME" --exit-status || {
  echo "O Actions falhou. Veja: https://github.com/$OWNER/$REPO_NAME/actions/runs/$RUN"
  exit 1
}

SUB="$(curl -s -H "Authorization: Bearer $(get CLOUDFLARE_API_TOKEN)" \
  "https://api.cloudflare.com/client/v4/accounts/$(get CLOUDFLARE_ACCOUNT_ID)/workers/subdomain" \
  | grep -o '"subdomain":"[^"]*"' | cut -d'"' -f4 || true)"

echo
echo "================ PRONTO ================"
[ -n "$SUB" ] && echo "Gateway (abre no navegador): https://ai-gateway.$SUB.workers.dev"
echo "APK (download direto):       https://github.com/$OWNER/$REPO_NAME/releases/download/latest/ai-gateway.apk"
echo "Resultado do Actions:        https://github.com/$OWNER/$REPO_NAME/actions/runs/$RUN"
echo "Senha do app (token):        $(get GATEWAY_TOKEN)"
echo
echo "Próximo passo: abra o app, digite a senha acima em Ajustes e toque em Conectar em cada IA."
