import chalk from 'chalk';
import { createLogger, format, transports } from 'winston';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
const { combine, timestamp, printf, errors } = format;

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

// Parse command line arguments
const args = process.argv.slice(2);
const isDebug = args.includes('-d') || args.includes('--debug');
const isVerbose = args.includes('-v') || args.includes('--verbose');
const envDebug = process.env.DEBUG === '1' || process.env.VERBOSE === '1';

// Get absolute project root path
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '../../..');
const logDir = path.join(projectRoot, 'logs');

// Ensure log directory exists
if (!fs.existsSync(logDir)) {
  try {
    fs.mkdirSync(logDir, { recursive: true });
    console.log(chalk.green(`Created log directory: ${logDir}`));
  } catch (err) {
    console.error(chalk.red(`Failed to create log directory: ${err}`));
    process.exit(1);
  }
}

// Custom log format
const customFormat = printf(({ level, message, timestamp, context, error }) => {
  const colors = {
    [LogLevel.ERROR]: chalk.red,
    [LogLevel.WARN]: chalk.yellow,
    [LogLevel.INFO]: chalk.green,
    [LogLevel.DEBUG]: chalk.gray
  };

  const color = colors[level as LogLevel] || chalk.white;
  const contextStr = context ? chalk.cyan(`[${context}] `) : '';
  const timestampStr = new Date(timestamp as string).toISOString();
  
  let output = `${timestampStr} ${color(level.toUpperCase().padEnd(5))} ${contextStr}${message}`;
  
  if (error instanceof Error) {
    output += `\n${chalk.red(error.stack)}`;
  }

  return output;
});

// File format (no colors)
const fileFormat = combine(
  timestamp(),
  errors({ stack: true }),
  format.json()
);

export class Logger {
  private logger;
  private currentLevel: LogLevel;
  private errorLogPath: string;
  private combinedLogPath: string;

  constructor() {
    this.currentLevel = (isDebug || isVerbose || envDebug) ? LogLevel.DEBUG : LogLevel.INFO;
    
    this.errorLogPath = path.join(logDir, 'error.log');
    this.combinedLogPath = path.join(logDir, 'combined.log');

    // Initialize logger
    this.logger = createLogger({
      level: this.currentLevel,
      format: combine(
        timestamp(),
        errors({ stack: true }),
        customFormat
      ),
      transports: [
        new transports.Console(),
        new transports.File({
          filename: this.errorLogPath,
          level: 'error',
          format: fileFormat
        }),
        new transports.File({
          filename: this.combinedLogPath,
          format: fileFormat
        })
      ],
      exceptionHandlers: [
        new transports.File({
          filename: path.join(logDir, 'exceptions.log'),
          format: fileFormat
        })
      ]
    });

    // Verify file creation
    this.verifyFileAccess();
    this.info('Logger initialized', 'Logger');
  }
  private verifyFileAccess() {
    try {
      // Just check if we can write to the directory
      fs.accessSync(logDir, fs.constants.W_OK);
      this.debug(`Log directory accessible: ${logDir}`, 'Logger');
    } catch (err) {
      console.error(chalk.red(`Cannot write to log directory: ${err}`));
      throw err;
    }
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

  private formatMessage(message: string, ...args: unknown[]): string {
    if (args.length === 0) return message;
    
    try {
      return message.replace(/%[sdj%]/g, (match) => {
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
      message: this.formatMessage(logData.message),
      context: logData.context,
      error: logData.error,
      timestamp: new Date().toISOString()
    });
  }

  error(message: string, context?: string, error?: Error | unknown) {
    this.log({ 
      level: LogLevel.ERROR, 
      message, 
      context, 
      error 
    });
  }

  warn(message: string, context?: string, ...args: unknown[]) {
    this.log({ 
      level: LogLevel.WARN, 
      message: this.formatMessage(message, ...args), 
      context 
    });
  }

  info(message: string, context?: string, ...args: unknown[]) {
    this.log({ 
      level: LogLevel.INFO, 
      message: this.formatMessage(message, ...args), 
      context 
    });
  }

  debug(message: string, context?: string, ...args: unknown[]) {
    this.log({ 
      level: LogLevel.DEBUG, 
      message: this.formatMessage(message, ...args), 
      context 
    });
  }

  rotateLogs() {
    const now = new Date().toISOString();
    [this.errorLogPath, this.combinedLogPath].forEach(file => {
      if (fs.existsSync(file)) {
        const rotatedFile = `${file}.${now}`;
        fs.renameSync(file, rotatedFile);
        this.info(`Rotated log file: ${file} → ${rotatedFile}`, 'Logger');
      }
    });
  }
}

// Singleton logger instance
export const logger = new Logger();