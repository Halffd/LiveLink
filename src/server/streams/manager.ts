	/**
	 * Disables a screen in the configuration and stops any running streams on it
	 * @param screen The screen number to disable
	 */
	async disableScreen(screen: number): Promise<{ success: boolean }> {
		try {
			logger.debug(`[StreamManager] Disabling screen ${screen}`);
			
			// First stop any streams running on this screen
			const activeStream = this.streams.find(
				(stream) => stream.screen === screen && stream.status === 'active'
			);
			
			if (activeStream) {
				logger.debug(`[StreamManager] Stopping active stream on screen ${screen} before disabling`);
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
			
			logger.debug(`[StreamManager] Screen ${screen} disabled successfully`);
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
			logger.debug(`[StreamManager] Enabling screen ${screen}`);
			
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
			
			logger.debug(`[StreamManager] Screen ${screen} enabled successfully`);
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
		logger.debug('[StreamManager] Initializing server');
		
		// Load screen configuration from config
		try {
			const config = await loadAllConfigs();
			
			// Initialize screen status from config
			if (config.screens) {
				logger.debug('[StreamManager] Loading screen status from config');
				
				// Initialize screen status for all configured screens
				Object.entries(config.screens).forEach(([screenStr, screenConfig]) => {
					const screen = parseInt(screenStr, 10);
					
					// If the screen is disabled in config, update both StreamManager and PlayerService
					if (screenConfig.disabled) {
						logger.debug(`[StreamManager] Screen ${screen} marked as disabled from config`);
						this.screenStatus.set(screen, { disabled: true });
						this.playerService.disableScreen(screen);
					} else {
						logger.debug(`[StreamManager] Screen ${screen} marked as enabled from config`);
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