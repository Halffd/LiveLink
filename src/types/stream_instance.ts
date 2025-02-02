import type { ChildProcess } from 'child_process';

/** Platform type for streams */
export type StreamPlatform = 'youtube' | 'twitch';

/** Represents a running stream process */
export interface StreamInstance {
  id: number;
  screen: number;
  url: string;
  quality: string;
  process?: any; // Replace with proper process type if needed
  /** Stream title (if available) */
  title?: string;
  /** Platform the stream is from */
  platform: StreamPlatform;
}

/** Stream process output data */
export interface StreamOutput {
  screen: number;
  data: string;
}

/** Stream process error data */
export interface StreamError {
  screen: number;
  error: string;
}

export interface StreamResponse {
  success: boolean;
  screen: number;
  message?: string;
} 