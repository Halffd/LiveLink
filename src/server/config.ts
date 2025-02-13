import type { StreamConfig, PlayerSettings } from '../types/stream.js';

export interface Config {
  player: PlayerSettings & {
    screens: StreamConfig[];
  };
}

export const defaultConfig: Config = {
  player: {
    preferStreamlink: false,
    defaultQuality: 'best',
    defaultVolume: 50,
    windowMaximized: false,
    maxStreams: 4,
    autoStart: true,
    screens: [
      {
        enabled: true,
        width: 1280,
        height: 720,
        x: 0,
        y: 0,
        volume: 50,
        quality: 'best',
        windowMaximized: false
      },
      {
        enabled: true,
        width: 1280,
        height: 720,
        x: 1280,
        y: 0,
        volume: 50,
        quality: 'best',
        windowMaximized: false
      }
    ]
  }
}; 