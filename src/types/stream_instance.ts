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
  /** URL of the stream that caused the error (if available) */
  url?: string;
  /** Whether to move to the next stream in queue (true) or retry same stream (false) */
  moveToNext?: boolean;
  /** Whether the stream crashed and should be restarted (true) or ended normally (false) */
  shouldRestart?: boolean;
}

export interface StreamEnd {
  screen: number;
  code?: number;
}

export interface StreamResponse {
  /** Screen number the operation was performed on */
  screen: number;
  /** Success or error message */
  message?: string;
  /** Whether the operation was successful */
  success: boolean;
  /** Error details if operation failed */
  error?: string;
} 