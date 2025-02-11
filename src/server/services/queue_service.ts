import { EventEmitter } from 'events';
import type { StreamSource } from '../../types/stream.js';
import { logger } from './logger.js';

export interface QueueEvents {
  'queue:updated': (screen: number, queue: StreamSource[]) => void;
  'queue:empty': (screen: number) => void;
  'all:watched': (screen: number) => void;
}

export class QueueService {
  private queues: Map<number, StreamSource[]> = new Map();
  private watchedStreams: Set<string> = new Set();
  private events: EventEmitter;

  constructor() {
    this.events = new EventEmitter();
  }

  // Queue Management
  setQueue(screen: number, streams: StreamSource[]) {
    if (!streams || !Array.isArray(streams)) {
      logger.warn(`Invalid streams array provided for screen ${screen}`, 'QueueService');
      return;
    }

    // Filter out already watched streams
    const validStreams = streams
      .filter(s => s && s.url)
      .filter(s => !this.watchedStreams.has(s.url));

    this.queues.set(screen, validStreams);
    
    logger.debug(`Set queue for screen ${screen}. Queue size: ${validStreams.length}`, 'QueueService');
    logger.debug(`Queue contents: ${JSON.stringify(validStreams)}`, 'QueueService');
    
    if (validStreams.length === 0) {
      this.events.emit('all:watched', screen);
    } else {
      this.events.emit('queue:updated', screen, validStreams);
    }
  }

  getQueue(screen: number): StreamSource[] {
    return this.queues.get(screen) || [];
  }

  clearQueue(screen: number) {
    this.queues.set(screen, []);
    logger.info(`Cleared queue for screen ${screen}`, 'QueueService');
    this.events.emit('queue:updated', screen, []);
  }

  clearAllQueues() {
    this.queues.clear();
    logger.info('Cleared all queues', 'QueueService');
  }

  // Stream Management
  getNextStream(screen: number): StreamSource | null {
    const queue = this.queues.get(screen);
    
    if (!queue || queue.length === 0) {
      logger.debug(`No queue or empty queue for screen ${screen}`, 'QueueService');
      this.events.emit('queue:empty', screen);
      return null;
    }
    
    while (queue.length > 0) {
      const nextStream = queue[0];
      if (!this.watchedStreams.has(nextStream.url)) {
        queue.shift(); // Remove the stream we're about to use
        this.watchedStreams.add(nextStream.url);
        logger.debug(`Found unwatched stream for screen ${screen}: ${nextStream.url}`, 'QueueService');
        return nextStream;
      }
      queue.shift(); // Remove watched stream
      logger.debug(`Skipping watched stream: ${nextStream.url}`, 'QueueService');
    }
    
    this.events.emit('queue:empty', screen);
    logger.debug(`No unwatched streams left in queue for screen ${screen}`, 'QueueService');
    return null;
  }

  // Watched Streams Management
  markStreamAsWatched(url: string) {
    this.watchedStreams.add(url);
  }

  isStreamWatched(url: string): boolean {
    return this.watchedStreams.has(url);
  }

  getWatchedStreams(): string[] {
    return Array.from(this.watchedStreams);
  }

  clearWatchedStreams() {
    this.watchedStreams.clear();
    logger.info('Cleared watched streams history', 'QueueService');
  }

  // Event Handling
  on<K extends keyof QueueEvents>(event: K, listener: QueueEvents[K]) {
    this.events.on(event, listener);
  }

  off<K extends keyof QueueEvents>(event: K, listener: QueueEvents[K]) {
    this.events.off(event, listener);
  }
}

// Create and export singleton instance
export const queueService = new QueueService(); 