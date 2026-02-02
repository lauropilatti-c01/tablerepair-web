import { Queue, QueueEvents } from 'bullmq';
import Redis from 'ioredis';
import { env } from './env.js';
import { createLogger } from '../utils/logger.js';
import type { JobPayload } from '../utils/types.js';

const log = createLogger('queue');

// Conexão Redis compartilhada
const connection = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null, // Necessário para BullMQ
});

connection.on('connect', () => log.info('Redis conectado'));
connection.on('error', (err: Error) => log.error('Redis erro', { error: err.message }));

// ==========================================
// FILAS
// ==========================================

// Fila principal de reparos
export const repairQueue = new Queue<JobPayload>('repair', {
  connection,
  defaultJobOptions: {
    attempts: env.MAX_RETRY_ATTEMPTS,
    backoff: {
      type: 'exponential',
      delay: 5000, // 5s, 10s, 20s, 40s...
    },
    removeOnComplete: {
      age: 3600 * 24, // Mantém por 24h após completar
      count: 1000,    // Ou últimos 1000 jobs
    },
    removeOnFail: {
      age: 3600 * 24 * 7, // Mantém falhas por 7 dias
    },
  },
});

// Eventos da fila (para WebSocket)
export const repairQueueEvents = new QueueEvents('repair', { connection });

// ==========================================
// HELPERS
// ==========================================

export async function addRepairJob(payload: JobPayload, priority: number = 0): Promise<Job<JobPayload>> {
  const job = await repairQueue.add('repair-table', payload, {
    priority,
    jobId: payload.taskId, // Usar taskId como jobId para rastreamento
  });

  log.debug('Job adicionado à fila', {
    jobId: job.id,
    taskId: payload.taskId,
    questionIndex: payload.questionIndex,
  });

  return job;
}

export async function addBulkRepairJobs(payloads: JobPayload[]): Promise<void> {
  const jobs = payloads.map((payload, index) => ({
    name: 'repair-table',
    data: payload,
    opts: {
      jobId: payload.taskId,
      priority: index, // Processa em ordem
    },
  }));

  await repairQueue.addBulk(jobs);
  log.info(`${jobs.length} jobs adicionados à fila`);
}

export async function getQueueStats() {
  const [waiting, active, completed, failed, delayed] = await Promise.all([
    repairQueue.getWaitingCount(),
    repairQueue.getActiveCount(),
    repairQueue.getCompletedCount(),
    repairQueue.getFailedCount(),
    repairQueue.getDelayedCount(),
  ]);

  return { waiting, active, completed, failed, delayed };
}

export async function pauseQueue(): Promise<void> {
  await repairQueue.pause();
  log.info('Fila pausada');
}

export async function resumeQueue(): Promise<void> {
  await repairQueue.resume();
  log.info('Fila retomada');
}

export async function clearQueue(): Promise<void> {
  await repairQueue.drain();
  log.info('Fila limpa');
}

export async function cancelBatchJobs(batchId: string): Promise<number> {
  // Busca jobs do batch e remove
  const jobs = await repairQueue.getJobs(['waiting', 'delayed', 'active']);
  let cancelled = 0;

  for (const job of jobs) {
    if (job.data.batchId === batchId) {
      await job.remove();
      cancelled++;
    }
  }

  log.info(`${cancelled} jobs cancelados para batch ${batchId}`);
  return cancelled;
}

// Graceful shutdown
export async function closeQueue(): Promise<void> {
  await repairQueue.close();
  await repairQueueEvents.close();
  connection.disconnect();
  log.info('Fila fechada');
}
