# TableRepair Backend

Backend escalável para processamento de tabelas HTML com IA. Processa JSONs com 50.000+ questões sem travar o navegador.

## Stack

- **API**: Fastify (TypeScript)
- **Banco**: PostgreSQL + Prisma ORM
- **Fila**: BullMQ + Redis
- **Workers**: Node.js Worker Pool
- **IA**: Google Gemini + OpenRouter

## Setup Rápido

### 1. Instalar Dependências

```bash
npm install
```

### 2. Configurar Ambiente

```bash
cp .env.example .env
# Editar .env com suas chaves
```

### 3. Subir Infraestrutura

```bash
# Subir PostgreSQL e Redis
npm run docker:up

# Aguardar containers estarem healthy (~10s)
```

### 4. Criar Banco de Dados

```bash
# Gerar client Prisma
npm run db:generate

# Rodar migrations
npm run db:migrate
```

### 5. Iniciar Servidor

```bash
# Desenvolvimento (com hot reload)
npm run dev

# Ou produção
npm run build
npm start
```

### 6. Iniciar Worker (em outro terminal)

```bash
npm run worker
```

## Endpoints da API

| Método | Endpoint | Descrição |
|--------|----------|-----------|
| POST | `/api/v1/batch/upload` | Upload JSON |
| GET | `/api/v1/batch/:id` | Status do batch |
| GET | `/api/v1/batch/:id/result` | Download resultado |
| POST | `/api/v1/batch/:id/cancel` | Cancelar |
| GET | `/api/v1/batch/:id/issues` | Listar issues |
| GET | `/api/v1/batch/:id/logs` | Logs |
| GET | `/api/health` | Health check |

## Exemplo de Uso

### Upload via curl

```bash
curl -X POST http://localhost:3000/api/v1/batch/upload \
  -F "file=@questoes.json" \
  -F 'options={"strategy":"hybrid","dryRun":false}'
```

### Verificar Status

```bash
curl http://localhost:3000/api/v1/batch/{batchId}
```

### Download Resultado

```bash
curl http://localhost:3000/api/v1/batch/{batchId}/result -o resultado.json
```

## Configuração

### Variáveis de Ambiente

```env
# Database
DATABASE_URL="postgresql://user:pass@localhost:5432/tablerepair"

# Redis
REDIS_URL="redis://localhost:6379"

# API Keys
GEMINI_API_KEY="sua-chave-gemini"
OPENROUTER_KEYS="key1,key2,key3"  # Separadas por vírgula

# Server
PORT=3000
NODE_ENV=development

# Workers
WORKER_CONCURRENCY=8
MAX_RETRY_ATTEMPTS=3
RATE_LIMIT_PER_MINUTE=60
```

## Arquitetura

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Frontend  │────▶│   API REST  │────▶│   BullMQ    │
│   (React)   │     │  (Fastify)  │     │   (Redis)   │
└─────────────┘     └─────────────┘     └──────┬──────┘
                                               │
                    ┌─────────────────────────┼───────┐
                    │                         ▼       │
                    │   ┌─────────────┐    ┌─────────┐│
                    │   │ PostgreSQL  │◀───│ Workers ││
                    │   └─────────────┘    └─────────┘│
                    │                          │      │
                    │                    ┌─────▼─────┐│
                    │                    │ Gemini/   ││
                    │                    │ OpenRouter││
                    │                    └───────────┘│
                    └─────────────────────────────────┘
```

## Monitoramento

### Ver Status da Fila

```bash
curl http://localhost:3000/api/health
```

### Ver Logs do Batch

```bash
curl http://localhost:3000/api/v1/batch/{batchId}/logs?level=ERROR
```

## Troubleshooting

### Fila travada

```bash
# Parar e reiniciar worker
npm run worker
```

### Muitas falhas

Verificar:
1. Chaves API válidas
2. Rate limits
3. Logs de erro: `GET /api/v1/batch/{id}/logs?level=ERROR`

## Produção

### Docker

```bash
# Build
docker build -t tablerepair-backend .

# Run
docker-compose -f docker-compose.prod.yml up -d
```

### Recomendações

- VPS com 4GB+ RAM
- SSD para PostgreSQL
- Redis persistente (AOF)
- Nginx como reverse proxy
- SSL/TLS via Let's Encrypt
