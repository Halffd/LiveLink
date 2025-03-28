import { EventEmitter } from 'events';
import type { StreamSource } from '../../types/stream.js';
import { logger } from './logger.js';

export interface QueueEvents {
  'queue:updated': (screen: number, queue: StreamSource[]) => void;
  'queue:empty': (screen: number) => void;
  'all:watched': (screen: number) => void;
}

interface FavoritesNode {
  priority: number;
  startTime: number;
  currentIndex: number;
  totalFavorites: number;
  nextNode: FavoritesNode | null;
  prevNode: FavoritesNode | null;
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

    // Initialize favorites tracking
    const favorites = validQueue.filter(s => s.subtype === 'favorites')
      .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999));
    
    // Create root node
    const rootNode: FavoritesNode = {
      priority: 999,
      startTime: 0,
      currentIndex: -1,
      totalFavorites: favorites.length,
      nextNode: null,
      prevNode: null
    };

    // Build initial node chain from favorites
    let currentNode = rootNode;
    favorites.forEach((fav, idx) => {
      const favTime = fav.startTime ? 
        (typeof fav.startTime === 'string' ? new Date(fav.startTime).getTime() : fav.startTime) : 0;
      
      const newNode: FavoritesNode = {
        priority: fav.priority ?? 999,
        startTime: favTime,
        currentIndex: idx,
        totalFavorites: favorites.length,
        nextNode: null,
        prevNode: currentNode
      };
      currentNode.nextNode = newNode;
      currentNode = newNode;
    });

    // Sort the queue using the node chain for comparison
    const sortedQueue = validQueue.sort((a, b) => {
      const aPriority = a.priority ?? 999;
      const bPriority = b.priority ?? 999;
      const aIsFavorite = a.subtype === 'favorites';
      const bIsFavorite = b.subtype === 'favorites';

      // If one is a favorite and the other isn't, favorite comes first
      if (aIsFavorite && !bIsFavorite) return -1;
      if (!aIsFavorite && bIsFavorite) return 1;

      // If priorities are different, sort by priority
      if (aPriority !== bPriority) {
        return aPriority - bPriority;
      }

      // If both are favorites, use node chain for ordering
      if (aIsFavorite && bIsFavorite) {
        // Find nodes for both streams
        let node: FavoritesNode | null = rootNode;
        let aNode: FavoritesNode | null = null;
        let bNode: FavoritesNode | null = null;

        while (node && (!aNode || !bNode)) {
          if (node.priority === aPriority) aNode = node;
          if (node.priority === bPriority) bNode = node;
          node = node.nextNode;
        }

        if (aNode && bNode) {
          // Compare based on node order
          return aNode.currentIndex - bNode.currentIndex;
        }
      }

      // For non-favorites or if nodes not found, sort by start time and viewer count
      const aTime = a.startTime ? (typeof a.startTime === 'string' ? new Date(a.startTime).getTime() : a.startTime) : 0;
      const bTime = b.startTime ? (typeof b.startTime === 'string' ? new Date(b.startTime).getTime() : b.startTime) : 0;
      
      if (aTime !== bTime) {
        return bTime - aTime; // Newer streams first
      }

      // Finally sort by viewer count
      return (b.viewerCount || 0) - (a.viewerCount || 0);
    });
    
    this.queues.set(screen, sortedQueue);
    
    logger.info(`Set queue for screen ${screen}. Queue size: ${sortedQueue.length}`, 'QueueService');
    logger.debug(`Queue contents: ${JSON.stringify(sortedQueue.map(s => ({
      url: s.url,
      priority: s.priority,
      startTime: s.startTime,
      viewerCount: s.viewerCount,
      isFavorite: s.subtype === 'favorites',
      favoriteIndex: favorites.findIndex(f => f.priority === s.priority)
    })))}`, 'QueueService');
    
    // Log favorites chain
    let node: FavoritesNode | null = rootNode;
    while (node) {
      logger.debug(`Favorites node: Priority ${node.priority}, Index ${node.currentIndex}/${node.totalFavorites}, Time ${new Date(node.startTime).toISOString()}`, 'QueueService');
      node = node.nextNode;
    }
    
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
      const isFavorite = stream.subtype === 'favorites';
      return !isFavorite && !this.watchedStreams.has(stream.url);
    });

    return streams.filter(stream => {
      const isFavorite = stream.subtype === 'favorites';
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