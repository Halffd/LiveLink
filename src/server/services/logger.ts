import chalk from 'chalk';
import { createLogger, format, transports } from 'winston';
import path from 'path';

const { combine, timestamp, printf } = format;

export enum LogLevel {
  ERROR = 'error',
  WARN = 'warn',
  INFO = 'info',
  DEBUG = 'debug'
}

interface LogMessage {
  level: LogLevel;
  message: string;
  timestamp?: string;
  context?: string;
  error?: Error | unknown;
}

const logFormat = printf(({ level, message, timestamp, context, error }) => {
  let logMessage = `${timestamp} [${level.toUpperCase()}] ${context ? `[${context}] ` : ''}${message}`;
  if (error instanceof Error) {
    logMessage += `\n${error.stack}`;
  }
  return logMessage;
});

export class Logger {
  private logger;
  private currentLevel: LogLevel = LogLevel.INFO;

  constructor() {
    this.logger = createLogger({
      format: combine(
        timestamp(),
        logFormat
      ),
      transports: [
        new transports.Console({
          format: format.combine(
            format.colorize(),
            logFormat
          )
        }),
        new transports.File({ 
          filename: path.join('logs', 'error.log'), 
          level: 'error' 
        }),
        new transports.File({ 
          filename: path.join('logs', 'combined.log') 
        })
      ]
    });
  }

  setLevel(level: LogLevel | string) {
    this.currentLevel = level.toLowerCase() as LogLevel;
    this.logger.level = this.currentLevel;
    this.debug(`Log level set to ${this.currentLevel}`, 'Logger');
  }

  shouldLog(level: LogLevel): boolean {
    const levels = {
      [LogLevel.ERROR]: 0,
      [LogLevel.WARN]: 1,
      [LogLevel.INFO]: 2,
      [LogLevel.DEBUG]: 3
    };
    return levels[level] <= levels[this.currentLevel];
  }

  log(logData: LogMessage) {
    if (!this.shouldLog(logData.level)) return;

    this.logger.log({
      level: logData.level,
      message: logData.message,
      context: logData.context,
      error: logData.error
    });

    // Console output with colors in development
    if (process.env.NODE_ENV !== 'production') {
      const colorize = {
        [LogLevel.ERROR]: chalk.red,
        [LogLevel.WARN]: chalk.yellow,
        [LogLevel.INFO]: chalk.blue,
        [LogLevel.DEBUG]: chalk.gray
      };

      const colorFn = colorize[logData.level];
      const timestamp = new Date().toISOString();
      console.log(
        colorFn(`${timestamp} [${logData.level.toUpperCase()}] ${logData.context ? `[${logData.context}] ` : ''}${logData.message}`)
      );
    }
  }

  error(message: string, context?: string, error?: Error) {
    this.log({ level: LogLevel.ERROR, message, context, error });
  }

  warn(message: string, context?: string) {
    this.log({ level: LogLevel.WARN, message, context });
  }

  info(message: string, context?: string) {
    this.log({ level: LogLevel.INFO, message, context });
  }

  debug(message: string, context?: string) {
    this.log({ level: LogLevel.DEBUG, message, context });
  }
}

export const logger = new Logger(); 