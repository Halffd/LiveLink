import { EventEmitter } from 'events';
import type { StreamSource } from '../../types/stream.js';
import { logger } from './logger.js';

export interface QueueEvents {
  'queue:updated': (screen: number, queue: StreamSource[]) => void;
  'queue:empty': (screen: number) => void;
  'all:watched': (screen: number) => void;
}

class QueueService extends EventEmitter {
  private queues: Map<number, StreamSource[]> = new Map();
  private watchedStreams: Set<string> = new Set();

  constructor() {
    super();
    logger.info('QueueService initialized', 'QueueService');
  }

  // Queue Management
  public setQueue(screen: number, queue: StreamSource[]): void {
    if (!queue || !Array.isArray(queue)) {
      logger.warn(`Invalid queue array provided for screen ${screen}`, 'QueueService');
      return;
    }

    // Filter out any null or undefined entries
    const validQueue = queue.filter(item => item && item.url);

    // Sort the queue by priority first, then by viewer count
    const sortedQueue = validQueue.sort((a, b) => {
      // First by priority (undefined priority goes last)
      const aPriority = a.priority ?? 999;
      const bPriority = b.priority ?? 999;
      if (aPriority !== bPriority) return aPriority - bPriority;

      // Then by start time (newer first) if we have timestamps
      if (a.startTime && b.startTime) {
        const aTime = typeof a.startTime === 'string' ? new Date(a.startTime).getTime() : a.startTime;
        const bTime = typeof b.startTime === 'string' ? new Date(b.startTime).getTime() : b.startTime;
        const timeDiff = Math.abs(aTime - bTime);
        // If streams started within 30 minutes of each other, consider them in the same time group
        if (timeDiff > 30 * 60 * 1000) {
          return bTime - aTime;
        }
      }

      // Finally by viewer count for streams in same priority and time group
      return (b.viewerCount || 0) - (a.viewerCount || 0);
    });
    
    this.queues.set(screen, sortedQueue);
    
    logger.info(`Set queue for screen ${screen}. Queue size: ${sortedQueue.length}`, 'QueueService');
    logger.debug(`Queue contents: ${JSON.stringify(sortedQueue)}`, 'QueueService');
    
    if (sortedQueue.length === 0) {
      logger.info(`Queue for screen ${screen} is empty, emitting all:watched event`, 'QueueService');
      this.emit('all:watched', screen);
    } else {
      logger.info(`Queue for screen ${screen} updated with ${sortedQueue.length} items`, 'QueueService');
      this.emit('queue:updated', screen, sortedQueue);
    }
  }

  public getQueue(screen: number): StreamSource[] {
    const queue = this.queues.get(screen) || [];
    logger.debug(`Getting queue for screen ${screen}. Queue size: ${queue.length}`, 'QueueService');
    return queue;
  }

  public addToQueue(screen: number, source: StreamSource): void {
    if (!source || !source.url) {
      logger.warn(`Invalid stream source provided for screen ${screen}`, 'QueueService');
      return;
    }

    const queue = this.getQueue(screen);
    queue.push(source);
    this.setQueue(screen, queue);
    logger.info(`Added stream ${source.url} to queue for screen ${screen}`, 'QueueService');
  }

  public clearQueue(screen: number): void {
    this.queues.set(screen, []);
    logger.info(`Cleared queue for screen ${screen}`, 'QueueService');
    this.emit('queue:updated', screen, []);
    this.emit('queue:empty', screen);
  }

  public clearAllQueues(): void {
    this.queues.clear();
    logger.info('Cleared all queues', 'QueueService');
  }

  // Stream Management
  public getNextStream(screen: number): StreamSource | undefined {
    const queue = this.queues.get(screen) || [];
    const nextStream = queue[0];
    logger.debug(`Getting next stream for screen ${screen}. Next stream: ${nextStream?.url || 'none'}`, 'QueueService');
    return nextStream;
  }

  public removeFromQueue(screen: number, index: number): void {
    const queue = this.queues.get(screen) || [];
    
    // Validate index
    if (index < 0 || index >= queue.length) {
      logger.warn(`Invalid index ${index} for queue of screen ${screen} with length ${queue.length}`, 'QueueService');
      return;
    }
    
    // Remove the item
    const removedItem = queue.splice(index, 1)[0];
    this.queues.set(screen, queue);
    
    logger.info(`Removed stream ${removedItem.url} from queue for screen ${screen}`, 'QueueService');
    logger.debug(`Queue size after removal: ${queue.length}`, 'QueueService');
    
    // Emit queue updated event
    this.emit('queue:updated', screen, queue);
    
    // If queue is now empty, emit queue empty event
    if (queue.length === 0) {
      logger.info(`Queue for screen ${screen} is now empty`, 'QueueService');
      this.emit('queue:empty', screen);
    }
  }

  // Watched Streams Management
  public markStreamAsWatched(url: string): void {
    this.watchedStreams.add(url);
  }

  public isStreamWatched(url: string): boolean {
    return this.watchedStreams.has(url);
  }

  public getWatchedStreams(): string[] {
    return Array.from(this.watchedStreams);
  }

  public clearWatchedStreams(): void {
    this.watchedStreams.clear();
    logger.info('Cleared watched streams history', 'QueueService');
  }

  // Event Handling
  override on<K extends keyof QueueEvents>(event: K, listener: QueueEvents[K]): this {
    super.on(event, listener);
    return this;
  }

  override off<K extends keyof QueueEvents>(event: K, listener: QueueEvents[K]): this {
    super.off(event, listener);
    return this;
  }

  // Add method to check if any streams are unwatched
  hasUnwatchedStreams(streams: StreamSource[]): boolean {
    return streams.some(stream => !this.watchedStreams.has(stream.url));
  }

  // Add method to filter unwatched streams
  public filterUnwatchedStreams(streams: StreamSource[]): StreamSource[] {
    // First check if we have any unwatched non-favorite streams
    const hasUnwatchedNonFavorites = streams.some(stream => {
      const isFavorite = stream.priority !== undefined && stream.priority < 900;
      return !isFavorite && !this.watchedStreams.has(stream.url);
    });

    return streams.filter(stream => {
      const isFavorite = stream.priority !== undefined && stream.priority < 900;
      const isWatched = this.isStreamWatched(stream.url);
      
      // If it's not watched, always include it
      if (!isWatched) {
        return true;
      }
      
      // If it's watched and a favorite, only include if all non-favorites are watched
      if (isFavorite && !hasUnwatchedNonFavorites) {
        logger.debug(`QueueService: Including watched favorite stream ${stream.url} with priority ${stream.priority} because all non-favorites are watched`, 'QueueService');
        return true;
      }
      
      // Otherwise, don't include watched streams
      logger.debug(`QueueService: Filtering out watched stream ${stream.url}`, 'QueueService');
      return false;
    });
  }
}

// Create and export singleton instance
export const queueService = new QueueService(); 