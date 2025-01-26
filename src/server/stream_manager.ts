import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { HolodexApiClient, Video } from 'holodex.js';
import { ApiClient } from '@twurple/api';
import { ClientCredentialsAuthProvider, RefreshingAuthProvider } from '@twurple/auth';
import * as fs from 'fs';
import * as path from 'path';
import { db, TwitchAuth } from './db/database';

/** Represents a running stream process */
interface Stream {
  process: ChildProcess;
  url: string;
  quality: string;
  screen: number;
  title?: string;
  platform: 'youtube' | 'twitch';
}

/** Options for starting a stream */
interface StreamOptions {
  url: string;
  quality: string;
  screen: number;
  volume?: number;
  useStreamlink?: boolean;
  windowMaximized?: boolean;
}

/** Configuration for stream platforms */
interface PlatformConfig {
  holodex: {
    apiKey: string;
    favoriteChannels: string[];
  };
  twitch: {
    clientId: string;
    clientSecret: string;
    streamersFile: string;
    tags?: string[];
    languages?: string[];
  };
  filters: string[];
  organizations: string[];
}

/** Stream source information */
interface StreamSource {
  url: string;
  title: string;
  platform: 'youtube' | 'twitch';
  viewerCount?: number;
  organization?: string;
  channelId?: string;
}

/**
 * Manages multiple video streams across different screens
 */
class StreamManager {
  private streams: Map<number, Stream>;
  private events: EventEmitter;
  private holodexClient: HolodexApiClient;
  private twitchClient: ApiClient;
  private config: PlatformConfig;
  private userAuthProvider?: RefreshingAuthProvider;

  /**
   * Creates a new StreamManager instance
   * @param config Platform configuration containing API keys and settings
   */
  constructor(config: PlatformConfig) {
    this.streams = new Map();
    this.events = new EventEmitter();
    this.config = config;
    
    // Initialize API clients
    this.holodexClient = new HolodexApiClient({ apiKey: config.holodex.apiKey });
    const authProvider = new ClientCredentialsAuthProvider(
      config.twitch.clientId,
      config.twitch.clientSecret
    );
    this.twitchClient = new ApiClient({ authProvider });
  }

  /**
   * Starts a new stream on the specified screen
   * @param options Stream configuration options
   * @returns Promise resolving to success status
   */
  async startStream(options: StreamOptions): Promise<boolean> {
    if (this.streams.has(options.screen)) {
      await this.stopStream(options.screen);
    }

    try {
      const platform = options.url.includes('twitch.tv') ? 'twitch' : 'youtube';
      const command = options.useStreamlink ? 'streamlink' : 'mpv';
      
      const args = this.buildPlayerArgs(options, command);
      const process = spawn(command, args);
      
      process.stdout.on('data', (data) => {
        this.events.emit('streamOutput', { 
          screen: options.screen, 
          data: data.toString() 
        });
      });

      process.stderr.on('data', (data) => {
        this.events.emit('streamError', { 
          screen: options.screen, 
          error: data.toString() 
        });
      });

      this.streams.set(options.screen, { 
        process, 
        url: options.url, 
        quality: options.quality, 
        screen: options.screen,
        platform 
      });
      
      return true;
    } catch (error) {
      console.error('Failed to start stream:', error);
      return false;
    }
  }

  /**
   * Builds command line arguments for the video player
   */
  private buildPlayerArgs(options: StreamOptions, player: 'mpv' | 'streamlink'): string[] {
    if (player === 'streamlink') {
      return [
        options.url,
        options.quality,
        '--player',
        'mpv',
        '--player-args',
        `--geometry=${this.getScreenGeometry(options.screen)} --volume=${options.volume || 0}${options.windowMaximized ? ' --window-maximized' : ''}`
      ];
    }

    return [
      options.url,
      `--geometry=${this.getScreenGeometry(options.screen)}`,
      `--volume=${options.volume || 0}`,
      ...(options.windowMaximized ? ['--window-maximized'] : [])
    ];
  }

  /**
   * Gets the geometry string for positioning on a specific screen
   */
  private getScreenGeometry(screen: number): string {
    // This is a simple implementation - you might want to get actual screen coordinates
    return `50%x50%+${screen * 1920}+0`;
  }

