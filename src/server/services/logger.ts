import chalk from 'chalk';
import { createLogger, format, transports } from 'winston';
import path from 'path';
import fs from 'fs';

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

// Parse command line arguments
const args = process.argv.slice(2);
const isDebug = args.includes('-d') || args.includes('--debug');
const isVerbose = args.includes('-v') || args.includes('--verbose');
const envDebug = process.env.DEBUG === '1' || process.env.VERBOSE === '1';
const logDir = path.join(process.cwd(), 'logs');

// Log rotation settings
const MAX_LOG_LINES = 5000;

// Create a custom format for consistent logging
const customFormat = printf(({ level, message, timestamp, context, error, trace }) => {
  const colorize = {
    [LogLevel.ERROR]: chalk.red,
    [LogLevel.WARN]: chalk.yellow,
    [LogLevel.INFO]: chalk.blue,
    [LogLevel.DEBUG]: chalk.gray
  };

  const colorFn = colorize[level as LogLevel] || chalk.white;
  const contextStr = context ? `[${context}] ` : '';
  const timestampStr = isVerbose 
    ? String(timestamp) 
    : (String(timestamp).split('T')[1] || '').split('.')[0];
  const baseMessage = `${timestampStr} [${level.toUpperCase()}] ${contextStr}${message}`;
  
  let fullMessage = colorFn(baseMessage);
  
  if (error instanceof Error) {
    fullMessage += '\n' + chalk.red(error.stack);
  }

  if (isVerbose && trace) {
    fullMessage += '\n' + chalk.gray(trace);
  }
  
  return fullMessage;
});

export class Logger {
  private logger;
  private currentLevel: LogLevel;
  private errorLogPath: string;
  private combinedLogPath: string;

  constructor() {
    // Set initial log level based on arguments and environment
    this.currentLevel = (isDebug || isVerbose || envDebug) ? LogLevel.DEBUG : LogLevel.INFO;
    
    this.errorLogPath = path.join(logDir, 'error.log');
    this.combinedLogPath = path.join(logDir, 'combined.log');

    // Ensure log directory exists
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    this.logger = createLogger({
      level: this.currentLevel,
      format: combine(
        timestamp(),
        format.errors({ stack: true }),
        customFormat
      ),
      transports: [
        new transports.Console({
          level: this.currentLevel
        }),
        new transports.File({ 
          filename: this.errorLogPath,
          level: 'error',
          format: format.uncolorize() // Remove colors for file output
        }),
        new transports.File({ 
          filename: this.combinedLogPath,
          format: format.uncolorize() // Remove colors for file output
        })
      ]
    });

    // Log initial debug state
    if (this.currentLevel === LogLevel.DEBUG) {
      const reason = [];
      if (isDebug) reason.push('--debug flag');
      if (isVerbose) reason.push('--verbose flag');
      if (envDebug) reason.push('DEBUG/VERBOSE environment variable');
      this.debug('Debug logging enabled via: %s', reason.join(', '));
    }
  }

  private rotateLogFile(filePath: string): void {
    try {
      if (!fs.existsSync(filePath)) return;
      
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split('\n');
      
      if (lines.length > MAX_LOG_LINES) {
        // Keep only the last MAX_LOG_LINES lines
        const trimmedContent = lines.slice(-MAX_LOG_LINES).join('\n');
        fs.writeFileSync(filePath, trimmedContent);
        
        // Log the rotation (but avoid infinite recursion)
        console.log(`[LOG ROTATION] Trimmed ${filePath} to ${MAX_LOG_LINES} lines`);
      }
    } catch (error) {
      console.error('Failed to rotate log file:', error);
    }
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

  private getStackTrace(): string | undefined {
    if (!isVerbose) return undefined;
    const stack = new Error().stack;
    if (!stack) return undefined;
    
    // Get the calling function's location
    const lines = stack.split('\n').slice(3); // Skip Error, getStackTrace, and log calls
    return lines.join('\n');
  }

  log(logData: LogMessage) {
    if (!this.shouldLog(logData.level)) return;

    this.logger.log({
      level: logData.level,
      message: logData.message,
      context: logData.context,
      error: logData.error,
      timestamp: new Date().toISOString(),
      trace: this.getStackTrace()
    });

    // Rotate logs after writing (do this occasionally to avoid performance hit)
    if (Math.random() < 0.01) { // 1% chance to check/rotate
      this.rotateLogFile(this.combinedLogPath);
      if (logData.level === LogLevel.ERROR) {
        this.rotateLogFile(this.errorLogPath);
      }
    }
  }

  error(message: string, context?: string, error?: Error | unknown) {
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

  // Manual rotation method
  rotateLogs(): void {
    this.rotateLogFile(this.combinedLogPath);
    this.rotateLogFile(this.errorLogPath);
    this.info('Manual log rotation completed', 'Logger');
  }
}

export const logger = new Logger();