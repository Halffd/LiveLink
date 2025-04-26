import type {
	StreamSource,
	StreamOptions,
	PlayerSettings,
	Config,
	FavoriteChannels,
	StreamResponse,
	ScreenConfig
} from '../types/stream.js';
import type {
	StreamOutput,
	StreamError,
	StreamInstance,
	StreamPlatform,
	StreamEnd
} from '../types/stream_instance.js';
import { logger } from './services/logger.js';
import { loadAllConfigs } from '../config/loader.js';
import { TwitchService } from './services/twitch.js';
import { HolodexService } from './services/holodex.js';
import { YouTubeService } from './services/youtube.js';
import { PlayerService } from './services/player.js';
import type { TwitchAuth } from './db/database.js';
import { env } from '../config/env.js';
import { queueService } from './services/queue_service.js';
import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import { KeyboardService } from './services/keyboard_service.js';
import './types/events.js';
import * as dns from 'dns';
import { safeAsync, parallelOps, withTimeout, withRetry } from './utils/async_helpers.js';

// Improve the StreamState enum with proper state machine transitions
enum StreamState {
	IDLE = 'idle',           // No stream running
	STARTING = 'starting',   // Stream is being started
	PLAYING = 'playing',     // Stream is running
	STOPPING = 'stopping',   // Stream is being stopped
	DISABLED = 'disabled',   // Screen is disabled
	ERROR = 'error',         // Error state
	NETWORK_RECOVERY = 'network_recovery' // Recovering from network issues
}

// Add stream state machine to handle transitions
class StreamStateMachine {
	private currentState: StreamState = StreamState.IDLE;
	private screen: number;

	constructor(screen: number, initialState: StreamState = StreamState.IDLE) {
		this.screen = screen;
		this.currentState = initialState;
	}

	getState(): StreamState {
		return this.currentState;
	}

	// Validate and perform state transition
	async transition(newState: StreamState, callback?: () => Promise<void>): Promise<boolean> {
		const validTransitions: Record<StreamState, StreamState[]> = {
			[StreamState.IDLE]: [StreamState.STARTING, StreamState.DISABLED, StreamState.NETWORK_RECOVERY],
			[StreamState.STARTING]: [StreamState.PLAYING, StreamState.ERROR, StreamState.STOPPING],
			[StreamState.PLAYING]: [StreamState.STOPPING, StreamState.ERROR, StreamState.NETWORK_RECOVERY],
			[StreamState.STOPPING]: [StreamState.IDLE, StreamState.ERROR],
			[StreamState.DISABLED]: [StreamState.IDLE],
			[StreamState.ERROR]: [StreamState.IDLE, StreamState.STARTING, StreamState.NETWORK_RECOVERY],
			[StreamState.NETWORK_RECOVERY]: [StreamState.IDLE, StreamState.STARTING, StreamState.ERROR]
		};

		if (!validTransitions[this.currentState].includes(newState)) {
			logger.warn(
				`Invalid state transition for screen ${this.screen}: ${this.currentState} -> ${newState}`,
				'StreamManager'
			);
			return false;
		}

		logger.info(`Screen ${this.screen} state transition: ${this.currentState} -> ${newState}`, 'StreamManager');

		// Execute callback if provided (for any setup/teardown during transition)
		if (callback) {
			await callback();
		}

		// Update the state
		this.currentState = newState;
		return true;
	}
}

// Add a simple mutex implementation
class SimpleMutex {
	private locked = false;
	private waitQueue: Array<() => void> = [];

	async acquire(): Promise<() => void> {
		if (!this.locked) {
			this.locked = true;
			return () => this.release();
		}

		return new Promise<() => void>(resolve => {
			this.waitQueue.push(() => {
				this.locked = true;
				resolve(() => this.release());
			});
		});
	}

	private release(): void {
		if (this.waitQueue.length > 0) {
			const next = this.waitQueue.shift();
			if (next) next();
		} else {
			this.locked = false;
		}
	}
}

/**
 * Manages multiple video streams across different screens
 */
export class StreamManager extends EventEmitter {
	// Core dependencies
	private config: Config;
	private twitchService: TwitchService;
	private holodexService: HolodexService;
	private youtubeService: YouTubeService;
	private playerService: PlayerService;
	private keyboardService: KeyboardService;
	private isShuttingDown = false;

	// Active streams and their states
	private streams: Map<number, StreamInstance> = new Map();
	private screenStates: Map<number, StreamState> = new Map();
	private screenMutexes: Map<number, SimpleMutex> = new Map();

	// User preferences
	private favoriteChannels: FavoriteChannels;
	private manuallyClosedScreens: Set<number> = new Set();
	private screenConfigs: Map<number, ScreenConfig> = new Map();

	// Simplified queues management
	private queues: Map<number, StreamSource[]> = new Map();

	// Network state
	private isOffline = false;
	private cleanupHandler: (() => void) | null = null;

	// Path storage
	private fifoPaths: Map<number, string> = new Map();
	private ipcPaths: Map<number, string> = new Map();

	// Store timers more directly for easier cleanup
	// private queueProcessingTimers: Map<number, NodeJS.Timeout> = new Map();
	// private streamRefreshTimers: Map<number, NodeJS.Timeout> = new Map();
	// private inactiveTimers: Map<number, NodeJS.Timeout> = new Map();
	// private globalUpdateInterval: NodeJS.Timeout | null = null;

	// Cache
	private cachedStreams: StreamSource[] = [];
	private lastStreamFetch: number = 0;
	private lastStreamRefresh: Map<number, number> = new Map();

	// Constants - keep these for configuration
	private readonly QUEUE_UPDATE_INTERVAL = 60 * 1000; // 1 minute
	private readonly STREAM_START_TIMEOUT = 10 * 1000; // 10 seconds
	private readonly STREAM_REFRESH_INTERVAL = 60 * 1000; // 1 minute
	private readonly RETRY_INTERVAL = 1000; // 1 second
	private readonly STREAM_CACHE_TTL = 30000; // 30 seconds

	// Event handling
	private errorCallback?: (data: StreamError) => void;

	// Replace screenStates Map with stateMachines Map
	private stateMachines: Map<number, StreamStateMachine> = new Map();

	// Simplified, single interval for queue management
	private queueUpdateInterval: NodeJS.Timeout | null = null;

	// Compatibility properties for backward compatibility
	private streamRefreshTimers: Map<number, NodeJS.Timeout> = new Map();

	// Track streams that failed to start to avoid infinite retry loops
	private failedStreamAttempts: Map<string, { timestamp: number, count: number }> = new Map();
	private readonly MAX_STREAM_ATTEMPTS = 2;
	private readonly STREAM_FAILURE_RESET_TIME = 3600000; // 1 hour in ms

	// Add a map to track when screens entered the STARTING state
	private screenStartingTimestamps: Map<number, number> = new Map();
	private readonly MAX_STARTING_TIME = 30000; // 30 seconds max in starting state

	constructor(
		config: Config,
		holodexService: HolodexService,
		twitchService: TwitchService,
		youtubeService: YouTubeService,
		playerService: PlayerService
	) {
		super();
		this.config = config;
		this.holodexService = holodexService;
		this.twitchService = twitchService;
		this.youtubeService = youtubeService;
		this.playerService = playerService;
		this.keyboardService = new KeyboardService();
		this.favoriteChannels = config.favoriteChannels;

		// Initialize screen configs
		this.initializeScreenConfigs();

		// Setup network recovery
		this.setupNetworkRecovery();

		// Initialize event listeners
		this.setupEventListeners();

		// Initialize state machines for each screen
		this.initializeStateMachines();

		// Start queue updates
		this.startQueueUpdates();

		logger.info('StreamManager initialized', 'StreamManager');
	}

	// Initialize state machines for all screens
	private initializeStateMachines(): void {
		this.config.streams.forEach(streamConfig => {
			const screen = streamConfig.screen;
			const initialState = streamConfig.enabled ? StreamState.IDLE : StreamState.DISABLED;
			this.stateMachines.set(screen, new StreamStateMachine(screen, initialState));
		});
		logger.info('Stream state machines initialized', 'StreamManager');
	}

	// Rename the first cleanup method to cleanupTimers
	private cleanupTimers(): void {
		// Stop queue updates
		if (this.queueUpdateInterval) {
			clearInterval(this.queueUpdateInterval);
			this.queueUpdateInterval = null;
		}

		// No need to clear multiple timers for each screen
		logger.info('Stream manager timers cleaned up', 'StreamManager');
	}

	// Simplified startQueueUpdates method using one central interval
	private async startQueueUpdates() {
		if (this.queueUpdateInterval !== null) {
			return; // Already running
		}

		// First run immediately
		await this.updateAllQueues();

		// Set up interval for periodic updates
		this.queueUpdateInterval = setInterval(async () => {
			await this.updateAllQueues();
		}, this.QUEUE_UPDATE_INTERVAL);

		logger.info(`Queue updates started with ${this.QUEUE_UPDATE_INTERVAL / 60000} minute interval`, 'StreamManager');
	}

	private stopQueueUpdates() {
		if (this.queueUpdateInterval !== null) {
			clearInterval(this.queueUpdateInterval);
			this.queueUpdateInterval = null;
			logger.info('Queue updates stopped', 'StreamManager');
		}
	}

