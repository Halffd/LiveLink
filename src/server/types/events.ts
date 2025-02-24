import { EventEmitter } from 'events';

declare global {
  interface ProcessEventTypes {
    'keyboard:autostart': (screen: number) => void;
    'keyboard:closeall': () => void;
  }
}

declare module 'events' {
  export interface Process {
    on<K extends keyof ProcessEventTypes>(event: K, listener: ProcessEventTypes[K]): this;
    emit<K extends keyof ProcessEventTypes>(
      event: K,
      ...args: Parameters<ProcessEventTypes[K]>
    ): boolean;
  }
}

export {}; 