import { EventEmitter } from 'events';
import { PlayerService } from '../services/player.js';
import { logger } from '../services/logger/index.js';
import { loadAllConfigs } from '../../config/loader.js';
import type { Config } from '../../types/config.js';

export class StreamManager extends EventEmitter {
	private streams: Array<{ screen: number; status: string }> = [];
	private config: any; // Using any temporarily for the config
	private playerService: PlayerService;
	private screenStatus: Map<number, { disabled: boolean }> = new Map();

	constructor(config: any, playerService: PlayerService) {
		super();
		this.config = config;
		this.playerService = playerService;
		
		// Initialize screen status
		this.initializeScreenStatus();
	}

	private async initializeScreenStatus(): Promise<void> {
		const config = await loadAllConfigs();
		if (config.screens) {
			Object.entries(config.screens).forEach(([screenStr, screenConfig]: [string, any]) => {
				const screen = parseInt(screenStr, 10);
				this.screenStatus.set(screen, { disabled: !!screenConfig.disabled });
			});
		}
	}

	async stopStream(screen: number, force?: boolean): Promise<boolean> {
		// This is a placeholder - in a real implementation, this would stop a stream
		return this.playerService.stopStream(screen, force);
	}
	
	/**
	 * Disables a screen in the configuration and stops any running streams on it
	 * @param screen The screen number to disable
	 */
	async disableScreen(screen: number): Promise<{ success: boolean }> {
		try {
			logger.debug(`[StreamManager] Disabling screen ${screen}`, 'StreamManager');
			
			// First stop any streams running on this screen
			const activeStream = this.streams.find(
				(stream) => stream.screen === screen && stream.status === 'active'
			);
			
			if (activeStream) {
				logger.debug(`[StreamManager] Stopping active stream on screen ${screen} before disabling`, 'StreamManager');
				try {
					// Use a timeout to ensure the stream is stopped
					const stopPromise = this.stopStream(screen);
					await Promise.race([
						stopPromise,
						new Promise((_, reject) => setTimeout(() => reject(new Error('Stop stream timeout')), 5000))
					]);
				} catch (error) {
					logger.error(`[StreamManager] Error stopping stream on screen ${screen}:`, 'StreamManager', error);
					// Continue with disabling even if stopping fails
				}
			}
			
			// Update the config to disable the screen
			const config = await loadAllConfigs();
			if (!config.screens) {
				config.screens = {};
			}
			
			if (!config.screens[screen]) {
				config.screens[screen] = {};
			}
			
			config.screens[screen].disabled = true;
			await this.config.saveConfig({ screens: config.screens });
			
			// Immediately update internal state
			this.screenStatus.set(screen, { disabled: true });
			
			// Remove stream from memory if it's still there
			this.streams = this.streams.filter((s) => !(s.screen === screen && s.status === 'active'));
			
			logger.debug(`[StreamManager] Screen ${screen} disabled successfully`, 'StreamManager');
			return { success: true };
		} catch (error) {
			logger.error(`[StreamManager] Failed to disable screen ${screen}`, 'StreamManager', error);
			return { success: false };
		}
	}

	/**
	 * Enables a previously disabled screen
	 * @param screen The screen number to enable
	 */
	async enableScreen(screen: number): Promise<{ success: boolean }> {
		try {
			logger.debug(`[StreamManager] Enabling screen ${screen}`, 'StreamManager');
			
			// Update the config to enable the screen
			const config = await loadAllConfigs();
			if (!config.screens) {
				config.screens = {};
			}
			
			if (!config.screens[screen]) {
				config.screens[screen] = {};
			}
			
			config.screens[screen].disabled = false;
			await this.config.saveConfig({ screens: config.screens });
			
			// Update internal state
			this.screenStatus.set(screen, { disabled: false });
			
			logger.debug(`[StreamManager] Screen ${screen} enabled successfully`, 'StreamManager');
			return { success: true };
		} catch (error) {
			logger.error(`[StreamManager] Failed to enable screen ${screen}`, 'StreamManager', error);
			return { success: false };
		}
	}

	/**
	 * Initialize the server
	 */
	async initServer(): Promise<void> {
		logger.debug('[StreamManager] Initializing server', 'StreamManager');
		
		// Load screen configuration from config
		try {
			const config = await loadAllConfigs();
			
			// Initialize screen status from config
			if (config.screens) {
				logger.debug('[StreamManager] Loading screen status from config', 'StreamManager');
				
				// Initialize screen status for all configured screens
				Object.entries(config.screens).forEach(([screenStr, screenConfig]: [string, any]) => {
					const screen = parseInt(screenStr, 10);
					
					// If the screen is disabled in config, update both StreamManager and PlayerService
					if (screenConfig.disabled) {
						logger.debug(`[StreamManager] Screen ${screen} marked as disabled from config`, 'StreamManager');
						this.screenStatus.set(screen, { disabled: true });
						this.playerService.disableScreen(screen);
					} else {
						logger.debug(`[StreamManager] Screen ${screen} marked as enabled from config`, 'StreamManager');
						this.screenStatus.set(screen, { disabled: false });
						this.playerService.enableScreen(screen);
					}
				});
			}
			
			// Ensure we have proper synchronization between StreamManager and PlayerService
			this.syncScreenStates();
			
			// Initialize the server and start players as needed
			await this.initStreams();
		} catch (error) {
			logger.error('[StreamManager] Error initializing server', 'StreamManager', error);
		}
	}
	
	private async initStreams(): Promise<void> {
		// This is a placeholder - in a real implementation, this would initialize streams
		logger.debug('[StreamManager] Initializing streams', 'StreamManager');
	}
	
	/**
	 * Ensure StreamManager and PlayerService screen states are in sync
	 */
	private syncScreenStates(): void {
		// Make sure our screen status map is in sync with the player service
		for (const [screen, status] of this.screenStatus.entries()) {
			if (status.disabled) {
				this.playerService.disableScreen(screen);
			} else {
				this.playerService.enableScreen(screen);
			}
		}
	}
	
	/**
	 * Clean up resources before shutdown
	 */
	async cleanup(): Promise<void> {
		logger.debug('[StreamManager] Cleaning up before shutdown', 'StreamManager');
		
		// Stop all streams
		const stopPromises = this.streams
			.filter(stream => stream.status === 'active')
			.map(stream => this.stopStream(stream.screen, true));
			
		await Promise.allSettled(stopPromises);
		
		// Let player service clean up its resources
		await this.playerService.cleanup();
	}
} 