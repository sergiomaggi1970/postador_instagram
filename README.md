# Postador Instagram — Servidor de Agendamento

Servidor Node.js que publica posts no Instagram automaticamente no horário agendado.

## Deploy no Railway (gratuito)

1. Crie uma conta em [railway.app](https://railway.app)
2. Clique em **New Project → Deploy from GitHub repo**
3. Selecione este repositório
4. Vá em **Variables** e adicione:
   - `API_SECRET` → uma senha forte (ex: `minha-chave-secreta-123`)
5. O Railway vai detectar o `package.json` e fazer o deploy automaticamente
6. Copie a URL pública gerada (ex: `https://postador-agendamento.up.railway.app`)

## Variáveis de ambiente

| Variável | Descrição | Padrão |
|---|---|---|
| `API_SECRET` | Chave de autenticação da API | `trocar-por-chave-secreta` |
| `PORT` | Porta do servidor | `3000` |
| `DB_PATH` | Caminho do banco SQLite | `./posts.db` |

## Endpoints

| Método | Rota | Descrição |
|---|---|---|
| GET | `/ping` | Health check |
| POST | `/schedule` | Agenda um post para data/hora específica |
| POST | `/queue` | Adiciona à fila (publica após o último agendado) |
| GET | `/posts` | Lista posts (aceita `?status=pending`) |
| DELETE | `/posts/:id` | Cancela um post pendente |
| PATCH | `/posts/:id` | Atualiza horário de um post pendente |

Todos os endpoints (exceto `/ping`) exigem o header `X-API-Secret`.
