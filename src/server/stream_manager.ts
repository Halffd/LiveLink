import type { StreamOptions, StreamSource } from '../types/stream.js';
import type { 
  StreamOutput, 
  StreamError, 
  StreamInstance,
  StreamResponse 
} from '../types/stream_instance.js';
import { logger } from './services/logger.js';
import { loadAllConfigs } from '../config/loader.js';
import { TwitchService } from './services/twitch.js';
import { HolodexService } from './services/holodex.js';
import { PlayerService } from './services/player.js';
import type { TwitchAuth } from './db/database.js';

/**
 * Manages multiple video streams across different screens
 */
export class StreamManager {
  private streams: Map<number, StreamInstance> = new Map();
  private config = loadAllConfigs();
  private twitchService: TwitchService;
  private holodexService: HolodexService;
  private playerService: PlayerService;

  /**
   * Creates a new StreamManager instance
   */
  constructor() {
    this.twitchService = new TwitchService(
      this.config.streams.twitch.clientId,
      this.config.streams.twitch.clientSecret,
      this.config.filters.filters
    );

    this.holodexService = new HolodexService(
      this.config.streams.holodex.apiKey,
      this.config.filters.filters,
      this.config.streams.favoriteChannels
    );

    this.playerService = new PlayerService();
    logger.info('Stream manager initialized', 'StreamManager');
  }

  /**
   * Starts a new stream on the specified screen
   */
  async startStream(options: StreamOptions): Promise<StreamResponse> {
    // Check if we've hit the stream limit
    if (this.streams.size >= this.config.player.maxStreams) {
      return {
        success: false,
        screen: options.screen || 1,
        message: `Maximum number of streams (${this.config.player.maxStreams}) reached`
      };
    }

    // Find first available screen
    let screen = options.screen;
    if (!screen) {
      for (let i = 1; i <= this.config.player.maxStreams; i++) {
        if (!this.streams.has(i)) {
          screen = i;
          break;
        }
      }
    }

    if (!screen) {
      return {
        success: false,
        screen: options.screen || 1,
        message: 'No available screens'
      };
    }

    const updatedOptions = {
      ...options,
      screen
    };

    return this.playerService.startStream(updatedOptions);
  }

  /**
   * Stops a stream on the specified screen
   */
  async stopStream(screen: number): Promise<boolean> {
    return this.playerService.stopStream(screen);
  }

  /**
   * Gets information about all active streams
   */
  getActiveStreams() {
    return this.playerService.getActiveStreams();
  }

  onStreamOutput(callback: (data: StreamOutput) => void) {
    this.playerService.onStreamOutput(callback);
  }

  onStreamError(callback: (data: StreamError) => void) {
    this.playerService.onStreamError(callback);
  }

  /**
   * Gets available organizations
   */
  getOrganizations(): string[] {
    return this.config.streams.organizations;
  }

  /**
   * Fetches live streams from both Holodex and Twitch
   */
  async getLiveStreams(options: { 
    organization?: string, 
    limit?: number 
  } = {}): Promise<StreamSource[]> {
    const [holodexStreams, twitchStreams] = await Promise.all([
      this.holodexService.getLiveStreams(options),
      this.twitchService.getStreams(options.limit)
    ]);

    return [...holodexStreams, ...twitchStreams];
  }

  /**
   * Gets VTuber streams from Twitch
   */
  async getVTuberStreams(limit = 50): Promise<StreamSource[]> {
    return this.twitchService.getVTuberStreams(limit);
  }

  /**
   * Gets Japanese language streams
   */
  async getJapaneseStreams(limit = 50): Promise<StreamSource[]> {
    return this.twitchService.getJapaneseStreams(limit);
  }

  /**
   * Sets up user authentication for Twitch
   */
  async setTwitchUserAuth(auth: TwitchAuth): Promise<void> {
    await this.twitchService.setUserAuth(auth);
  }

  /**
   * Gets streams from user's followed channels
   */
  async getFollowedStreams(userId: string): Promise<StreamSource[]> {
    return this.twitchService.getFollowedStreams(userId);
  }

  async autoStartStreams() {
    if (!this.config.player.autoStart) return;

    try {
      const streams = await this.getLiveStreams();
      const availableSlots = this.config.player.maxStreams - this.streams.size;
      
      for (let i = 0; i < Math.min(streams.length, availableSlots); i++) {
        const stream = streams[i];
        await this.startStream({
          url: stream.url,
          quality: this.config.player.defaultQuality,
          screen: i + 1,
          windowMaximized: this.config.player.windowMaximized
        });
      }
    } catch (error) {
      logger.error(
        'Failed to auto-start streams',
        'StreamManager',
        error instanceof Error ? error : new Error(String(error))
      );
    }
  }
}

// Create and export stream manager instance
export const streamManager = new StreamManager(); 