	// Simplified method to update all queues
	public async updateAllQueues() {
		if (this.isShuttingDown) {
			return;
		}

		logger.info('Updating stream queues...', 'StreamManager');

		// Get all enabled screens
		const enabledScreens = this.config.streams
			.filter(stream => stream.enabled)
			.map(stream => stream.screen);

		// Check for stuck screens in STARTING state
		const now = Date.now();
		for (const screen of enabledScreens) {
			const currentState = this.getScreenState(screen);

			if (currentState === StreamState.STARTING) {
				// Record when the screen first entered STARTING state if not already tracked
				if (!this.screenStartingTimestamps.has(screen)) {
					this.screenStartingTimestamps.set(screen, now);
				}

				const startTime = this.screenStartingTimestamps.get(screen)!;
				const timeInStarting = now - startTime;

				if (timeInStarting > this.MAX_STARTING_TIME) {
					// This screen has been stuck in STARTING state for too long - force reset it
					logger.warn(`Screen ${screen} has been stuck in STARTING state for ${Math.floor(timeInStarting / 1000)}s, forcing reset`, 'StreamManager');

					try {
						// Force stop any stream that might be in process
						await this.playerService.stopStream(screen, true);

						// Reset the state to IDLE
						await this.setScreenState(screen, StreamState.IDLE);

						// Clear the timestamp
						this.screenStartingTimestamps.delete(screen);
					} catch (error) {
						logger.error(
							`Error resetting stuck STARTING state for screen ${screen}`,
							'StreamManager',
							error instanceof Error ? error : new Error(String(error))
						);
					}
				}
			} else {
				// If not in STARTING state anymore, clear the timestamp
				this.screenStartingTimestamps.delete(screen);
			}
		}

		// Update queues for each screen
		for (const screen of enabledScreens) {
			try {
				// Check if there's an active stream on this screen
				const activeStream = this.getActiveStreams().find(s => s.screen === screen);
				const currentState = this.getScreenState(screen);

				if (!activeStream) {
					// If screen is in ERROR state, reset it to IDLE to allow starting new streams
					if (currentState === StreamState.ERROR) {
						logger.info(`Resetting screen ${screen} from ERROR to IDLE state`, 'StreamManager');
						await this.setScreenState(screen, StreamState.IDLE);
					}

					// If no active stream and screen is in IDLE state, try to start a new one
					if (currentState === StreamState.IDLE) {
						const lastRefresh = this.lastStreamRefresh.get(screen) || 0;
						const timeSinceLastRefresh = now - lastRefresh;

						// Reduced refresh interval check to be more aggressive
						const minimumRefreshInterval = this.STREAM_REFRESH_INTERVAL / 3; // 20 seconds instead of 60

						if (timeSinceLastRefresh >= minimumRefreshInterval) {
							logger.info(`No active stream on screen ${screen}, fetching new streams`, 'StreamManager');

							try {
								// Check if there are already queued streams for this screen
								const existingQueue = this.queues.get(screen) || [];

								if (existingQueue.length > 0) {
									// If there's already a queue, start the first stream immediately
									logger.info(`Found ${existingQueue.length} streams in queue for screen ${screen}, starting first one`, 'StreamManager');

									// Filter out streams that have repeatedly failed to start
									const filteredQueue = existingQueue.filter(stream => {
										const failRecord = this.failedStreamAttempts.get(stream.url);
										if (!failRecord) return true; // Never failed before

										// Reset failure count if it's been long enough
										if (now - failRecord.timestamp > this.STREAM_FAILURE_RESET_TIME) {
											this.failedStreamAttempts.delete(stream.url);
											return true;
										}

										// Skip if too many recent failures
										return failRecord.count < this.MAX_STREAM_ATTEMPTS;
									});

									if (filteredQueue.length === 0) {
										logger.warn(`All ${existingQueue.length} streams in queue for screen ${screen} have failed recently, fetching fresh streams`, 'StreamManager');
										this.queues.delete(screen);
										// Force fetch new streams
										this.lastStreamFetch = 0;
										await this.updateQueue(screen);
										continue;
									}

									// Save a copy of the queue before starting the stream
									const originalQueue = [...filteredQueue];

									const firstStream = filteredQueue[0];
									logger.info(`Attempting to start stream on screen ${screen}: ${firstStream.url}`, 'StreamManager');

									// Record when we enter STARTING state
									this.screenStartingTimestamps.set(screen, now);

									// Attempt to start the stream
									const startResult = await this.startStream({
										url: firstStream.url,
										screen,
										quality: this.config.player.defaultQuality,
										title: firstStream.title,
										viewerCount: firstStream.viewerCount,
										startTime: firstStream.startTime
									});

									if (startResult.success) {
										logger.info(`Successfully started stream on screen ${screen}: ${firstStream.url}`, 'StreamManager');

										// Clear any failure record for this stream
										this.failedStreamAttempts.delete(firstStream.url);

										// Update queue to remove the started stream
										if (originalQueue.length > 1) {
											this.queues.set(screen, originalQueue.slice(1));
											logger.debug(`Updated queue for screen ${screen}, ${originalQueue.length - 1} streams remaining`, 'StreamManager');
										} else {
											this.queues.delete(screen);
											logger.debug(`Queue empty after starting stream on screen ${screen}`, 'StreamManager');
										}

										this.lastStreamRefresh.set(screen, now);
									} else {
										// Stream failed to start - record the failure
										const failRecord = this.failedStreamAttempts.get(firstStream.url) || { timestamp: now, count: 0 };
										failRecord.count++;
										failRecord.timestamp = now;
										this.failedStreamAttempts.set(firstStream.url, failRecord);

										// Log detailed error
										logger.error(`Failed to start stream on screen ${screen}: ${firstStream.url}. Error: ${startResult.error} (Attempt ${failRecord.count})`, 'StreamManager');

										// Remove the failed stream from queue and try the next one or fetch fresh streams
										if (originalQueue.length > 1) {
											logger.info(`Trying next stream in queue for screen ${screen}`, 'StreamManager');
											this.queues.set(screen, originalQueue.slice(1));

											// Schedule an immediate refresh to try the next stream
											setTimeout(() => this.updateAllQueues(), 1000);
										} else {
											// No more streams in queue, clear it
											this.queues.delete(screen);
											logger.debug(`Queue empty after failed start on screen ${screen}`, 'StreamManager');

											// Try to get fresh streams after a short delay
											logger.info(`Fetching fresh streams for screen ${screen} after failed start`, 'StreamManager');
											setTimeout(async () => {
												this.lastStreamFetch = 0; // Force fresh data
												await this.updateQueue(screen);
												this.updateAllQueues();
											}, 3000);
										}
									}
								} else {
									// No existing queue, fetch fresh streams
									// Reset last stream fetch to force fresh data
									this.lastStreamFetch = 0;
									logger.info(`No queue for screen ${screen}, fetching fresh streams`, 'StreamManager');
									const streams = await this.getLiveStreams();
									const availableStreams = streams.filter(s => s.screen === screen);

									if (availableStreams.length > 0) {
										// Filter out streams that have repeatedly failed
										const filteredStreams = availableStreams.filter(stream => {
											const failRecord = this.failedStreamAttempts.get(stream.url);
											if (!failRecord) return true; // Never failed before

											// Reset failure count if it's been long enough
											if (now - failRecord.timestamp > this.STREAM_FAILURE_RESET_TIME) {
												this.failedStreamAttempts.delete(stream.url);
												return true;
											}

											// Skip if too many recent failures
											return failRecord.count < this.MAX_STREAM_ATTEMPTS;
										});

										if (filteredStreams.length === 0) {
											logger.warn(`All ${availableStreams.length} available streams for screen ${screen} have failed recently`, 'StreamManager');
											continue;
										}

										// Start first stream immediately
										const firstStream = filteredStreams[0];
										logger.info(`Starting stream on screen ${screen}: ${firstStream.url}`, 'StreamManager');

										// Record when we enter STARTING state
										this.screenStartingTimestamps.set(screen, now);

										const startResult = await this.startStream({
											url: firstStream.url,
											screen,
											quality: this.config.player.defaultQuality,
											title: firstStream.title,
											viewerCount: firstStream.viewerCount,
											startTime: firstStream.startTime
										});

										if (startResult.success) {
											logger.info(`Successfully started stream on screen ${screen}: ${firstStream.url}`, 'StreamManager');

											// Clear any failure record for this stream
											this.failedStreamAttempts.delete(firstStream.url);

											// Set remaining streams in queue
											if (filteredStreams.length > 1) {
												this.queues.set(screen, filteredStreams.slice(1));
												logger.debug(`Set queue for screen ${screen} with ${filteredStreams.length - 1} streams`, 'StreamManager');
											}

											this.lastStreamRefresh.set(screen, now);
										} else {
											// Stream failed to start - record the failure
											const failRecord = this.failedStreamAttempts.get(firstStream.url) || { timestamp: now, count: 0 };
											failRecord.count++;
											failRecord.timestamp = now;
											this.failedStreamAttempts.set(firstStream.url, failRecord);

											// Log detailed error
											logger.error(`Failed to start fresh stream on screen ${screen}: ${firstStream.url}. Error: ${startResult.error} (Attempt ${failRecord.count})`, 'StreamManager');

											// Store the remaining streams in the queue to try later
											if (filteredStreams.length > 1) {
												logger.info(`Setting queue with remaining ${filteredStreams.length - 1} streams for later retry on screen ${screen}`, 'StreamManager');
												this.queues.set(screen, filteredStreams.slice(1));

												// Schedule an immediate refresh to try the next stream
												setTimeout(() => this.updateAllQueues(), 1000);
											}
										}
									} else {
										logger.info(`No available streams found for screen ${screen}`, 'StreamManager');
									}
								}
							} catch (error) {
								logger.error(
									`Failed to fetch streams for screen ${screen}`,
									'StreamManager',
									error instanceof Error ? error : new Error(String(error))
								);
							}
						} else {
							logger.debug(`No active stream on screen ${screen}, but refresh interval not elapsed (${Math.floor(timeSinceLastRefresh / 1000)}s of ${Math.floor(minimumRefreshInterval / 1000)}s). Will check again soon.`, 'StreamManager');
						}
					} else if (currentState !== StreamState.STARTING) {
						// If screen is in any other state than IDLE, STARTING or ERROR, log it
						logger.debug(`Screen ${screen} has no active stream but is in state ${currentState}, not attempting to start new stream`, 'StreamManager');
					}
				} else {
					// There's an active stream
					logger.debug(`Active stream already running on screen ${screen}`, 'StreamManager');
				}
			} catch (error) {
				logger.error(
					`Failed to update queue for screen ${screen}`,
					'StreamManager',
					error instanceof Error ? error : new Error(String(error))
				);
			}
		}
	}

	// Add method to safely transition screen state with proper logging
	private async setScreenState(screen: number, state: StreamState, setupCallback?: () => Promise<void>, fastUpdate: boolean = false): Promise<boolean> {
		if (!this.stateMachines.has(screen)) {
			this.stateMachines.set(screen, new StreamStateMachine(screen));
		}

		const stateMachine = this.stateMachines.get(screen)!;

		// For fast updates, bypass the normal transition validation
		if (fastUpdate) {
			// Just log the transition
			logger.info(`Screen ${screen} fast state transition: ${stateMachine.getState()} -> ${state}`, 'StreamManager');

			// Execute callback if provided
			if (setupCallback) {
				await setupCallback();
			}

			// Force set the state directly using private access
			// We access the state machine's private property directly
			// This is a hack, but it's needed for performance in this case
			(stateMachine as any).currentState = state;
			return true;
		}

		// Otherwise use normal transition validation
		return stateMachine.transition(state, setupCallback);
	}

	// Add method to get current screen state with a default
	private getScreenState(screen: number): StreamState {
		if (!this.stateMachines.has(screen)) {
			this.stateMachines.set(screen, new StreamStateMachine(screen));
		}
		return this.stateMachines.get(screen)!.getState();
	}

	// Fix the linter errors by deleting elements from Map correctly
	private async withLock<T>(screen: number, operation: string, callback: () => Promise<T>): Promise<T> {
		// Get or create mutex for this screen
		if (!this.screenMutexes.has(screen)) {
			this.screenMutexes.set(screen, new SimpleMutex());
		}

		const mutex = this.screenMutexes.get(screen)!;
		const release = await mutex.acquire();

		try {
			logger.debug(`Acquired lock for screen ${screen} during ${operation}`, 'StreamManager');
			return await callback();
		} finally {
			release();
			logger.debug(`Released lock for screen ${screen} after ${operation}`, 'StreamManager');
		}
	}

	private async handleStreamEnd(screen: number): Promise<void> {
		logger.info(`Handling stream end for screen ${screen}`, 'StreamManager');

		const currentState = this.getScreenState(screen);

		// Only process if we're in a valid state for handling stream end
		if (currentState !== StreamState.PLAYING && currentState !== StreamState.ERROR) {
			logger.info(`Ignoring stream end for screen ${screen} in state ${currentState}`, 'StreamManager');
			return;
		}

		logger.info(`Handling stream end for screen ${screen}`, 'StreamManager');

		// Clear any existing processing timeout
		this.clearQueueProcessingTimeout(screen);

		try {
			// Set state to stopping while we handle the stream end
			await this.setScreenState(screen, StreamState.STOPPING);

			// Process concurrently for faster transitions
			const stopPromise = this.playerService.stopStream(screen, true);

			// While stopping, prepare the next stream
			const nextStream = queueService.dequeueNextStream(screen);

			// Await the stop operation
			await stopPromise;

			// Ensure we're no longer tracking this stream
			if (this.streams.has(screen)) {
				logger.info(`Removing stream tracking for screen ${screen}`, 'StreamManager');
				this.streams.delete(screen);
			} else {
				logger.info(`No stream to remove from tracking for screen ${screen}`, 'StreamManager');
			}

			// Now we're effectively in IDLE state
			await this.setScreenState(screen, StreamState.IDLE);

			if (!nextStream) {
				logger.info(`No next stream in queue for screen ${screen}, looking for new streams`, 'StreamManager');
				await this.handleEmptyQueue(screen);
				return;
			}

			// Start the stream immediately
			logger.info(`Moving to next stream in queue for screen ${screen}: ${nextStream.url}`, 'StreamManager');

			// Temporarily set to STARTING state
			await this.setScreenState(screen, StreamState.STARTING);

			// Make sure screen config is available
			const screenConfig = this.getScreenConfig(screen) || {
				screen,
				id: screen,
				enabled: true,
				volume: this.config.player.defaultVolume,
				quality: this.config.player.defaultQuality,
				windowMaximized: this.config.player.windowMaximized
			};

			// Always call playerService.startStream directly to ensure stream starts
			try {
				logger.info(`Directly starting stream for screen ${screen}: ${nextStream.url}`, 'StreamManager');

				const startResult = await this.playerService.startStream({
					url: nextStream.url,
					screen,
					quality: nextStream.quality || screenConfig.quality || 'best',
					volume: nextStream.volume || screenConfig.volume,
					windowMaximized: screenConfig.windowMaximized,
					title: nextStream.title,
					viewerCount: nextStream.viewerCount,
					startTime: nextStream.startTime,
					config: screenConfig
				});

				if (startResult.success) {
					logger.info(`Successfully started next stream on screen ${screen}`, 'StreamManager');

					// Update our stream tracking
					this.streams.set(screen, {
						id: Date.now(),
						screen,
						url: nextStream.url,
						quality: nextStream.quality || screenConfig.quality || 'best',
						volume: nextStream.volume || screenConfig.volume,
						title: nextStream.title,
						platform: nextStream.platform || 'youtube',
						process: null,
						status: 'playing'
					});

					await this.setScreenState(screen, StreamState.PLAYING);
				} else {
					logger.error(`Failed to start next stream on screen ${screen}: ${startResult.error}`, 'StreamManager');
					await this.setScreenState(screen, StreamState.ERROR);

					// If starting the stream fails, try to update the queue immediately
					logger.info(`Calling handleEmptyQueue after failure for screen ${screen}`, 'StreamManager');
					await this.handleEmptyQueue(screen);
				}
			} catch (startError) {
				logger.error(
					`Exception during stream start on screen ${screen}`,
					'StreamManager',
					startError instanceof Error ? startError : new Error(String(startError))
				);

				await this.setScreenState(screen, StreamState.ERROR);
				await this.handleEmptyQueue(screen);
			}
		} catch (error) {
			logger.error(
				`Failed to process stream end for screen ${screen}`,
				'StreamManager',
				error instanceof Error ? error : new Error(String(error))
			);

			await this.setScreenState(screen, StreamState.ERROR);

			// If there was an error, try to update the queue
			try {
				await this.handleEmptyQueue(screen);
			} catch (queueError) {
				logger.error(
					`Failed to handle empty queue after error on screen ${screen}`,
					'StreamManager',
					queueError instanceof Error ? queueError : new Error(String(queueError))
				);
			}
		}
	}

