# Dockerfile para TableRepair Backend
FROM node:20-alpine

WORKDIR /app

# Instalar dependencias do sistema
RUN apk add --no-cache openssl

# Copiar arquivos de dependencias
COPY package*.json ./
COPY prisma ./prisma/

# Instalar dependencias
RUN npm ci --only=production

# Gerar Prisma Client
RUN npx prisma generate

# Copiar codigo fonte
COPY . .

# Build TypeScript
RUN npm run build

# Criar diretorios para uploads e outputs
RUN mkdir -p /app/uploads /app/outputs

# Expor porta
EXPOSE 3000

# Comando padrao (pode ser sobrescrito)
CMD ["node", "dist/app.js"]
