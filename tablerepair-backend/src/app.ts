import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import { env, isDev } from './config/env.js';
import { logger, createLogger } from './utils/logger.js';
import { db } from './services/dbService.js';
import { closeQueue } from './config/queue.js';
import { batchRoutes } from './api/routes/batch.routes.js';
import { healthRoutes } from './api/routes/health.routes.js';

const log = createLogger('app');

// Criar instância Fastify
const app = Fastify({
  logger: isDev ? {
    transport: {
      target: 'pino-pretty',
      options: { colorize: true }
    }
  } : true,
});

// Registrar plugins
await app.register(cors, {
  origin: true, // Allow all origins (can restrict later)
  credentials: true,
});

await app.register(multipart, {
  limits: {
    fileSize: env.MAX_FILE_SIZE_MB * 1024 * 1024, // MB para bytes
  },
});

await app.register(websocket);

// Registrar rotas
await app.register(healthRoutes, { prefix: '/api' });
await app.register(batchRoutes, { prefix: '/api/v1/batch' });

// Error handler global
app.setErrorHandler((error, request, reply) => {
  log.error('Unhandled error', {
    error: error.message,
    stack: error.stack,
    url: request.url,
  });

  reply.status(error.statusCode || 500).send({
    error: 'Internal Server Error',
    message: isDev ? error.message : 'Something went wrong',
  });
});

// Graceful shutdown
const shutdown = async (signal: string) => {
  log.info(`Received ${signal}. Shutting down gracefully...`);

  try {
    await app.close();
    await closeQueue();
    await db.disconnect();
    log.info('Shutdown complete');
    process.exit(0);
  } catch (err) {
    log.error('Error during shutdown', { error: err });
    process.exit(1);
  }
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Iniciar servidor
const start = async () => {
  try {
    // Conectar ao banco
    await db.connect();

    // Iniciar servidor
    await app.listen({ port: env.PORT, host: env.HOST });

    log.info(`🚀 Server running at http://${env.HOST}:${env.PORT}`);
    log.info(`📊 Environment: ${env.NODE_ENV}`);
    log.info(`🔧 Workers: ${env.WORKER_CONCURRENCY}`);
  } catch (err) {
    log.error('Failed to start server', { error: err });
    process.exit(1);
  }
};

start();

export { app };
