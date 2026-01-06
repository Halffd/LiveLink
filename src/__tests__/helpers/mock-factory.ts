/**
 * Mock factory for creating test dependencies
 */
import { mock, type MockProxy } from 'jest-mock-extended';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import { Readable } from 'stream';
import type { StreamSource, Stream } from '../../types/stream';
import type { Config } from '../../types/stream';
import type { HolodexService } from '../../server/services/holodex';
import type { TwitchService } from '../../server/services/twitch';
import type { YouTubeService } from '../../server/services/youtube';
import type { PlayerService } from '../../server/services/player';

/**
 * Creates a mock child process for testing
 */
export function createMockChildProcess(): MockProxy<ChildProcess> {
  const mockProcess = mock<ChildProcess>();
  
  // Mock stdout and stderr as Readable streams
  const stdout = mock<Readable>();
  const stderr = mock<Readable>();

  Object.assign(mockProcess, {
    stdout,
    stderr,
    pid: 12345,
    kill: jest.fn(() => true) // Mock kill here
  });
  
  return mockProcess;
}

/**
 * Creates a mock event emitter for testing
 */
export function createMockEventEmitter(): MockProxy<EventEmitter> & EventEmitter {
  const realEmitter = new EventEmitter();
  const mockEmitter = mock<EventEmitter>();
  
  // Forward all event emitter methods to the real emitter
  mockEmitter.on.mockImplementation((event, listener) => {
    realEmitter.on(event, listener);
    return mockEmitter;
  });
  
  mockEmitter.once.mockImplementation((event, listener) => {
    realEmitter.once(event, listener);
    return mockEmitter;
  });
  
  mockEmitter.emit.mockImplementation((event, ...args) => {
    return realEmitter.emit(event, ...args);
  });
  
  mockEmitter.removeListener.mockImplementation((event, listener) => {
    realEmitter.removeListener(event, listener);
    return mockEmitter;
  });
  
  mockEmitter.removeAllListeners.mockImplementation((event) => {
    realEmitter.removeAllListeners(event);
    return mockEmitter;
  });
  
  return Object.assign(mockEmitter, realEmitter);
}

/**
 * Creates a mock stream source for testing
 */
export function createMockStreamSource(overrides: Partial<StreamSource> = {}): StreamSource {
  return {
    id: `stream-${Date.now()}`,
    url: `https://youtube.com/watch?v=${Date.now()}`,
    title: 'Test Stream',
    platform: 'youtube',
    viewerCount: 1000,
    thumbnail: 'https://example.com/thumbnail.jpg',
    channel: 'Test Channel',
    channelId: 'test-channel-id',
    sourceStatus: 'live',
    startTime: Date.now(),
    duration: 3600,
    priority: 100,
    tags: ['test'],
    screen: 1,
    organization: 'test-org',
    subtype: 'test',
    quality: 'best',
    volume: 50,
    status: 'playing',
    ...overrides
  };
}

/**
 * Creates a mock stream for testing
 */
export function createMockStream(overrides: Partial<Stream> = {}): Stream {
  const mockProcess = createMockChildProcess();
  
  return {
    id: `stream-${Date.now()}`,
    url: `https://youtube.com/watch?v=${Date.now()}`,
    title: 'Test Stream',
    platform: 'youtube',
    viewerCount: 1000,
    thumbnail: 'https://example.com/thumbnail.jpg',
    channel: 'Test Channel',
    channelId: 'test-channel-id',
    sourceStatus: 'live',
    startTime: Date.now(),
    duration: 3600,
    priority: 100,
    tags: ['test'],
    screen: 1,
    organization: 'test-org',
    subtype: 'test',
    quality: 'best',
    volume: 50,
    status: 'playing',
    position: 0,
    process: mockProcess,
    playerStatus: 'playing',
    ...overrides
  };
}

/**
 * Creates a mock config for testing
 */
