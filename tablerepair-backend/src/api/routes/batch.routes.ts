import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import * as fs from 'fs/promises';
import * as path from 'path';
import { db } from '../../services/dbService.js';
import { addBulkRepairJobs, cancelBatchJobs, getQueueStats } from '../../config/queue.js';
import { auditData, getQuestionId, FIELDS_TO_AUDIT } from '../../services/auditService.js';
import { createLogger } from '../../utils/logger.js';
import { env } from '../../config/env.js';
import type { Question, JobPayload, RepairContext } from '../../utils/types.js';

const log = createLogger('batchRoutes');

// Schemas de validação
const uploadOptionsSchema = z.object({
  strategy: z.enum(['hybrid', 'openrouter']).default('hybrid'),
  dryRun: z.boolean().default(false),
  severityFilter: z.enum(['BAD', 'WARN', 'ALL']).default('BAD'),
});

export const batchRoutes: FastifyPluginAsync = async (app) => {

  // ==========================================
  // POST /upload - Upload JSON e criar batch
  // ==========================================
  app.post('/upload', async (request, reply) => {
    try {
      const data = await request.file();

      if (!data) {
        return reply.status(400).send({ error: 'No file uploaded' });
      }

      // Ler conteúdo do arquivo
      const buffer = await data.toBuffer();
      const content = buffer.toString('utf-8');

      // Parse JSON
      let jsonData: Question[] | { questoes: Question[] };
      try {
        jsonData = JSON.parse(content);
      } catch (e) {
        return reply.status(400).send({ error: 'Invalid JSON file' });
      }

      const questions = Array.isArray(jsonData) ? jsonData : (jsonData.questoes || []);

      if (questions.length === 0) {
        return reply.status(400).send({ error: 'JSON has no questions' });
      }

      // Parse opções do form data
      const optionsRaw = data.fields?.options;
      const optionsStr = typeof optionsRaw === 'object' && 'value' in optionsRaw
        ? (optionsRaw as any).value
        : '{}';
      const options = uploadOptionsSchema.parse(JSON.parse(optionsStr || '{}'));

      // Salvar arquivo no disco
      const fileName = data.filename || 'upload.json';
      const timestamp = Date.now();
      const inputFilePath = path.join(env.UPLOAD_DIR, `${timestamp}_${fileName}`);

      await fs.mkdir(env.UPLOAD_DIR, { recursive: true });
      await fs.writeFile(inputFilePath, content);

      // Criar batch no banco
      const batch = await db.createBatch({
        fileName,
        fileSize: buffer.length,
        inputFilePath,
        strategy: options.strategy,
        dryRun: options.dryRun,
      });

      log.info('Batch created', { batchId: batch.id, fileName, questions: questions.length });

      // Iniciar auditoria (síncrona, rápida)
      await db.updateBatchStatus(batch.id, 'PROCESSING', 'AUDIT');

      const auditStart = Date.now();
      const report = auditData(jsonData);
      const auditTime = Date.now() - auditStart;

      log.info('Audit complete', {
        batchId: batch.id,
        time: auditTime,
        issues: report.issues.length,
        bad: report.stats.bad,
        warn: report.stats.warn,
      });

      // Filtrar issues por severidade
      const filteredIssues = options.severityFilter === 'ALL'
        ? report.issues
        : report.issues.filter(i =>
            options.severityFilter === 'BAD' ? i.severity === 'BAD' : true
          );

      // Atualizar contadores do batch
      await db.updateBatchCounters(batch.id, {
        totalQuestions: questions.length,
        totalTables: report.stats.totalTables,
        totalIssues: filteredIssues.length,
      });

      // Se dryRun, parar aqui
      if (options.dryRun) {
        await db.updateBatchStatus(batch.id, 'COMPLETED', 'DONE');
        return {
          batchId: batch.id,
          status: 'COMPLETED',
          dryRun: true,
          audit: {
            time: auditTime,
            totalTables: report.stats.totalTables,
            bad: report.stats.bad,
            warn: report.stats.warn,
            issues: filteredIssues.length,
          },
        };
      }

      // Criar tasks para cada issue (deduplicadas por tabela)
      const taskMap = new Map<string, JobPayload>();

      for (const issue of filteredIssues) {
        const key = `${issue.questionIndex}-${issue.field}-${issue.tableIndex}`;

        if (!taskMap.has(key)) {
          const q = questions[issue.questionIndex];
          const context: RepairContext = {
            materia: q?.materia,
            assunto: q?.assunto,
            topico: q?.topico,
            enunciado: q?.enunciado?.substring(0, 1000),
            texto_associado: q?.texto_associado?.substring(0, 2000),
            qid: issue.qid,
            field: issue.field,
          };

          const task = await db.createTask({
            batchId: batch.id,
            questionIndex: issue.questionIndex,
            qid: String(issue.qid),
            field: issue.field,
            tableIndex: issue.tableIndex,
            taskType: 'REPAIR',
            issueType: issue.type,
            severity: issue.severity,
            rawHtml: issue.rawHtml,
            context,
          });

          taskMap.set(key, {
            taskId: task.id,
            batchId: batch.id,
            questionIndex: issue.questionIndex,
            qid: String(issue.qid),
            field: issue.field,
            tableIndex: issue.tableIndex,
            rawHtml: issue.rawHtml,
            context,
            attempt: 0,
          });
        }
      }

      // Enfileirar jobs
      const jobs = Array.from(taskMap.values());
      await addBulkRepairJobs(jobs);

      await db.updateBatchStatus(batch.id, 'PROCESSING', 'REPAIR');

      log.info('Jobs queued', { batchId: batch.id, jobs: jobs.length });

      return {
        batchId: batch.id,
        status: 'PROCESSING',
        totalQuestions: questions.length,
        totalIssues: filteredIssues.length,
        tasksCreated: jobs.length,
        estimatedTime: Math.ceil(jobs.length * 5 / 60), // ~5s por task, em minutos
      };

    } catch (error: any) {
      log.error('Upload error', { error: error.message });
      return reply.status(500).send({ error: error.message });
    }
  });

  // ==========================================
  // GET /:batchId - Status do batch
  // ==========================================
  app.get('/:batchId', async (request, reply) => {
    const { batchId } = request.params as { batchId: string };

    const progress = await db.getBatchProgress(batchId);

    if (!progress) {
      return reply.status(404).send({ error: 'Batch not found' });
    }

    const batch = await db.getBatch(batchId);

    return {
      ...progress,
      fileName: batch?.fileName,
      createdAt: batch?.createdAt,
      startedAt: batch?.startedAt,
      completedAt: batch?.completedAt,
      strategy: batch?.strategy,
      outputFileReady: !!batch?.outputFilePath,
    };
  });

  // ==========================================
  // GET /:batchId/result - Download resultado
  // ==========================================
  app.get('/:batchId/result', async (request, reply) => {
    const { batchId } = request.params as { batchId: string };

    const batch = await db.getBatch(batchId);

    if (!batch) {
      return reply.status(404).send({ error: 'Batch not found' });
    }

    if (batch.status !== 'COMPLETED') {
      return reply.status(202).send({
        error: 'Batch not completed yet',
        status: batch.status,
        phase: batch.currentPhase,
      });
    }

    if (!batch.outputFilePath) {
      return reply.status(404).send({ error: 'Output file not generated' });
    }

    try {
      const content = await fs.readFile(batch.outputFilePath, 'utf-8');
      const outputFileName = batch.fileName.replace('.json', '_POS_TABELA.json');

      reply.header('Content-Type', 'application/json');
      reply.header('Content-Disposition', `attachment; filename="${outputFileName}"`);

      return content;
    } catch (error) {
      return reply.status(404).send({ error: 'Output file not found on disk' });
    }
  });

  // ==========================================
  // POST /:batchId/cancel - Cancelar batch
  // ==========================================
  app.post('/:batchId/cancel', async (request, reply) => {
    const { batchId } = request.params as { batchId: string };

    const batch = await db.getBatch(batchId);

    if (!batch) {
      return reply.status(404).send({ error: 'Batch not found' });
    }

    if (batch.status === 'COMPLETED' || batch.status === 'CANCELLED') {
      return reply.status(400).send({
        error: 'Cannot cancel batch',
        status: batch.status,
      });
    }

    // Cancelar jobs na fila
    const cancelled = await cancelBatchJobs(batchId);

    // Atualizar status
    await db.updateBatchStatus(batchId, 'CANCELLED');

    log.info('Batch cancelled', { batchId, jobsCancelled: cancelled });

    return {
      batchId,
      status: 'CANCELLED',
      jobsCancelled: cancelled,
    };
  });

  // ==========================================
  // GET /:batchId/issues - Listar issues
  // ==========================================
  app.get('/:batchId/issues', async (request, reply) => {
    const { batchId } = request.params as { batchId: string };
    const { severity, status, limit = '50', offset = '0' } = request.query as any;

    const tasks = await db.getTasksByBatch(batchId, status);

    const filtered = severity
      ? tasks.filter(t => t.severity === severity)
      : tasks;

    const paginated = filtered.slice(
      parseInt(offset),
      parseInt(offset) + parseInt(limit)
    );

    return {
      total: filtered.length,
      limit: parseInt(limit),
      offset: parseInt(offset),
      issues: paginated.map(t => ({
        id: t.id,
        questionIndex: t.questionIndex,
        qid: t.qid,
        field: t.field,
        tableIndex: t.tableIndex,
        type: t.issueType,
        severity: t.severity,
        status: t.status,
        attempts: t.attempts,
        repairedHtml: t.repairedHtml?.substring(0, 500),
        error: t.lastError,
      })),
    };
  });

  // ==========================================
  // GET /:batchId/logs - Logs do batch
  // ==========================================
  app.get('/:batchId/logs', async (request, reply) => {
    const { batchId } = request.params as { batchId: string };
    const { level, limit = '100', offset = '0' } = request.query as any;

    const logs = await db.getLogs(batchId, {
      level,
      limit: parseInt(limit),
      offset: parseInt(offset),
    });

    return {
      total: logs.length,
      logs: logs.map(l => ({
        id: l.id,
        level: l.level,
        message: l.message,
        taskId: l.taskId,
        questionIndex: l.questionIndex,
        createdAt: l.createdAt,
        metadata: l.metadata,
      })),
    };
  });
};
