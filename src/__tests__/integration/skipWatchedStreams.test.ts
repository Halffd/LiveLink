/**
 * Integration tests for skipWatchedStreams feature
 * 
 * These tests verify that the skipWatchedStreams option works correctly
 * across multiple components of the LiveLink application.
 */
import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { StreamManager } from '../../server/stream_manager';
import { QueueService } from '../../server/services/queue_service';
import { PlayerService } from '../../server/services/player';
import { 
  createMockConfig, 
  createMockServices,
  createMockStreamSource
} from '../helpers/mock-factory';
import { ExecutionTracker } from '../helpers/async-utils';
import { TimerMock } from '../helpers/timer-mock';

// Mock the queue service
jest.mock('../../server/services/queue_service', () => {
  // Create a real instance for testing
  const QueueService = jest.requireActual('../../server/services/queue_service').QueueService;
  const queueService = new QueueService();
  
  // Spy on methods
  jest.spyOn(queueService, 'setQueue');
  jest.spyOn(queueService, 'getQueue');
  jest.spyOn(queueService, 'addToQueue');
  jest.spyOn(queueService, 'clearQueue');
  jest.spyOn(queueService, 'clearAllQueues');
  jest.spyOn(queueService, 'getNextStream');
  jest.spyOn(queueService, 'removeFromQueue');
  jest.spyOn(queueService, 'markStreamAsWatched');
  jest.spyOn(queueService, 'isStreamWatched');
  jest.spyOn(queueService, 'getWatchedStreams');
  jest.spyOn(queueService, 'clearWatchedStreams');
  jest.spyOn(queueService, 'hasUnwatchedStreams');
  jest.spyOn(queueService, 'filterUnwatchedStreams');
  
  return { queueService, QueueService };
});

// Mock the logger to reduce noise
jest.mock('../../server/services/logger', () => {
  return {
    logger: {
      info: jest.fn(),
      debug: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    }
  };
});

// Mock keyboard events
jest.mock('../../server/services/keyboard_events', () => {
  const mockEmitter = {
    on: jest.fn(),
    off: jest.fn(),
    emit: jest.fn()
  };
  
  return { keyboardEvents: mockEmitter };
});

