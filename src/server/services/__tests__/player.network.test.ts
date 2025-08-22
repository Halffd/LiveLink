import { jest } from '@jest/globals';
import { PlayerService } from '../player';
import type { Config } from '../../../types/stream';
import EventEmitter from 'events';
import { ChildProcess } from 'child_process';

// Mock the child_process module
jest.mock('child_process', () => ({
  spawn: jest.fn(() => {
    const mockProcess = new EventEmitter() as any;
    mockProcess.kill = jest.fn();
    mockProcess.stdout = new EventEmitter();
    mockProcess.stderr = new EventEmitter();
    mockProcess.pid = 12345;
    return mockProcess;
  })
}));

// Mock fs module
jest.mock('fs', () => ({
  existsSync: jest.fn(),
  unlinkSync: jest.fn(),
  mkdirSync: jest.fn(),
  writeFileSync: jest.fn(),
  readFileSync: jest.fn(),
  createWriteStream: jest.fn().mockReturnValue({
    write: jest.fn(),
    end: jest.fn(),
    on: jest.fn()
  })
}));

describe('PlayerService Network Error Handling', () => {
  let playerService: PlayerService;
  let mockConfig: Config;
  let mockProcess: any;
  let errorCallback: jest.Mock;
  import * as childProcess from 'child_process';
import * as fs from 'fs';

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    // Mock process.cwd()
    jest.spyOn(process, 'cwd').mockReturnValue('/fake/path');

    // Setup fs mock responses
    fs.existsSync.mockImplementation((path: string) => {
      if (path.includes('mpv-socket')) {
        return false;
      }
      return true;
    });

    // Setup mock config
    mockConfig = {
      player: {
        defaultVolume: 50,
        defaultQuality: 'best',
        windowMaximized: true,
        screens: [
          { screen: 1, enabled: true, id: 'screen1' }
        ]
      }
    } as Config;

    // Create PlayerService instance
    playerService = new PlayerService(mockConfig);

    // Add error callback
    errorCallback = jest.fn();
    playerService.onStreamError(errorCallback);

    // Get the mock process reference
    mockProcess = childProcess.spawn();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('should retry on network errors with linear-capped backoff', async () => {
    // Mock isProcessRunning to return false (process not running)
    jest.spyOn(playerService as any, 'isProcessRunning').mockReturnValue(false);

    // Start a stream
    await playerService.startStream({
      screen: 1,
      url: 'https://example.com/stream',
      quality: 'best'
    });

    // Verify we have a stream
    expect((playerService as any).streams.get(1)).toBeDefined();

    // Simulate a network error (code 2 is a common network error code)
    mockProcess.emit('exit', 2);

    // Verify error callback was not called yet (we're retrying)
    expect(errorCallback).not.toHaveBeenCalled();

    // Verify retry timer was set
    expect((playerService as any).retryTimers.get(1)).toBeDefined();

    // Verify network retry count was incremented
    expect((playerService as any).networkRetries.get(1)).toBe(1);

    // Fast-forward time to trigger the retry
    jest.advanceTimersByTime(5000); // First retry should be at 5s

    // Verify a second attempt was made to start the stream
    expect(childProcess.spawn).toHaveBeenCalledTimes(2);

    // Simulate another network error
    mockProcess.emit('exit', 2);

    // Verify network retry count was incremented again
    expect((playerService as any).networkRetries.get(1)).toBe(2);

    // Verify a longer backoff was used (check time to trigger second retry)
    jest.advanceTimersByTime(10000); // Second retry should be at 10s

    // Verify a third attempt was made
    expect(childProcess.spawn).toHaveBeenCalledTimes(3);

    // Verify the maximum backoff is capped
    mockProcess.emit('exit', 2);
    expect((playerService as any).networkRetries.get(1)).toBe(3);

    // This should use a 15s backoff
    jest.advanceTimersByTime(15000);
    expect(childProcess.spawn).toHaveBeenCalledTimes(4);

    // One more error should use 20s backoff (capped max)
    mockProcess.emit('exit', 2);
    expect((playerService as any).networkRetries.get(1)).toBe(4);

    // Verify the backoff is capped at 20s
    jest.advanceTimersByTime(20000);
    expect(childProcess.spawn).toHaveBeenCalledTimes(5);

    // Final error should now give up
    mockProcess.emit('exit', 2);
    expect((playerService as any).networkRetries.get(1)).toBe(5);

    // Verify it's now giving up and calling the error callback
    expect(errorCallback).toHaveBeenCalledWith(expect.objectContaining({
      screen: 1,
      code: 2,
      moveToNext: true
    }));
  });

  test('should reset retry count after 5 minutes of successful streaming', async () => {
    // Mock isProcessRunning to return false (process not running)
    jest.spyOn(playerService as any, 'isProcessRunning').mockReturnValue(false);

    // Start a stream
    await playerService.startStream({
      screen: 1,
      url: 'https://example.com/stream',
      quality: 'best'
    });

    // Simulate a network error
    mockProcess.emit('exit', 2);

    // Verify network retry count was set
    expect((playerService as any).networkRetries.get(1)).toBe(1);
    
    // Record the time of the error
    const errorTime = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(errorTime);

    // Fast-forward timer to trigger retry
    jest.advanceTimersByTime(5000);

    // Second stream starts successfully
    expect(childProcess.spawn).toHaveBeenCalledTimes(2);

    // Now simulate a long period of successful streaming (over 5 minutes)
    jest.spyOn(Date, 'now').mockReturnValue(errorTime + 5 * 60 * 1000 + 1000);

    // Another network error occurs much later
    mockProcess.emit('exit', 2);

    // Verify retry count was reset to 1 (not incremented to 2)
    expect((playerService as any).networkRetries.get(1)).toBe(1);
  });

  test('should correctly identify network-related error codes', () => {
    // Access the private method using type casting
    const isNetworkErrorCode = (playerService as any).isNetworkErrorCode.bind(playerService);

    // Test with common network error codes
    expect(isNetworkErrorCode(2)).toBe(true);  // Streamlink network error
    expect(isNetworkErrorCode(1)).toBe(true);  // General error (could be network)
    expect(isNetworkErrorCode(9)).toBe(true);  // Killed (during network fluctuations)
    
    // Test with non-network error codes
    expect(isNetworkErrorCode(0)).toBe(false); // Normal exit
    expect(isNetworkErrorCode(null)).toBe(false); // No code
  });

  test('should clear retry timers on manual stop', async () => {
    // Mock isProcessRunning to return false
    jest.spyOn(playerService as any, 'isProcessRunning').mockReturnValue(false);

    // Start a stream
    await playerService.startStream({
      screen: 1,
      url: 'https://example.com/stream',
      quality: 'best'
    });

    // Simulate a network error
    mockProcess.emit('exit', 2);

    // Verify retry timer was set
    expect((playerService as any).retryTimers.get(1)).toBeDefined();

    // Manually stop the stream
    await playerService.stopStream(1, false, true);

    // Verify retry timer was cleared
    expect((playerService as any).retryTimers.get(1)).toBeUndefined();
  });
}); 