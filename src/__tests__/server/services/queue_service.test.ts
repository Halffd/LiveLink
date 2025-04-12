/**
 * Unit tests for QueueService
 * 
 * These tests focus on verifying the behavior of the QueueService,
 * particularly around handling watched streams and the skipWatchedStreams option.
 */
import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { QueueService } from '../../../server/services/queue_service';
import { createMockStreamSource } from '../../helpers/mock-factory';
import { ExecutionTracker } from '../../helpers/async-utils';

// Mock the logger to reduce noise
jest.mock('../../../server/services/logger', () => {
  return {
    logger: {
      info: jest.fn(),
      debug: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    }
  };
});

describe('QueueService Tests', () => {
  let queueService: QueueService;
  let executionTracker: ExecutionTracker;
  
  beforeEach(() => {
    // Reset all mocks
    jest.clearAllMocks();
    
    // Create execution tracker for tracking operations
    executionTracker = new ExecutionTracker();
    
    // Create QueueService instance
    queueService = new QueueService();
  });
  
  /**
   * Test basic queue operations
   */
  test('should manage queues for different screens', () => {
    // Create mock stream sources
    const stream1 = createMockStreamSource({ screen: 1, url: 'https://youtube.com/1' });
    const stream2 = createMockStreamSource({ screen: 1, url: 'https://youtube.com/2' });
    const stream3 = createMockStreamSource({ screen: 2, url: 'https://youtube.com/3' });
    
    // Set up queues
    queueService.setQueue(1, [stream1, stream2]);
    queueService.setQueue(2, [stream3]);
    
    // Verify queues
    expect(queueService.getQueue(1)).toHaveLength(2);
    expect(queueService.getQueue(2)).toHaveLength(1);
    
    // Verify getNextStream
    expect(queueService.getNextStream(1)).toEqual(stream1);
    expect(queueService.getNextStream(2)).toEqual(stream3);
    
    // Remove from queue
    queueService.removeFromQueue(1, 0);
    
    // Verify queue after removal
    expect(queueService.getQueue(1)).toHaveLength(1);
    expect(queueService.getNextStream(1)).toEqual(stream2);
    
    // Clear queue
    queueService.clearQueue(1);
    
    // Verify queue is empty
    expect(queueService.getQueue(1)).toHaveLength(0);
    expect(queueService.getNextStream(1)).toBeUndefined();
    
    // Clear all queues
    queueService.clearAllQueues();
    
    // Verify all queues are empty
    expect(queueService.getQueue(1)).toHaveLength(0);
    expect(queueService.getQueue(2)).toHaveLength(0);
  });
  
  /**
   * Test watched streams management
   */
  test('should track watched streams correctly', () => {
    // Create mock stream sources
    const stream1 = createMockStreamSource({ url: 'https://youtube.com/1' });
    const stream2 = createMockStreamSource({ url: 'https://youtube.com/2' });
    
    // Initially no streams are watched
    expect(queueService.isStreamWatched(stream1.url)).toBe(false);
    expect(queueService.isStreamWatched(stream2.url)).toBe(false);
    expect(queueService.getWatchedStreams()).toHaveLength(0);
    
    // Mark stream1 as watched
    queueService.markStreamAsWatched(stream1.url);
    
    // Verify stream1 is watched
    expect(queueService.isStreamWatched(stream1.url)).toBe(true);
    expect(queueService.isStreamWatched(stream2.url)).toBe(false);
    expect(queueService.getWatchedStreams()).toHaveLength(1);
    expect(queueService.getWatchedStreams()).toContain(stream1.url);
    
    // Mark stream2 as watched
    queueService.markStreamAsWatched(stream2.url);
    
    // Verify both streams are watched
    expect(queueService.isStreamWatched(stream1.url)).toBe(true);
    expect(queueService.isStreamWatched(stream2.url)).toBe(true);
    expect(queueService.getWatchedStreams()).toHaveLength(2);
    expect(queueService.getWatchedStreams()).toContain(stream1.url);
    expect(queueService.getWatchedStreams()).toContain(stream2.url);
    
    // Clear watched streams
    queueService.clearWatchedStreams();
    
    // Verify no streams are watched
    expect(queueService.isStreamWatched(stream1.url)).toBe(false);
    expect(queueService.isStreamWatched(stream2.url)).toBe(false);
    expect(queueService.getWatchedStreams()).toHaveLength(0);
  });
  
  /**
   * Test filtering unwatched streams
   */
  test('should filter unwatched streams correctly', () => {
    // Create mock stream sources with different priorities
    const favoriteStream = createMockStreamSource({ 
      url: 'https://youtube.com/favorite', 
      priority: 100  // Lower priority = higher importance (favorite)
    });
    
    const normalStream1 = createMockStreamSource({ 
      url: 'https://youtube.com/normal1', 
      priority: 900  // Higher priority = lower importance (not favorite)
    });
    
    const normalStream2 = createMockStreamSource({ 
      url: 'https://youtube.com/normal2', 
      priority: 900  // Higher priority = lower importance (not favorite)
    });
    
    // Initially no streams are watched
    const allStreams = [favoriteStream, normalStream1, normalStream2];
    let filteredStreams = queueService.filterUnwatchedStreams(allStreams);
    
    // All streams should be included since none are watched
    expect(filteredStreams).toHaveLength(3);
    
    // Mark normalStream1 as watched
    queueService.markStreamAsWatched(normalStream1.url);
    
    // Filter again
    filteredStreams = queueService.filterUnwatchedStreams(allStreams);
    
    // normalStream1 should be excluded
    expect(filteredStreams).toHaveLength(2);
    expect(filteredStreams).toContainEqual(expect.objectContaining({ url: favoriteStream.url }));
    expect(filteredStreams).toContainEqual(expect.objectContaining({ url: normalStream2.url }));
    expect(filteredStreams).not.toContainEqual(expect.objectContaining({ url: normalStream1.url }));
    
    // Mark all normal streams as watched
    queueService.markStreamAsWatched(normalStream2.url);
    
    // Filter again
    filteredStreams = queueService.filterUnwatchedStreams(allStreams);
    
    // Only favorite stream should be included even though it's not watched
    // This is because all non-favorites are watched
    expect(filteredStreams).toHaveLength(1);
    expect(filteredStreams).toContainEqual(expect.objectContaining({ url: favoriteStream.url }));
    
    // Mark favorite stream as watched
    queueService.markStreamAsWatched(favoriteStream.url);
    
    // Filter again
    filteredStreams = queueService.filterUnwatchedStreams(allStreams);
    
    // Favorite stream should still be included even though it's watched
    // This is because all streams are watched, so we include favorites
    expect(filteredStreams).toHaveLength(1);
    expect(filteredStreams).toContainEqual(expect.objectContaining({ url: favoriteStream.url }));
  });
  
  /**
   * Test hasUnwatchedStreams method
   */
  test('should correctly determine if there are unwatched streams', () => {
    // Create mock stream sources
    const stream1 = createMockStreamSource({ url: 'https://youtube.com/1' });
    const stream2 = createMockStreamSource({ url: 'https://youtube.com/2' });
    const stream3 = createMockStreamSource({ url: 'https://youtube.com/3' });
    
    // Initially all streams are unwatched
    const streams = [stream1, stream2, stream3];
    expect(queueService.hasUnwatchedStreams(streams)).toBe(true);
    
    // Mark all streams as watched
    queueService.markStreamAsWatched(stream1.url);
    queueService.markStreamAsWatched(stream2.url);
    queueService.markStreamAsWatched(stream3.url);
    
    // Now there should be no unwatched streams
    expect(queueService.hasUnwatchedStreams(streams)).toBe(false);
    
    // Clear watched streams
    queueService.clearWatchedStreams();
    
    // Now all streams should be unwatched again
    expect(queueService.hasUnwatchedStreams(streams)).toBe(true);
  });
  
  /**
   * Test events emitted by the queue service
   */
  test('should emit appropriate events when queue changes', () => {
    // Create mock stream sources
    const stream1 = createMockStreamSource({ screen: 1, url: 'https://youtube.com/1' });
    const stream2 = createMockStreamSource({ screen: 1, url: 'https://youtube.com/2' });
    
    // Set up event listeners
    const queueUpdatedHandler = jest.fn();
    const queueEmptyHandler = jest.fn();
    const allWatchedHandler = jest.fn();
    
    queueService.on('queue:updated', queueUpdatedHandler);
    queueService.on('queue:empty', queueEmptyHandler);
    queueService.on('all:watched', allWatchedHandler);
    
    // Set queue with streams
    queueService.setQueue(1, [stream1, stream2]);
    
    // Verify queue:updated was emitted
    expect(queueUpdatedHandler).toHaveBeenCalledWith(1, [stream1, stream2]);
    expect(queueEmptyHandler).not.toHaveBeenCalled();
    expect(allWatchedHandler).not.toHaveBeenCalled();
    
    // Reset mocks
    queueUpdatedHandler.mockReset();
    
    // Remove all streams from queue
    queueService.removeFromQueue(1, 0);
    queueService.removeFromQueue(1, 0);
    
    // Verify queue:empty was emitted
    expect(queueUpdatedHandler).toHaveBeenCalledTimes(2);
    expect(queueEmptyHandler).toHaveBeenCalledWith(1);
    
    // Reset mocks
    queueUpdatedHandler.mockReset();
    queueEmptyHandler.mockReset();
    
    // Set empty queue
    queueService.setQueue(1, []);
    
    // Verify all:watched was emitted
    expect(queueUpdatedHandler).toHaveBeenCalledWith(1, []);
    expect(allWatchedHandler).toHaveBeenCalledWith(1);
  });
  
  /**
   * Test edge cases with invalid inputs
   */
  test('should handle invalid inputs gracefully', () => {
    // Set queue with null
    queueService.setQueue(1, null as any);
    
    // Verify queue is empty
    expect(queueService.getQueue(1)).toHaveLength(0);
    
    // Set queue with undefined
    queueService.setQueue(1, undefined as any);
    
    // Verify queue is empty
    expect(queueService.getQueue(1)).toHaveLength(0);
    
    // Set queue with invalid items
    queueService.setQueue(1, [null, undefined, { notAStream: true } as any]);
    
    // Verify queue is empty
    expect(queueService.getQueue(1)).toHaveLength(0);
    
    // Add invalid stream to queue
    queueService.addToQueue(1, null as any);
    queueService.addToQueue(1, undefined as any);
    queueService.addToQueue(1, { notAStream: true } as any);
    
    // Verify queue is empty
    expect(queueService.getQueue(1)).toHaveLength(0);
    
    // Remove from invalid index
    queueService.removeFromQueue(1, -1);
    queueService.removeFromQueue(1, 100);
    
    // Should not throw errors
  });
});
