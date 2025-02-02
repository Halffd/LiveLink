import type { StreamSource, StreamOptions, StreamLimits, StreamSourceType } from '../types/stream.js';
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
      undefined,
      undefined,
      this.config.filters.filters
    );

    this.holodexService = new HolodexService(
      undefined,
      this.config.filters.filters,
      this.config.streams.favoriteChannels,
      this.config
    );

    this.playerService = new PlayerService();
    logger.info('Stream manager initialized', 'StreamManager');
  }

  /**
   * Starts a new stream on the specified screen
   */
  async startStream(options: Partial<StreamOptions> & { url: string }): Promise<StreamResponse> {
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

    return this.playerService.startStream({
      ...options,
      screen,
      quality: options.quality || this.config.player.defaultQuality
    });
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
   * Fetches live streams from both Holodex and Twitch based on config
   */
  async getLiveStreams(options: StreamLimits = {}): Promise<StreamSource[]> {
    try {
      const { limit = this.config.player.limits.total } = options;

      // Get enabled sources for each type
      const twitchSource = this.config.player.limits.sources.find(s => 
        s.type === ('twitch' as StreamSourceType) && s.enabled
      );
      const holodexSources = this.config.player.limits.sources.filter(s => 
        s.enabled && (s.type === 'favorites' || s.type === 'organization')
      );

      const twitchLimit = twitchSource?.limit || 0;
      const holodexLimit = holodexSources.reduce((acc, s) => acc + s.limit, 0);

      // Fetch streams from both services
      const [twitchStreams, holodexStreams] = await Promise.all([
        twitchLimit > 0 ? this.twitchService.getStreams(twitchLimit) : [],
        holodexLimit > 0 ? this.holodexService.getLiveStreams({
          limit: holodexLimit
        }) : []
      ]);

      // Sort streams by viewer count
      const sortedTwitch = [...twitchStreams].sort((a, b) => 
        (b.viewerCount || 0) - (a.viewerCount || 0)
      );
      const sortedHolodex = [...holodexStreams].sort((a, b) => 
        (b.viewerCount || 0) - (a.viewerCount || 0)
      );

      // Merge streams based on source priorities
      const sources = this.config.player.limits.sources;
      const result: StreamSource[] = [];

      for (const source of sources) {
        if (!source.enabled) continue;

        const streams = source.type === ('twitch' as StreamSourceType) 
          ? sortedTwitch 
          : sortedHolodex;
        result.push(...streams.slice(0, source.limit));

        if (result.length >= limit) break;
      }

      return result.slice(0, limit);
    } catch (error) {
      logger.error(
        'Failed to fetch live streams',
        'StreamManager',
        error instanceof Error ? error : new Error(String(error))
      );
      return [];
    }
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
      logger.info(`Auto-starting ${Math.min(streams.length, availableSlots)} streams`, 'StreamManager');
      logger.info(JSON.stringify(streams));
      for (let i = 0; i < Math.min(streams.length, availableSlots); i++) {
        const stream = streams[i];
        logger.info(`Starting stream ${stream.url} on screen ${i + 1}`);
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