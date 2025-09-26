/**
 * Race condition tests for PlayerService
 * 
 * These tests focus on verifying proper handling of concurrent operations,
 * race conditions, and network resilience in the PlayerService class.
 */
import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { mock } from 'jest-mock-extended';
import { PlayerService } from '../../../server/services/player';
import { 
  createMockConfig, 
  createMockChildProcess,
  createFetchMock
} from '../../helpers/mock-factory';
import { 
  delay, 
  executeStaggered,
  ExecutionTracker,
  createDeferred
} from '../../helpers/async-utils';
import { TimerMock } from '../../helpers/timer-mock';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { ChildProcess } from 'child_process';

// Mock fs module
jest.mock('fs', () => ({
  existsSync: jest.fn().mockReturnValue(true),
  mkdirSync: jest.fn(),
  readdirSync: jest.fn().mockReturnValue([]),
  statSync: jest.fn().mockReturnValue({
    isFile: () => true,
    mtime: new Date(),
    size: 1000
  }),
  unlinkSync: jest.fn(),
  writeFileSync: jest.fn()
}));

// Mock child_process module
jest.mock('child_process', () => {
  const mockSpawn = jest.fn().mockImplementation(() => {
    const mockProcess = new EventEmitter() as any;
    mockProcess.stdout = new EventEmitter();
    mockProcess.stderr = new EventEmitter();
    mockProcess.kill = jest.fn().mockReturnValue(true);
    mockProcess.pid = 12345;
    return mockProcess;
  });
  
  return { spawn: mockSpawn };
});

// Mock path module
jest.mock('path', () => {
  const originalPath = jest.requireActual('path');
  return {
    ...originalPath,
    join: jest.fn().mockImplementation((...args) => args.join('/'))
  };
});

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