	// Modify handleEmptyQueue to use state machine and locking
	private async handleEmptyQueue(screen: number): Promise<void> {
		return this.withLock(screen, 'handleEmptyQueue', async () => {
			const currentState = this.getScreenState(screen);

			// Allow processing in IDLE or ERROR states to be more robust
			if (currentState !== StreamState.IDLE && currentState !== StreamState.ERROR) {
				logger.info(`Ignoring empty queue handling for screen ${screen} in state ${currentState}`, 'StreamManager');
				return;
			}

			// Set state to starting before adding test stream
			await this.setScreenState(screen, StreamState.STARTING);

			try {
				logger.info(`Handling empty queue for screen ${screen}, fetching fresh streams`, 'StreamManager');

				// Force reset cache timestamp to get fresh data
				this.lastStreamFetch = 0;
				this.lastStreamRefresh.set(screen, 0);

				// Update queue to get fresh streams
				await this.updateQueue(screen);

				// Get updated queue
				const queue = this.queues.get(screen) || [];

				if (queue.length > 0) {
					// Try each stream in the queue until one starts successfully or we run out of streams
					let success = false;

					// Make a copy of the queue to iterate through
					const queueCopy = [...queue];
					this.queues.set(screen, []); // Clear the queue while we process

					for (const nextStream of queueCopy) {
						if (success) {
							// Add remaining streams back to queue
							this.queues.get(screen)!.push(nextStream);
							continue;
						}

						logger.info(`Attempting to start stream on screen ${screen}: ${nextStream.url}`, 'StreamManager');

						// Get screen config for direct player use
						const screenConfig = this.getScreenConfig(screen) || {
							screen,
							id: screen,
							enabled: true,
							volume: this.config.player.defaultVolume,
							quality: this.config.player.defaultQuality,
							windowMaximized: this.config.player.windowMaximized
						};

						// Use playerService directly instead of this.startStream
						try {
							const result = await this.playerService.startStream({
								url: nextStream.url,
								screen,
								quality: nextStream.quality || screenConfig.quality || 'best',
								volume: nextStream.volume || screenConfig.volume,
								windowMaximized: screenConfig.windowMaximized,
								title: nextStream.title,
								viewerCount: nextStream.viewerCount,
								startTime: nextStream.startTime,
								config: screenConfig
							});

							if (result.success) {
								logger.info(`Successfully started stream on screen ${screen}`, 'StreamManager');

								// Update stream tracking
								this.streams.set(screen, {
									id: Date.now(),
									screen,
									url: nextStream.url,
									quality: nextStream.quality || screenConfig.quality || 'best',
									volume: nextStream.volume || screenConfig.volume,
									title: nextStream.title,
									platform: nextStream.platform || 'youtube',
									process: null,
									status: 'playing'
								});

								await this.setScreenState(screen, StreamState.PLAYING);
								success = true;
							} else {
								logger.error(`Failed to start stream on screen ${screen}: ${result.error}`, 'StreamManager');
								// Continue to next stream in queue
							}
						} catch (startError) {
							logger.error(
								`Exception during stream start on screen ${screen}`,
								'StreamManager',
								startError instanceof Error ? startError : new Error(String(startError))
							);
							// Continue to next stream in queue
						}
					}

					// If we couldn't start any stream and have empty queue now
					if (!success) {
						logger.warn(`Failed to start any stream from queue of ${queueCopy.length} for screen ${screen}`, 'StreamManager');
						await this.setScreenState(screen, StreamState.ERROR);

						// Schedule another attempt after a short delay
						setTimeout(() => {
							logger.info(`Scheduling another attempt to refresh streams for screen ${screen}`, 'StreamManager');
							this.updateAllQueues();
						}, 5000); // Try again in 5 seconds
					}
				} else {
					logger.info(`No streams available for screen ${screen} after queue update`, 'StreamManager');

					// Try adding a test stream when no streams are available
					try {
						await this.addDefaultTestStream(screen);
						await this.setScreenState(screen, StreamState.IDLE);
					} catch (testStreamError) {
						logger.error(
							`Failed to add test stream for screen ${screen}`,
							'StreamManager',
							testStreamError instanceof Error ? testStreamError : new Error(String(testStreamError))
						);
						await this.setScreenState(screen, StreamState.ERROR);
					}
				}
			} catch (error) {
				logger.error(
					`Error handling empty queue for screen ${screen}`,
					'StreamManager',
					error instanceof Error ? error : new Error(String(error))
				);

				await this.setScreenState(screen, StreamState.ERROR);

				// Schedule another attempt after a delay
				setTimeout(() => {
					logger.info(`Scheduling retry after error for screen ${screen}`, 'StreamManager');
					this.updateAllQueues();
				}, 10000); // Try again in 10 seconds
			}
		});
	}

	private async handleAllStreamsWatched(screen: number) {
		logger.info(`All streams watched for screen ${screen}, refetching immediately...`);

		// Clear watched history to allow playing again
		queueService.clearWatchedStreams();
		logger.info(`Cleared watched streams history for screen ${screen}`, 'StreamManager');

		// Skip the waiting period and refresh immediately
		logger.info(`Fetching new streams after all watched for screen ${screen}`, 'StreamManager');

		// Force reset cache timestamp to get fresh data
		this.lastStreamFetch = 0;
		this.lastStreamRefresh.set(screen, 0);

		// Update queue to get fresh streams
		await this.updateQueue(screen);

		// Process the queue immediately
		await this.handleEmptyQueue(screen);
	}

	// Modify startStream to use state machine and locking
	async startStream(options: StreamOptions & { url: string }): Promise<StreamResponse> {
		const screen = options.screen;

		// Ensure screen is defined
		if (screen === undefined) {
			return {
				screen: 0, // Use 0 as invalid screen
				success: false,
				error: 'Screen number is required'
			};
		}

		return this.withLock(screen, 'startStream', async () => {
			const currentState = this.getScreenState(screen);

			// Only start if in IDLE or ERROR state
			if (currentState !== StreamState.IDLE && currentState !== StreamState.ERROR) {
				logger.warn(`Cannot start stream on screen ${screen} in state ${currentState}`, 'StreamManager');
				return {
					screen,
					success: false,
					error: `Screen is busy in state ${currentState}`
				};
			}

			// Set state to starting
			await this.setScreenState(screen, StreamState.STARTING);

			return safeAsync<StreamResponse>(async () => {
				// Ensure screen config exists
				const screenConfig = this.screenConfigs.get(screen);
				if (!screenConfig) {
					throw new Error(`Screen ${screen} not found in screenConfigs`);
				}

				// Start the stream
				const result = await this.playerService.startStream({
					screen,
					config: screenConfig,
					url: options.url,
					quality: options.quality || screenConfig.quality,
					volume: options.volume || screenConfig.volume,
					windowMaximized: options.windowMaximized ?? screenConfig.windowMaximized,
					title: options.title,
					viewerCount: options.viewerCount,
					startTime: typeof options.startTime === 'string' ? Date.parse(options.startTime) : options.startTime,
					isRetry: options.isRetry
				});

				// Update state based on result
				if (result.success) {
					// Add the new stream to our map
					this.streams.set(screen, {
						url: options.url,
						screen: screen,
						quality: options.quality || 'best',
						platform: options.url.includes('twitch.tv') ? 'twitch' as StreamPlatform :
							options.url.includes('youtube.com') ? 'youtube' as StreamPlatform : 'twitch' as StreamPlatform,
						status: 'playing',
						volume: 100,
						process: null,
						id: Date.now() // Use timestamp as unique ID
					});

					await this.setScreenState(screen, StreamState.PLAYING);
					return { screen, success: true };
				} else {
					await this.setScreenState(screen, StreamState.ERROR);
					return {
						screen,
						success: false,
						error: result.error || 'Failed to start stream'
					};
				}
			}, `StreamManager:startStream:${screen}`, {
				screen,
				success: false,
				error: 'Unexpected error during stream start'
			});
		});
	}

	// Implement stopStream with state machine
	async stopStream(screen: number, isManualStop: boolean = false): Promise<boolean> {
		return this.withLock(screen, 'stopStream', async () => {
			const currentState = this.getScreenState(screen);

			// Can't stop if already stopping or disabled
			if (currentState === StreamState.STOPPING || currentState === StreamState.DISABLED) {
				logger.warn(`Cannot stop stream on screen ${screen} in state ${currentState}`, 'StreamManager');
				return false;
			}

			// Update state to stopping
			await this.setScreenState(screen, StreamState.STOPPING);

			try {
				logger.info(`Stopping stream on screen ${screen}, manualStop=${isManualStop}`, 'StreamManager');

				const activeStream = this.streams.get(screen);
				if (activeStream) {
					logger.info(`Active stream on screen ${screen}: ${activeStream.url}`, 'StreamManager');
				} else {
					logger.info(`No active stream found in manager for screen ${screen}`, 'StreamManager');
				}

				if (isManualStop) {
					this.manuallyClosedScreens.add(screen);
					logger.info(`Screen ${screen} manually closed, added to manuallyClosedScreens`, 'StreamManager');
				}

				// Clear any processing state
				this.clearQueueProcessingTimeout(screen);

				// Stop the stream in player service
				logger.info(`Calling player service to stop stream on screen ${screen}`, 'StreamManager');
				const success = await this.playerService.stopStream(screen, true, isManualStop);
				logger.info(`Player service stopStream result: ${success} for screen ${screen}`, 'StreamManager');

				// Clean up all related resources
				if (success) {
					logger.debug(`Successfully stopped stream on screen ${screen}, cleaning up resources`, 'StreamManager');
					this.streams.delete(screen);
					this.clearInactiveTimer(screen);
					this.clearStreamRefresh(screen);

					// Also clear these timers to be safe
					const streamRefreshTimer = this.streamRefreshTimers.get(screen);
					if (streamRefreshTimer) {
						logger.debug(`Clearing stream refresh timer for screen ${screen}`, 'StreamManager');
						clearTimeout(streamRefreshTimer);
						this.streamRefreshTimers.delete(screen);
					}

					this.lastStreamRefresh.delete(screen);
				} else {
					logger.warn(`Failed to stop stream on screen ${screen}, forcing cleanup`, 'StreamManager');
					this.streams.delete(screen);
					this.clearInactiveTimer(screen);
					this.clearStreamRefresh(screen);
				}

				// Update state based on result
				await this.setScreenState(screen, StreamState.IDLE);
				return true;
			} catch (error) {
				await this.setScreenState(screen, StreamState.ERROR);
				logger.error(`Error stopping stream on screen ${screen}`, 'StreamManager',
					error instanceof Error ? error : new Error(String(error)));

				// Force cleanup anyway on error
				logger.debug(`Forcing cleanup after error for screen ${screen}`, 'StreamManager');
				this.streams.delete(screen);
				this.clearInactiveTimer(screen);
				this.clearStreamRefresh(screen);

				return false;
			}
		});
	}

