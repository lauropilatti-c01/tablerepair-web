// Types compartilhados - baseado no projeto original
// PRESERVADO: Não alterar estrutura para manter compatibilidade

// ==========================================
// TIPOS DO PROJETO ORIGINAL (preservados)
// ==========================================

export interface Question {
  id?: string | number | null;
  id_pasta?: string | number;
  id_resolucao?: string | number;
  enunciado?: string;
  resolucao?: string;
  resolucao_aprofundada?: string;
  texto_associado?: string;
  materia?: string;
  assunto?: string;
  topico?: string;
  [key: string]: any;
}

export interface Issue {
  id: string;
  qid: string | number;
  questionIndex: number;
  field: string;
  tableIndex: number;
  severity: 'BAD' | 'WARN';
  type: string;
  title: string;
  location?: { row?: number; col?: number };
  rawHtml: string;
  fullText: string;
}

export interface AuditReport {
  stats: {
    time: number;
    totalTables: number;
    bad: number;
    warn: number;
  };
  issues: Issue[];
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface RepairAttempt {
  attemptNumber: number;
  provider: 'google' | 'openrouter';
  prompt: string;
  rawResponse: string;
  cleanedHtml: string;
  validationErrors: string[];
  usage: TokenUsage;
}

export interface RepairLog {
  issueId: string;
  qid: string | number;
  field: string;
  timestamp: string;
  attempts: RepairAttempt[];
  finalResult: 'success' | 'failed';
  totalCostBRL: number;
}

export interface RepairResult {
  issueId: string;
  originalHtml: string;
  repairedHtml: string;
  success: boolean;
  error?: string;
  provider?: 'google' | 'openrouter';
  usage?: TokenUsage;
  costBRL?: number;
  log?: RepairLog;
}

export interface RepairContext {
  materia?: string;
  assunto?: string;
  topico?: string;
  enunciado?: string;
  texto_associado?: string;
  qid: string | number;
  field: string;
}

// ==========================================
// TIPOS DO BACKEND (novos)
// ==========================================

export interface BatchCreateInput {
  fileName: string;
  fileSize: number;
  inputFilePath: string;
  strategy?: 'hybrid' | 'openrouter';
  dryRun?: boolean;
}

export interface BatchProgress {
  batchId: string;
  status: string;
  phase: string;
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  percentage: number;
  estimatedTimeRemaining?: number;
  costs: {
    tokensUsed: number;
    costBRL: number;
  };
}

export interface TaskCreateInput {
  batchId: string;
  questionIndex: number;
  qid: string;
  field: string;
  tableIndex: number;
  taskType: 'AUDIT' | 'REPAIR' | 'VALIDATE';
  issueType?: string;
  severity?: string;
  rawHtml?: string;
  context?: RepairContext;
}

export interface JobPayload {
  taskId: string;
  batchId: string;
  questionIndex: number;
  qid: string;
  field: string;
  tableIndex: number;
  rawHtml: string;
  context: RepairContext;
  attempt: number;
}

// Campos que são auditados em cada questão
export const FIELDS_TO_AUDIT = [
  'enunciado',
  'resolucao',
  'resolucao_aprofundada',
  'texto_associado',
] as const;

export type AuditableField = typeof FIELDS_TO_AUDIT[number];
