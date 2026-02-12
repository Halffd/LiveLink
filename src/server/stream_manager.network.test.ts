import { jest } from '@jest/globals';
import { StreamManager } from './stream_manager';
import type { Config } from '../types/stream';
import EventEmitter from 'events';

// Mock services
jest.mock('./services/holodex', () => ({
  HolodexService: jest.fn().mockImplementation(() => ({
    getLiveStreams: jest.fn().mockResolvedValue([]),
    getUpcomingStreams: jest.fn().mockResolvedValue([]),
    getTopStreams: jest.fn().mockResolvedValue([])
  }))
}));

jest.mock('./services/twitch', () => ({
  TwitchService: jest.fn().mockImplementation(() => ({
    getLiveStreams: jest.fn().mockResolvedValue([]),
    getFollowedStreams: jest.fn().mockResolvedValue([])
  }))
}));

jest.mock('./services/youtube', () => ({
  YouTubeService: jest.fn().mockImplementation(() => ({
    getLiveStreams: jest.fn().mockResolvedValue([])
  }))
}));

jest.mock('./services/player', () => ({
  PlayerService: jest.fn().mockImplementation(() => ({
    startStream: jest.fn().mockResolvedValue({ success: true }),
    stopStream: jest.fn().mockResolvedValue(true),
    getActiveStreams: jest.fn().mockReturnValue([]),
    onStreamError: jest.fn(),
    onStreamEnd: jest.fn(),
    onStreamOutput: jest.fn(),
    disableScreen: jest.fn(),
    enableScreen: jest.fn(),
    sendCommandToScreen: jest.fn(),
    sendCommandToAll: jest.fn(),
    cleanup: jest.fn().mockResolvedValue(undefined),
    DUMMY_SOURCE: ''
  }))
}));


// Mock fetch for network status tests
global.fetch = jest.fn();

// Mock setTimeout
jest.mock('node:timers/promises', () => ({
  setTimeout: jest.fn().mockResolvedValue(undefined)
}));