	/**
	 * Gets information about all active streams
	 */
	getActiveStreams() {
		return this.playerService.getActiveStreams();
	}

	onStreamOutput(callback: (data: StreamOutput) => void) {
		this.playerService.onStreamOutput(callback);
	}

	onStreamError(callback: (data: StreamError) => void) {
		this.playerService.onStreamError(callback);
	}

	/**
	 * Gets available organizations
	 */
	getOrganizations(): string[] {
		return this.config.organizations;
	}

	/**
	 * Fetches live streams from both Holodex and Twitch based on config
	 */
	async getLiveStreams(retryCount = 0): Promise<StreamSource[]> {
		// Check if we have a recent cache
		const now = Date.now();
		if (this.cachedStreams.length > 0 && now - this.lastStreamFetch < this.STREAM_CACHE_TTL) {
			logger.debug(
				`Using cached streams (${this.cachedStreams.length} streams, age: ${
					now - this.lastStreamFetch
				}ms)`,
				'StreamManager'
			);
			return this.cachedStreams;
		}

		logger.info('Fetching fresh stream data...', 'StreamManager');

		return await safeAsync(async () => {
				const results: Array<StreamSource & { screen?: number; sourceName?: string; priority?: number }> = [];
				const streamConfigs = this.config.streams;

				// Defensive check for config
				if (!streamConfigs || !Array.isArray(streamConfigs)) {
					logger.warn('Stream configuration is missing or invalid', 'StreamManager');
					return this.cachedStreams.length > 0 ? this.cachedStreams : [];
				}

				// Create fetch operations for all enabled screens
				const fetchOperations = streamConfigs
					.filter(streamConfig => streamConfig.enabled)
					.map(streamConfig => {
						const screenNumber = streamConfig.screen;
						return async () => {
							logger.debug(`Fetching streams for screen ${screenNumber}`, 'StreamManager');

							// Sort sources by priority first
							const sortedSources = streamConfig.sources && Array.isArray(streamConfig.sources)
								? [...streamConfig.sources]
									.filter(source => source.enabled)
									.sort((a, b) => (a.priority || 999) - (b.priority || 999))
								: [];

							logger.debug(
								'Sources for screen %s: %s',
								String(screenNumber),
								sortedSources.map(s => `${s.type}:${s.subtype || 'other'} (${s.priority || 999})`).join(', ')
							);

							// Process each source for this screen
							const screenStreamsBySource = await parallelOps(
								sortedSources.map(source => () => this.fetchStreamsForSource(source, screenNumber)),
								`StreamManager:fetchScreenSources:${screenNumber}`,
								{ continueOnError: true }
							);

							// Flatten and return all streams for this screen
							return screenStreamsBySource.flat();
						};
					});

				// Run all screen fetches in parallel
				const screenStreams = await parallelOps(
					fetchOperations,
					'StreamManager:fetchAllScreens',
					{ continueOnError: true }
				);

				// Combine all streams from all screens
				results.push(...screenStreams.flat());

				// Filter out any streams with 'ended' status
				const filteredResults = results.filter(stream => {
					// For ended streams, filter them out
					if (stream.sourceStatus === 'ended') {
						logger.debug(`Filtering out ended stream: ${stream.url}`, 'StreamManager');
						return false;
					}

					// For upcoming streams, check if they're in the past
					if (stream.sourceStatus === 'upcoming' && stream.startTime) {
						// If the start time is in the past by more than 30 minutes, filter it out
						if (stream.startTime < now - 30 * 60 * 1000) {
							logger.debug(`Filtering out past upcoming stream: ${stream.url}`, 'StreamManager');
							return false;
						}
					}

					return true;
				});

				// Save to cache
				this.cachedStreams = filteredResults;
				this.lastStreamFetch = now;

				logger.info(`Fetched ${filteredResults.length} streams from all sources`, 'StreamManager');

				return filteredResults;
			}, 'StreamManager:getLiveStreams',
			// Fallback to cached streams or empty array if error occurs
			this.cachedStreams.length > 0 ? this.cachedStreams : []);
	}

	// Add this new helper method to fetch streams for a specific source
	private async fetchStreamsForSource(
		source: { type: string; subtype?: string; name?: string; limit?: number; priority?: number; tags?: string[] },
		screenNumber: number
	): Promise<StreamSource[]> {
		return safeAsync(async () => {
			let sourceStreams: StreamSource[] = [];

			// Get streams based on source type
			if (source.type === 'holodex') {
				if (source.subtype === 'organization' && source.name) {
					sourceStreams = await this.holodexService.getLiveStreams({
						organization: source.name as string,
						limit: source.limit || 50
					});
				} else if (source.subtype === 'favorites') {
					sourceStreams = await this.holodexService.getLiveStreams({
						channels: this.getFlattenedFavorites('holodex'),
						limit: source.limit || 50
					});
				}
			} else if (source.type === 'twitch') {
				if (source.subtype === 'favorites') {
					sourceStreams = await this.twitchService.getStreams({
						channels: this.getFlattenedFavorites('twitch'),
						limit: source.limit || 50
					});
				} else if (source.tags && source.tags.length > 0) {
					sourceStreams = await this.twitchService.getStreams({
						tags: source.tags,
						limit: source.limit || 50
					});
				}
			}

			// Add screen and priority information to all streams from this source
			sourceStreams.forEach(stream => {
				stream.screen = screenNumber;
				stream.priority = source.priority || 999;
				stream.subtype = source.subtype;
			});

			return sourceStreams;
		}, `StreamManager:fetchStreamsForSource:${source.type}:${source.subtype || 'other'}:${screenNumber}`, []);
	}

	/**
	 * Gets VTuber streams from Twitch
	 */
	async getVTuberStreams(limit = 50): Promise<StreamSource[]> {
		return this.twitchService.getVTuberStreams(limit);
	}

	/**
	 * Gets Japanese language streams
	 */
	async getJapaneseStreams(limit = 50): Promise<StreamSource[]> {
		return this.twitchService.getJapaneseStreams(limit);
	}

	/**
	 * Sets up user authentication for Twitch
	 */
	async setTwitchUserAuth(auth: TwitchAuth): Promise<void> {
		await this.twitchService.setUserAuth(auth);
	}

	/**
	 * Gets streams from user's followed channels
	 */
	async getFollowedStreams(userId: string): Promise<StreamSource[]> {
		return this.twitchService.getFollowedStreams(userId);
	}

	async autoStartStreams() {
		if (this.isShuttingDown) return;

		logger.info('Auto-starting streams...', 'StreamManager');

		try {
			// Get all enabled screens with autoStart enabled from streams config
			const autoStartScreens = this.config.streams
				.filter(stream => stream.enabled && stream.autoStart)
				.map(stream => stream.screen);

			if (autoStartScreens.length === 0) {
				logger.info('No screens configured for auto-start', 'StreamManager');
				return;
			}

			logger.info(`Auto-starting streams for screens: ${autoStartScreens.join(', ')}`, 'StreamManager');

			// First, fetch all available streams
			const allStreams = await this.getLiveStreams();
			logger.info(`Fetched ${allStreams.length} live streams for initialization`, 'StreamManager');

			// Process each screen
			for (const screen of autoStartScreens) {
				// Check if a stream is already playing on this screen
				const activeStreams = this.getActiveStreams();
				const isStreamActive = activeStreams.some(s => s.screen === screen);

				if (isStreamActive) {
					logger.info(`Stream already active on screen ${screen}, skipping auto-start`, 'StreamManager');

					// Still update the queue for this screen
					const streamConfig = this.config.streams.find(s => s.screen === screen);
					if (!streamConfig) {
						logger.warn(`No stream configuration found for screen ${screen}`, 'StreamManager');
						continue;
					}

					// Filter streams for this screen but exclude the currently playing one
					const currentStream = this.streams.get(screen);
					const currentUrl = currentStream?.url;

					const screenStreams = allStreams.filter(stream => {
						// Skip the currently playing stream
						if (currentUrl && stream.url === currentUrl) {
							return false;
						}

						// Only include streams that are actually live
						if (!stream.sourceStatus || stream.sourceStatus !== 'live') {
							return false;
						}

						// Check if stream is already playing on another screen
						const isPlaying = activeStreams.some(s => s.url === stream.url);

						// Never allow duplicate streams across screens
						if (isPlaying) {
							return false;
						}

						// Check if this stream matches the screen's configured sources
						const matchesSource = streamConfig.sources?.some(source => {
							if (!source.enabled) return false;

							switch (source.type) {
								case 'holodex':
									if (stream.platform !== 'youtube') return false;
									if (source.subtype === 'favorites' && stream.channelId && this.isChannelInFavorites('holodex', stream.channelId)) return true;
									if (source.subtype === 'organization' && source.name && stream.organization === source.name) return true;
									break;
								case 'twitch':
									if (stream.platform !== 'twitch') return false;
									if (source.subtype === 'favorites' && stream.channelId && this.isChannelInFavorites('twitch', stream.channelId)) return true;
									if (!source.subtype && source.tags?.includes('vtuber')) return true;
									break;
							}
							return false;
						});

						return matchesSource;
					}).sort((a, b) => {
						// Sort by priority first
						const aPriority = a.priority ?? 999;
						const bPriority = b.priority ?? 999;
						if (aPriority !== bPriority) return aPriority - bPriority;

						return 0;
					});

					// Set up the queue first
					if (screenStreams.length > 0) {
						queueService.setQueue(screen, screenStreams);
						logger.info(`Initialized queue for screen ${screen} with ${screenStreams.length} streams`, 'StreamManager');
					}

					continue; // Skip to next screen
				}

				// Reset the last refresh time to force a fresh start
				this.lastStreamRefresh.set(screen, 0);

				// Get stream configuration for this screen
				const streamConfig = this.config.streams.find(s => s.screen === screen);
				if (!streamConfig) {
					logger.warn(`No stream configuration found for screen ${screen}`, 'StreamManager');
					continue;
				}

				// Filter and sort streams for this screen
				const screenStreams = allStreams.filter(stream => {
					// Only include streams that are actually live
					if (!stream.sourceStatus || stream.sourceStatus !== 'live') {
						return false;
					}

					// Check if stream is already playing on another screen
					const isPlaying = activeStreams.some(s => s.url === stream.url);

					// Never allow duplicate streams across screens
					if (isPlaying) {
						return false;
					}

					// Check if this stream matches the screen's configured sources
					const matchesSource = streamConfig.sources?.some(source => {
						if (!source.enabled) return false;

						switch (source.type) {
							case 'holodex':
								if (stream.platform !== 'youtube') return false;
								if (source.subtype === 'favorites' && stream.channelId && this.isChannelInFavorites('holodex', stream.channelId)) return true;
								if (source.subtype === 'organization' && source.name && stream.organization === source.name) return true;
								break;
							case 'twitch':
								if (stream.platform !== 'twitch') return false;
								if (source.subtype === 'favorites' && stream.channelId && this.isChannelInFavorites('twitch', stream.channelId)) return true;
								if (!source.subtype && source.tags?.includes('vtuber')) return true;
								break;
						}
						return false;
					});

					return matchesSource;
				}).sort((a, b) => {
					// Sort by priority first
					const aPriority = a.priority ?? 999;
					const bPriority = b.priority ?? 999;
					if (aPriority !== bPriority) return aPriority - bPriority;

					return 0; //(b.viewerCount || 0) - (a.viewerCount || 0);
				});

				if (screenStreams.length > 0) {
					// Take the first stream to play and queue the rest
					const [firstStream, ...queueStreams] = screenStreams;

					// Set up the queue first
					if (queueStreams.length > 0) {
						queueService.setQueue(screen, queueStreams);
						logger.info(`Initialized queue for screen ${screen} with ${queueStreams.length} streams`, 'StreamManager');
					}

					// Start playing the first stream
					logger.info(`Starting initial stream on screen ${screen}: ${firstStream.url}`, 'StreamManager');
					await this.startStream({
						url: firstStream.url,
						screen,
						quality: this.config.player.defaultQuality,
						windowMaximized: this.config.player.windowMaximized,
						volume: this.config.player.defaultVolume,
						title: firstStream.title,
						viewerCount: firstStream.viewerCount,
						startTime: firstStream.startTime
					});
				} else {
					logger.info(`No live streams available for screen ${screen}, will try again later`, 'StreamManager');
				}
			}

			logger.info('Auto-start complete', 'StreamManager');
		} catch (error) {
			logger.error(`Error during auto-start: ${error instanceof Error ? error.message : String(error)}`, 'StreamManager');
		}
	}

