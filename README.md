# AI Gateway

Um endereço só (`/v1`, compatível com a API da OpenAI) para várias IAs gratuitas.
Quando a cota de uma acaba — 429, 402, 403, 401 ou timeout — o gateway passa
sozinho para a próxima chave, modelo ou provedor.

**v2 · local-first · zero dependências · 100% gratuito**

- Roda no seu PC com `node src/index.js` e vira um `.exe` único em `npm run build:exe`.
- Chaves cifradas em repouso (AES-256-GCM) em `data/keys.enc.json`.
- Cotas controladas por **chave + modelo** (RPM/RPD/TPM/TPD), com tetos aprendidos
  dos headers de cada provedor.
- Várias chaves por provedor, com rotação automática no 429.
- Painel com Chaves, Cadeia, Modelos, Uso, Playground e Ajustes.
- Streaming, `auto`, `auto-code`, modelo unificado e `provedor:modelo`.
- Endpoints custom OpenAI-compatíveis (Ollama, LM Studio, vLLM, llama.cpp).

## Requisitos

Node.js 20+ (testado no 22). Nenhum pacote para instalar em runtime.

## Rodar do código

```powershell
node src/index.js
```

Abre `http://localhost:8787`, mostra a **chave do gateway** (`agw-…`) no console e
no painel. Sem chaves cadastradas, o painel abre em **Chaves** — conecte pelo menos
uma IA (Groq, Gemini, OpenRouter, NVIDIA, Cerebras, Mistral, OpenCode Zen ou
Cloudflare Workers AI). O botão leva à página da chave e o gateway valida antes de
salvar.

Outros comandos:

```powershell
node src/index.js --check      # testa cada provedor conectado
node src/index.js --discover   # lista os modelos que cada provedor serve agora
node src/index.js --no-open    # não abre o navegador
npm run smoke                  # sobe numa pasta temporária e testa as rotas
```

## Baixar o EXE

Cada push no `main` gera o executável no GitHub Actions. Link fixo:

```
https://github.com/helioangelis/ai-gateway/releases/latest/download/AI-Gateway.exe
```

Ou abra **Actions → Build → último run → Artifacts → AI-Gateway-exe**. O release
`latest` é sobrescrito a cada push; o histórico fica nos runs.

## Gerar o EXE localmente

```powershell
npm run build:exe
```

Saída: `dist/AI-Gateway.exe` (arquivo único, ~90 MB, sem instalar nada). Os dados
ficam em `dist/data/` ao lado do executável. O build usa `esbuild` e `postject`
via `npx` (baixados na hora; nada fica no projeto).

## Usar no OpenCode

Acrescente o provedor em `~/.config/opencode/opencode.json` (schema V2):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "providers": {
    "aigateway": {
      "name": "AI Gateway (local)",
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": {
        "baseURL": "http://127.0.0.1:8787/v1",
        "apiKey": "{env:AIGATEWAY_TOKEN}"
      },
      "models": {
        "auto": {
          "name": "Auto Router",
          "limit": { "context": 131072, "output": 32768 }
        }
      }
    }
  }
}
```

Defina `AIGATEWAY_TOKEN` com a chave do gateway e reinicie o OpenCode. Depois
`/models` → **Auto Router**. Para fixar um modelo, use `aigateway/<modelo>`.

## API

Todas as rotas exigem `Authorization: Bearer <chave-do-gateway>` (ou `x-api-key`),
exceto `/health` e o login do painel.

| Rota | O que faz |
|---|---|
| `POST /v1/chat/completions` | chat (stream e não-stream) |
| `GET /v1/models` | modelos disponíveis |
| `GET /api/status` | estado dos provedores, cotas e últimos erros |
| `GET/POST/DELETE /api/keys` | gerenciar chaves |
| `POST /api/keys/:id/test` | validar chave no provedor |
| `POST /api/discover` | listar modelos ao vivo de um provedor |
| `GET/PUT /api/settings` | ordem, estratégia, limites, provedores custom |
| `GET /api/usage` | uso por dia e requisições recentes |
| `POST /api/check` | testar todos os provedores |
| `POST /api/reset` | liberar todas as esperas |

Valores de `model`:

- `auto` — segue a ordem da cadeia (estratégia escolhida no painel).
- `auto-code` — modelos marcados como `code` primeiro.
- `groq` / `groq:openai/gpt-oss-120b` — fixa provedor ou modelo.
- um id de modelo que exista em vários provedores — failover estrito entre eles.
- qualquer outro nome — tratado como `auto`.

## Como o fallback decide

| Erro | O que acontece |
|---|---|
| 429 | chave+modelo em espera (usa `Retry-After`; 1 min se for por minuto, até 6 h se diário) |
| 402 / 403 | provedor em espera (6 h / 3 h) |
| 401 | chave em espera por 12 h e desativada no painel |
| 404 | modelo em espera por 1 h |
| contexto grande | modelo em espera por 5 min |
| 5xx, rede, timeout | modelo em espera por 1 min |
| 400 / 422 | tenta o próximo, sem espera |

O histórico é cortado para caber no contexto de cada provedor (limite global em
Ajustes, por provedor no catálogo).

## Dados e segurança

| Arquivo | Conteúdo |
|---|---|
| `data/keys.enc.json` | chaves dos provedores (AES-256-GCM) |
| `data/.secret` | segredo que cifra as chaves (0600) |
| `data/.token` | chave do gateway |
| `data/settings.json` | ordem, estratégia, modelos, provedores custom |
| `data/state.json` | esperas, estatísticas e uso |

Trocar `ENCRYPTION_KEY` (ou apagar `.secret`) torna as chaves salvas ilegíveis.
O gateway só escuta em `127.0.0.1` por padrão; para expor na rede, defina
`HOST=0.0.0.0` **e** `GATEWAY_TOKEN` — o servidor recusa subir sem os dois.

## Roadmap

- **Fase 1 (esta):** core + painel + EXE.
- **Fase 2:** empacotamento Android com Node embutido (mesmo `src/`), serviço em
  primeiro plano e botão ligar/desligar com desligamento por ociosidade.
- **Fase 3:** `/v1/messages` (Claude Code), MCP e backup cifrado entre aparelhos.

## Licença

MIT.
