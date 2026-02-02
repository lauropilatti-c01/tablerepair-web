#!/bin/bash
set -e

echo "=========================================="
echo "  TABLEREPAIR BACKEND - DEPLOY"
echo "=========================================="

# Cores
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Verificar Node.js
if ! command -v node &> /dev/null; then
    echo -e "${YELLOW}Node.js não encontrado. Instalando via nvm...${NC}"
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
    export NVM_DIR="$HOME/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
    nvm install 20
    nvm use 20
fi

echo -e "${GREEN}✓ Node.js $(node -v)${NC}"

# Verificar Docker
if ! command -v docker &> /dev/null; then
    echo -e "${YELLOW}Docker não encontrado. Por favor instale o Docker.${NC}"
    exit 1
fi

echo -e "${GREEN}✓ Docker encontrado${NC}"

# 1. Instalar dependências
echo ""
echo "1/5 - Instalando dependências..."
npm install

# 2. Gerar Prisma Client
echo ""
echo "2/5 - Gerando Prisma Client..."
npx prisma generate

# 3. Subir Redis
echo ""
echo "3/5 - Iniciando Redis..."
docker-compose up -d redis

# Aguardar Redis
sleep 3

# 4. Criar diretórios
echo ""
echo "4/5 - Criando diretórios..."
mkdir -p uploads outputs

# 5. Build
echo ""
echo "5/5 - Compilando TypeScript..."
npm run build

echo ""
echo "=========================================="
echo -e "${GREEN}  DEPLOY CONCLUÍDO!${NC}"
echo "=========================================="
echo ""
echo "Para iniciar:"
echo "  API:    npm start"
echo "  Worker: npm run start:worker"
echo ""
echo "Ou em modo desenvolvimento:"
echo "  API:    npm run dev"
echo "  Worker: npm run worker:watch"
echo ""
echo "Para testar:"
echo "  curl http://localhost:3000/health"
echo ""