	// Modify disableScreen to use state machine
	async disableScreen(screen: number, fastDisable: boolean = false): Promise<void> {
		// If fast disable is requested, immediately update state and return
		if (fastDisable) {
			// Update state to disabled immediately (without lock)
			this.setScreenState(screen, StreamState.DISABLED, undefined, true); // Use fastUpdate=true

			// Send quit command to MPV directly - this is more reliable than process kill
			try {
				logger.info(`Sending quit command to MPV on screen ${screen}`, 'StreamManager');
				this.playerService.sendCommandToScreen(screen, 'quit');

				// Give MPV a moment to quit cleanly
				await new Promise(resolve => setTimeout(resolve, 100));
			} catch (error) {
				logger.warn(`Failed to send quit command to screen ${screen}`, 'StreamManager');
			}

			// Update player service (non-blocking)
			this.playerService.disableScreen(screen);

			// Update screen config
			const config = this.screenConfigs.get(screen);
			if (config) {
				config.enabled = false;
				this.screenConfigs.set(screen, config);
				this.emit('screenConfigUpdate', screen, config);
			}

			// Start the full cleanup in the background
			this.withLock(screen, 'backgroundDisableScreen', async () => {
				logger.info(`Processing background cleanup for disabled screen ${screen}`, 'StreamManager');

				// First stop any active stream on this screen
				const hasActiveStream = this.streams.has(screen);
				if (hasActiveStream) {
					logger.info(`Stopping active stream on screen ${screen} in background`, 'StreamManager');
					await this.stopStream(screen, true);
				}

				// Synchronize disabled screens to ensure consistency
				this.synchronizeDisabledScreens();

				logger.info(`Background cleanup completed for screen ${screen}`, 'StreamManager');
			}).catch(error => {
				logger.error(`Error in background cleanup for screen ${screen}`, 'StreamManager',
					error instanceof Error ? error : new Error(String(error)));
			});

			return;
		}

		// Otherwise use the regular path with locking
		return this.withLock(screen, 'disableScreen', async () => {
			logger.info(`Disabling screen ${screen}`, 'StreamManager');

			// First stop any active stream on this screen
			const hasActiveStream = this.streams.has(screen);
			if (hasActiveStream) {
				logger.info(`Stopping active stream on screen ${screen} before disabling`, 'StreamManager');
				await this.stopStream(screen, true);
			}

			// Update state to disabled
			await this.setScreenState(screen, StreamState.DISABLED);

			// Update player service
			this.playerService.disableScreen(screen);

			// Update screen config
			const config = this.screenConfigs.get(screen);
			if (config) {
				config.enabled = false;
				this.screenConfigs.set(screen, config);
				this.emit('screenConfigUpdate', screen, config);
			}

			// Synchronize disabled screens to ensure consistency
			this.synchronizeDisabledScreens();

			logger.info(`Screen ${screen} disabled`, 'StreamManager');
		});
	}

	// Modify enableScreen to use state machine
	async enableScreen(screen: number): Promise<void> {
		return this.withLock(screen, 'enableScreen', async () => {
			logger.info(`Enabling screen ${screen}`, 'StreamManager');

			// Update state to idle
			await this.setScreenState(screen, StreamState.IDLE);

			// Update player service
			this.playerService.enableScreen(screen);

			// Update screen config
			const config = this.screenConfigs.get(screen);
			if (config) {
				config.enabled = true;
				this.screenConfigs.set(screen, config);
				this.emit('screenConfigUpdate', screen, config);
			}

			// Force reset cache timestamp to get fresh data
			this.lastStreamFetch = 0;
			this.lastStreamRefresh.set(screen, 0);

			// Initialize queue for this screen if needed
			if (!this.queues.has(screen)) {
				try {
					await this.updateQueue(screen);
				} catch (error) {
					logger.warn(`Failed to update queue for screen ${screen}, will try default stream instead`, 'StreamManager');
				}
			}

			// Check if we have streams in the queue
			const queue = this.queues.get(screen) || [];

			try {
				if (queue.length > 0) {
					// Start the first stream in the queue
					const nextStream = queue.shift();
					if (nextStream) {
						logger.info(`Starting queued stream on screen ${screen}: ${nextStream.url}`, 'StreamManager');
						await this.startStream({
							url: nextStream.url,
							screen,
							quality: config?.quality || 'best',
							windowMaximized: config?.windowMaximized || true
						});
					}
				} else {
					// No streams in queue, start a default test stream
					logger.info(`No streams in queue for screen ${screen}, starting default test stream`, 'StreamManager');
					await this.addDefaultTestStream(screen);
				}
			} catch (error) {
				logger.error(`Failed to start stream after enabling screen ${screen}`, 'StreamManager',
					error instanceof Error ? error : new Error(String(error)));

				// Fall back to default test stream on error
				try {
					await this.addDefaultTestStream(screen);
				} catch (testError) {
					logger.error(`Failed to start default test stream for screen ${screen}`, 'StreamManager',
						testError instanceof Error ? testError : new Error(String(testError)));
				}
			}

			logger.info(`Screen ${screen} enabled`, 'StreamManager');
		});
	}

	/**
	 * Handles empty queue by fetching and starting new streams
	 */
	public async handleQueueEmpty(screen: number): Promise<void> {
		return this.handleEmptyQueue(screen);
	}

	/**
	 * Restarts streams on specified screen or all screens
	 */
	public async restartStreams(screen?: number): Promise<void> {
		if (screen) {
			// Restart specific screen
			await this.stopStream(screen, false);
			await this.handleQueueEmpty(screen);
		} else {
			// Restart all screens
			const activeScreens = Array.from(this.streams.keys());
			for (const screenId of activeScreens) {
				await this.stopStream(screenId, false);
				await this.handleQueueEmpty(screenId);
			}
		}
	}

	async reorderQueue(screen: number, sourceIndex: number, targetIndex: number): Promise<void> {
		const queue = queueService.getQueue(screen);
		if (sourceIndex < 0 || sourceIndex >= queue.length ||
			targetIndex < 0 || targetIndex >= queue.length) {
			throw new Error('Invalid source or target index');
		}

		// Reorder the queue
		const [item] = queue.splice(sourceIndex, 1);
		queue.splice(targetIndex, 0, item);
		queueService.setQueue(screen, queue);

		logger.info(`Reordered queue for screen ${screen}: moved item from ${sourceIndex} to ${targetIndex}`, 'StreamManager');
	}

	getQueueForScreen(screen: number): StreamSource[] {
		return queueService.getQueue(screen);
	}

	async setPlayerPriority(priority: string, restartStreams: boolean = true): Promise<void> {
		// Validate priority
		const validPriorities = ['realtime', 'high', 'above_normal', 'normal', 'below_normal', 'low', 'idle'];
		if (!validPriorities.includes(priority.toLowerCase())) {
			throw new Error(`Invalid priority: ${priority}. Valid values are: ${validPriorities.join(', ')}`);
		}

		// Update config
		if (!this.config.mpv) {
			this.config.mpv = {};
		}
		this.config.mpv.priority = priority;

		// Restart all streams to apply new priority if requested
		logger.info(`Setting player priority to ${priority}${restartStreams ? ' and restarting streams' : ' without restarting streams'}`, 'StreamManager');
		if (restartStreams) {
			await this.restartStreams();
		}
	}

	public markStreamAsWatched(url: string): void {
		queueService.markStreamAsWatched(url);
		logger.info(`Stream marked as watched: ${url}`, 'StreamManager');
	}

	public getWatchedStreams(): string[] {
		return queueService.getWatchedStreams();
	}

	public clearWatchedStreams(): void {
		queueService.clearWatchedStreams();
		logger.info('Cleared watched streams history', 'StreamManager');
	}

	async cleanup() {
		this.isShuttingDown = true;

		try {
			// Stop all keyboard listeners
			this.keyboardService.cleanup();

			// Get all active screens
			const activeScreens = Array.from(this.streams.keys());

			// Stop all streams
			const stopPromises = activeScreens.map(screen =>
				this.stopStream(screen, true).catch(error => {
					logger.error(
						`Failed to stop stream on screen ${screen} during cleanup`,
						'StreamManager',
						error instanceof Error ? error : new Error(String(error))
					);
				})
			);

			// Wait for all streams to stop
			await Promise.all(stopPromises);

			// Stop queue updates
			this.stopQueueUpdates();

			// Clear all queues
			this.queues.clear();

			// Remove all FIFO files
			for (const [, fifoPath] of this.fifoPaths) {
				try {
					fs.unlinkSync(fifoPath);
				} catch {
					// Ignore errors, file might not exist
					logger.debug(`Failed to remove FIFO file ${fifoPath}`, 'StreamManager');
				}
			}
			this.fifoPaths.clear();
			this.ipcPaths.clear();

			// Clear all event listeners
			this.removeAllListeners();

			logger.info('Stream manager cleanup complete', 'StreamManager');
		} catch (error) {
			logger.error(
				'Error during stream manager cleanup',
				'StreamManager',
				error instanceof Error ? error : new Error(String(error))
			);
			throw error;
		}
	}

	public sendCommandToScreen(screen: number, command: string): void {
		this.playerService.sendCommandToScreen(screen, command);
	}

	public sendCommandToAll(command: string): void {
		this.playerService.sendCommandToAll(command);
	}

	public async addToQueue(screen: number, source: StreamSource): Promise<void> {
		const queue = this.queues.get(screen) || [];

		// Check if stream already exists in queue
		const exists = queue.some(item => item.url === source.url);
		if (exists) {
			logger.info(`Stream ${source.url} already in queue for screen ${screen}`, 'StreamManager');
			return;
		}

		queue.push(source);
		this.queues.set(screen, queue);

		// Also update the queue service to ensure consistency
		queueService.setQueue(screen, queue);

		logger.info(`Added stream ${source.url} to queue for screen ${screen}`, 'StreamManager');
		this.emit('queueUpdate', screen, queue);
	}

	public async removeFromQueue(screen: number, index: number): Promise<void> {
		const queue = this.queues.get(screen) || [];
		if (index >= 0 && index < queue.length) {
			queue.splice(index, 1);
			this.queues.set(screen, queue);
			this.emit('queueUpdate', screen, queue);
		}
	}

	public getPlayerSettings() {
		return {
			preferStreamlink: this.config.player.preferStreamlink,
			defaultQuality: this.config.player.defaultQuality,
			defaultVolume: this.config.player.defaultVolume,
			windowMaximized: this.config.player.windowMaximized,
			maxStreams: this.config.player.maxStreams,
			autoStart: this.config.player.autoStart
		};
	}

	public async updatePlayerSettings(settings: Partial<PlayerSettings>): Promise<void> {
		// Update the settings
		Object.assign(this.config.player, settings);

		// Emit settings update event
		this.emit('settingsUpdate', this.config.player);
		await this.saveConfig();
	}

	public getScreenConfigs() {
		return this.config.player.screens;
	}

	public async saveConfig(): Promise<void> {
		try {
			await fs.promises.writeFile(
				path.join(process.cwd(), 'config', 'config.json'),
				JSON.stringify(this.config, null, 2),
				'utf-8'
			);
			this.emit('configUpdate', this.config);
		} catch (error) {
			this.emit('error', error);
			throw error;
		}
	}

	public getScreenConfig(screen: number): ScreenConfig | undefined {
		return this.screenConfigs.get(screen);
	}

	public updateScreenConfig(screen: number, config: Partial<ScreenConfig>): void {
		const screenConfig = this.getScreenConfig(screen);
		if (!screenConfig) {
			throw new Error(`Screen ${screen} not found`);
		}

		// Update the config
		Object.assign(screenConfig, config);

		this.screenConfigs.set(screen, screenConfig);
		this.emit('screenConfigChanged', { screen, config });
	}