  /**
   * Stops a stream on the specified screen
   */
  async stopStream(screen: number): Promise<boolean> {
    const stream = this.streams.get(screen);
    if (stream) {
      stream.process.kill();
      this.streams.delete(screen);
      return true;
    }
    return false;
  }

  /**
   * Fetches live streams from both Holodex and Twitch
   */
  async getLiveStreams(options: { 
    organization?: string, 
    limit?: number,
    includeCustomTwitch?: boolean 
  } = {}): Promise<StreamSource[]> {
    try {
      const streams = await Promise.all([
        this.getFavoriteStreams(),
        options.organization ? 
          this.getHolodexStreams({ organization: options.organization, limit: options.limit }) :
          Promise.resolve([]),
        options.includeCustomTwitch ?
          this.getCustomTwitchStreams() :
          this.getTwitchStreams(options.limit)
      ]);

      return streams
        .flat()
        .filter((stream, index, self) => 
          index === self.findIndex(s => s.url === stream.url)
        )
        .sort((a, b) => (b.viewerCount || 0) - (a.viewerCount || 0))
        .slice(0, options.limit || 50);
    } catch (error) {
      console.error('Failed to fetch live streams:', error);
      return [];
    }
  }

  /**
   * Fetches streams from favorite Holodex channels
   */
  private async getFavoriteStreams(): Promise<StreamSource[]> {
    const streams = await Promise.all(
      this.config.holodex.favoriteChannels.map(channelId =>
        this.holodexClient.getLiveVideos({ 
          channel_id: channelId,
          status: 'live'
        })
      )
    );

    return streams
      .flat()
      .filter(video => !this.isChannelFiltered(video))
      .map(video => ({
        url: `https://youtube.com/watch?v=${video.id}`,
        title: video.title,
        platform: 'youtube' as const,
        viewerCount: video.live_viewers,
        channelId: video.channel.id,
        organization: video.channel.org
      }));
  }

  /**
   * Fetches custom Twitch streamers from file
   */
  private async getCustomTwitchStreams(): Promise<StreamSource[]> {
    try {
      const fileContent = await fs.promises.readFile(
        this.config.twitch.streamersFile,
        'utf-8'
      );
      const streamers = fileContent.split('\n').filter(Boolean);
      
      const streams = await Promise.all(
        streamers.map(username =>
          this.twitchClient.streams.getStreamByUserName(username)
        )
      );

      return streams
        .filter((stream): stream is NonNullable<typeof stream> => 
          stream !== null && !this.config.filters.includes(stream.userName.toLowerCase())
        )
        .map(stream => ({
          url: `https://twitch.tv/${stream.userName}`,
          title: stream.title,
          platform: 'twitch' as const,
          viewerCount: stream.viewers
        }));
    } catch (error) {
      console.error('Failed to read custom Twitch streamers:', error);
      return [];
    }
  }

  /**
   * Fetches live streams from Holodex
   */
  private async getHolodexStreams(options: { 
    organization?: string, 
    limit?: number 
  }): Promise<StreamSource[]> {
    const videos = await this.holodexClient.getLiveVideos({
      org: options.organization,
      sort: 'live_viewers',
      order: 'desc',
      status: 'live',
      limit: options.limit || 50
    });

    return videos
      .filter(video => !this.isChannelFiltered(video))
      .map(video => ({
        url: `https://youtube.com/watch?v=${video.id}`,
        title: video.title,
        platform: 'youtube' as const,
        viewerCount: video.live_viewers
      }));
  }

  /**
   * Fetches live streams from Twitch
   */
  private async getTwitchStreams(limit = 50): Promise<StreamSource[]> {
    const streams = await this.twitchClient.streams.getStreams({ limit });
    
    return streams.data
      .filter(stream => !this.config.filters.includes(stream.userName.toLowerCase()))
      .map(stream => ({
        url: `https://twitch.tv/${stream.userName}`,
        title: stream.title,
        platform: 'twitch' as const,
        viewerCount: stream.viewers
      }));
  }

  private isChannelFiltered(video: Video): boolean {
    const channelName = video?.channel?.name?.toLowerCase();
    const channelId = video?.channel?.id;
    
    // Don't filter favorite channels
    if (this.config.holodex.favoriteChannels.includes(channelId)) {
      return false;
    }
    
    return this.config.filters.some(filter => 
      channelName?.includes(filter.toLowerCase())
    );
  }