describe('PlayerService Race Condition Tests', () => {
  let playerService: PlayerService;
  let mockConfig: ReturnType<typeof createMockConfig>;
  let timerMock: TimerMock;
  let executionTracker: ExecutionTracker;
  let fetchMock: ReturnType<typeof createFetchMock>;
  let mockProcesses: Map<number, ChildProcess> = new Map();
  
  beforeEach(() => {
    // Reset all mocks
    jest.clearAllMocks();
    mockProcesses.clear();
    
    // Create mock dependencies
    mockConfig = createMockConfig();
    
    // Set up timer mock
    timerMock = new TimerMock();
    timerMock.install();
    
    // Set up fetch mock
    fetchMock = createFetchMock();
    
    // Create execution tracker for tracking async operations
    executionTracker = new ExecutionTracker();
    
    // Mock spawn to create tracked processes
    const mockSpawn = require('child_process').spawn as jest.Mock;
    mockSpawn.mockImplementation(() => {
      const mockProcess = new EventEmitter() as any;
      mockProcess.stdout = new EventEmitter();
      mockProcess.stderr = new EventEmitter();
      mockProcess.kill = jest.fn().mockReturnValue(true);
      mockProcess.pid = Math.floor(Math.random() * 10000) + 1000;
      
      // Track the process
      mockProcesses.set(mockProcess.pid, mockProcess);
      
      return mockProcess;
    });
    
    // Create PlayerService instance with mocked dependencies
    playerService = new PlayerService(mockConfig);
    
    // Mock the testConnection method to control network availability
    (playerService as any).testConnection = jest.fn().mockResolvedValue(true);
  });
  
  afterEach(() => {
    // Restore timers
    timerMock.restore();
    
    // Restore fetch
    fetchMock.restore();
  });
  
  /**
   * Test that the PlayerService prevents multiple streams from starting simultaneously
   */
  test('should prevent multiple streams from starting simultaneously on the same screen', async () => {
    // Create deferred promises to control when processes emit events
    const startDeferred1 = createDeferred<void>();
    const startDeferred2 = createDeferred<void>();
    
    // Set up stream options
    const streamOptions1 = {
      url: 'https://youtube.com/watch?v=1',
      screen: 1,
      quality: 'best'
    };
    
    const streamOptions2 = {
      url: 'https://youtube.com/watch?v=2',
      screen: 1, // Same screen
      quality: 'best'
    };
    
    // Start first stream (don't await)
    const stream1Promise = playerService.startStream(streamOptions1).then(() => {
      executionTracker.record('stream1:completed');
    });
    
    // Wait a bit to ensure first stream has started
    await delay(10);
    
    // Start second stream (should be blocked until first completes)
    const stream2Promise = playerService.startStream(streamOptions2).then(() => {
      executionTracker.record('stream2:completed');
    });
    
    // Wait a bit more
    await delay(10);
    
    // Get the processes
    const processes = Array.from(mockProcesses.values());
    expect(processes.length).toBe(1);
    
    // Emit 'data' event to indicate stream started
    processes[0].stdout.emit('data', 'Stream started successfully');
    
    // Resolve the first stream start
    startDeferred1.resolve();
    
    // Wait for the first stream to complete
    await stream1Promise;
    
    // Now the second stream should start
    // Wait a bit
    await delay(10);
    
    // Now there should be two processes
    expect(mockProcesses.size).toBe(2);
    
    // Emit 'data' event for the second process
    const processes2 = Array.from(mockProcesses.values());
    processes2[1].stdout.emit('data', 'Stream started successfully');
    
    // Resolve the second stream start
    startDeferred2.resolve();
    
    // Wait for both streams to complete
    await Promise.all([stream1Promise, stream2Promise]);
    
    // Verify the execution order
    const events = executionTracker.getEvents();
    expect(events[0]).toBe('stream1:completed');
    expect(events[1]).toBe('stream2:completed');
  });
  
  /**
   * Test that the PlayerService properly handles network errors and retries
   */
  test('should retry streams with exponential backoff when network errors occur', async () => {
    // Mock testConnection to simulate network outage and recovery
    (playerService as any).testConnection = jest.fn()
      .mockResolvedValueOnce(false)  // First check: network down
      .mockResolvedValueOnce(false)  // Second check: still down
      .mockResolvedValueOnce(true);  // Third check: network back
    
    // Set up stream options
    const streamOptions = {
      url: 'https://youtube.com/watch?v=1',
      screen: 1,
      quality: 'best'
    };
    
    // Start stream
    const startPromise = playerService.startStream(streamOptions);
    
    // Wait a bit for the stream to start
    await delay(10);
    
    // Get the process
    const processes = Array.from(mockProcesses.values());
    expect(processes.length).toBe(1);
    
    // Emit 'data' event to indicate stream started
    processes[0].stdout.emit('data', 'Stream started successfully');
    
    // Complete the start promise
    await startPromise;
    
    // Now trigger a network error
    processes[0].emit('exit', 2); // Code 2 is a network-related error
    
    // Advance time to trigger retry logic
    timerMock.advanceTime(1500); // First backoff: 1.5s
    
    // Network is still down, so no new process yet
    expect(mockProcesses.size).toBe(1);
    
    // Advance time again
    timerMock.advanceTime(2250); // Second backoff: 1.5s * 1.5 = 2.25s
    
    // Network is now up, should have started a new process
    expect(mockProcesses.size).toBe(2);
    
    // Verify testConnection was called the expected number of times
    expect((playerService as any).testConnection).toHaveBeenCalledTimes(3);
  });
  
  /**
   * Test that the PlayerService properly handles multiple concurrent network errors
   */
  test('should handle multiple concurrent network errors without race conditions', async () => {
    // Mock testConnection to simulate network outage and recovery
    (playerService as any).testConnection = jest.fn()
      .mockResolvedValue(true); // Network is up
    
    // Set up stream options for multiple screens
    const streamOptions1 = {
      url: 'https://youtube.com/watch?v=1',
      screen: 1,
      quality: 'best'
    };
    
    const streamOptions2 = {
      url: 'https://youtube.com/watch?v=2',
      screen: 2,
      quality: 'best'
    };
    
    // Start both streams
    await Promise.all([
      playerService.startStream(streamOptions1),
      playerService.startStream(streamOptions2)
    ]);
    
    // Should have two processes
    expect(mockProcesses.size).toBe(2);
    
    // Get the processes
    const processes = Array.from(mockProcesses.values());
    
    // Trigger network errors on both streams simultaneously
    processes.forEach(process => {
      process.emit('exit', 2); // Code 2 is a network-related error
    });
    
    // Advance time to trigger retry logic
    timerMock.advanceTime(1500); // First backoff: 1.5s
    
    // Should have started two new processes
    expect(mockProcesses.size).toBe(4);
    
    // Verify testConnection was called for both screens
    expect((playerService as any).testConnection).toHaveBeenCalledTimes(2);
    
    // Check that the retry counters are maintained separately for each screen
    expect((playerService as any).streamRetries.get(1)).toBe(2);
    expect((playerService as any).streamRetries.get(2)).toBe(2);
  });
  
  /**
   * Test that the PlayerService properly handles frozen streams
   */
  test('should detect and restart frozen streams based on output silence', async () => {
    // Set up stream options
    const streamOptions = {
      url: 'https://youtube.com/watch?v=1',
      screen: 1,
      quality: 'best'
    };
    
    // Start stream
    await playerService.startStream(streamOptions);
    
    // Should have one process
    expect(mockProcesses.size).toBe(1);
    
    // Get the process
    const process = Array.from(mockProcesses.values())[0];
    
    // Emit some initial output
    process.stdout.emit('data', 'Stream started successfully');
    
    // Advance time past the output silence threshold (15s)
    timerMock.advanceTime(20000);
    
    // First check should increment the failure counter but not restart yet
    // Advance time for next health check (5s)
    timerMock.advanceTime(5000);
    
    // Second check
    timerMock.advanceTime(5000);
    
    // Third check should trigger restart (after 3 consecutive failures)
    timerMock.advanceTime(5000);
    
    // Should have started a new process
    expect(mockProcesses.size).toBe(2);
    
    // The old process should have been killed
    expect(process.kill).toHaveBeenCalled();
  });
  
  /**
   * Test that the PlayerService properly handles skipWatchedStreams option
   */
  test('should respect skipWatchedStreams setting during network retries', async () => {
    // Mock handleProcessExit to track calls
    const originalHandleProcessExit = (playerService as any).handleProcessExit;
    (playerService as any).handleProcessExit = jest.fn().mockImplementation(async function(screen: number, code: number) {
      executionTracker.record(`handleProcessExit:${screen}:${code}`);
      return originalHandleProcessExit.call(this, screen, code);
    });
    
    // Set up stream options for two screens with different skipWatchedStreams settings
    const streamOptions1 = {
      url: 'https://youtube.com/watch?v=1',
      screen: 1, // Screen 1 has skipWatchedStreams: true
      quality: 'best'
    };
    
    const streamOptions2 = {
      url: 'https://youtube.com/watch?v=2',
      screen: 2, // Screen 2 has skipWatchedStreams: false
      quality: 'best'
    };
    
    // Start both streams
    await Promise.all([
      playerService.startStream(streamOptions1),
      playerService.startStream(streamOptions2)
    ]);
    
    // Should have two processes
    expect(mockProcesses.size).toBe(2);
    
    // Get the processes
    const processes = Array.from(mockProcesses.values());
    
    // Trigger network errors on both streams
    processes.forEach((process, index) => {
      const screen = index + 1;
      process.emit('exit', 2); // Code 2 is a network-related error
      executionTracker.record(`process:exit:${screen}`);
    });
    
    // Advance time to trigger retry logic
    timerMock.advanceTime(1500);
    
    // Both streams should be retried regardless of skipWatchedStreams setting
    // because this is a network error, not a watched stream check
    expect(mockProcesses.size).toBe(4);
    
    // Verify handleProcessExit was called for both screens
    expect((playerService as any).handleProcessExit).toHaveBeenCalledTimes(2);
    
    // Verify the execution order
    const events = executionTracker.getEvents();
    expect(events).toContain('process:exit:1');
    expect(events).toContain('process:exit:2');
    expect(events).toContain('handleProcessExit:1:2');
    expect(events).toContain('handleProcessExit:2:2');
  });
  
  /**
   * Test that the PlayerService properly handles cleanup to prevent memory leaks
   */
  test('should properly clean up resources to prevent memory leaks', async () => {
    // Set up stream options
    const streamOptions = {
      url: 'https://youtube.com/watch?v=1',
      screen: 1,
      quality: 'best'
    };
    
    // Start stream
    await playerService.startStream(streamOptions);
    
    // Should have one process
    expect(mockProcesses.size).toBe(1);
    
    // Spy on clearMonitoring and clearRetryTimer
    const clearMonitoringSpy = jest.spyOn(playerService as any, 'clearMonitoring');
    const clearRetryTimerSpy = jest.spyOn(playerService as any, 'clearRetryTimer');
    
    // Stop the stream
    await playerService.stopStream(1);
    
    // Verify clearMonitoring and clearRetryTimer were called
    expect(clearMonitoringSpy).toHaveBeenCalledWith(1);
    expect(clearRetryTimersSpy).toHaveBeenCalledWith(1);
    
    // Verify that all maps are cleared for this screen
    expect((playerService as any).streams.has(1)).toBe(false);
    expect((playerService as any).streamRetries.has(1)).toBe(false);
    expect((playerService as any).retryTimers.has(1)).toBe(false);
    expect((playerService as any).streamRefreshTimers.has(1)).toBe(false);
    expect((playerService as any).inactiveTimers.has(1)).toBe(false);
    expect((playerService as any).ipcPaths.has(1)).toBe(false);
    expect((playerService as any).healthCheckIntervals.has(1)).toBe(false);
  });
});