	public getConfig() {
		return {
			streams: this.config.player.screens,
			organizations: this.config.organizations,
			favoriteChannels: this.config.favoriteChannels,
			holodex: {
				apiKey: this.config.holodex.apiKey
			},
			twitch: {
				clientId: this.config.twitch.clientId,
				clientSecret: this.config.twitch.clientSecret,
				streamersFile: this.config.twitch.streamersFile
			}
		};
	}

	public async updateConfig(newConfig: Partial<Config>): Promise<void> {
		Object.assign(this.config, newConfig);
		await this.saveConfig();
		this.emit('configUpdate', this.getConfig());
	}

	public async updateFavorites(favorites: FavoriteChannels): Promise<void> {
		this.favoriteChannels = favorites;
		this.config.favoriteChannels = favorites;

		// Update services with new favorites - flatten all groups into a single array for each platform
		const flattenedHolodex = this.getFlattenedFavorites('holodex');
		const flattenedTwitch = this.getFlattenedFavorites('twitch');
		const flattenedYoutube = this.getFlattenedFavorites('youtube');

		this.holodexService.updateFavorites(flattenedHolodex);
		this.twitchService.updateFavorites(flattenedTwitch);
		this.youtubeService.updateFavorites(flattenedYoutube);

		await fs.promises.writeFile(
			path.join(process.cwd(), 'config', 'favorites.json'),
			JSON.stringify(favorites, null, 2),
			'utf-8'
		);

		this.emit('favoritesUpdate', favorites);
	}

	public getFavorites(): FavoriteChannels {
		return this.favoriteChannels;
	}

	public async addFavorite(platform: 'holodex' | 'twitch' | 'youtube', channelId: string, group: string = 'default'): Promise<void> {
		// Ensure the platform and group exist
		if (!this.favoriteChannels[platform]) {
			this.favoriteChannels[platform] = {};
		}

		if (!this.favoriteChannels[platform][group]) {
			this.favoriteChannels[platform][group] = [];
		}

		// Add the channel to the specified group if it doesn't already exist
		if (!this.favoriteChannels[platform][group].includes(channelId)) {
			this.favoriteChannels[platform][group].push(channelId);
			await this.updateFavorites(this.favoriteChannels);
		}
	}

	public async removeFavorite(platform: 'holodex' | 'twitch' | 'youtube', channelId: string, group: string = 'default'): Promise<void> {
		if (this.favoriteChannels[platform] && this.favoriteChannels[platform][group]) {
			const index = this.favoriteChannels[platform][group].indexOf(channelId);
			if (index !== -1) {
				this.favoriteChannels[platform][group].splice(index, 1);
				await this.updateFavorites(this.favoriteChannels);
			}
		}
	}

	private initializeQueues() {
		this.config.player.screens.forEach(screen => {
			this.queues.set(screen.screen, []);
		});

		// Force update all queues after initialization but handle error properly
		// without passing a parameter to updateAllQueues
		this.updateAllQueues().catch((error: unknown) => {
			logger.error(
				'Failed to initialize queues',
				'StreamManager',
				error instanceof Error ? error : new Error(String(error))
			);
		});
	}

	/**
	 * Get comprehensive information about a screen, including:
	 * - Current stream
	 * - Queue
	 * - Configuration
	 * - Status
	 */
	public getScreenInfo(screen: number) {
		// Get screen configuration
		const screenConfig = this.config.player.screens.find(s => s.screen === screen);
		if (!screenConfig) {
			throw new Error(`Screen ${screen} not found`);
		}

		// Get active stream for this screen
		const activeStream = this.getActiveStreams().find(s => s.screen === screen);

		// Get queue for this screen
		const queue = this.getQueueForScreen(screen);

		return {
			config: screenConfig,
			currentStream: activeStream || null,
			queue,
			enabled: screenConfig.enabled,
			status: activeStream?.status || 'stopped',
			// Additional useful information
			volume: screenConfig.volume,
			quality: screenConfig.quality,
			windowMaximized: screenConfig.windowMaximized,
			dimensions: {
				width: screenConfig.width,
				height: screenConfig.height,
				x: screenConfig.x,
				y: screenConfig.y
			}
		};
	}

	handleLuaMessage(screen: number, type: string, data: unknown) {
		if (typeof data === 'object' && data !== null) {
			this.playerService.handleLuaMessage(screen, type, data as Record<string, unknown>);
		}
	}

	public handlePlaylistUpdate(screen: number, playlist: Array<{
		filename: string;
		title?: string;
		current: boolean;
	}>): void {
		// Get or create stream instance
		let stream = this.streams.get(screen);

		// If no stream exists but we have playlist data, create a new stream instance
		if (!stream && playlist.length > 0) {
			const currentItem = playlist.find(item => item.current);
			if (currentItem) {
				// Get screen configuration
				const screenConfig = this.config.player.screens.find(s => s.screen === screen);
				if (!screenConfig) {
					logger.warn(`No screen configuration found for screen ${screen}`, 'StreamManager');
					return;
				}

				// Create new stream instance
				stream = {
					id: Date.now(),
					screen,
					url: currentItem.filename,
					title: currentItem.title,
					quality: screenConfig.quality || this.config.player.defaultQuality,
					status: 'playing',
					platform: currentItem.filename.includes('youtube.com') ? 'youtube' : 'twitch',
					volume: screenConfig.volume || this.config.player.defaultVolume,
					process: null // Process will be attached when available
				};
				this.streams.set(screen, stream);
				logger.info(`Created new stream instance for screen ${screen}`, 'StreamManager');
			}
		}

		if (!stream) {
			logger.warn(`No active stream found for screen ${screen} during playlist update`, 'StreamManager');
			return;
		}

		// Update the stream's playlist
		stream.playlist = playlist.map(item => ({
			id: Date.now(),
			screen,
			url: item.filename,
			title: item.title,
			quality: stream.quality,
			status: item.current ? 'playing' : 'stopped',
			platform: item.filename.includes('youtube.com') ? 'youtube' : 'twitch',
			volume: stream.volume,
			process: item.current ? stream.process : null
		}));

		// Log the update
		logger.debug(
			`Updated playlist for screen ${screen} with ${playlist.length} items`,
			'StreamManager'
		);

		// Emit playlist update event
		this.emit('playlistUpdate', screen, stream.playlist);
	}

	/**
	 * Gets a list of all enabled screens
	 */
	getEnabledScreens(): number[] {
		// Get all enabled screens from the config
		return this.config.streams
			.filter(stream => stream.enabled)
			.map(stream => stream.screen);
	}

	/**
	 * Resets the refresh timestamps for specified screens
	 * @param screens Array of screen numbers to reset
	 */
	resetRefreshTimestamps(screens: number[]): void {
		logger.info(`Resetting refresh timestamps for screens: ${screens.join(', ')}`, 'StreamManager');

		screens.forEach(screen => {
			this.lastStreamRefresh.set(screen, 0);
		});
	}

	/**
	 * Filter streams to remove those that have been watched already
	 * @param streams The list of stream sources to filter
	 * @param screen The screen number
	 * @returns Filtered list of streams with watched ones removed
	 */
	private filterUnwatchedStreams(streams: StreamSource[], screen: number): StreamSource[] {
		// Get screen config
		const screenConfig = this.getScreenConfig(screen);
		if (!screenConfig) {
			logger.warn(`No config found for screen ${screen}, using default settings`, 'StreamManager');
		}

		// Check if we should skip watched streams
		// First check screen-specific setting, then global setting, default to true if neither is set
		const skipWatched = screenConfig?.skipWatchedStreams !== undefined ?
			screenConfig.skipWatchedStreams :
			(this.config.skipWatchedStreams !== undefined ? this.config.skipWatchedStreams : true);

		if (!skipWatched) {
			logger.info(`Watched stream skipping disabled for screen ${screen}`, 'StreamManager');
			return streams;
		}

		const unwatchedStreams = streams.filter((stream: StreamSource) => {
			const isWatched = this.isStreamWatched(stream.url);
			if (isWatched) {
				logger.debug(
					`Filtering out watched stream: ${stream.url} (${stream.title || 'No title'})`,
					'StreamManager'
				);
			}
			return !isWatched;
		});

		if (unwatchedStreams.length < streams.length) {
			logger.info(
				`Filtered out ${streams.length - unwatchedStreams.length} watched streams for screen ${screen}`,
				'StreamManager'
			);
		}

		return unwatchedStreams;
	}

	/**
	 * Updates the queue for a specific screen, optionally forcing a refresh
	 * @param screen Screen number
	 */
	async updateQueue(screen: number): Promise<void> {
		return safeAsync(async () => {
			const screenConfig = this.getScreenConfig(screen);
			if (!screenConfig || !screenConfig.enabled) {
				logger.debug(`Screen ${screen} is disabled or has no config, skipping queue update`, 'StreamManager');
				return;
			}

			// Get streams from all sources
			const streams = await this.getAllStreamsForScreen(screen);
			if (streams.length === 0) {
				logger.info(`No streams found for screen ${screen}, queue will be empty`, 'StreamManager');
			}

			// Log stream status distribution
			const liveCount = streams.filter(s => s.sourceStatus === 'live').length;
			const upcomingCount = streams.filter(s => s.sourceStatus === 'upcoming').length;
			const otherCount = streams.length - liveCount - upcomingCount;

			logger.info(
				`Stream status breakdown for screen ${screen}: ${liveCount} live, ${upcomingCount} upcoming, ${otherCount} other`,
				'StreamManager'
			);

			// Filter out watched streams based on configuration - fixed parameter type
			const filteredStreams = this.filterUnwatchedStreams(streams, screen);

			// Sort streams
			const sortedStreams = this.sortStreams(filteredStreams, screenConfig.sorting);

			// Update queue
			this.queues.set(screen, sortedStreams);
			queueService.setQueue(screen, sortedStreams);

			logger.info(
				`Updated queue for screen ${screen}: ${sortedStreams.length} streams (${streams.length - sortedStreams.length} filtered)`,
				'StreamManager'
			);

			// Emit queue update event
			this.emit('queueUpdate', { screen, queue: sortedStreams });
		}, `StreamManager:updateQueue:${screen}`, undefined);
	}

	private isStreamWatched(url: string): boolean {
		// Use queueService to check watched status
		return queueService.getWatchedStreams().includes(url);
	}

	/**
	 * Synchronize disabled screens from config to PlayerService
	 */
	private synchronizeDisabledScreens(): void {
		if (!this.config.player.screens) return;

		// Mark all disabled screens in the PlayerService
		for (const screenConfig of this.config.player.screens) {
			if (!screenConfig.enabled) {
				this.playerService.disableScreen(screenConfig.screen);
				logger.info(`Screen ${screenConfig.screen} marked as disabled during initialization`, 'StreamManager');
			}
		}
	}

	// Add method to force queue refresh
	public async forceQueueRefresh(): Promise<void> {
		return safeAsync(async () => {
			logger.info('Forcing queue refresh for all screens', 'StreamManager');

			// Save ALL existing streams to preserve them
			const existingStreams = new Map<number, StreamSource[]>();
			for (const [screen, queue] of this.queues.entries()) {
				if (queue.length > 0) {
					existingStreams.set(screen, [...queue]);
					logger.info(`Preserving ${queue.length} existing streams for screen ${screen}`, 'StreamManager');
				}
			}

			// Reset all refresh timestamps to force update
			this.lastStreamFetch = 0;

			// Get all enabled screens
			const enabledScreens = this.getEnabledScreens();

			// Clear last refresh timestamps for all screens to force fresh fetch
			for (const screen of enabledScreens) {
				this.lastStreamRefresh.set(screen, 0);
			}

			// Do NOT clear existing queues before fetching - we'll merge instead
			logger.info('Fetching fresh stream data for all screens', 'StreamManager');

			// Force update all queues
			await this.updateAllQueues();

			// After fetching new streams, restore preserved streams for each screen
			for (const [screen, preserved] of existingStreams.entries()) {
				const currentQueue = this.queues.get(screen) || [];

				// Avoid duplicates by creating a Set of URLs in the current queue
				const currentUrls = new Set(currentQueue.map(stream => stream.url));

				// Filter preserved streams to only include those not already in the queue
				const uniquePreserved = preserved.filter(stream => !currentUrls.has(stream.url));

				if (uniquePreserved.length > 0) {
					// Merge current queue with preserved streams
					const newQueue = [...currentQueue, ...uniquePreserved];

					// Update the queue
					this.queues.set(screen, newQueue);
					queueService.setQueue(screen, newQueue);

					logger.info(`Restored ${uniquePreserved.length} preserved streams for screen ${screen}`, 'StreamManager');
				}
			}
		}, 'StreamManager:forceQueueRefresh', undefined);
	}