describe('skipWatchedStreams Integration Tests', () => {
  let streamManager: StreamManager;
  let mockServices: ReturnType<typeof createMockServices>;
  let mockConfig: ReturnType<typeof createMockConfig>;
  let timerMock: TimerMock;
  let executionTracker: ExecutionTracker;
  
  beforeEach(() => {
    // Reset all mocks
    jest.clearAllMocks();
    
    // Get the real queue service instance
    queueService = require('../../server/services/queue_service').queueService;
    queueService.clearAllQueues();
    queueService.clearWatchedStreams();
    
    // Create mock dependencies
    mockServices = createMockServices();
    mockConfig = createMockConfig();
    
    // Set up timer mock
    timerMock = new TimerMock();
    timerMock.install();
    
    // Create execution tracker for tracking operations
    executionTracker = new ExecutionTracker();
    
    // Create StreamManager instance with mocked dependencies
    streamManager = new StreamManager(
      mockConfig,
      mockServices.holodexService,
      mockServices.twitchService,
      mockServices.playerService
    );
  });
  
  afterEach(() => {
    // Restore timers
    timerMock.restore();
  });
  
  /**
   * Test that skipWatchedStreams: true prevents watched streams from being played
   */
  test('should skip watched streams when skipWatchedStreams is true', async () => {
    // Configure screen 1 with skipWatchedStreams: true
    mockConfig.player.screens[0].skipWatchedStreams = true;
    
    // Create mock streams
    const stream1 = createMockStreamSource({ 
      screen: 1, 
      url: 'https://youtube.com/1',
      priority: 900 // Not a favorite
    });
    
    const stream2 = createMockStreamSource({ 
      screen: 1, 
      url: 'https://youtube.com/2',
      priority: 900 // Not a favorite
    });
    
    // Mock getLiveStreams to return our test streams
    mockServices.holodexService.getLiveStreams.mockResolvedValue([stream1, stream2]);
    
    // Mark stream1 as watched
    queueService.markStreamAsWatched(stream1.url);
    
    // Set up the queue with both streams
    queueService.setQueue(1, [stream1, stream2]);
    
    // Handle stream end for screen 1
    await streamManager.handleStreamEnd(1);
    
    // Verify that stream1 was skipped and stream2 was started
    expect(mockServices.playerService.startStream).toHaveBeenCalledTimes(1);
    expect(mockServices.playerService.startStream).toHaveBeenCalledWith(
      expect.objectContaining({
        url: stream2.url,
        screen: 1
      })
    );
    
    // Verify that stream1 was removed from the queue
    expect(queueService.removeFromQueue).toHaveBeenCalledWith(1, 0);
  });
  
  /**
   * Test that skipWatchedStreams: false allows watched streams to be played
   */
  test('should not skip watched streams when skipWatchedStreams is false', async () => {
    // Configure screen 2 with skipWatchedStreams: false
    mockConfig.player.screens[1].skipWatchedStreams = false;
    
    // Create mock streams
    const stream1 = createMockStreamSource({ 
      screen: 2, 
      url: 'https://youtube.com/1',
      priority: 900 // Not a favorite
    });
    
    const stream2 = createMockStreamSource({ 
      screen: 2, 
      url: 'https://youtube.com/2',
      priority: 900 // Not a favorite
    });
    
    // Mock getLiveStreams to return our test streams
    mockServices.holodexService.getLiveStreams.mockResolvedValue([stream1, stream2]);
    
    // Mark stream1 as watched
    queueService.markStreamAsWatched(stream1.url);
    
    // Set up the queue with both streams
    queueService.setQueue(2, [stream1, stream2]);
    
    // Handle stream end for screen 2
    await streamManager.handleStreamEnd(2);
    
    // Verify that stream1 was started despite being watched
    expect(mockServices.playerService.startStream).toHaveBeenCalledTimes(1);
    expect(mockServices.playerService.startStream).toHaveBeenCalledWith(
      expect.objectContaining({
        url: stream1.url,
        screen: 2
      })
    );
  });
  
  /**
   * Test that favorite streams are always played regardless of skipWatchedStreams
   */
  test('should always play favorite streams regardless of skipWatchedStreams', async () => {
    // Configure screen 1 with skipWatchedStreams: true
    mockConfig.player.screens[0].skipWatchedStreams = true;
    
    // Create mock streams
    const favoriteStream = createMockStreamSource({ 
      screen: 1, 
      url: 'https://youtube.com/favorite',
      priority: 100 // Low priority = favorite
    });
    
    const normalStream = createMockStreamSource({ 
      screen: 1, 
      url: 'https://youtube.com/normal',
      priority: 900 // High priority = not favorite
    });
    
    // Mock getLiveStreams to return our test streams
    mockServices.holodexService.getLiveStreams.mockResolvedValue([favoriteStream, normalStream]);
    
    // Mark both streams as watched
    queueService.markStreamAsWatched(favoriteStream.url);
    queueService.markStreamAsWatched(normalStream.url);
    
    // Set up the queue with both streams
    queueService.setQueue(1, [favoriteStream, normalStream]);
    
    // Handle stream end for screen 1
    await streamManager.handleStreamEnd(1);
    
    // Verify that favoriteStream was started despite being watched
    expect(mockServices.playerService.startStream).toHaveBeenCalledTimes(1);
    expect(mockServices.playerService.startStream).toHaveBeenCalledWith(
      expect.objectContaining({
        url: favoriteStream.url,
        screen: 1
      })
    );
  });
  
  /**
   * Test that the global skipWatchedStreams setting is used as a fallback
   */
  test('should use global skipWatchedStreams setting as fallback', async () => {
    // Remove screen-specific skipWatchedStreams setting
    delete mockConfig.player.screens[0].skipWatchedStreams;
    
    // Set global skipWatchedStreams to false
    mockConfig.skipWatchedStreams = false;
    
    // Create mock streams
    const stream1 = createMockStreamSource({ 
      screen: 1, 
      url: 'https://youtube.com/1',
      priority: 900 // Not a favorite
    });
    
    const stream2 = createMockStreamSource({ 
      screen: 1, 
      url: 'https://youtube.com/2',
      priority: 900 // Not a favorite
    });
    
    // Mock getLiveStreams to return our test streams
    mockServices.holodexService.getLiveStreams.mockResolvedValue([stream1, stream2]);
    
    // Mark stream1 as watched
    queueService.markStreamAsWatched(stream1.url);
    
    // Set up the queue with both streams
    queueService.setQueue(1, [stream1, stream2]);
    
    // Handle stream end for screen 1
    await streamManager.handleStreamEnd(1);
    
    // Verify that stream1 was started despite being watched
    // because global skipWatchedStreams is false
    expect(mockServices.playerService.startStream).toHaveBeenCalledTimes(1);
    expect(mockServices.playerService.startStream).toHaveBeenCalledWith(
      expect.objectContaining({
        url: stream1.url,
        screen: 1
      })
    );
  });
  
  /**
   * Test that the queue filtering respects skipWatchedStreams when updating queues
   */
  test('should respect skipWatchedStreams when updating queues', async () => {
    // Configure screens with different skipWatchedStreams settings
    mockConfig.player.screens[0].skipWatchedStreams = true;  // Screen 1
    mockConfig.player.screens[1].skipWatchedStreams = false; // Screen 2
    
    // Create mock streams
    const stream1 = createMockStreamSource({ 
      screen: 1, 
      url: 'https://youtube.com/1',
      priority: 900 // Not a favorite
    });
    
    const stream2 = createMockStreamSource({ 
      screen: 1, 
      url: 'https://youtube.com/2',
      priority: 900 // Not a favorite
    });
    
    const stream3 = createMockStreamSource({ 
      screen: 2, 
      url: 'https://youtube.com/3',
      priority: 900 // Not a favorite
    });
    
    const stream4 = createMockStreamSource({ 
      screen: 2, 
      url: 'https://youtube.com/4',
      priority: 900 // Not a favorite
    });
    
    // Mark stream1 and stream3 as watched
    queueService.markStreamAsWatched(stream1.url);
    queueService.markStreamAsWatched(stream3.url);
    
    // Mock getLiveStreams to return our test streams
    mockServices.holodexService.getLiveStreams.mockResolvedValue([
      stream1, stream2, stream3, stream4
    ]);
    
    // Update queues for both screens
    await streamManager.updateAllQueues(true);
    
    // Get the queues
    const queue1 = queueService.getQueue(1);
    const queue2 = queueService.getQueue(2);
    
    // Screen 1 (skipWatchedStreams: true) should only have unwatched streams
    expect(queue1).toHaveLength(1);
    expect(queue1[0].url).toBe(stream2.url);
    
    // Screen 2 (skipWatchedStreams: false) should have all streams
    expect(queue2).toHaveLength(2);
    expect(queue2.map(s => s.url)).toContain(stream3.url);
    expect(queue2.map(s => s.url)).toContain(stream4.url);
  });
  
  /**
   * Test that handleEmptyQueue respects skipWatchedStreams when fetching new streams
   */
  test('should respect skipWatchedStreams when handling empty queues', async () => {
    // Configure screens with different skipWatchedStreams settings
    mockConfig.player.screens[0].skipWatchedStreams = true;  // Screen 1
    mockConfig.player.screens[1].skipWatchedStreams = false; // Screen 2
    
    // Create mock streams
    const stream1 = createMockStreamSource({ 
      screen: 1, 
      url: 'https://youtube.com/1',
      priority: 900 // Not a favorite
    });
    
    const stream2 = createMockStreamSource({ 
      screen: 2, 
      url: 'https://youtube.com/2',
      priority: 900 // Not a favorite
    });
    
    // Mark both streams as watched
    queueService.markStreamAsWatched(stream1.url);
    queueService.markStreamAsWatched(stream2.url);
    
    // Mock getLiveStreams to return our test streams
    mockServices.holodexService.getLiveStreams.mockResolvedValue([stream1, stream2]);
    
    // Handle empty queue for screen 1 (skipWatchedStreams: true)
    await streamManager.handleEmptyQueue(1);
    
    // Verify that no stream was started for screen 1
    // because all streams are watched and skipWatchedStreams is true
    expect(mockServices.playerService.startStream).not.toHaveBeenCalled();
    
    // Reset mocks
    jest.clearAllMocks();
    
    // Handle empty queue for screen 2 (skipWatchedStreams: false)
    await streamManager.handleEmptyQueue(2);
    
    // Verify that stream2 was started for screen 2
    // despite being watched because skipWatchedStreams is false
    expect(mockServices.playerService.startStream).toHaveBeenCalledTimes(1);
    expect(mockServices.playerService.startStream).toHaveBeenCalledWith(
      expect.objectContaining({
        url: stream2.url,
        screen: 2
      })
    );
  });
});