describe('StreamManager Network Recovery', () => {
  let streamManager: StreamManager;
  let mockConfig: Config;
  let mockHolodexService: any;
  let mockTwitchService: any;
  let mockYouTubeService: any;
  let mockPlayerService: any;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    // Reset fetch mock
    (global.fetch as jest.Mock).mockReset();

    // Create mock services
    mockHolodexService = require('./services/holodex').HolodexService();
    mockTwitchService = require('./services/twitch').TwitchService();
    mockYouTubeService = require('./services/youtube').YouTubeService();
    mockPlayerService = require('./services/player').PlayerService();

    // Create mock config
    mockConfig = {
      player: {
        defaultVolume: 50,
        defaultQuality: 'best',
        windowMaximized: true,
        screens: [
          { screen: 1, enabled: true, id: 'screen1' }
        ]
      },
      twitch: {},
      holodex: {},
      youtube: {},
      streamlink: {}
    } as Config;

    // Create StreamManager instance
    streamManager = new StreamManager(
      mockConfig,
      mockHolodexService,
      mockTwitchService,
      mockYouTubeService,
      mockPlayerService
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('should detect network going offline', async () => {
    // Mock fetch to simulate network down
    (global.fetch as jest.Mock).mockRejectedValue(new Error('Network error'));

    // Trigger network check by advancing timer
    jest.advanceTimersByTime(20000);

    // Access private isOffline flag using type assertion
    expect((streamManager as any).isOffline).toBe(true);
  });

  test('should detect network coming back online', async () => {
    // First set network as offline
    (global.fetch as jest.Mock).mockRejectedValue(new Error('Network error'));
    jest.advanceTimersByTime(20000);
    expect((streamManager as any).isOffline).toBe(true);

    // Now simulate network coming back online
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200
    });

    // Advance timer to trigger next check
    jest.advanceTimersByTime(20000);

    // Network should be back online
    expect((streamManager as any).isOffline).toBe(false);
  });

  test('should skip queue updates when offline', async () => {
    // Set up spy on updateAllQueues method
    const updateQueuesSpy = jest.spyOn(streamManager as any, 'updateAllQueues');

    // Set network as offline
    (global.fetch as jest.Mock).mockRejectedValue(new Error('Network error'));
    jest.advanceTimersByTime(20000);
    expect((streamManager as any).isOffline).toBe(true);

    // Trigger queue update interval
    jest.advanceTimersByTime(15 * 60 * 1000);

    // Verify updateQueues was not called
    expect(updateQueuesSpy).not.toHaveBeenCalled();
  });

  test('should perform recovery actions when network comes back online', async () => {
    // Set up spies
    const forceQueueRefreshSpy = jest.spyOn(streamManager as any, 'forceQueueRefresh')
      .mockResolvedValue(undefined);
    const updateQueueSpy = jest.spyOn(streamManager as any, 'updateQueue')
      .mockResolvedValue(undefined);
    const handleEmptyQueueSpy = jest.spyOn(streamManager as any, 'handleEmptyQueue')
      .mockResolvedValue(undefined);

    // Mock getEnabledScreens
    jest.spyOn(streamManager as any, 'getEnabledScreens')
      .mockReturnValue([1]);

    // First set network as offline
    (global.fetch as jest.Mock).mockRejectedValue(new Error('Network error'));
    jest.advanceTimersByTime(20000);
    expect((streamManager as any).isOffline).toBe(true);

    // Mock getActiveStreams to return empty array (no active streams)
    mockPlayerService.getActiveStreams.mockReturnValue([]);

    // Now simulate network coming back online
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200
    });

    // Advance timer to trigger next check
    jest.advanceTimersByTime(20000);

    // Network should be back online
    expect((streamManager as any).isOffline).toBe(false);

    // Fast forward to trigger the recovery process
    jest.advanceTimersByTime(3000);

    // Verify recovery actions were called
    expect(forceQueueRefreshSpy).toHaveBeenCalled();
    
    // Wait for all promises to resolve
    await Promise.resolve();
    await Promise.resolve();
    
    // Verify attempt to start new streams
    expect(handleEmptyQueueSpy).toHaveBeenCalledWith(1);
  });

  test('should not perform recovery if a stream is still active', async () => {
    // Set up spies
    const forceQueueRefreshSpy = jest.spyOn(streamManager as any, 'forceQueueRefresh')
      .mockResolvedValue(undefined);

    // First set network as offline
    (global.fetch as jest.Mock).mockRejectedValue(new Error('Network error'));
    jest.advanceTimersByTime(20000);
    expect((streamManager as any).isOffline).toBe(true);

    // Mock getActiveStreams to return an active stream
    mockPlayerService.getActiveStreams.mockReturnValue([
      { screen: 1, url: 'https://example.com', status: 'playing' }
    ]);

    // Now simulate network coming back online
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200
    });

    // Advance timer to trigger next check
    jest.advanceTimersByTime(20000);

    // Network should be back online
    expect((streamManager as any).isOffline).toBe(false);

    // Fast forward to trigger the recovery process
    jest.advanceTimersByTime(3000);

    // Verify forceQueueRefresh was not called because stream is still active
    expect(forceQueueRefreshSpy).not.toHaveBeenCalled();
  });

  test('should perform full reset after long outage', async () => {
    // Set up spies
    const forceQueueRefreshSpy = jest.spyOn(streamManager as any, 'forceQueueRefresh')
      .mockResolvedValue(undefined);

    // First set network as offline
    (global.fetch as jest.Mock).mockRejectedValue(new Error('Network error'));
    jest.advanceTimersByTime(20000);
    expect((streamManager as any).isOffline).toBe(true);

    // Mock getActiveStreams to return empty array
    mockPlayerService.getActiveStreams.mockReturnValue([]);

    // Mock Date.now to simulate a very long outage (more than 1 hour)
    const originalNow = Date.now;
    const currentTime = Date.now();
    Date.now = jest.fn().mockReturnValue(currentTime + 3600000 + 1000);

    // Now simulate network coming back online
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200
    });

    // Advance timer to trigger next check
    jest.advanceTimersByTime(20000);

    // Fast forward to trigger the recovery process
    jest.advanceTimersByTime(3000);

    // Verify cachedStreams was cleared for long outage
    expect((streamManager as any).cachedStreams).toEqual([]);
    expect((streamManager as any).lastStreamFetch).toBe(0);

    // Restore Date.now
    Date.now = originalNow;
  });

  test('should not perform recovery if already performed recently', async () => {
    // Set up spies
    const forceQueueRefreshSpy = jest.spyOn(streamManager as any, 'forceQueueRefresh')
      .mockResolvedValue(undefined);

    // First set network as offline
    (global.fetch as jest.Mock).mockRejectedValue(new Error('Network error'));
    jest.advanceTimersByTime(20000);
    expect((streamManager as any).isOffline).toBe(true);

    // Now simulate network coming back online
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200
    });

    // Advance timer to trigger next check
    jest.advanceTimersByTime(20000);
    
    // Fast forward to trigger the recovery process
    jest.advanceTimersByTime(3000);
    
    // Reset the spy to check if it's called again
    forceQueueRefreshSpy.mockClear();
    
    // Set network offline and online again quickly
    (global.fetch as jest.Mock).mockRejectedValue(new Error('Network error'));
    jest.advanceTimersByTime(20000);
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 });
    jest.advanceTimersByTime(20000);
    
    // Fast forward to trigger the recovery process
    jest.advanceTimersByTime(3000);
    
    // Verify refresh was skipped because we just did one
    expect(forceQueueRefreshSpy).not.toHaveBeenCalled();
  });
}); 