	// Add network recovery handler
	private setupNetworkRecovery(): void {
		// Listen for network offline event
		queueService.networkEmitter.on('offline', () => {
			logger.warn('Network connection lost, pausing stream updates', 'StreamManager');
			this.isOffline = true;
		});

		// Listen for network online event
		queueService.networkEmitter.on('online', async () => {
			if (!this.isOffline) return; // Already online

			logger.info('Network connection restored, resuming stream updates', 'StreamManager');
			this.isOffline = false;

			try {
				// Force refresh all queues
				await this.forceQueueRefresh();

				// Get enabled screens
				const enabledScreens = this.getEnabledScreens();
				if (enabledScreens.length === 0) {
					logger.info('No enabled screens found after network recovery', 'StreamManager');
					return;
				}

				logger.info(`Processing ${enabledScreens.length} screens after network recovery`, 'StreamManager');

				// Handle each screen individually
				for (const screen of enabledScreens) {
					// Get current stream for this screen
					const activeStream = this.streams.get(screen);

					// Set temporarily to network recovery state
					await this.setScreenState(screen, StreamState.NETWORK_RECOVERY);

					try {
						// For screens with active streams that might have stalled
						if (activeStream) {
							logger.info(`Restarting stream on screen ${screen} after network recovery`, 'StreamManager');

							// Stop current stream
							await this.playerService.stopStream(screen, true);

							// Restart the same stream
							await this.startStream({
								url: activeStream.url,
								screen,
								quality: activeStream.quality || 'best',
								windowMaximized: true
							});
						}
						// For screens without streams, update the queue and start a stream
						else {
							logger.info(`Updating queue for screen ${screen} after network recovery`, 'StreamManager');

							// Force refresh streams
							this.lastStreamFetch = 0;

							// Update queue with fresh streams
							await this.updateQueue(screen);

							// Try to start a new stream from the queue
							const queue = this.queues.get(screen) || [];
							if (queue.length > 0) {
								const nextStream = queue[0];
								queue.shift();
								this.queues.set(screen, queue);

								logger.info(`Starting first stream in queue after network recovery: ${nextStream.url}`, 'StreamManager');

								await this.startStream({
									url: nextStream.url,
									screen,
									quality: 'best',
									windowMaximized: true
								});
							} else {
								logger.info(`No streams available after network recovery for screen ${screen}`, 'StreamManager');
								await this.setScreenState(screen, StreamState.IDLE);
							}
						}
					} catch (error) {
						logger.error(
							`Error processing screen ${screen} after network recovery`,
							'StreamManager',
							error instanceof Error ? error : new Error(String(error))
						);
						await this.setScreenState(screen, StreamState.ERROR);
					}
				}
			} catch (error) {
				logger.error(
					'Failed to handle network recovery',
					'StreamManager',
					error instanceof Error ? error : new Error(String(error))
				);
			}
		});
	}

	async refreshStreams(): Promise<void> {
		logger.info('Refreshing streams for all screens', 'StreamManager');
		for (const screen of this.screenConfigs.keys()) {
			await this.updateQueue(screen);
		}
	}

	/**
	 * Force refresh all streams and optionally restart them
	 * @param restart Whether to restart all streams after refreshing (default false)
	 */
	public async forceRefreshAll(restart: boolean = false): Promise<void> {
		logger.info(`Force refreshing all streams${restart ? ' and restarting them' : ' without restarting'}`, 'StreamManager');

		try {
			// Force refresh all queues first
			await this.forceQueueRefresh();

			if (restart) {
				// Only restart streams if explicitly requested
				logger.info('Restart parameter was set to true - restarting all streams', 'StreamManager');
				await this.restartStreams();
				logger.info('All streams have been restarted successfully', 'StreamManager');
			} else {
				logger.info('Streams will continue playing with current content - no restart requested', 'StreamManager');
			}
		} catch (error) {
			logger.error(
				'Failed to force refresh all streams',
				'StreamManager',
				error instanceof Error ? error : new Error(String(error))
			);
			throw error;
		}
	}

	// Add a method to periodically clean up finished streams
	private setupStreamCleanup(): void {
		// Periodically check for orphaned streams and clean them up
		const interval = setInterval(() => {
			if (this.isShuttingDown) {
				clearInterval(interval);
				return;
			}

			try {
				this.synchronizeStreams();
			} catch (error) {
				logger.error('Error in stream cleanup interval', 'StreamManager', error instanceof Error ? error : new Error(String(error)));
			}
		}, 60000); // Check every minute

		// Track if we're in the process of cleaning up
		let isCleaningUp = false;

		// Cleanup on shutdown
		this.cleanupHandler = () => {
			if (isCleaningUp) {
				logger.warn('Cleanup already in progress, forcing exit', 'StreamManager');
				process.exit(1);
				return;
			}

			isCleaningUp = true;
			clearInterval(interval);

			// Create a safety timeout in case cleanup hangs
			const safetyTimeout = setTimeout(() => {
				logger.error('Cleanup timed out after 8 seconds, forcing exit', 'StreamManager');
				process.exit(1);
			}, 8000);

			// Fix the void catch issue by using an async IIFE
			(async () => {
				try {
					logger.info('Starting cleanup process...', 'StreamManager');
					await this.cleanup();
					logger.info('Cleanup completed successfully', 'StreamManager');
					clearTimeout(safetyTimeout);
					// We don't call process.exit() here because we let the parent shutdown handler handle it
				} catch (error) {
					logger.error('Error during cleanup', 'StreamManager', error instanceof Error ? error : new Error(String(error)));
					clearTimeout(safetyTimeout);
					process.exit(1);
				}
			})();
		};

		// We don't directly handle SIGINT here anymore - the server's shutdown handler is responsible
	}

	/**
	 * Synchronize the stream manager's state with the player service
	 * to ensure no orphaned streams or inconsistencies
	 */
	private synchronizeStreams(): void {
		try {
			logger.debug(`Starting stream synchronization at ${new Date().toISOString()}`, 'StreamManager');

			// Get active streams from player service
			const playerStreams = this.playerService.getActiveStreams();
			const playerScreens = new Set(playerStreams.map(stream => stream.screen));

			// Get active streams from stream manager
			const managerScreens = new Set(this.streams.keys());

			// Log current state
			logger.debug(`Stream synchronization - Manager screens: [${Array.from(managerScreens).join(', ')}], Player screens: [${Array.from(playerScreens).join(', ')}]`, 'StreamManager');

			// More detailed logging about the actual stream instances
			if (playerStreams.length > 0) {
				const streamDetails = playerStreams.map(stream =>
					`{screen: ${stream.screen}, url: ${stream.url?.substring(0, 30)}..., status: ${stream.status}}`
				).join(', ');
				logger.debug(`Player service has ${playerStreams.length} active streams: ${streamDetails}`, 'StreamManager');
			}

			if (this.streams.size > 0) {
				const managerStreamDetails = Array.from(this.streams.entries())
					.map(([screen, stream]) => `{screen: ${screen}, url: ${stream.url?.substring(0, 30)}...}`)
					.join(', ');
				logger.debug(`Stream manager has ${this.streams.size} tracked streams: ${managerStreamDetails}`, 'StreamManager');
			}

			// Check for streams that exist in player but not in manager
			for (const screen of playerScreens) {
				if (!managerScreens.has(screen)) {
					logger.warn(`Orphaned stream found on screen ${screen} - stopping it`, 'StreamManager');
					this.playerService.stopStream(screen, true).catch(error => {
						logger.error(`Failed to stop orphaned stream on screen ${screen}`, 'StreamManager', error instanceof Error ? error : new Error(String(error)));
					});
				}
			}

			// Check for streams that exist in manager but not in player
			for (const screen of managerScreens) {
				if (!playerScreens.has(screen)) {
					logger.warn(`Stream in manager but not in player for screen ${screen} - cleaning up`, 'StreamManager');
					this.streams.delete(screen);
					this.clearStreamRefresh(screen);
					this.clearInactiveTimer(screen);
				}
			}

			// Update the disabled screens in player service
			this.synchronizeDisabledScreens();

			logger.debug(`Completed stream synchronization at ${new Date().toISOString()}`, 'StreamManager');
		} catch (error) {
			logger.error('Error synchronizing streams', 'StreamManager', error instanceof Error ? error : new Error(String(error)));
		}
	}

	private async getAllStreamsForScreen(screen: number): Promise<StreamSource[]> {
		const screenConfig = this.getScreenConfig(screen);
		if (!screenConfig || !screenConfig.sources?.length) {
			return [];
		}

		const streams: StreamSource[] = [];
		for (const source of screenConfig.sources) {
			if (!source.enabled) continue;

			try {
				let sourceStreams: StreamSource[] = [];
				if (source.type === 'holodex') {
					if (source.subtype === 'organization' && source.name) {
						sourceStreams = await this.holodexService.getLiveStreams({
							organization: source.name,
							limit: source.limit
						});
					} else if (source.subtype === 'favorites') {
						sourceStreams = await this.holodexService.getLiveStreams({
							channels: this.getFlattenedFavorites('holodex'),
							limit: source.limit
						});
					}
				} else if (source.type === 'twitch') {
					if (source.subtype === 'favorites') {
						sourceStreams = await this.twitchService.getStreams({
							channels: this.getFlattenedFavorites('twitch'),
							limit: source.limit
						});
					}
				}

				// Filter out finished streams (keep live and upcoming)
				sourceStreams = sourceStreams.filter(stream => {
					// For YouTube/Holodex, sourceStatus could be 'live', 'upcoming', or 'ended'
					if (stream.sourceStatus === 'ended') {
						logger.debug(`Filtering out ended stream: ${stream.url}`, 'StreamManager');
						return false;
					}

					// For upcoming streams, check if they're in the past
					if (stream.sourceStatus === 'upcoming' && stream.startTime) {
						const now = Date.now();
						// If the start time is in the past by more than 30 minutes, filter it out
						if (stream.startTime < now - 30 * 60 * 1000) {
							logger.debug(`Filtering out past upcoming stream: ${stream.url}`, 'StreamManager');
							return false;
						}
					}

					return true;
				});

				// Add source metadata to streams
				sourceStreams.forEach(stream => {
					stream.subtype = source.subtype;
					stream.priority = source.priority;
					stream.screen = screen;
				});

				streams.push(...sourceStreams);
			} catch (error) {
				logger.error(
					`Failed to fetch streams for source ${source.type}/${source.subtype}`,
					'StreamManager',
					error instanceof Error ? error : new Error(String(error))
				);
			}
		}

		logger.info(`Retrieved ${streams.length} total streams for screen ${screen}`, 'StreamManager');
		return streams;
	}

	/**
	 * Helper method to get a flattened array of channel IDs across all groups for a platform
	 * @param platform The platform to get favorites for (holodex, twitch, youtube)
	 * @returns Array of channel IDs from all groups
	 */
	private getFlattenedFavorites(platform: 'holodex' | 'twitch' | 'youtube'): string[] {
		if (!this.favoriteChannels || !this.favoriteChannels[platform]) {
			return [];
		}

		// Get all groups for this platform and flatten them into a single array
		const platformFavorites = this.favoriteChannels[platform];
		const allChannels: string[] = [];

		// Sort groups by priority (lower number = higher priority)
		const groupNames = Object.keys(platformFavorites);
		const sortedGroups = groupNames.sort((a, b) => {
			const priorityA = this.favoriteChannels.groups[a]?.priority || 999;
			const priorityB = this.favoriteChannels.groups[b]?.priority || 999;
			return priorityA - priorityB;
		});

		// Add channels from each group, maintaining priority order
		for (const groupName of sortedGroups) {
			const channelsInGroup = platformFavorites[groupName] || [];
			for (const channelId of channelsInGroup) {
				if (!allChannels.includes(channelId)) {
					allChannels.push(channelId);
				}
			}
		}

		return allChannels;
	}

