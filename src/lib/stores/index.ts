import { writable } from 'svelte/store';
import type { Stream, StreamSource } from '../../types/stream.js';

// Active streams store
export const activeStreams = writable<Stream[]>([]);

// Queue store for each screen
export const streamQueues = writable<Map<number, StreamSource[]>>(new Map());

// Screen configuration store
export const screenConfigs = writable<Map<number, {
  enabled: boolean;
  width: number;
  height: number;
  x: number;
  y: number;
  volume: number;
  quality: string;
  windowMaximized: boolean;
}>>(new Map());

// Player settings store
export const playerSettings = writable({
  preferStreamlink: false,
  defaultQuality: 'best',
  defaultVolume: 0,
  windowMaximized: true,
  maxStreams: 2,
  autoStart: true
});

// Initialize all stores
export async function initializeStores() {
  try {
    // Fetch active streams
    const streamsResponse = await fetch('/api/streams/active');
    const streams = await streamsResponse.json();
    activeStreams.set(streams);

    // Fetch player settings
    const settingsResponse = await fetch('/api/player/settings');
    const settings = await settingsResponse.json();
    playerSettings.set(settings);

    // Set up screen configs
    const screensResponse = await fetch('/api/screens');
    const screens = await screensResponse.json();
    const screenConfigMap = new Map();
    screens.forEach((screen: any) => {
      screenConfigMap.set(screen.id, {
        enabled: screen.enabled,
        width: screen.width,
        height: screen.height,
        x: screen.x,
        y: screen.y,
        volume: screen.volume,
        quality: screen.quality,
        windowMaximized: screen.windowMaximized
      });
    });
    screenConfigs.set(screenConfigMap);

    // Set up stream queues
    const queueMap = new Map();
    for (const screen of screens) {
      const queueResponse = await fetch(`/api/streams/queue/${screen.id}`);
      const queue = await queueResponse.json();
      queueMap.set(screen.id, queue);
    }
    streamQueues.set(queueMap);

  } catch (error) {
    console.error('Failed to initialize stores:', error);
  }
}

// Subscribe to WebSocket updates
if (typeof window !== 'undefined') {
  const ws = new WebSocket(`ws://${window.location.host}/ws`);
  
  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    
    switch (data.type) {
      case 'streamUpdate':
        activeStreams.update(streams => {
          const index = streams.findIndex(s => s.screen === data.stream.screen);
          if (index !== -1) {
            streams[index] = data.stream;
          } else {
            streams.push(data.stream);
          }
          return streams;
        });
        break;
        
      case 'queueUpdate':
        streamQueues.update(queues => {
          queues.set(data.screen, data.queue);
          return queues;
        });
        break;
        
      case 'screenUpdate':
        screenConfigs.update(configs => {
          configs.set(data.screen.id, {
            enabled: data.screen.enabled,
            width: data.screen.width,
            height: data.screen.height,
            x: data.screen.x,
            y: data.screen.y,
            volume: data.screen.volume,
            quality: data.screen.quality,
            windowMaximized: data.screen.windowMaximized
          });
          return configs;
        });
        break;
    }
  };
} 