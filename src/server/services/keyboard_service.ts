import { Worker } from 'worker_threads';
import { logger } from './logger.js';
import { fileURLToPath } from 'url';
import path from 'path';
import { EventEmitter } from 'events';

// Create a singleton event emitter for keyboard events
export const keyboardEvents = new EventEmitter();

export class KeyboardService {
  private worker?: Worker;
  private isShuttingDown = false;
  private initializationTimeout?: NodeJS.Timeout;

  constructor() {
    this.setupWorker();
    logger.info('Keyboard service initializing...', 'KeyboardService');
  }

  private setupWorker() {
    try {
      // Create a new worker thread using the keyboard worker file
      const workerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'keyboard_worker.js');
      this.worker = new Worker(workerPath);

      // Set a timeout for initialization
      this.initializationTimeout = setTimeout(() => {
        if (!this.isShuttingDown) {
          logger.error(
            'Keyboard service initialization timed out. Please check your system permissions.',
            'KeyboardService'
          );
          this.cleanup();
        }
      }, 5000);

      // Handle messages from the worker
      this.worker.on('message', async (message: { type: string; screen?: number; error?: string }) => {
        try {
          switch (message.type) {
            case 'ready': {
              clearTimeout(this.initializationTimeout);
              logger.info('Keyboard service initialized successfully', 'KeyboardService');
              break;
            }
            case 'error': {
              clearTimeout(this.initializationTimeout);
              logger.error(
                'Keyboard initialization error. Please ensure you have the required permissions:',
                'KeyboardService',
                new Error(message.error || 'Unknown error')
              );
              logger.info(
                'To fix permission issues, try the following:\n' +
                '1. Install required packages:\n' +
                '   sudo apt-get install libx11-dev libxtst-dev libpng-dev\n' +
                '2. Set input device permissions:\n' +
                '   sudo chmod +r /dev/input/event*\n' +
                '3. Add your user to the input group:\n' +
                '   sudo usermod -a -G input $USER\n' +
                '4. Log out and log back in for group changes to take effect',
                'KeyboardService'
              );
              this.cleanup();
              break;
            }
            case 'autostart': {
              if (message.screen) {
                logger.info(`Keyboard shortcut: Alt+${message.screen === 1 ? 'L' : 'K'} - Auto-starting screen ${message.screen}`, 'KeyboardService');
                keyboardEvents.emit('autostart', message.screen);
              }
              break;
            }
            case 'closeall': {
              logger.info('Keyboard shortcut: Alt+F1 - Closing all players', 'KeyboardService');
              keyboardEvents.emit('closeall');
              break;
            }
          }
        } catch (error) {
          logger.error(
            'Failed to handle keyboard shortcut',
            'KeyboardService',
            error instanceof Error ? error : new Error(String(error))
          );
        }
      });

      // Handle worker errors
      this.worker.on('error', (error) => {
        if (!this.isShuttingDown) {
          clearTimeout(this.initializationTimeout);
          logger.error(
            'Keyboard worker error',
            'KeyboardService',
            error instanceof Error ? error : new Error(String(error))
          );
          this.cleanup();
        }
      });

      // Handle worker exit
      this.worker.on('exit', (code) => {
        if (code !== 0 && !this.isShuttingDown) {
          clearTimeout(this.initializationTimeout);
          logger.error(`Keyboard worker stopped with exit code ${code}`, 'KeyboardService');
          this.cleanup();
        }
      });

      // Set up signal handlers
      this.setupSignalHandlers();
    } catch (error) {
      clearTimeout(this.initializationTimeout);
      logger.error(
        'Failed to initialize keyboard service',
        'KeyboardService',
        error instanceof Error ? error : new Error(String(error))
      );
      this.cleanup();
    }
  }

  private setupSignalHandlers() {
    // Ensure cleanup happens on process termination
    process.on('SIGINT', () => this.cleanup());
    process.on('SIGTERM', () => this.cleanup());
    process.on('exit', () => this.cleanup());
  }

  cleanup() {
    this.isShuttingDown = true;
    clearTimeout(this.initializationTimeout);
    if (this.worker) {
      // Send cleanup message to worker
      this.worker.postMessage('cleanup');
      // Give the worker a chance to clean up
      setTimeout(() => {
        this.worker?.terminate();
        this.worker = undefined;
      }, 1000);
    }
  }
} 