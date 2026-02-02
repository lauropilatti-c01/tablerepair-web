import { PrismaClient, Batch, Task, ProcessLog } from '@prisma/client';

// Type aliases para status (agora são strings no banco)
type BatchStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
type TaskStatus = 'PENDING' | 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'RETRY' | 'SKIPPED' | 'CANCELLED';
type BatchPhase = 'UPLOAD' | 'AUDIT' | 'REPAIR' | 'VALIDATION' | 'EXPORT' | 'DONE';
type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
import { createLogger } from '../utils/logger.js';
import type { BatchCreateInput, TaskCreateInput, BatchProgress } from '../utils/types.js';

const log = createLogger('dbService');

// Singleton do Prisma Client
class DatabaseService {
  private static instance: DatabaseService;
  public prisma: PrismaClient;

  private constructor() {
    this.prisma = new PrismaClient({
      log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
    });
  }

  static getInstance(): DatabaseService {
    if (!DatabaseService.instance) {
      DatabaseService.instance = new DatabaseService();
    }
    return DatabaseService.instance;
  }

  async connect(): Promise<void> {
    try {
      await this.prisma.$connect();
      log.info('Conectado ao PostgreSQL');
    } catch (error) {
      log.error('Falha ao conectar ao PostgreSQL', { error });
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    await this.prisma.$disconnect();
    log.info('Desconectado do PostgreSQL');
  }

  // ==========================================
  // BATCH OPERATIONS
  // ==========================================

  async createBatch(input: BatchCreateInput): Promise<Batch> {
    const batch = await this.prisma.batch.create({
      data: {
        fileName: input.fileName,
        fileSize: input.fileSize,
        inputFilePath: input.inputFilePath,
        strategy: input.strategy || 'hybrid',
        dryRun: input.dryRun || false,
        status: 'PENDING',
        currentPhase: 'UPLOAD',
      },
    });
    log.info('Batch criado', { batchId: batch.id, fileName: input.fileName });
    return batch;
  }

  async getBatch(batchId: string): Promise<Batch | null> {
    return this.prisma.batch.findUnique({ where: { id: batchId } });
  }

  async updateBatchStatus(batchId: string, status: BatchStatus, phase?: BatchPhase): Promise<Batch> {
    const data: any = { status };

    if (phase) data.currentPhase = phase;
    if (status === 'PROCESSING' && !data.startedAt) data.startedAt = new Date();
    if (status === 'COMPLETED') data.completedAt = new Date();
    if (status === 'CANCELLED') data.cancelledAt = new Date();

    return this.prisma.batch.update({
      where: { id: batchId },
      data,
    });
  }

  async updateBatchCounters(batchId: string, counters: Partial<{
    totalQuestions: number;
    totalTables: number;
    totalIssues: number;
    successCount: number;
    failedCount: number;
    skippedCount: number;
    totalTokensUsed: number;
    totalCostBRL: number;
  }>): Promise<Batch> {
    return this.prisma.batch.update({
      where: { id: batchId },
      data: counters,
    });
  }

  async incrementBatchCounters(batchId: string, increments: {
    successCount?: number;
    failedCount?: number;
    skippedCount?: number;
    totalTokensUsed?: number;
    totalCostBRL?: number;
  }): Promise<Batch> {
    return this.prisma.batch.update({
      where: { id: batchId },
      data: {
        successCount: increments.successCount ? { increment: increments.successCount } : undefined,
        failedCount: increments.failedCount ? { increment: increments.failedCount } : undefined,
        skippedCount: increments.skippedCount ? { increment: increments.skippedCount } : undefined,
        totalTokensUsed: increments.totalTokensUsed ? { increment: increments.totalTokensUsed } : undefined,
        totalCostBRL: increments.totalCostBRL ? { increment: increments.totalCostBRL } : undefined,
      },
    });
  }

  async getBatchProgress(batchId: string): Promise<BatchProgress | null> {
    const batch = await this.prisma.batch.findUnique({
      where: { id: batchId },
      include: {
        _count: {
          select: {
            tasks: true,
          },
        },
      },
    });

    if (!batch) return null;

    const taskStats = await this.prisma.task.groupBy({
      by: ['status'],
      where: { batchId },
      _count: { status: true },
    });

    const statusCounts = taskStats.reduce((acc: Record<string, number>, curr: { status: string; _count: { status: number } }) => {
      acc[curr.status] = curr._count.status;
      return acc;
    }, {} as Record<string, number>);

    const totalTasks = batch._count.tasks;
    const completedTasks = (statusCounts['COMPLETED'] || 0) + (statusCounts['SKIPPED'] || 0);
    const failedTasks = statusCounts['FAILED'] || 0;

    return {
      batchId: batch.id,
      status: batch.status,
      phase: batch.currentPhase,
      totalTasks,
      completedTasks,
      failedTasks,
      percentage: totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0,
      costs: {
        tokensUsed: batch.totalTokensUsed,
        costBRL: batch.totalCostBRL,
      },
    };
  }

  async setBatchOutputFile(batchId: string, outputFilePath: string): Promise<Batch> {
    return this.prisma.batch.update({
      where: { id: batchId },
      data: { outputFilePath },
    });
  }

  // ==========================================
  // TASK OPERATIONS
  // ==========================================

  async createTask(input: TaskCreateInput): Promise<Task> {
    return this.prisma.task.create({
      data: {
        batchId: input.batchId,
        questionIndex: input.questionIndex,
        qid: input.qid,
        field: input.field,
        tableIndex: input.tableIndex,
        taskType: input.taskType,
        issueType: input.issueType,
        severity: input.severity,
        rawHtml: input.rawHtml,
        context: input.context as any,
        status: 'PENDING',
      },
    });
  }

  async createManyTasks(inputs: TaskCreateInput[]): Promise<number> {
    const result = await this.prisma.task.createMany({
      data: inputs.map(input => ({
        batchId: input.batchId,
        questionIndex: input.questionIndex,
        qid: input.qid,
        field: input.field,
        tableIndex: input.tableIndex,
        taskType: input.taskType,
        issueType: input.issueType,
        severity: input.severity,
        rawHtml: input.rawHtml,
        context: input.context as any,
        status: 'PENDING',
      })),
    });
    return result.count;
  }

  async getTask(taskId: string): Promise<Task | null> {
    return this.prisma.task.findUnique({ where: { id: taskId } });
  }

  async getPendingTasks(batchId: string, limit: number = 100): Promise<Task[]> {
    return this.prisma.task.findMany({
      where: {
        batchId,
        status: { in: ['PENDING', 'RETRY'] },
        OR: [
          { nextRetryAt: null },
          { nextRetryAt: { lte: new Date() } },
        ],
      },
      orderBy: { questionIndex: 'asc' },
      take: limit,
    });
  }

  async updateTaskStatus(taskId: string, status: TaskStatus, extras?: Partial<{
    repairedHtml: string;
    provider: string;
    tokensUsed: number;
    costBRL: number;
    lastError: string;
    bullJobId: string;
    attempts: number;
    nextRetryAt: Date;
  }>): Promise<Task> {
    const data: any = { status, ...extras };

    if (status === 'PROCESSING') data.startedAt = new Date();
    if (status === 'COMPLETED' || status === 'FAILED') data.completedAt = new Date();

    return this.prisma.task.update({
      where: { id: taskId },
      data,
    });
  }

  async incrementTaskAttempt(taskId: string): Promise<Task> {
    return this.prisma.task.update({
      where: { id: taskId },
      data: { attempts: { increment: 1 } },
    });
  }

  async getTasksByBatch(batchId: string, status?: TaskStatus): Promise<Task[]> {
    return this.prisma.task.findMany({
      where: {
        batchId,
        ...(status ? { status } : {}),
      },
      orderBy: { questionIndex: 'asc' },
    });
  }

  async getCompletedTasksGroupedByQuestion(batchId: string): Promise<Map<number, Task[]>> {
    const tasks = await this.prisma.task.findMany({
      where: {
        batchId,
        status: 'COMPLETED',
      },
      orderBy: [{ questionIndex: 'asc' }, { tableIndex: 'asc' }],
    });

    const grouped = new Map<number, Task[]>();
    for (const task of tasks) {
      const existing = grouped.get(task.questionIndex) || [];
      existing.push(task);
      grouped.set(task.questionIndex, existing);
    }
    return grouped;
  }

  // ==========================================
  // LOG OPERATIONS
  // ==========================================

  async createLog(
    batchId: string,
    level: LogLevel,
    message: string,
    extras?: Partial<{
      taskId: string;
      questionIndex: number;
      field: string;
      metadata: any;
      stackTrace: string;
    }>
  ): Promise<ProcessLog> {
    return this.prisma.processLog.create({
      data: {
        batchId,
        level,
        message,
        taskId: extras?.taskId,
        questionIndex: extras?.questionIndex,
        field: extras?.field,
        metadata: extras?.metadata,
        stackTrace: extras?.stackTrace,
      },
    });
  }

  async getLogs(batchId: string, options?: {
    level?: LogLevel;
    limit?: number;
    offset?: number;
  }): Promise<ProcessLog[]> {
    return this.prisma.processLog.findMany({
      where: {
        batchId,
        ...(options?.level ? { level: options.level } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: options?.limit || 100,
      skip: options?.offset || 0,
    });
  }

  // ==========================================
  // CLEANUP
  // ==========================================

  async deleteOldBatches(daysOld: number = 30): Promise<number> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - daysOld);

    const result = await this.prisma.batch.deleteMany({
      where: {
        createdAt: { lt: cutoff },
        status: { in: ['COMPLETED', 'FAILED', 'CANCELLED'] },
      },
    });

    log.info(`Removidos ${result.count} batches antigos`);
    return result.count;
  }
}

// Exporta singleton
export const db = DatabaseService.getInstance();
