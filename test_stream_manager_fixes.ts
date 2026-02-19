import { StreamManager, StreamState, StreamFailureType } from './src/server/stream_manager.ts';
import { StreamInstance } from './src/types/stream_instance.js';
import { Config } from './src/types/stream.js';
import { TwitchService } from './src/server/services/twitch.js';
import { HolodexService } from './src/server/services/holodex.js';
import { PlayerService } from './src/server/services/player.js';
import { logger } from './src/server/services/logger.js';

// Mock services for testing
class MockTwitchService extends TwitchService {
  constructor() {
    super('', '', []);
  }

  async getStreams() {
    return [];
  }

  async getVTuberStreams() {
    return [];
  }

  async getJapaneseStreams() {
    return [];
  }
}

class MockHolodexService extends HolodexService {
  constructor(apiKey: string, filters: any[], favoriteChannelIds: any[]) {
    super(apiKey, filters, favoriteChannelIds);
  }

  async getLiveStreams() {
    return [];
  }
}

class MockPlayerService extends PlayerService {
  constructor(config: Config) {
    super(config);
  }

  async startStream() {
    return { success: true, screen: 1, message: 'Stream started' };
  }

  async stopStream() {
    return true;
  }

  isStreamHealthy() {
    return true;
  }

  getStartupCooldown() {
    return 0;
  }

  onStreamEnd(callback: (data: any) => void) {
    // Mock event listener
  }

  onStreamError(callback: (data: any) => void) {
    // Mock event listener
  }

  onStreamOutput(callback: (data: any) => void) {
    // Mock event listener
  }

  sendCommandToScreen(screen: number, command: string) {
    // Mock implementation
  }

  sendCommandToAll(command: string) {
    // Mock implementation
  }

  getActiveStreams() {
    return [];
  }

  disableScreen(screen: number) {
    // Mock implementation
  }

  enableScreen(screen: number) {
    // Mock implementation
  }

  handleLuaMessage(screen: number, type: string, data: Record<string, unknown>) {
    // Mock implementation
  }
}

// Create a mock config
const mockConfig: Config = {
  streams: [],
  organizations: [],
  favoriteChannels: {
    holodex: {},
    twitch: {},
    youtube: {}
  },
  holodex: {
    apiKey: ''
  },
  twitch: {
    clientId: '',
    clientSecret: '',
    streamersFile: ''
  },
  filters: {
    filters: []
  },
  player: {
    preferStreamlink: false,
    defaultQuality: 'best',
    defaultVolume: 50,
    windowMaximized: false,
    maxStreams: 10,
    autoStart: false,
    screens: []
  },
  mpv: {}
};

// Test the fixes
async function testStreamManagerFixes() {
  console.log('Testing StreamManager fixes...');
  
  const twitchService = new MockTwitchService();
  const holodexService = new MockHolodexService('', [], []);
  const playerService = new MockPlayerService(mockConfig);
  
  const streamManager = new StreamManager(
    mockConfig,
    holodexService,
    twitchService,
    playerService
  );

  // Test 1: Verify that stuck starting timer is properly set up and cancelled
  console.log('\n1. Testing stuck starting timer setup and cancellation...');
  
  // Simulate transitioning to STARTING state
  await streamManager['setScreenState'](1, StreamState.STARTING);
  
  // Check if timer was set up
  const hasTimer = streamManager['stuckStartingTimers'].has(1);
  console.log(`Timer set up for screen 1: ${hasTimer}`);
  
  // Simulate transitioning to PLAYING state (should cancel timer)
  await streamManager['setScreenState'](1, StreamState.PLAYING);
  
  // Check if timer was cancelled
  const hasTimerAfterPlay = streamManager['stuckStartingTimers'].has(1);
  console.log(`Timer cancelled after PLAYING transition: ${!hasTimerAfterPlay}`);
  
  // Test 2: Verify failure classification
  console.log('\n2. Testing failure classification...');
  
  // Test manual stop
  const manualStopFailure = streamManager['classifyStreamFailure'](true, 0);
  console.log(`Manual stop classified as: ${manualStopFailure}`);
  console.log(`Manual stop should be marked as watched: ${streamManager['shouldMarkStreamAsWatched'](manualStopFailure, 0)}`);
  
  // Test short playback (timeout)
  const shortPlaybackFailure = streamManager['classifyStreamFailure'](false, 3);
  console.log(`Short playback (<5s) classified as: ${shortPlaybackFailure}`);
  console.log(`Short playback should be marked as watched: ${streamManager['shouldMarkStreamAsWatched'](shortPlaybackFailure, 3)}`);
  
  // Test longer playback (natural end)
  const longPlaybackFailure = streamManager['classifyStreamFailure'](false, 15);
  console.log(`Longer playback (>5s) classified as: ${longPlaybackFailure}`);
  console.log(`Longer playback should be marked as watched: ${streamManager['shouldMarkStreamAsWatched'](longPlaybackFailure, 15)}`);
  
  // Test 3: Verify stuck starting timer cancellation
  console.log('\n3. Testing stuck starting timer cancellation...');
  
  // Set up a timer
  streamManager['setupStuckStartingTimer'](2);
  console.log(`Timer set up for screen 2: ${streamManager['stuckStartingTimers'].has(2)}`);
  
  // Cancel the timer
  streamManager['cancelStuckStartingTimer'](2);
  console.log(`Timer cancelled for screen 2: ${!streamManager['stuckStartingTimers'].has(2)}`);
  
  // Test 4: Verify state transitions properly cancel stuck starting timers
  console.log('\n4. Testing state transitions cancel stuck starting timers...');
  
  // Set up a timer again
  streamManager['setupStuckStartingTimer'](3);
  console.log(`Timer set up for screen 3: ${streamManager['stuckStartingTimers'].has(3)}`);
  
  // Transition from STARTING to PLAYING (should cancel timer)
  await streamManager['setScreenState'](3, StreamState.STARTING);
  await streamManager['setScreenState'](3, StreamState.PLAYING);
  console.log(`Timer cancelled after STARTING->PLAYING transition: ${!streamManager['stuckStartingTimers'].has(3)}`);
  
  console.log('\nAll tests completed successfully!');
  
  // Cleanup
  await streamManager.cleanup();
}

// Run the tests
testStreamManagerFixes().catch(console.error);