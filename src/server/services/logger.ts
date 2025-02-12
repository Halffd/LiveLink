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

// Create a custom format for consistent logging
const customFormat = printf(({ level, message, timestamp, context, error }) => {
  const colorize = {
    [LogLevel.ERROR]: chalk.red,
    [LogLevel.WARN]: chalk.yellow,
    [LogLevel.INFO]: chalk.blue,
    [LogLevel.DEBUG]: chalk.gray
  };

  const colorFn = colorize[level as LogLevel] || chalk.white;
  const contextStr = context ? `[${context}] ` : '';
  const baseMessage = `${timestamp} [${level.toUpperCase()}] ${contextStr}${message}`;
  
  let fullMessage = colorFn(baseMessage);
  
  if (error instanceof Error) {
    fullMessage += '\n' + chalk.red(error.stack);
  }
  
  return fullMessage;
});

export class Logger {
  private logger;
  private currentLevel: LogLevel = LogLevel.INFO;

  constructor() {
    this.logger = createLogger({
      format: combine(
        timestamp(),
        customFormat
      ),
      transports: [
        new transports.Console(),
        new transports.File({ 
          filename: path.join('logs', 'error.log'), 
          level: 'error',
          format: format.uncolorize() // Remove colors for file output
        }),
        new transports.File({ 
          filename: path.join('logs', 'combined.log'),
          format: format.uncolorize() // Remove colors for file output
        })
      ]
    });
  }

  setLevel(level: LogLevel | string) {
    this.currentLevel = level.toLowerCase() as LogLevel;
    this.logger.level = this.currentLevel;
    this.debug('Log level set to %s', this.currentLevel);
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

  private formatMessage(message: string, ...args: (string | number)[]): string {
    if (args.length === 0) return message;
    
    try {
      return message.replace(/%[sdj%]/g, (match: string): string => {
        if (match === '%%') return '%';
        if (args.length === 0) return match;
        const arg = args.shift();
        switch (match) {
          case '%s': return String(arg);
          case '%d': return String(Number(arg));
          case '%j': return JSON.stringify(arg);
          default: return match;
        }
      });
    } catch (error) {
      return message;
    }
  }

  log(logData: LogMessage) {
    if (!this.shouldLog(logData.level)) return;

    this.logger.log({
      level: logData.level,
      message: logData.message,
      context: logData.context,
      error: logData.error,
      timestamp: new Date().toISOString()
    });
  }

  error(message: string, context?: string, error?: Error) {
    this.log({ 
      level: LogLevel.ERROR, 
      message: this.formatMessage(message), 
      context, 
      error 
    });
  }

  warn(message: string, context?: string, ...args: (string | number)[]) {
    this.log({ 
      level: LogLevel.WARN, 
      message: this.formatMessage(message, ...args), 
      context 
    });
  }

  info(message: string, context?: string, ...args: (string | number)[]) {
    this.log({ 
      level: LogLevel.INFO, 
      message: this.formatMessage(message, ...args), 
      context 
    });
  }

  debug(message: string, context?: string, ...args: (string | number)[]) {
    this.log({ 
      level: LogLevel.DEBUG, 
      message: this.formatMessage(message, ...args), 
      context 
    });
  }
}

export const logger = new Logger(); 