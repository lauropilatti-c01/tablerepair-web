import { FastifyPluginAsync } from 'fastify';
import { db } from '../../services/dbService.js';
import { getQueueStats } from '../../config/queue.js';

export const healthRoutes: FastifyPluginAsync = async (app) => {
  // Health check básico
  app.get('/health', async (request, reply) => {
    try {
      // Verificar conexão com banco
      await db.prisma.$queryRaw`SELECT 1`;

      // Verificar fila
      const queueStats = await getQueueStats();

      return {
        status: 'ok',
        timestamp: new Date().toISOString(),
        database: 'connected',
        queue: {
          waiting: queueStats.waiting,
          active: queueStats.active,
          completed: queueStats.completed,
          failed: queueStats.failed,
        },
        uptime: process.uptime(),
      };
    } catch (error: any) {
      reply.status(503);
      return {
        status: 'error',
        timestamp: new Date().toISOString(),
        error: error.message,
      };
    }
  });

  // Versão da API
  app.get('/version', async () => {
    return {
      version: '1.0.0',
      name: 'TableRepair Backend',
      environment: process.env.NODE_ENV,
    };
  });
};
