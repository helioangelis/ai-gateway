# AI Gateway

Um endereço só para várias IAs gratuitas. Quando a cota de uma acaba (429, 402, 403 ou timeout), o gateway passa sozinho para a próxima.

Provedores: Groq, Google Gemini, OpenRouter (`:free`), NVIDIA NIM, Cerebras, Mistral, OpenCode Zen e Cloudflare Workers AI.

O GitHub Actions faz o resto: roda os testes, publica o gateway no Cloudflare Workers (grátis, 24 h no ar), confere que subiu e gera o APK com link de download direto.

## Conectar as IAs pelo app (sem mexer em arquivo)

Em **Ajustes**, cada IA tem um botão:

| IA | O que o botão faz |
|---|---|
| OpenRouter | **Entrar com OpenRouter**: abre a tela de login deles; ao autorizar, a chave volta sozinha para o gateway (OAuth PKCE). |
| Groq, Gemini, NVIDIA, Cerebras, Mistral, OpenCode Zen, Cloudflare | **Conectar**: abre a página de login/chave do provedor no navegador do celular; você cria a chave, copia, volta ao app, cola e toca em **Salvar**. |

Só o OpenRouter oferece login de verdade para apps de terceiros. Nos outros, o provedor só entrega a chave depois do login no site dele, por isso o botão leva você até lá e recebe a chave colada.

O gateway testa a chave na hora (se o provedor recusar, avisa e não salva). As chaves ficam criptografadas (AES-GCM, derivada do seu `GATEWAY_TOKEN`) no armazenamento do gateway e nunca voltam para a tela. Trocar o `GATEWAY_TOKEN` torna as chaves salvas ilegíveis; é preciso conectar de novo.

## Fazer tudo (Termux, uma vez só)

```sh
pkg install -y unzip
cd ~ && unzip ~/storage/downloads/ai-gateway.zip -d ai-gateway && cd ai-gateway
bash setup-termux.sh        # na primeira vez só cria o .env
nano .env                   # preencha CLOUDFLARE_API_TOKEN e CLOUDFLARE_ACCOUNT_ID
bash setup-termux.sh        # cria o repositório, envia os segredos, espera o Actions e mostra os links
```

Só 2 itens são obrigatórios no `.env`: `CLOUDFLARE_API_TOKEN` (com as permissões "Edit Cloudflare Workers" e "Workers KV Storage: Edit") e `CLOUDFLARE_ACCOUNT_ID`. A senha do gateway (`GATEWAY_TOKEN`) é criada sozinha e mostrada no final.

Na primeira vez o `gh auth login` pede um login no navegador. Isso é do GitHub e não dá para automatizar.

O script termina mostrando o endereço do gateway, o link direto do APK (`.../releases/download/latest/ai-gateway.apk`) e a senha. No app: Ajustes, digite a senha, toque em Conectar em cada IA.

## Depois disso

Cada `git push` na branch `main` repete tudo (testes, publicação, APK). As IAs conectadas pelo app continuam conectadas entre publicações.

## Usar no seu app

É a API da OpenAI; troque só a URL base:

```js
const r = await fetch('https://ai-gateway.SEU-SUBDOMINIO.workers.dev/v1/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer SEU_GATEWAY_TOKEN' },
  body: JSON.stringify({ model: 'auto-code', messages: [{ role: 'user', content: 'Crie um site de portfólio' }], stream: true }),
});
// os cabeçalhos X-Provider e X-Model dizem quem respondeu
```

Valores de `model`:
- `auto`: segue a ordem dos provedores.
- `auto-code`: coloca primeiro os modelos marcados com `code: true`.
- `groq` ou `groq:openai/gpt-oss-120b`: fixa um provedor ou modelo (sem fallback).
- qualquer outro nome (ex.: `gpt-4o`) é tratado como `auto`.

Rotas (todas com `Authorization: Bearer <token>`, exceto `/health` e o retorno do login):
`POST /v1/chat/completions`, `GET /v1/models`, `GET /api/status`, `GET /api/check`, `POST /api/reset`, `GET /api/discover/<provedor>`, `POST /api/keys`, `POST /api/keys/remove`, `POST /api/connect/<provedor>/start`, `GET /oauth/<provedor>/callback`.

## Ajustar modelos e ordem

Os nomes de modelos gratuitos mudam muito. Se um provedor devolver 404, veja os nomes atuais em `<gateway>/api/discover/groq` (troque `groq` pelo provedor) e crie o segredo `GATEWAY_CONFIG` com algo como:

```json
{ "order": ["groq", "gemini", "openrouter"], "models": { "groq": [{ "id": "openai/gpt-oss-120b", "code": true }] } }
```

Campos: `order`, `disabled`, `models` (strings ou `{ "id", "code" }`) e `extraProviders` (qualquer API compatível com OpenAI; veja `config.example.json`).

## Como o fallback decide

| Erro | O que acontece |
|---|---|
| 429 | modelo em espera (usa `Retry-After`; 1 min se for por minuto, 3 h se for cota diária) |
| 402 / 403 | provedor inteiro em espera (6 h / 3 h) |
| 401 | provedor em espera por 12 h (chave inválida) |
| 404 | modelo em espera por 1 h |
| contexto grande | modelo em espera por 5 min |
| 5xx, rede, timeout | modelo em espera por 1 min |
| 400 / 422 | tenta o próximo, sem espera |

No Cloudflare as esperas ficam num KV, então valem para todas as instâncias. O histórico da conversa é enviado inteiro a cada mensagem (assim a conversa continua ao trocar de IA) e cortado para caber no contexto de cada provedor.

## Rodar local (opcional)

```sh
node server.js              # http://localhost:8787
node server.js --check      # testa cada chave
node server.js --discover   # lista modelos de cada provedor
node test/mock-test.js      # 20 testes com provedores falsos
```

Abra pelo endereço `http://localhost:8787` (não `127.0.0.1`): o login do OpenRouter só aceita `localhost` como retorno em modo local. Exige Node 20 ou mais novo.

## Cuidados

- As chaves ficam só nos segredos do GitHub/Cloudflare e no armazenamento criptografado do gateway. Nunca dentro do APK nem do código. O `.env` não vai para o repositório.
- O gateway recusa qualquer uso sem `GATEWAY_TOKEN`. Sem isso, qualquer pessoa que achasse o endereço gastaria sua cota.
- O APK não leva o token; você digita uma vez no app.
- Uma conta por provedor. Criar várias para driblar limite viola os termos e leva a bloqueio.
- Em planos gratuitos vários provedores podem usar seus prompts para treinar modelos. Não envie dados de clientes nem senhas.
- Os limites gratuitos do Cloudflare Workers (100 mil requisições por dia) sobram para uso pessoal.
