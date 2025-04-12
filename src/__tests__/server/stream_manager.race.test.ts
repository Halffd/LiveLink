/**
 * Race condition tests for StreamManager
 * 
 * These tests focus on verifying proper handling of concurrent operations
 * and race conditions in the StreamManager class.
 */
import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { mock } from 'jest-mock-extended';
import { StreamManager } from '../../server/stream_manager';
import { 
  createMockConfig, 
  createMockServices, 
  createMockStreamSource 
} from '../helpers/mock-factory';
import { 
  delay, 
  executeStaggered,
  ExecutionTracker 
} from '../helpers/async-utils';
import { TimerMock } from '../helpers/timer-mock';
import { queueService } from '../../server/services/queue_service';

// Mock the queue service
jest.mock('../../server/services/queue_service', () => {
  const mockQueueService = {
    setQueue: jest.fn(),
    getQueue: jest.fn().mockReturnValue([]),
    addToQueue: jest.fn(),
    clearQueue: jest.fn(),
    clearAllQueues: jest.fn(),
    getNextStream: jest.fn(),
    removeFromQueue: jest.fn(),
    markStreamAsWatched: jest.fn(),
    isStreamWatched: jest.fn().mockReturnValue(false),
    getWatchedStreams: jest.fn().mockReturnValue([]),
    clearWatchedStreams: jest.fn(),
    on: jest.fn(),
    off: jest.fn(),
    hasUnwatchedStreams: jest.fn().mockReturnValue(true),
    filterUnwatchedStreams: jest.fn(streams => streams),
    emit: jest.fn()
  };
  
  return { queueService: mockQueueService };
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

describe('StreamManager Race Condition Tests', () => {
  let streamManager: StreamManager;
  let mockServices: ReturnType<typeof createMockServices>;
  let mockConfig: ReturnType<typeof createMockConfig>;
  let timerMock: TimerMock;
  let executionTracker: ExecutionTracker;
  
  beforeEach(() => {
    // Reset all mocks
    jest.clearAllMocks();
    
    // Create mock dependencies
    mockServices = createMockServices();
    mockConfig = createMockConfig();
    
    // Set up timer mock
    timerMock = new TimerMock();
    timerMock.install();
    
    // Create execution tracker for tracking async operations
    executionTracker = new ExecutionTracker();
    
    // Create StreamManager instance with mocked dependencies
    streamManager = new StreamManager(
      mockConfig,
      mockServices.holodexService,
      mockServices.twitchService,
      mockServices.youtubeService,
      mockServices.playerService
    );
  });
  
  afterEach(() => {
    // Restore timers
    timerMock.restore();
  });
  
  /**
   * Test that the queueProcessing lock prevents multiple concurrent
   * stream end handlers from processing the same screen
   */
  test('should prevent concurrent handleStreamEnd calls for the same screen', async () => {
    // Create mock stream sources
    const mockStream1 = createMockStreamSource({ screen: 1, url: 'https://youtube.com/1' });
    const mockStream2 = createMockStreamSource({ screen: 1, url: 'https://youtube.com/2' });
    
    // Set up queue service to return different streams on consecutive calls
    (queueService.getNextStream as jest.Mock)
      .mockReturnValueOnce(mockStream1)
      .mockReturnValueOnce(mockStream2);
    
    // Track the streams that were started
    const startedStreams: string[] = [];
    
    // Mock the startStream method to track calls and add delay
    const originalStartStream = streamManager.startStream.bind(streamManager);
    streamManager.startStream = jest.fn().mockImplementation(async (options) => {
      executionTracker.record(`startStream:${options.url}`);
      startedStreams.push(options.url);
      // Add delay to simulate stream starting
      await delay(50);
      return originalStartStream(options);
    });
    
    // Call handleStreamEnd multiple times concurrently for the same screen
    await executeStaggered([
      () => {
        executionTracker.record('handleStreamEnd:call1');
        return streamManager.handleStreamEnd(1);
      },
      () => {
        executionTracker.record('handleStreamEnd:call2');
        return streamManager.handleStreamEnd(1);
      },
      () => {
        executionTracker.record('handleStreamEnd:call3');
        return streamManager.handleStreamEnd(1);
      }
    ], 10);
    
    // Verify that startStream was called only once
    expect(streamManager.startStream).toHaveBeenCalledTimes(1);
    
    // Verify that only the first stream was started
    expect(startedStreams).toEqual([mockStream1.url]);
    
    // Verify the execution order shows the lock working
    const events = executionTracker.getEvents();
    expect(events).toContain('handleStreamEnd:call1');
    expect(events).toContain('startStream:https://youtube.com/1');
    
    // The second and third calls should have been blocked by the queueProcessing lock
    expect(queueService.getNextStream).toHaveBeenCalledTimes(1);
  });
  
  /**
   * Test that skipWatchedStreams option is respected when multiple streams
   * are processed concurrently
   */
  test('should respect skipWatchedStreams setting during concurrent operations', async () => {
    // Create mock stream sources for different screens
    const mockStream1 = createMockStreamSource({ 
      screen: 1, 
      url: 'https://youtube.com/1',
      priority: 100
    });
    
    const mockStream2 = createMockStreamSource({ 
      screen: 2, 
      url: 'https://youtube.com/2',
      priority: 200
    });
    
    // Configure screens with different skipWatchedStreams settings
    mockConfig.player.screens[0].skipWatchedStreams = true;  // Screen 1
    mockConfig.player.screens[1].skipWatchedStreams = false; // Screen 2
    
    // Set up queue service
    (queueService.getNextStream as jest.Mock)
      .mockImplementation((screen) => {
        return screen === 1 ? mockStream1 : mockStream2;
      });
    
    // Mock isStreamWatched to return true for the first stream
    (queueService.isStreamWatched as jest.Mock)
      .mockImplementation((url) => {
        return url === mockStream1.url;
      });
    
    // Track the streams that were started
    const startedStreams: Array<{screen: number, url: string}> = [];
    
    // Mock the startStream method to track calls
    const originalStartStream = streamManager.startStream.bind(streamManager);
    streamManager.startStream = jest.fn().mockImplementation(async (options) => {
      executionTracker.record(`startStream:${options.screen}:${options.url}`);
      startedStreams.push({screen: options.screen, url: options.url});
      await delay(50); // Add delay to simulate stream starting
      return originalStartStream(options);
    });
    
    // Process streams for both screens concurrently
    await Promise.all([
      streamManager.handleStreamEnd(1),
      streamManager.handleStreamEnd(2)
    ]);
    
    // Verify that startStream was called only for screen 2
    // since screen 1 has skipWatchedStreams=true and its stream is marked as watched
    expect(streamManager.startStream).toHaveBeenCalledTimes(1);
    
    // Verify that only screen 2's stream was started
    expect(startedStreams).toEqual([
      {screen: 2, url: mockStream2.url}
    ]);
    
    // Verify the stream on screen 1 was skipped due to being watched
    expect(queueService.removeFromQueue).toHaveBeenCalledWith(1, 0);
  });
  
  /**
   * Test that the StreamManager properly handles network race conditions
   * when fetching streams
   */
  test('should handle network race conditions when fetching streams', async () => {
    // Mock getLiveStreams to simulate different response times
    const fastStream = createMockStreamSource({ screen: 1, priority: 100 });
    const slowStream = createMockStreamSource({ screen: 1, priority: 200 });
    
    // First call returns quickly with one stream
    mockServices.holodexService.getLiveStreams.mockImplementationOnce(async () => {
      executionTracker.record('holodex:fast');
      await delay(10);
      return [fastStream];
    });
    
    // Second call takes longer but returns a different stream
    mockServices.twitchService.getLiveStreams.mockImplementationOnce(async () => {
      executionTracker.record('twitch:slow');
      await delay(100);
      return [slowStream];
    });
    
    // Third call fails with an error
    mockServices.youtubeService.getLiveStreams.mockImplementationOnce(async () => {
      executionTracker.record('youtube:error');
      await delay(50);
      throw new Error('Network error');
    });
    
    // Call getLiveStreams
    const streams = await streamManager.getLiveStreams();
    
    // Verify that both successful responses were combined
    expect(streams).toHaveLength(2);
    expect(streams).toContainEqual(expect.objectContaining({ url: fastStream.url }));
    expect(streams).toContainEqual(expect.objectContaining({ url: slowStream.url }));
    
    // Verify the execution order
    const events = executionTracker.getEvents();
    expect(events).toEqual([
      'holodex:fast',
      'youtube:error',
      'twitch:slow'
    ]);
  });
  
  /**
   * Test that the StreamManager properly handles a stream ending while
   * another stream is being processed
   */
  test('should handle a stream ending while another is being processed', async () => {
    // Create mock streams for different screens
    const mockStream1 = createMockStreamSource({ screen: 1 });
    const mockStream2 = createMockStreamSource({ screen: 2 });
    
    // Set up queue service
    (queueService.getNextStream as jest.Mock)
      .mockImplementation((screen) => {
        return screen === 1 ? mockStream1 : mockStream2;
      });
    
    // Mock startStream to add delay for screen 1
    const originalStartStream = streamManager.startStream.bind(streamManager);
    streamManager.startStream = jest.fn().mockImplementation(async (options) => {
      executionTracker.record(`startStream:${options.screen}`);
      
      // Add significant delay for screen 1 to ensure overlap
      if (options.screen === 1) {
        await delay(200);
      } else {
        await delay(50);
      }
      
      return originalStartStream(options);
    });
    
    // Start processing stream for screen 1 (will take longer)
    const screen1Promise = streamManager.handleStreamEnd(1);
    
    // Wait a bit to ensure screen 1 processing has started
    await delay(20);
    
    // Start processing stream for screen 2 (will complete faster)
    const screen2Promise = streamManager.handleStreamEnd(2);
    
    // Wait for both to complete
    await Promise.all([screen1Promise, screen2Promise]);
    
    // Verify that startStream was called for both screens
    expect(streamManager.startStream).toHaveBeenCalledTimes(2);
    
    // Verify the execution order
    const events = executionTracker.getEvents();
    expect(events[0]).toBe('startStream:1');
    expect(events[1]).toBe('startStream:2');
    
    // Verify that both streams were marked as watched
    expect(queueService.markStreamAsWatched).toHaveBeenCalledWith(mockStream1.url);
    expect(queueService.markStreamAsWatched).toHaveBeenCalledWith(mockStream2.url);
  });
  
  /**
   * Test that the StreamManager properly handles errors during stream processing
   */
  test('should handle errors during stream processing without affecting other screens', async () => {
    // Create mock streams for different screens
    const mockStream1 = createMockStreamSource({ screen: 1 });
    const mockStream2 = createMockStreamSource({ screen: 2 });
    
    // Set up queue service
    (queueService.getNextStream as jest.Mock)
      .mockImplementation((screen) => {
        return screen === 1 ? mockStream1 : mockStream2;
      });
    
    // Mock startStream to fail for screen 1
    const originalStartStream = streamManager.startStream.bind(streamManager);
    streamManager.startStream = jest.fn().mockImplementation(async (options) => {
      executionTracker.record(`startStream:${options.screen}`);
      
      if (options.screen === 1) {
        throw new Error('Failed to start stream');
      }
      
      return originalStartStream(options);
    });
    
    // Process both screens concurrently
    await Promise.all([
      streamManager.handleStreamEnd(1).catch(() => {
        executionTracker.record('screen1:error');
      }),
      streamManager.handleStreamEnd(2)
    ]);
    
    // Verify that startStream was called for both screens
    expect(streamManager.startStream).toHaveBeenCalledTimes(2);
    
    // Verify the execution order includes the error
    const events = executionTracker.getEvents();
    expect(events).toContain('startStream:1');
    expect(events).toContain('screen1:error');
    expect(events).toContain('startStream:2');
    
    // Verify that the queueProcessing lock was released for both screens
    // This is important to ensure future stream processing isn't blocked
    const queueProcessingField = (streamManager as any).queueProcessing;
    expect(queueProcessingField.has(1)).toBe(false);
    expect(queueProcessingField.has(2)).toBe(false);
  });
});
