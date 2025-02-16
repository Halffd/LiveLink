import type { Stream } from './stream.js';
import type { ChildProcess } from 'child_process';

/** Platform type for streams */
export type StreamPlatform = 'youtube' | 'twitch';

/** Represents a running stream process */
export interface StreamInstance {
  id: number;
  screen: number;
  url: string;
  quality: string;
  status: 'playing' | 'paused' | 'stopped' | 'error';
  volume: number;
  process: ChildProcess | null;
  /** Stream title (if available) */
  title?: string;
  /** Platform the stream is from */
  platform: StreamPlatform;
  progress?: number;
  watched?: boolean;
  playlist?: StreamInstance[];
  error?: string;
  startTime?: number;
  duration?: number;
}

/** Stream process output data */
export interface StreamOutput {
  screen: number;
  data: string;
  type: 'stdout' | 'stderr';
}

/** Stream process error data */
export interface StreamError {
  screen: number;
  error: string;
  code?: number;
}

export interface StreamResponse {
  screen: number;
  message?: string;
  error?: string;
} 