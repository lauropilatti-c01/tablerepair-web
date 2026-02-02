/**
 * REPAIR WORKER
 *
 * Processa jobs da fila BullMQ.
 * Cada job representa uma tabela para reparar.
 */

import { Worker, Job } from 'bullmq';
import Redis from 'ioredis';
import { env } from '../config/env.js';
import { db } from '../services/dbService.js';
import { repairTableWithGemini, countExpectedCols } from '../services/repairService.js';
import { createLogger } from '../utils/logger.js';
import type { JobPayload } from '../utils/types.js';

const log = createLogger('repairWorker');

// Conexão Redis para o worker
const connection = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
});

// Criar worker
const worker = new Worker<JobPayload>(
  'repair',
  async (job: Job<JobPayload>) => {
    const { taskId, batchId, questionIndex, qid, field, tableIndex, rawHtml, context, attempt } = job.data;

    log.info('Processing job', {
      jobId: job.id,
      taskId,
      qid,
      field,
      attempt: attempt + 1,
    });

    try {
      // Atualizar status para PROCESSING
      await db.updateTaskStatus(taskId, 'PROCESSING', {
        bullJobId: job.id,
        attempts: attempt + 1,
      });

      // Contar colunas esperadas
      const expectedCols = countExpectedCols(rawHtml);

      // Buscar batch para saber a estratégia
      const batch = await db.getBatch(batchId);
      const strategy = (batch?.strategy as 'hybrid' | 'openrouter') || 'hybrid';

      // Executar reparo
      const result = await repairTableWithGemini(
        taskId,
        rawHtml,
        expectedCols,
        context,
        strategy
      );

      if (result.success) {
        // Sucesso - atualizar task
        await db.updateTaskStatus(taskId, 'COMPLETED', {
          repairedHtml: result.repairedHtml,
          provider: result.provider,
          tokensUsed: result.usage?.totalTokens || 0,
          costBRL: result.costBRL || 0,
        });

        // Incrementar contadores do batch
        await db.incrementBatchCounters(batchId, {
          successCount: 1,
          totalTokensUsed: result.usage?.totalTokens || 0,
          totalCostBRL: result.costBRL || 0,
        });

        // Log de sucesso
        await db.createLog(batchId, 'INFO', `Table repaired successfully`, {
          taskId,
          questionIndex,
          field,
          metadata: {
            provider: result.provider,
            tokens: result.usage?.totalTokens,
            cost: result.costBRL,
          },
        });

        log.info('Job completed', {
          jobId: job.id,
          taskId,
          provider: result.provider,
          tokens: result.usage?.totalTokens,
        });

        return { success: true, taskId };

      } else {
        // Falha
        const task = await db.getTask(taskId);
        const maxAttempts = task?.maxAttempts || 3;

        if ((attempt + 1) < maxAttempts) {
          // Retry
          await db.updateTaskStatus(taskId, 'RETRY', {
            lastError: result.error,
            nextRetryAt: new Date(Date.now() + Math.pow(2, attempt + 1) * 5000), // Exponential backoff
          });

          log.warn('Job failed, will retry', {
            jobId: job.id,
            taskId,
            error: result.error,
            attempt: attempt + 1,
          });

          // Re-throw para BullMQ fazer retry
          throw new Error(result.error || 'Repair failed');

        } else {
          // Max attempts reached
          await db.updateTaskStatus(taskId, 'FAILED', {
            lastError: result.error,
          });

          await db.incrementBatchCounters(batchId, {
            failedCount: 1,
          });

          await db.createLog(batchId, 'ERROR', `Table repair failed after ${maxAttempts} attempts`, {
            taskId,
            questionIndex,
            field,
            metadata: { error: result.error },
          });

          log.error('Job permanently failed', {
            jobId: job.id,
            taskId,
            error: result.error,
          });

          return { success: false, taskId, error: result.error };
        }
      }

    } catch (error: any) {
      log.error('Job error', {
        jobId: job.id,
        taskId,
        error: error.message,
      });

      // Atualizar task com erro
      await db.updateTaskStatus(taskId, 'RETRY', {
        lastError: error.message,
      });

      throw error; // BullMQ vai fazer retry
    }
  },
  {
    connection,
    concurrency: env.WORKER_CONCURRENCY,
    limiter: {
      max: env.RATE_LIMIT_PER_MINUTE,
      duration: 60000, // 1 minuto
    },
  }
);

// Event handlers
worker.on('completed', async (job) => {
  log.debug('Job completed event', { jobId: job.id });

  // Verificar se batch está completo
  const batchId = job.data.batchId;
  await checkBatchCompletion(batchId);
});

