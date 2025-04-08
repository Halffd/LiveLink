import type { Stream, StreamSource, PlayerSettings, ScreenConfig } from '../types/stream.js';

class ApiClient {
  private baseUrl = '/api';
  private useCaching = true;

  // Helper method to safely parse JSON
  private async safeJsonParse(response: Response): Promise<any> {
    try {
      return await response.json();
    } catch (error) {
      console.error('JSON parsing error:', error);
      throw new Error('Invalid JSON response from server');
    }
  }

  // Helper method to make API requests with error handling and caching
  private async request<T>(
    endpoint: string, 
    options?: RequestInit, 
    useCache: boolean = true
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    
    try {
      let response: Response;
      
      // For GET requests, use caching or debouncing if enabled
      if (options?.method === undefined || options?.method === 'GET') {
        if (this.useCaching && typeof window !== 'undefined') {
          // Check if window.cachedFetch exists
          if (typeof (window as any).cachedFetch === 'function') {
            return await (window as any).cachedFetch(url, options);
          }
          // Check if window.debouncedFetch exists
          if (typeof (window as any).debouncedFetch === 'function') {
            return await (window as any).debouncedFetch(url, options);
          }
        }
        
        // Fall back to regular fetch if caching is disabled or the functions don't exist
        response = await fetch(url, options);
      } else {
        // For non-GET requests, use regular fetch
        response = await fetch(url, options);
      }
      
      if (!response.ok) {
        const errorText = await response.text();
        let errorMessage = `API error (${response.status}): `;
        
        try {
          // Try to parse error as JSON
          const errorJson = JSON.parse(errorText);
          errorMessage += errorJson.error || errorJson.message || errorText;
        } catch {
          // If not JSON, use text
          errorMessage += errorText || response.statusText;
        }
        
        throw new Error(errorMessage);
      }
      
      return await this.safeJsonParse(response);
    } catch (error) {
      console.error(`API request failed for ${endpoint}:`, error);
      throw error;
    }
  }

  // Stream Management
  async getActiveStreams(): Promise<Stream[]> {
    return this.request<Stream[]>('/streams/active');
  }

  async startStream(url: string, screen?: number, quality?: string): Promise<any> {
    return this.request<any>('/streams/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, screen, quality })
    }, false);
  }

  async stopStream(screen: number): Promise<void> {
    await this.request<void>(`/streams/${screen}`, {
      method: 'DELETE'
    }, false);
  }

  async restartStream(screen: number): Promise<void> {
    await this.request<void>('/streams/restart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ screen })
    }, false);
  }

  // Queue Management
  async getQueue(screen: number): Promise<StreamSource[]> {
    return this.request<StreamSource[]>(`/streams/queue/${screen}`);
  }

  async addToQueue(screen: number, stream: StreamSource): Promise<void> {
    await this.request<void>(`/streams/queue/${screen}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(stream)
    }, false);
  }

  async removeFromQueue(screen: number, index: number): Promise<void> {
    await this.request<void>(`/streams/queue/${screen}/${index}`, {
      method: 'DELETE'
    }, false);
  }

  async reorderQueue(screen: number, sourceIndex: number, targetIndex: number): Promise<void> {
    await this.request<void>('/streams/reorder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ screen, sourceIndex, targetIndex })
    }, false);
  }

  // Player Controls
  async sendCommand(screen: number, command: string): Promise<void> {
    await this.request<void>(`/player/command/${screen}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command })
    }, false);
  }

  async sendCommandToAll(command: string): Promise<void> {
    await this.request<void>('/player/command/all', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command })
    }, false);
  }

  async setVolume(target: number | 'all', level: number): Promise<void> {
    await this.request<void>(`/player/volume/${target}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level })
    }, false);
  }

  async togglePause(target: number | 'all'): Promise<void> {
    await this.request<void>(`/player/pause/${target}`, {
      method: 'POST'
    }, false);
  }

  async seek(target: number | 'all', seconds: number): Promise<void> {
    await this.request<void>(`/player/seek/${target}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seconds })
    }, false);
  }

  // Settings
  async getPlayerSettings(): Promise<PlayerSettings> {
    return this.request<PlayerSettings>('/player/settings');
  }

  async updatePlayerSettings(settings: Partial<PlayerSettings>): Promise<void> {
    await this.request<void>('/player/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings)
    }, false);
  }

  async getScreenConfigs(): Promise<ScreenConfig[]> {
    return this.request<ScreenConfig[]>('/screens');
  }

  async updateScreenConfig(screen: number, config: Partial<ScreenConfig>): Promise<void> {
    await this.request<void>(`/screens/${screen}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config)
    }, false);
  }

  // Watched Streams
  async getWatchedStreams(): Promise<string[]> {
    return this.request<string[]>('/streams/watched');
  }

  async markStreamAsWatched(url: string): Promise<void> {
    await this.request<void>('/streams/watched', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    }, false);
  }

  async clearWatchedStreams(): Promise<void> {
    await this.request<void>('/streams/watched', {
      method: 'DELETE'
    }, false);
  }

  // Server Control
  async stopServer(): Promise<void> {
    await this.request<void>('/server/stop', {
      method: 'POST'
    }, false);
  }

  // Get all streams
  async getAllStreams(options: { organization?: string, limit?: number } = {}): Promise<StreamSource[]> {
    const params = new URLSearchParams();
    if (options.organization) params.append('organization', options.organization);
    if (options.limit) params.append('limit', options.limit.toString());
    
    const queryString = params.toString() ? `?${params.toString()}` : '';
    return this.request<StreamSource[]>(`/streams${queryString}`);
  }

  // Get organizations
  async getOrganizations(): Promise<string[]> {
    return this.request<string[]>('/organizations');
  }

  // Auto-start streams
  async autoStartStreams(): Promise<void> {
    await this.request<void>('/streams/autostart', {
      method: 'POST'
    }, false);
  }

  // Enable/disable caching
  setCaching(enabled: boolean): void {
    this.useCaching = enabled;
  }

  async getStreamStatus(screen: number) {
    const response = await fetch(`${this.baseUrl}/streams/${screen}/status`);
    if (!response.ok) {
      throw new Error('Failed to get stream status');
    }
    return response.json();
  }
}

export const api = new ApiClient(); 