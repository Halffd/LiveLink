import { EventEmitter } from 'events';
import type { Stream, StreamSource, StreamConfig, PlayerSettings } from '../types/stream.js';
import type { Config } from './config.js';
import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs/promises';
import path from 'path';

interface StreamInstance {
  screen: number;
  url: string;
  status: 'playing' | 'paused' | 'stopped' | 'error';
  quality: string;
  volume: number;
  error?: string;
  startTime?: number;
  duration?: number;
  process: ChildProcess | null;
  platform: 'youtube' | 'twitch';
}

export class StreamManager extends EventEmitter {
  private activeStreams: Map<number, StreamInstance> = new Map();
  private queues: Map<number, StreamSource[]> = new Map();
  private processes: Map<number, ChildProcess> = new Map();

  constructor(private config: Config) {
    super();
    this.initializeQueues();
  }

  private initializeQueues() {
    this.config.player.screens.forEach(screen => {
      this.queues.set(screen.id || 0, []);
    });
  }

  // Stream Management
  async startStream(options: { screen: number; url: string; quality?: string }) {
    try {
      // Check if URL is already playing on any screen
      const existingStream = Array.from(this.activeStreams.values())
        .find(stream => stream.url === options.url);
      
      if (existingStream) {
        throw new Error(`URL is already playing on screen ${existingStream.screen}`);
      }

      const screenConfig = this.config.player.screens.find(s => s.id === options.screen);
      if (!screenConfig || !screenConfig.enabled) {
        throw new Error('Screen not available');
      }

      // Stop existing stream if any
      await this.stopStream(options.screen);

      // Create stream object
      const stream: StreamInstance = {
        screen: options.screen,
        url: options.url,
        status: 'playing',
        quality: options.quality || screenConfig.quality || this.config.player.defaultQuality,
        volume: screenConfig.volume || this.config.player.defaultVolume,
        process: null as any,
        platform: this.detectPlatform(options.url)
      };

      // Start MPV process
      const process = spawn('mpv', [
        options.url,
        '--no-terminal',
        `--volume=${stream.volume}`,
        `--geometry=${screenConfig.width}x${screenConfig.height}+${screenConfig.x}+${screenConfig.y}`,
        screenConfig.windowMaximized ? '--fullscreen' : '--no-fullscreen',
        '--force-window=yes',
        '--keep-open=yes',
        '--input-ipc-server=/tmp/mpvsocket' + options.screen
      ]);

      stream.process = process;

      process.on('error', (error: Error) => {
        stream.status = 'error';
        stream.error = error.message;
        this.emit('streamUpdate', stream);
        this.emit('error', error);
      });

      process.on('exit', (code: number) => {
        if (code !== 0) {
          stream.status = 'error';
          stream.error = `Process exited with code ${code}`;
          this.emit('streamUpdate', stream);
        }
        this.processes.delete(options.screen);
        this.activeStreams.delete(options.screen);
      });

      this.processes.set(options.screen, process);
      this.activeStreams.set(options.screen, stream);
      this.emit('streamUpdate', stream);

    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }

  private detectPlatform(url: string): 'youtube' | 'twitch' {
    if (url.includes('youtube.com') || url.includes('youtu.be')) {
      return 'youtube';
    }
    return 'twitch';
  }

  async stopStream(screen: number) {
    const process = this.processes.get(screen);
    if (process) {
      process.kill();
      this.processes.delete(screen);
      this.activeStreams.delete(screen);
      this.emit('streamUpdate', {
        screen,
        url: '',
        quality: '',
        platform: 'twitch',  // Default platform
        playerStatus: 'stopped',
        volume: 0,
        process: null
      } as Stream);
    }
  }

  // Queue Management
  getQueueForScreen(screen: number): StreamSource[] {
    return this.queues.get(screen) || [];
  }

  getAllQueues(): Map<number, StreamSource[]> {
    return this.queues;
  }

  async addToQueue(screen: number, source: StreamSource) {
    const queue = this.queues.get(screen) || [];
    queue.push(source);
    this.queues.set(screen, queue);
    this.emit('queueUpdate', screen, queue);
  }

  async removeFromQueue(screen: number, index: number) {
    const queue = this.queues.get(screen) || [];
    if (index >= 0 && index < queue.length) {
      queue.splice(index, 1);
      this.queues.set(screen, queue);
      this.emit('queueUpdate', screen, queue);
    }
  }

  async reorderQueue(screen: number, sourceIndex: number, targetIndex: number) {
    const queue = this.queues.get(screen) || [];
    if (sourceIndex >= 0 && sourceIndex < queue.length && targetIndex >= 0 && targetIndex < queue.length) {
      const [item] = queue.splice(sourceIndex, 1);
      queue.splice(targetIndex, 0, item);
      this.queues.set(screen, queue);
      this.emit('queueUpdate', screen, queue);
    }
  }

  // Player Control
  sendCommandToScreen(screen: number, command: string) {
    const process = this.processes.get(screen);
    if (process?.stdin) {
      process.stdin.write(command + '\n');
    }
  }

  sendCommandToAll(command: string) {
    this.processes.forEach(process => {
      if (process?.stdin) {
        process.stdin.write(command + '\n');
      }
    });
  }

  // Getters
  getActiveStreams(): StreamInstance[] {
    return Array.from(this.activeStreams.values());
  }

  getScreenConfigs(): StreamConfig[] {
    return this.config.player.screens;
  }

  // Settings Management
  updatePlayerSettings(settings: Partial<PlayerSettings>) {
    Object.assign(this.config.player, settings);
    this.emit('settingsUpdate', this.config.player);
  }

  updateScreenConfig(screen: number, config: Partial<StreamConfig>) {
    const screenConfig = this.config.player.screens.find(s => s.id === screen);
    if (screenConfig) {
      Object.assign(screenConfig, config);
      this.emit('screenUpdate', screen, screenConfig);
    }
  }

  async saveConfig() {
    try {
      // Save streams configuration
      const streamsConfig = {
        streams: this.config.streams,
        organizations: this.config.organizations,
        favoriteChannels: this.config.favoriteChannels,
        holodex: this.config.holodex,
        twitch: this.config.twitch
      };

      await fs.writeFile(
        path.join(process.cwd(), 'config', 'streams.json'),
        JSON.stringify(streamsConfig, null, 2)
      );

      // Save player configuration
      const playerConfig = {
        preferStreamlink: this.config.player.preferStreamlink,
        defaultQuality: this.config.player.defaultQuality,
        defaultVolume: this.config.player.defaultVolume,
        windowMaximized: this.config.player.windowMaximized,
        maxStreams: this.config.player.maxStreams,
        autoStart: this.config.player.autoStart,
        screens: this.config.player.screens
      };

      await fs.writeFile(
        path.join(process.cwd(), 'config', 'player.json'),
        JSON.stringify(playerConfig, null, 2)
      );

      this.emit('configUpdate', this.config);
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }

  getScreenInfo(screen: number) {
    const screenConfig = this.config.player.screens.find(s => s.id === screen);
    if (!screenConfig) {
      throw new Error(`Screen ${screen} not found`);
    }

    const activeStream = this.activeStreams.get(screen);
    const queue = this.queues.get(screen) || [];

    return {
      config: screenConfig,
      currentStream: activeStream || null,
      queue,
      enabled: screenConfig.enabled,
      status: activeStream?.status || 'stopped'
    };
  }
} 