	/**
	 * Helper method to check if a channel is in any favorite group for a platform
	 * @param platform The platform to check (holodex, twitch, youtube)
	 * @param channelId The channel ID to check for
	 * @returns True if the channel is in any favorite group for the platform
	 */
	private isChannelInFavorites(platform: 'holodex' | 'twitch' | 'youtube', channelId: string): boolean {
		if (!this.favoriteChannels || !this.favoriteChannels[platform]) {
			return false;
		}

		const platformFavorites = this.favoriteChannels[platform];

		// Check each group for the channel ID
		for (const groupName in platformFavorites) {
			if (platformFavorites[groupName]?.includes(channelId)) {
				return true;
			}
		}

		return false;
	}

	private sortStreams(streams: StreamSource[], sorting?: { field: string; order: 'asc' | 'desc' }): StreamSource[] {
		if (!sorting) return streams;

		const { field, order } = sorting;

		return [...streams].sort((a, b) => {
			// Handle undefined values
			const aValue = a[field as keyof StreamSource];
			const bValue = b[field as keyof StreamSource];

			if (aValue === undefined && bValue === undefined) return 0;
			if (aValue === undefined) return order === 'asc' ? 1 : -1;
			if (bValue === undefined) return order === 'asc' ? -1 : 1;

			// Compare values based on their types
			if (typeof aValue === 'number' && typeof bValue === 'number') {
				return order === 'asc' ? aValue - bValue : bValue - aValue;
			}

			if (typeof aValue === 'string' && typeof bValue === 'string') {
				return order === 'asc'
					? aValue.localeCompare(bValue)
					: bValue.localeCompare(aValue);
			}

			// Default comparison for other types
			const aStr = String(aValue);
			const bStr = String(bValue);
			return order === 'asc' ? aStr.localeCompare(bStr) : bStr.localeCompare(aStr);
		});
	}

	// Add the missing method
	private async addDefaultTestStream(screen: number): Promise<void> {
		logger.info(`Adding default test stream for screen ${screen}`, 'StreamManager');

		try {
			// Default test streams - try YouTube first, then Twitch
			const testStreams = [
				{
					url: 'https://www.youtube.com/watch?v=jfKfPfyJRdk', // YouTube lofi beats
					title: 'Default Test Stream - YouTube',
					platform: 'youtube'
				},
				{
					url: 'https://www.twitch.tv/twitchpresents',
					title: 'Default Test Stream - Twitch',
					platform: 'twitch'
				}
			];

			// Try to add the first test stream
			const testStream = testStreams[0];
			const source: StreamSource = {
				url: testStream.url,
				title: testStream.title,
				platform: testStream.platform as 'youtube' | 'twitch',
				viewerCount: 100,
				thumbnail: '',
				sourceStatus: 'live',
				startTime: Date.now(),
				priority: 1,
				screen
			};

			// Use queueService to add to queue
			await this.addToQueue(screen, source);

			// Try to start the stream immediately
			const result = await this.startStream({
				url: source.url,
				screen,
				quality: 'best',
				windowMaximized: true
			});

			if (result.success) {
				logger.info(`Added and started default test stream for screen ${screen}`, 'StreamManager');
				await this.setScreenState(screen, StreamState.PLAYING);
			} else {
				logger.warn(`Failed to start default test stream for screen ${screen}: ${result.error}`, 'StreamManager');
				await this.setScreenState(screen, StreamState.ERROR);
			}
		} catch (error) {
			logger.error(
				`Failed to add default test stream for screen ${screen}`,
				'StreamManager',
				error instanceof Error ? error : new Error(String(error))
			);
			await this.setScreenState(screen, StreamState.ERROR);
		}
	}

	// Add the missing initializeScreenConfigs method
	private initializeScreenConfigs(): void {
		// Initialize screenConfigs from config
		this.screenConfigs = new Map(this.config.player.screens.map(screen => [
			screen.screen,
			{
				screen: screen.screen,
				id: screen.id,
				enabled: screen.enabled,
				volume: this.config.player.defaultVolume,
				quality: this.config.player.defaultQuality,
				windowMaximized: this.config.player.windowMaximized,
				sources: screen.sources || [],
				sorting: screen.sorting || { field: 'viewerCount', order: 'desc' },
				refresh: screen.refresh || 300,
				autoStart: screen.autoStart !== undefined ? screen.autoStart : true
			}
		]));

		logger.info(`Initialized ${this.screenConfigs.size} screen configurations`, 'StreamManager');
	}

	// Add the missing setupEventListeners method
	private setupEventListeners(): void {
		// Set up stream error handler
		this.playerService.onStreamError(async (data: StreamError) => {
			// If screen was manually closed, ignore error
			if (this.manuallyClosedScreens.has(data.screen)) {
				logger.info(`Ignoring error for manually closed screen ${data.screen}`, 'StreamManager');
				return;
			}

			logger.info(`Stream error on screen ${data.screen}: ${data.error}`, 'StreamManager');

			// Use withLock to ensure exclusive access during error handling
			await this.withLock(data.screen, 'handleError', async () => {
				try {
					if (data.shouldRestart) {
						// If stream crashed with non-zero exit code, try to restart the same stream
						logger.info(`Stream crashed with code ${data.code}, attempting to restart same stream on screen ${data.screen}`, 'StreamManager');

						// Get current stream URL
						const url = data.url;
						if (url) {
							// Try to restart the same stream
							await this.setScreenState(data.screen, StreamState.STARTING);

							const result = await this.startStream({
								url: url,
								screen: data.screen,
								quality: this.config.player.defaultQuality || 'best',
								windowMaximized: true
							});

							if (result.success) {
								logger.info(`Successfully restarted crashed stream on screen ${data.screen}`, 'StreamManager');
								await this.setScreenState(data.screen, StreamState.PLAYING);
							} else {
								logger.error(`Failed to restart crashed stream on screen ${data.screen}, will try queue: ${result.error}`, 'StreamManager');
								await this.handleStreamEnd(data.screen);
							}
						} else {
							logger.error(`No URL available to restart stream on screen ${data.screen}, will try queue`, 'StreamManager');
							await this.handleStreamEnd(data.screen);
						}
					} else if (data.moveToNext) {
						// Normal stream end or error where we should move to next stream
						logger.info(`Moving to next stream in queue for screen ${data.screen}`, 'StreamManager');
						await this.handleStreamEnd(data.screen);
					} else {
						// Default behavior for backward compatibility
						await this.handleStreamEnd(data.screen);
					}
				} catch (error) {
					logger.error(`Error handling stream error on screen ${data.screen}`, 'StreamManager',
						error instanceof Error ? error : new Error(String(error)));
				}
			});
		});

		// Set up queue update notifications
		queueService.on('queue:updated', (screen, queue) => {
			this.queues.set(screen, queue);
			logger.debug(`Queue updated for screen ${screen}, size: ${queue.length}`, 'StreamManager');
		});

		queueService.on('queue:empty', (screen) => {
			logger.info(`Queue is empty for screen ${screen}, handling empty queue`, 'StreamManager');
			this.handleEmptyQueue(screen).catch(error => {
				logger.error(`Failed to handle empty queue for screen ${screen}`, 'StreamManager',
					error instanceof Error ? error : new Error(String(error)));
			});
		});

		logger.info('Event listeners set up', 'StreamManager');
	}

	// Add compatibility methods that do nothing, for backwards compatibility
	// These will be removed once we've updated all calling code
	private clearTimers(_screen: number): void {
		// No-op, for backwards compatibility
	}

	private clearQueueProcessingTimeout(_screen: number): void {
		// No-op, for backwards compatibility
	}

	private clearInactiveTimer(_screen: number): void {
		// No-op, for backwards compatibility
	}

	private clearStreamRefresh(_screen: number): void {
		// No-op, for backwards compatibility
	}

	/**
	 * Sorts streams based on favorite group priorities, then live status, then viewer count
	 * @param streams List of streams to sort
	 * @returns Sorted stream list
	 */
	private sortStreamsByPriority(streams: StreamSource[]): StreamSource[] {
		return [...streams].sort((a, b) => {
			// Get group priorities (default to lowest priority if not found)
			const aGroupPriority = this.getChannelGroupPriority(a.channelId, a.platform) || 999;
			const bGroupPriority = this.getChannelGroupPriority(b.channelId, b.platform) || 999;

			// First sort by group priority
			if (aGroupPriority !== bGroupPriority) {
				return aGroupPriority - bGroupPriority;
			}

			// Then by live status
			if (a.sourceStatus === 'live' && b.sourceStatus !== 'live') return -1;
			if (a.sourceStatus !== 'live' && b.sourceStatus === 'live') return 1;

			// Finally by viewer count
			return (b.viewerCount || 0) - (a.viewerCount || 0);
		});
	}

	/**
	 * Gets the priority of the favorite group a channel belongs to
	 * @param channelId Channel ID
	 * @param platform Platform (youtube, twitch, holodex)
	 * @returns Priority number (lower is higher priority) or undefined if not in favorites
	 */
	private getChannelGroupPriority(channelId?: string, platform?: string): number | undefined {
		if (!channelId || !platform) return undefined;

		// Map platform names to favorite channel keys
		const platformKey = platform === 'youtube' ? 'youtube' :
			platform === 'twitch' ? 'twitch' : 'holodex';

		// Find which group this channel belongs to
		for (const [groupName, group] of Object.entries(this.favoriteChannels.groups)) {
			const channelList = this.favoriteChannels[platformKey as keyof typeof this.favoriteChannels]?.[groupName];
			// Add a type guard to ensure channelList is an array
			if (Array.isArray(channelList) && channelList.includes(channelId)) {
				return group.priority;
			}
		}

		return undefined;
	}

	/**
	 * Toggle a screen's enabled state
	 */
	async toggleScreen(screen: number): Promise<boolean> {
		return this.withLock(screen, 'toggleScreen', async () => {
			logger.info(`Toggling screen ${screen} state`, 'StreamManager');

			const screenConfig = this.getScreenConfig(screen);
			if (!screenConfig) {
				logger.warn(`No configuration found for screen ${screen}, cannot toggle`, 'StreamManager');
				return false;
			}

			const isCurrentlyEnabled = screenConfig.enabled;
			if (isCurrentlyEnabled) {
				await this.disableScreen(screen, true); // Use fast disable for better responsiveness
				logger.info(`Screen ${screen} toggled to disabled`, 'StreamManager');
				return false; // Now disabled
			} else {
				await this.enableScreen(screen);
				logger.info(`Screen ${screen} toggled to enabled`, 'StreamManager');
				return true; // Now enabled
			}
		});
	}
}

// Create singleton instance
const config = loadAllConfigs();
// Create flattened favorites arrays for services
const flattenedHolodexFavorites: string[] = [];
if (config.favoriteChannels && config.favoriteChannels.holodex) {
	Object.values(config.favoriteChannels.holodex).forEach(channels => {
		if (Array.isArray(channels)) {
			flattenedHolodexFavorites.push(...channels);
		}
	});
}

const holodexService = new HolodexService(
	env.HOLODEX_API_KEY,
	config.filters?.filters ? config.filters.filters.map(f => typeof f === 'string' ? f : f.value) : [],
	flattenedHolodexFavorites,
	config
);
const twitchService = new TwitchService(
	env.TWITCH_CLIENT_ID,
	env.TWITCH_CLIENT_SECRET,
	config.filters?.filters ? config.filters.filters.map(f => typeof f === 'string' ? f : f.value) : []
);
// Create flattened YouTube favorites array
const flattenedYoutubeFavorites: string[] = [];
if (config.favoriteChannels && config.favoriteChannels.youtube) {
	Object.values(config.favoriteChannels.youtube).forEach(channels => {
		if (Array.isArray(channels)) {
			flattenedYoutubeFavorites.push(...channels);
		}
	});
}

const youtubeService = new YouTubeService(
	flattenedYoutubeFavorites
);
const playerService = new PlayerService(config);

export const streamManager = new StreamManager(
	config,
	holodexService,
	twitchService,
	youtubeService,
	playerService
); 