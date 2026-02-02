import { config } from 'dotenv';
import { z } from 'zod';

// Carrega .env
config();

// Schema de validação das variáveis de ambiente
const envSchema = z.object({
  // Database
  DATABASE_URL: z.string().url(),

  // Redis
  REDIS_URL: z.string().default('redis://localhost:6379'),

  // API Keys
  GEMINI_API_KEY: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),

  // Server
  PORT: z.coerce.number().default(3001),
  HOST: z.string().default('0.0.0.0'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // Workers
  WORKER_CONCURRENCY: z.coerce.number().default(8),
  MAX_RETRY_ATTEMPTS: z.coerce.number().default(3),

  // Rate Limiting
  RATE_LIMIT_PER_MINUTE: z.coerce.number().default(60),

  // File Storage
  UPLOAD_DIR: z.string().default('./uploads'),
  OUTPUT_DIR: z.string().default('./outputs'),
  MAX_FILE_SIZE_MB: z.coerce.number().default(500),
});

// Valida e exporta
const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Variáveis de ambiente inválidas:');
  console.error(parsed.error.format());
  process.exit(1);
}

export const env = parsed.data;

// Helpers
export const isDev = env.NODE_ENV === 'development';
export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
