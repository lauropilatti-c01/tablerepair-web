import winston from 'winston';
import { env, isDev } from '../config/env.js';

const { combine, timestamp, printf, colorize, json } = winston.format;

// Formato para desenvolvimento (legível)
const devFormat = combine(
  colorize(),
  timestamp({ format: 'HH:mm:ss' }),
  printf(({ level, message, timestamp, ...meta }) => {
    const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    return `${timestamp} [${level}]: ${message}${metaStr}`;
  })
);

// Formato para produção (JSON estruturado)
const prodFormat = combine(
  timestamp(),
  json()
);

// Criar logger
export const logger = winston.createLogger({
  level: isDev ? 'debug' : 'info',
  format: isDev ? devFormat : prodFormat,
  transports: [
    new winston.transports.Console(),
    // Em produção, adicionar file transport
    ...(isDev ? [] : [
      new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
      new winston.transports.File({ filename: 'logs/combined.log' }),
    ]),
  ],
});

// Helper para criar logger com contexto
export function createLogger(context: string) {
  return {
    debug: (message: string, meta?: object) => logger.debug(message, { context, ...meta }),
    info: (message: string, meta?: object) => logger.info(message, { context, ...meta }),
    warn: (message: string, meta?: object) => logger.warn(message, { context, ...meta }),
    error: (message: string, meta?: object) => logger.error(message, { context, ...meta }),
  };
}