worker.on('failed', (job, error) => {
  log.warn('Job failed event', {
    jobId: job?.id,
    error: error.message,
  });
});

worker.on('error', (error) => {
  log.error('Worker error', { error: error.message });
});

// Verificar se batch está completo
async function checkBatchCompletion(batchId: string) {
  const progress = await db.getBatchProgress(batchId);

  if (!progress) return;

  const isComplete = (progress.completedTasks + progress.failedTasks) >= progress.totalTasks;

  if (isComplete) {
    log.info('Batch processing complete', {
      batchId,
      success: progress.completedTasks,
      failed: progress.failedTasks,
    });

    // Gerar arquivo de saída
    await generateOutputFile(batchId);

    // Atualizar status
    await db.updateBatchStatus(batchId, 'COMPLETED', 'DONE');
  }
}

// Gerar arquivo JSON final
async function generateOutputFile(batchId: string) {
  try {
    const batch = await db.getBatch(batchId);
    if (!batch) return;

    // Ler arquivo original
    const originalContent = await import('fs/promises').then(fs =>
      fs.readFile(batch.inputFilePath, 'utf-8')
    );

    let originalData: any;
    try {
      originalData = JSON.parse(originalContent);
    } catch {
      log.error('Failed to parse original file', { batchId });
      return;
    }

    const questions = Array.isArray(originalData)
      ? originalData
      : (originalData.questoes || []);

    // Buscar tasks completadas
    const tasksMap = await db.getCompletedTasksGroupedByQuestion(batchId);

    // Aplicar reparos
    let modifiedCount = 0;
    for (const [questionIndex, tasks] of tasksMap) {
      const q = questions[questionIndex];
      if (!q) continue;

      for (const task of tasks) {
        if (task.repairedHtml && task.status === 'COMPLETED') {
          // Aplicar reparo usando domReplace
          const field = task.field;
          const originalFieldValue = q[field];

          if (originalFieldValue) {
            const newValue = domReplace(originalFieldValue, task.repairedHtml, task.tableIndex);
            if (newValue !== originalFieldValue) {
              q[field] = newValue;
              modifiedCount++;
            }
          }
        }
      }
    }

    // Salvar arquivo de saída
    const outputFileName = batch.fileName.replace('.json', '_POS_TABELA.json');
    const outputDir = env.OUTPUT_DIR;
    const outputFilePath = `${outputDir}/${Date.now()}_${outputFileName}`;

    await import('fs/promises').then(fs => fs.mkdir(outputDir, { recursive: true }));

    const outputData = Array.isArray(originalData)
      ? questions
      : { ...originalData, questoes: questions };

    await import('fs/promises').then(fs =>
      fs.writeFile(outputFilePath, JSON.stringify(outputData, null, 2))
    );

    // Atualizar batch com caminho do arquivo
    await db.setBatchOutputFile(batchId, outputFilePath);

    log.info('Output file generated', {
      batchId,
      path: outputFilePath,
      modifiedQuestions: modifiedCount,
    });

  } catch (error: any) {
    log.error('Failed to generate output file', {
      batchId,
      error: error.message,
    });
  }
}

// DOM Replace function (preservada do original)
function domReplace(fullHtml: string, newTableHtml: string, tableIndex: number): string {
  try {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM(`<body>${fullHtml}</body>`);
    const doc = dom.window.document;
    const body = doc.querySelector('body');

    if (!body) return fullHtml;

    // Get all top-level tables
    const allTables = Array.from(body.querySelectorAll('table')).filter((t: Element) => {
      let p = t.parentElement;
      while (p && p !== body) {
        if (p.tagName === 'TABLE') return false;
        p = p.parentElement;
      }
      return true;
    }) as Element[];

    if (tableIndex >= allTables.length) {
      log.warn('Table index out of bounds', { tableIndex, totalTables: allTables.length });
      return fullHtml;
    }

    const targetTable = allTables[tableIndex] as Element;

    if (newTableHtml.trim() === '') {
      // Remove table (CONTENT_SWALLOW case)
      targetTable.remove();
    } else {
      // Replace table
      const tempDiv = doc.createElement('div');
      tempDiv.innerHTML = newTableHtml;
      const newTable = tempDiv.querySelector('table');

      if (newTable) {
        targetTable.replaceWith(newTable);
      }
    }

    return body.innerHTML;
  } catch (error: any) {
    log.error('domReplace error', { error: error.message });
    return fullHtml;
  }
}

// Graceful shutdown
async function shutdown() {
  log.info('Worker shutting down...');
  await worker.close();
  connection.disconnect();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

log.info('Repair worker started', { concurrency: env.WORKER_CONCURRENCY });

export { worker };
