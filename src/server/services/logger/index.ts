import { createLogger, format, transports } from 'winston';
import { join } from 'path';

const logDir = join(process.cwd(), 'logs');

const winstonLogger = createLogger({
  level: 'debug',
  format: format.combine(
    format.timestamp(),
    format.errors({ stack: true }),
    format.splat(),
    format.json()
  ),
  defaultMeta: { service: 'livelink' },
  transports: [
    new transports.File({ filename: join(logDir, 'error.log'), level: 'error' }),
    new transports.File({ filename: join(logDir, 'combined.log') })
  ]
});

if (process.env.NODE_ENV !== 'production') {
  winstonLogger.add(new transports.Console({
    format: format.combine(
      format.colorize(),
      format.simple()
    )
  }));
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogError = Error | string | number;

interface LogContext {
  context: string;
  error?: {
    message?: string;
    stack?: string;
    details?: unknown;
  };
}

function formatError(error: LogError): LogContext['error'] {
  if (error instanceof Error) {
    return {
      message: error.message,
      stack: error.stack,
      details: error
    };
  }
  return {
    message: String(error)
  };
}

function log(level: LogLevel, message: string, context: string, error?: LogError) {
  const meta: LogContext = { context };
  if (error !== undefined) {
    meta.error = formatError(error);
  }
  winstonLogger.log(level, message, meta);
}

export const logger = {
  debug: (message: string, context: string, error?: LogError) => {
    log('debug', message, context, error);
  },
  info: (message: string, context: string, error?: LogError) => {
    log('info', message, context, error);
  },
  warn: (message: string, context: string, error?: LogError) => {
    log('warn', message, context, error);
  },
  error: (message: string, context: string, error?: LogError) => {
    log('error', message, context, error);
  }
}; 