export function createMockConfig(overrides: Partial<Config> = {}): Config {
  const screenConfig = {
    screen: 1,
    id: 1,
    enabled: true,
    skipWatchedStreams: true,
    volume: 50,
    quality: 'best',
    windowMaximized: false,
    sources: [
      {
        type: 'holodex',
        subtype: 'organization',
        enabled: true,
        priority: 100,
        limit: 10,
        name: 'Hololive'
      }
    ]
  };

  return {
    skipWatchedStreams: true,
    player: {
      defaultQuality: 'best',
      defaultVolume: 50,
      windowMaximized: false,
      maxStreams: 2,
      autoStart: true,
      preferStreamlink: true,
      force_player: false,
      screens: [screenConfig]
    },
    streams: [screenConfig],
    holodex: {
      apiKey: 'test-api-key'
    },
    twitch: {
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret'
    },
    organizations: ['Hololive', 'Nijisanji'],
    favoriteChannels: {
      holodex: {
        default: [{ id: 'channel1', name: 'Channel 1', score: 100 }, { id: 'channel2', name: 'Channel 2', score: 90 }]
      },
      twitch: {
        default: [{ id: 'channel3', name: 'Channel 3', score: 120 }, { id: 'channel4', name: 'Channel 4', score: 80 }]
      },
      youtube: {
        default: [{ id: 'channel5', name: 'Channel 5', score: 110 }, { id: 'channel6', name: 'Channel 6', score: 70 }]
      }
    },
    ...overrides
  };
}

/**
 * Creates mock services for testing StreamManager
 */
export function createMockServices() {
  const holodexService = mock<HolodexService>();
  const twitchService = mock<TwitchService>();
  const youtubeService = mock<YouTubeService>();
  const playerService = mock<PlayerService>();
  
  // Set up default implementations
  holodexService.getLiveStreams.mockResolvedValue([]);
  twitchService.getStreams.mockResolvedValue([]);
  youtubeService.getLiveStreams.mockResolvedValue([]);
  playerService.startStream.mockResolvedValue({ screen: 1, success: true });
  playerService.stopStream.mockResolvedValue(true);
  playerService.isRetrying.mockReturnValue(false);
  
  return {
    holodexService,
    twitchService,
    youtubeService,
    playerService
  };
}

/**
 * Creates a controlled fetch mock for network testing
 */
export function createFetchMock() {
  // Save the original fetch
  const originalFetch = global.fetch;
  
  // Create a mock fetch function
  const fetchMock = jest.fn();
  
  // Mock responses by URL
  const mockResponses = new Map<string, { 
    status: number; 
    body: any; 
    delay?: number;
    error?: boolean;
  }>();
  
  // Replace global fetch with our mock
  global.fetch = fetchMock;
  
  // Default implementation
  fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
    const mockResponse = mockResponses.get(url.toString());
    
    if (mockResponse) {
      if (mockResponse.delay) {
        await new Promise(resolve => setTimeout(resolve, mockResponse.delay));
      }
      
      if (mockResponse.error) {
        throw new Error(`Network error: ${url}`);
      }
      
      return {
        status: mockResponse.status,
        ok: mockResponse.status >= 200 && mockResponse.status < 300,
        json: async () => mockResponse.body,
        text: async () => JSON.stringify(mockResponse.body)
      } as Response;
    }
    
    // Default response if no mock is found
    return {
      status: 404,
      ok: false,
      json: async () => ({ error: 'Not found' }),
      text: async () => 'Not found'
    } as Response;
  });
  
  return {
    mock: fetchMock,
    mockResponses,
    restore: () => {
      global.fetch = originalFetch;
    },
    mockResponse: (url: string, response: { 
      status: number; 
      body: any; 
      delay?: number;
      error?: boolean;
    }) => {
      mockResponses.set(url, response);
    },
    reset: () => {
      fetchMock.mockClear();
      mockResponses.clear();
    }
  };
}