  /**
   * Gets information about all active streams
   */
  getActiveStreams() {
    return Array.from(this.streams.entries()).map(([screen, stream]) => ({
      screen,
      url: stream.url,
      quality: stream.quality,
      title: stream.title,
      platform: stream.platform
    }));
  }

  onStreamOutput(callback: (data: { screen: number, data: string }) => void) {
    this.events.on('streamOutput', callback);
  }

  onStreamError(callback: (data: { screen: number, error: string }) => void) {
    this.events.on('streamError', callback);
  }

  /**
   * Gets available organizations
   */
  getOrganizations(): string[] {
    return this.config.organizations;
  }

  /**
   * Sets up user authentication for Twitch
   */
  async setTwitchUserAuth(auth: TwitchAuth): Promise<void> {
    this.userAuthProvider = new RefreshingAuthProvider(
      {
        clientId: this.config.twitch.clientId,
        clientSecret: this.config.twitch.clientSecret,
        onRefresh: async (userId, newTokenData) => {
          await db.saveTwitchAuth({
            userId,
            accessToken: newTokenData.accessToken,
            refreshToken: newTokenData.refreshToken,
            expiresAt: newTokenData.expiresIn * 1000 + Date.now()
          });
        }
      }
    );

    await this.userAuthProvider.addUserForToken({
      accessToken: auth.accessToken,
      refreshToken: auth.refreshToken,
      expiresIn: Math.floor((auth.expiresAt - Date.now()) / 1000),
      obtainmentTimestamp: Date.now()
    }, ['user:read:follows']);
  }

  /**
   * Gets streams from user's followed channels
   */
  async getFollowedStreams(userId: string): Promise<StreamSource[]> {
    if (!this.userAuthProvider) {
      throw new Error('User not authenticated');
    }

    const userClient = new ApiClient({ authProvider: this.userAuthProvider });
    const follows = await userClient.users.getFollowedChannels(userId);
    const channelIds = follows.data.map(follow => follow.broadcasterId);
    
    const streams = await this.twitchClient.streams.getStreamsByUserIds(channelIds);
    
    return streams.data
      .filter(stream => !this.config.filters.includes(stream.userName.toLowerCase()))
      .map(stream => ({
        url: `https://twitch.tv/${stream.userName}`,
        title: stream.title,
        platform: 'twitch' as const,
        viewerCount: stream.viewers
      }));
  }

  /**
   * Gets VTuber streams from Twitch
   */
  async getVTuberStreams(limit = 50): Promise<StreamSource[]> {
    const streams = await this.twitchClient.streams.getStreams({
      limit,
      tags: ['VTuber']
    });

    return streams.data
      .filter(stream => !this.config.filters.includes(stream.userName.toLowerCase()))
      .map(stream => ({
        url: `https://twitch.tv/${stream.userName}`,
        title: stream.title,
        platform: 'twitch' as const,
        viewerCount: stream.viewers
      }));
  }

  /**
   * Gets Japanese language streams
   */
  async getJapaneseStreams(limit = 50): Promise<StreamSource[]> {
    const streams = await this.twitchClient.streams.getStreams({
      limit,
      language: 'ja'
    });

    return streams.data
      .filter(stream => !this.config.filters.includes(stream.userName.toLowerCase()))
      .map(stream => ({
        url: `https://twitch.tv/${stream.userName}`,
        title: stream.title,
        platform: 'twitch' as const,
        viewerCount: stream.viewers
      }));
  }
}

// Create and export stream manager instance
const config: PlatformConfig = {
  holodex: {
    apiKey: process.env.HOLODEX_API_KEY || '',
    favoriteChannels: [
      'UC54JqsuIbMw_d1Ieb4hjKoQ',
      'UCIfAvpeIWGHb0duCkMkmm2Q',
      'UC6T7TJZbW6nO-qsc5coo8Pg',
      // Add more favorite channel IDs here
    ]
  },
  twitch: {
    clientId: process.env.TWITCH_CLIENT_ID || '',
    clientSecret: process.env.TWITCH_CLIENT_SECRET || '',
    streamersFile: path.resolve('../build/streams.txt')
  },
  filters: [
    "HanasakiMiyabi",
    "KanadeIzuru",
    // ... other filters
  ],
  organizations: [
    'Hololive',
    'Nijisanji',
    'Phase Connect',
    'VShojo',
    'Indie'
  ]
};

export const streamManager = new StreamManager(config); 