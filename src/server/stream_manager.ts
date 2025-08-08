import type {
	Config,
	FavoriteChannels,
	PlayerSettings,
	ScreenConfig,
	StreamOptions,
	StreamResponse,
	StreamSource
} from '../types/stream.js';
import type { StreamError, StreamInstance, StreamPlatform } from '../types/stream_instance.js';
import { logger } from './services/logger.js';
import { loadAllConfigs } from '../config/loader.js';
import { TwitchService } from './services/twitch.js';
import { HolodexService } from './services/holodex.js';
import { PlayerService } from './services/player.js';
import { env } from '../config/env.js';
import { queueService } from './services/queue_service.js';
import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import { KeyboardService } from './services/keyboard_service.js';
import './types/events.js';
import { parallelOps, safeAsync } from './utils/async_helpers.js';
import { SimpleMutex } from './utils/mutex.js';
import { isYouTubeStreamLive } from './utils/youtube_utils.js';

// Improve the StreamState enum with proper state machine transitions
enum StreamState {
	IDLE = 'idle', // No stream running
	STARTING = 'starting', // Stream is being started
	PLAYING = 'playing', // Stream is running
	STOPPING = 'stopping', // Stream is being stopped
	DISABLED = 'disabled', // Screen is disabled
	ERROR = 'error', // Error state
	NETWORK_RECOVERY = 'network_recovery' // Recovering from network issues
}

async function timeoutPromise<T>(promise: Promise<T>, ms: number): Promise<T> {
	const timeout = new Promise<T>((_, reject) => setTimeout(() => reject(new Error('Timeout')), ms));
	return Promise.race([promise, timeout]);
}

// Add stream state machine to handle transitions
class StreamStateMachine {
	private currentState: StreamState = StreamState.IDLE;
	readonly screen: number;

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
			[StreamState.IDLE]: [
				StreamState.STARTING,
				StreamState.DISABLED,
				StreamState.NETWORK_RECOVERY
			],
			[StreamState.STARTING]: [StreamState.PLAYING, StreamState.ERROR, StreamState.STOPPING],
			[StreamState.PLAYING]: [
				StreamState.STOPPING,
				StreamState.ERROR,
				StreamState.NETWORK_RECOVERY
			],
			[StreamState.STOPPING]: [StreamState.IDLE, StreamState.ERROR],
			[StreamState.DISABLED]: [StreamState.IDLE],
			[StreamState.ERROR]: [StreamState.IDLE, StreamState.STARTING, StreamState.NETWORK_RECOVERY],
			[StreamState.NETWORK_RECOVERY]: [StreamState.IDLE, StreamState.STARTING, StreamState.ERROR]
		};

		if (!validTransitions[this.currentState].includes(newState) && this.currentState !== newState) {
			logger.warn(
				`Invalid state transition for screen ${this.screen}: ${this.currentState} -> ${newState}`,
				'StreamManager'
			);
			return false;
		}

		logger.info(
			`Screen ${this.screen} state transition: ${this.currentState} -> ${newState}`,
			'StreamManager'
		);

		// Execute callback if provided (for any setup/teardown during transition)
		if (callback) {
			await callback();
		}

		// Update the state
		this.currentState = newState;
		return true;
	}
	//set state
	setState(newState: StreamState) {
		this.currentState = newState;
	}
}

/**
 * Manages multiple video streams across different screens
 */
export class StreamManager extends EventEmitter {
	// Core dependencies
	readonly config: Config;
	private twitchService: TwitchService;
	private holodexService: HolodexService;
	private playerService: PlayerService;
	private keyboardService: KeyboardService;
	private isShuttingDown = false;

	// Active streams and their states
	private streams: Map<number, StreamInstance> = new Map();
	private screenMutexes: Map<number, SimpleMutex> = new Map();

	// User preferences
	readonly favoriteChannels: FavoriteChannels;
	private manuallyClosedScreens: Set<number> = new Set();
	private screenConfigs: Map<number, ScreenConfig> = new Map();

	// Simplified queues management
	private queues: Map<number, StreamSource[]> = new Map();

	// Network state
	private isOffline = false;

	// Path storage
	private fifoPaths: Map<number, string> = new Map();
	private ipcPaths: Map<number, string> = new Map();

	// Constants - keep these for configuration
	private readonly QUEUE_UPDATE_INTERVAL = 60 * 1000; // 1 minute

	// Replace screenStates Map with stateMachines Map
	private stateMachines: Map<number, StreamStateMachine> = new Map();

	// Simplified, single interval for queue management
	private queueUpdateInterval: NodeJS.Timeout | null = null;

	// Track streams that failed to start to avoid infinite retry loops
	private failedStreamAttempts: Map<string, { timestamp: number; count: number }> = new Map();
	private readonly MAX_STREAM_ATTEMPTS = 2;
	private readonly STREAM_FAILURE_RESET_TIME = 3600000; // 1 hour in ms

	// Add a map to track when screens entered the STARTING state
	private screenStartingTimestamps: Map<number, number> = new Map();
	private readonly MAX_STARTING_TIME = 30000; // 30 seconds max in starting state

	// Add a set to track screens that are currently being processed
	private processingScreens: Set<number> = new Set();
	private readonly DEFAULT_LOCK_TIMEOUT = 2000; // 15 seconds
	private readonly RETRY_TIMEOUT = 20000; // 15 seconds
	private readonly ERROR_HANDLER_TIMEOUT = 60000; // 60 seconds for error handling
	private readonly OPERATION_TIMEOUT = 5000; // 30 seconds for normal operations
	private retryTimers: Map<number, NodeJS.Timeout> = new Map();
	private networkRetries: Map<number, number> = new Map();
	private lastNetworkError: Map<number, number> = new Map();

	// Add new properties at the top of the class
	private watchedStreams: Map<string, number> = new Map(); // URL -> timestamp
	private readonly MAX_WATCHED_STREAMS = 8;
	private readonly WATCHED_STREAM_RESET_TIME = 10 * 60 * 60 * 1000;

	constructor(
		config: Config,
		holodexService: HolodexService,
		twitchService: TwitchService,
		playerService: PlayerService
	) {
		super();
		this.config = config;
		this.holodexService = holodexService;
		this.twitchService = twitchService;
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
		this.startQueueUpdates().catch((error) => {
			logger.error('Failed to start queue updates', error, 'StreamManager');
		});

		logger.info('StreamManager initialized', 'StreamManager');
	}

	// Initialize state machines for all screens
	private initializeStateMachines(): void {
		this.config.streams.forEach((streamConfig) => {
			const screen = streamConfig.screen;
			const initialState = streamConfig.enabled ? StreamState.IDLE : StreamState.DISABLED;
			this.stateMachines.set(screen, new StreamStateMachine(screen, initialState));
		});
		logger.info('Stream state machines initialized', 'StreamManager');
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

		logger.info(
			`Queue updates started with ${this.QUEUE_UPDATE_INTERVAL / 60000} minute interval`,
			'StreamManager'
		);
	}

	private stopQueueUpdates() {
		if (this.queueUpdateInterval !== null) {
			clearInterval(this.queueUpdateInterval);
			this.queueUpdateInterval = null;
			logger.info('Queue updates stopped', 'StreamManager');
		}
	}

	/**
	 * Updates stream queues for all enabled screens in parallel
	 * Processes each screen independently with proper error handling
	 */
	public async updateAllQueues() {
		if (this.isShuttingDown) {
			logger.debug('Skipping queue update - shutdown in progress', 'StreamManager');
			return;
		}

		// Get list of enabled screens that aren't currently being processed
		const screensToProcess = this.config.streams
			.filter(s => s.enabled && !this.processingScreens.has(s.screen))
			.map(s => s.screen);

		if (screensToProcess.length === 0) {
			logger.debug('No screens to process for queue update', 'StreamManager');
			return;
		}

		logger.info(`Updating queues for ${screensToProcess.length} screens`, 'StreamManager');

		// Process all screens in parallel with individual error handling
		await Promise.allSettled(
			screensToProcess.map(screen => 
				this.withLock(screen, 'updateSingleScreen', () => this.updateSingleScreen(screen))
				.catch(error => {
					logger.error(
						`Failed to update queue for screen ${screen}`,
						'StreamManager',
						error instanceof Error ? error : new Error(String(error))
					);
				})
			)
		);
	}
	
	/**
	 * Updates the queue for a single screen and starts a stream if needed
	 * @param screen The screen number to update
	 */
	private async updateSingleScreen(screen: number): Promise<void> {
		// Mark this screen as being processed
		this.processingScreens.add(screen);

		try {
			const currentState = this.getScreenState(screen);

			// Quick state checks first
			if (currentState === StreamState.STARTING) {
				this.handleStuckStarting(screen);
				return;
			}

			// Skip if screen is disabled or already has an active stream
			if (currentState === StreamState.DISABLED) {
				return;
			}

			const activeStream = this.streams.get(screen);
			if (activeStream) {
				logger.debug(`Screen ${screen} already has an active stream`, 'StreamManager');
				return;
			}

			// Reset ERROR state to IDLE to allow retries
			if (currentState === StreamState.ERROR) {
				this.setScreenState(screen, StreamState.IDLE);
			}

			// Only proceed if in IDLE state
			if (this.getScreenState(screen) !== StreamState.IDLE) {
				return;
			}

			// Update the queue for this screen
			await this.updateQueue(screen);

			// Get the queue and start a stream if available
			const queue = this.queues.get(screen) || [];
			if (queue.length > 0) {
				// Use non-blocking call to start stream
				this.tryStartStreamAsync(screen).catch(error => {
					logger.error(
						`Failed to start stream on screen ${screen}`,
						'StreamManager',
						error instanceof Error ? error : new Error(String(error))
					);
				});
			} else {
				logger.debug(`No streams in queue for screen ${screen}`, 'StreamManager');
			}
		} catch (error) {
			logger.error(
				`Error in updateSingleScreen for screen ${screen}`,
				'StreamManager',
				error instanceof Error ? error : new Error(String(error))
			);
		} finally {
			// Always remove from processing set when done
			this.processingScreens.delete(screen);
		}
	}
	
	/**
	 * Attempts to start a stream on the specified screen with a short timeout
	 * Runs asynchronously and handles retries automatically
     * @param screen The screen number to start the stream on
     * @param retryCount Number of retry attempts made so far
     */
	private async tryStartStreamAsync(screen: number, retryCount = 0): Promise<void> {
		// Skip if screen is not in a valid state to start a stream
		const currentState = this.getScreenState(screen);
		if (currentState !== StreamState.IDLE && currentState !== StreamState.ERROR) {
			logger.debug(`Screen ${screen} is in state ${currentState}, skipping stream start`, 'StreamManager');
			return;
		}

		try {
			// Get a local copy of the queue to work with
			const queue = [...(this.queues.get(screen) || [])];
			
			if (queue.length === 0) {
				// If we've already retried too many times, give up
				if (retryCount >= 3) {
					logger.warn(`No streams in queue for screen ${screen} after ${retryCount} retries`, 'StreamManager');
					return;
				}

				// Try to update the queue and retry
				logger.debug(`No streams in queue for screen ${screen}, updating queue...`, 'StreamManager');
				await this.updateQueue(screen);
				
				// Schedule a retry with backoff
				setTimeout(() => this.tryStartStreamAsync(screen, retryCount + 1), 500 * (retryCount + 1));
				return;
			}

			const [nextStream, ...remainingQueue] = queue;
			
			// Update state to STARTING before attempting to start
			this.setScreenState(screen, StreamState.STARTING);
			
			// Log the attempt
			logger.info(`Attempting to start stream on screen ${screen}: ${nextStream.url}`, 'StreamManager');
			
			// Start stream with a short timeout
			const result = await timeoutPromise(
				this.startStream({
					url: nextStream.url,
					screen,
					quality: this.config.player.defaultQuality,
					title: nextStream.title,
					viewerCount: nextStream.viewerCount,
					startTime: nextStream.startTime
				}),
				3000 // 3 second timeout for stream start
			);

			// Handle the result
			if (result.success) {
				// Success - remove from queue and update state
				this.queues.set(screen, remainingQueue);
				this.setScreenState(screen, StreamState.PLAYING);
				logger.info(`Successfully started stream on screen ${screen}`, 'StreamManager');
			} else {
				// Failed to start stream - log and try next in queue
				logger.warn(
					`Failed to start stream on screen ${screen}: ${result.error || 'Unknown error'}`,
					'StreamManager'
				);
				
				// Update queue and state
				this.queues.set(screen, remainingQueue);
				this.setScreenState(screen, StreamState.IDLE);
				
				// If we have more streams to try, schedule a retry with backoff
				if (remainingQueue.length > 0) {
					const backoffTime = Math.min(1000 * (retryCount + 1), 5000); // Max 5s backoff
					setTimeout(() => this.tryStartStreamAsync(screen, retryCount + 1), backoffTime);
				} else {
					// No more streams in queue, update queue and retry
					setTimeout(() => this.tryStartStreamAsync(screen, retryCount + 1), 1000);
				}
			}
		} catch (error) {
			// Handle any unexpected errors
			const errorMessage = error instanceof Error ? error.message : String(error);
			logger.error(
				`Unexpected error starting stream on screen ${screen}: ${errorMessage}`,
				'StreamManager',
				error
			);
			
			// Reset state to IDLE to allow retries
			this.setScreenState(screen, StreamState.IDLE);
			
			// If we have more retries left, schedule one
			if (retryCount < 3) {
				setTimeout(() => this.tryStartStreamAsync(screen, retryCount + 1), 1000 * (retryCount + 1));
			} else {
				logger.error(
					`Giving up on screen ${screen} after ${retryCount} retries`,
					'StreamManager'
				);
			}
		}
	}
	/**
	 * Safely transitions a screen to a new state with optional error and force flags
	 * @param screen The screen number to update
	 * @param state The new state to transition to
	 * @param error Optional error information for ERROR state
	 * @param force If true, forces the state transition even if it's not a valid transition
	 * @returns boolean indicating if the state was successfully updated
	 */
	private setScreenState(
		screen: number,
		state: StreamState,
		error?: Error,
		force = false
	): boolean {
		const stateMachine = this.stateMachines.get(screen);
		if (!stateMachine) {
			logger.warn(`No state machine found for screen ${screen}`, 'StreamManager');
			return false;
		}

		const currentState = stateMachine.getState();
		
		// Skip if already in the target state
		if (currentState === state) {
			return true;
		}

		try {
			// If forcing, bypass state machine validation
			if (force) {
				stateMachine.setState(state);
			} else {
				// Let the state machine handle the transition
				stateMachine.transition(state);
			}

			// Log the state transition
			const logMessage = error 
				? `Screen ${screen} state: ${currentState} -> ${state} (Error: ${error.message})`
			: `Screen ${screen} state: ${currentState} -> ${state}`;

			// Use appropriate log level based on state
			if (state === StreamState.ERROR) {
				logger.error(logMessage, 'StreamManager');
			} else if (state === StreamState.STARTING || state === StreamState.STOPPING) {
				logger.debug(logMessage, 'StreamManager');
			} else {
				logger.info(logMessage, 'StreamManager');
			}

			return true;
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			logger.error(
				`Failed to transition screen ${screen} from ${currentState} to ${state}: ${errorMessage}`,
				'StreamManager'
			);
			return false;
		}
	}
	/**
	 * Handles stuck STARTING state by resetting to IDLE and logging the issue
	 * @param screen The screen number that's stuck in STARTING state
	 */
	private handleStuckStarting(screen: number): void {
		logger.warn(
			`Screen ${screen} appears to be stuck in STARTING state. Resetting to IDLE.`,
			'StreamManager'
		);
		this.setScreenState(screen, StreamState.IDLE);
	}

	/**
	 * Gets the current state of a screen
	 * @param screen The screen number to check
	 * @returns The current StreamState of the screen
	 */
	private getScreenState(screen: number): StreamState {
		if (!this.stateMachines.has(screen)) {
			this.stateMachines.set(screen, new StreamStateMachine(screen));
		}
		
		const stateMachine = this.stateMachines.get(screen)!;
		const currentState = stateMachine.getState();
		
		// If we think we're playing, verify the stream is actually working
		if (currentState === StreamState.PLAYING) {
			const stream = this.streams.get(screen);
			if (!stream || !this.isStreamHealthy(stream)) {
				// Stream is dead/unhealthy, transition to error
				logger.warn(`Stream on screen ${screen} appears unhealthy, transitioning to error state`, 'StreamManager');
				this.setScreenState(screen, StreamState.ERROR, undefined, true);
				return StreamState.ERROR;
			}
		}
		
		return currentState;
	}
	
	private isStreamHealthy(stream: StreamInstance): boolean {
		// Check if process is alive AND if it's actually streaming
		// This is where you'd check for recent data, network connectivity, etc.
		return this.playerService.getActiveStreams().some(s => s.screen === stream.screen) && this.playerService.isStreamHealthy(stream.screen);	
	}
private async withLock<T>(
		screen: number,
		operation: string,
		callback: () => Promise<T>
	): Promise<T> {
		if (!this.screenMutexes.has(screen)) {
			this.screenMutexes.set(screen, new SimpleMutex(logger, `Screen${screen}Mutex`));
		}
		const mutex = this.screenMutexes.get(screen)!;

		// Generate a unique operation ID for tracking
		const opId = `${operation}_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;

		let release: (() => void) | null = null;
		try {
			logger.debug(
				`Attempting to acquire lock for screen ${screen} during ${operation} (${opId})`,
				'StreamManager'
			);

			// Use longer timeout for error handling
			const lockTimeout =
				operation === 'handleError' ? this.ERROR_HANDLER_TIMEOUT : this.DEFAULT_LOCK_TIMEOUT;
			release = await mutex.acquire(lockTimeout, opId, operation);

			logger.debug(
				`Acquired lock for screen ${screen} during ${operation} (${opId})`,
				'StreamManager'
			);

			// Add timeout protection for the operation itself
			const operationTimeout =
				operation === 'handleError' ? this.ERROR_HANDLER_TIMEOUT : this.OPERATION_TIMEOUT;

			return await Promise.race([
				callback(),
				new Promise<T>((_, reject) => {
					setTimeout(() => {
						reject(new Error(`Operation ${operation} timed out after ${operationTimeout / 1000}s`));
					}, operationTimeout);
				})
			]);
		} catch (err) {
			logger.error(
				`Error inside lock for screen ${screen} during ${operation} (${opId}): ${err}`,
				'StreamManager'
			);

			// If this was a timeout, try to recover
			if (err instanceof Error && err.message.includes('timeout')) {
				logger.warn(
					`Attempting recovery for screen ${screen} after timeout in ${operation}`,
					'StreamManager'
				);
				try {
					// Force stop any active stream without waiting
					this.playerService.stopStream(screen, true).catch((stopError) => {
						logger.error(
							`Failed to stop stream during recovery for screen ${screen}`,
							'StreamManager',
							stopError
						);
					});

					// Reset screen state immediately
					await this.setScreenState(screen, StreamState.IDLE, undefined, true);

					// Clear any tracking data
					this.streams.delete(screen);
					this.processingScreens.delete(screen);
					this.screenStartingTimestamps.delete(screen);

					// Schedule queue update with retries - but don't wait for it
					const retryQueueUpdate = async (retries = 3) => {
						try {
							await this.updateAllQueues();
						} catch (error) {
							if (retries > 0) {
								logger.warn(
									`Queue update failed, retrying in 5s (${retries} retries left)`,
									'StreamManager'
								);
								setTimeout(() => retryQueueUpdate(retries - 1), 5000);
							} else {
								logger.error(
									`Failed to update queues after ${3 - retries} retries`,
									'StreamManager'
								);
							}
						}
					};

					// Start retry process in background
					retryQueueUpdate().catch((error) => {
						logger.error('Background queue update failed', 'StreamManager', error);
					});
				} catch (recoveryError) {
					logger.error(`Recovery failed for screen ${screen}`, 'StreamManager', recoveryError);
				}
			}

			throw err;
		} finally {
			if (release) {
				try {
					release();
					logger.debug(
						`Released lock for screen ${screen} after ${operation} (${opId})`,
						'StreamManager'
					);
				} catch (releaseError) {
					logger.error(`Error releasing lock for screen ${screen}`, 'StreamManager', releaseError);
				}
			}

			// Clean up mutex if no active streams and not locked
			try {
				if (!this.streams.has(screen) && !mutex.isLocked()) {
					this.screenMutexes.delete(screen);
					logger.debug(
						`Deleted mutex for screen ${screen} after ${operation} (${opId})`,
						'StreamManager'
					);
				}
			} catch (cleanupError) {
				logger.error(`Error cleaning up mutex for screen ${screen}`, 'StreamManager', cleanupError);
			}
		}
	}

	private async handleStreamEnd(screen: number): Promise<void> {
		// Get current stream before any cleanup
		const currentStream = this.streams.get(screen);
		if (currentStream?.url) {
			this.markStreamAsWatched(currentStream.url);
			this.streams.delete(screen);
			// Mark the stream as watched
			logger.info(`Marked ended stream as watched: ${currentStream.url}`, 'StreamManager');
			logger.info(
				`Watched streams before adding to queue: ${Array.from(this.watchedStreams.keys()).join(', ')} Length: ${this.watchedStreams.size}`
			);

			// Note that markStreamAsWatched already removes the stream from all queues
			// So we don't need to explicitly remove it here
		}
		this.playerService.cleanup_after_stop(screen);
		this.queues.delete(screen);
		await this.updateQueue(screen);
		//this.queues.set(screen, await this.getLiveStreams().filter(s => s.screen === screen));
		// Get the queue
		const queue = this.queues.get(screen) || [];

		// Get next stream from queue
		let nextStream = queue[0];
		if (!nextStream) {
			logger.info(
				`No next stream in queue for screen ${screen}, handling empty queue`,
				'StreamManager'
			);
			await this.handleEmptyQueue(screen);
			return;
		}

		// Skip stream if it's watched (should not happen with our filters, but just in case)
		if (this.isStreamWatched(nextStream.url)) {
			logger.warn(
				`Next stream in queue for screen ${screen} is already watched: ${nextStream.url}. Skipping to the next one.`,
				'StreamManager'
			);

			// Remove the watched stream from queue
			queue.shift();
			this.queues.set(screen, queue);
			queueService.setQueue(screen, queue);
			nextStream = queue[0];
		}

		// Make sure screen config is available
		const screenConfig = this.getScreenConfig(screen) || {
			screen,
			id: screen,
			enabled: true,
			volume: this.config.player.defaultVolume,
			quality: this.config.player.defaultQuality,
			windowMaximized: this.config.player.windowMaximized
		};

		// Always call playerService.startStream directly to start the next stream from queue
		try {
			logger.info(`Starting next stream for screen ${screen}: ${nextStream.url}`, 'StreamManager');

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

				// Remove the started stream from queue
				queue.shift();
				this.queues.set(screen, queue);
				queueService.setQueue(screen, queue);

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
				logger.error(
					`Failed to start next stream on screen ${screen}: ${startResult.error}`,
					'StreamManager'
				);
				await this.setScreenState(screen, StreamState.ERROR);

				// Remove the failed stream from queue
				queue.shift();
				this.queues.set(screen, queue);
				queueService.setQueue(screen, queue);

				// If starting the stream fails, try the next stream in queue
				logger.debug(`Trying next stream after failure for screen ${screen}`, 'StreamManager');
				setTimeout(() => this.handleStreamEnd(screen), 200);
			}
		} catch (error) {
			logger.error(
				`Error starting next stream on screen ${screen}`,
				'StreamManager',
				error instanceof Error ? error : new Error(String(error))
			);
			await this.setScreenState(screen, StreamState.ERROR);

			// Remove the failed stream from queue
			queue.shift();
			this.queues.set(screen, queue);
			queueService.setQueue(screen, queue);

			// Try next stream
			await this.handleStreamEnd(screen);
		}
	}

	// Modify handleEmptyQueue to use state machine and locking
	private async handleEmptyQueue(screen: number): Promise<void> {
		return this.withLock(screen, 'handleEmptyQueue', async () => {
			const currentState = this.getScreenState(screen);

			// Allow processing in IDLE or ERROR states to be more robust
			if (currentState !== StreamState.IDLE && currentState !== StreamState.ERROR) {
				logger.info(
					`Ignoring empty queue handling for screen ${screen} in state ${currentState}`,
					'StreamManager'
				);
				return;
			}

			// Set state to starting before fetching new streams
			await this.setScreenState(screen, StreamState.STARTING);

			try {
				logger.info(
					`Handling empty queue for screen ${screen}, fetching fresh streams`,
					'StreamManager'
				);

				// Fetch fresh streams from all sources
				const streams = await this.getLiveStreams();
				logger.info(`Fetched ${streams.length} streams from sources`, 'StreamManager');

				// Filter streams for this screen, remove watched ones, and filter out upcoming streams
				// Only allow streams that are truly live, or (legacy) have a startTime not in the future
				const now = Date.now();
				const availableStreams = this.filterUnwatchedStreams(
					streams.filter(s =>
						(!s.screen || s.screen === screen) &&
						(
							// Prefer explicit live status
							(s.sourceStatus === 'live') ||
							// For legacy/unknown status, fallback to startTime check
							(!s.sourceStatus && (!s.startTime || s.startTime <= now))
						)
					),
					screen
				);

				if (availableStreams.length > 0) {
					logger.info(
						`Found ${availableStreams.length} available streams for screen ${screen}`,
						'StreamManager'
					);

					// Filter out streams that have repeatedly failed
					const filteredStreams = availableStreams.filter((stream) => {
						const failRecord = this.failedStreamAttempts.get(stream.url);
						if (!failRecord) return true; // Never failed before

						const now = Date.now();
						// Reset failure count if it's been long enough
						if (now - failRecord.timestamp > this.STREAM_FAILURE_RESET_TIME) {
							this.failedStreamAttempts.delete(stream.url);
							return true;
						}

						// Skip if too many recent failures
						return failRecord.count < this.MAX_STREAM_ATTEMPTS;
					});

					if (filteredStreams.length === 0) {
						logger.warn(
							`All ${availableStreams.length} available streams for screen ${screen} have failed recently`,
							'StreamManager'
						);
						await this.setScreenState(screen, StreamState.IDLE);

						// Schedule another attempt after a delay
						setTimeout(() => {
							logger.info(
								`Scheduling another attempt to fetch streams for screen ${screen}`,
								'StreamManager'
							);
							this.updateAllQueues();
						}, this.RETRY_TIMEOUT); // Try again in 20 seconds
						return;
					}

					// Sort streams by viewer count (highest first) and prioritize live streams
					const sortedStreams = [...filteredStreams].sort((a, b) => {
						// Prioritize streams that are currently live
						const aIsLive = a.sourceStatus === 'live';
						const bIsLive = b.sourceStatus === 'live';
						if (aIsLive && !bIsLive) return -1;
						if (!aIsLive && bIsLive) return 1;
						// Then sort by viewer count
						return (b.viewerCount || 0) - (a.viewerCount || 0);
					});

					// Update the queue with all streams except the first one
					const [firstStream, ...queueStreams] = sortedStreams;

					// Set up the queue first
					if (queueStreams.length > 0) {
						this.queues.set(screen, queueStreams);
						queueService.setQueue(screen, queueStreams);
						logger.info(
							`Added ${queueStreams.length} streams to queue for screen ${screen}`,
							'StreamManager'
						);
					}

					// Start the first stream
					logger.info(
						`Starting first stream on screen ${screen}: ${firstStream.url}`,
						'StreamManager'
					);
					const result = await this.startStream({
						url: firstStream.url,
						screen,
						quality: this.config.player.defaultQuality,
						title: firstStream.title,
						viewerCount: firstStream.viewerCount,
						startTime: firstStream.startTime
					});

					if (result.success) {
						logger.info(`Successfully started stream on screen ${screen}`, 'StreamManager');
						await this.setScreenState(screen, StreamState.PLAYING);
					} else {
						logger.error(
							`Failed to start stream on screen ${screen}: ${result.error}`,
							'StreamManager'
						);
						// Try next stream in queue
						await this.handleStreamEnd(screen);
					}
				} else {
					logger.info(
						`No live streams available for screen ${screen}, will retry later`,
						'StreamManager'
					);
					await this.setScreenState(screen, StreamState.IDLE);

					// Schedule another attempt after a delay
					setTimeout(() => {
						logger.info(
							`Scheduling another attempt to fetch streams for screen ${screen}`,
							'StreamManager'
						);
						this.updateAllQueues();
					}, 30000); // Try again in 30 seconds
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
				}, 30000); // Try again in 30 seconds
			}
		});
	}

	// Modify startStream to use state machine and locking
	async startStream(options: StreamOptions & { url: string }): Promise<StreamResponse> {
		const screen = options.screen;
// ... (rest of the code remains the same)
		logger.info(`Starting stream on screen ${screen}: ${options.url}`, 'StreamManager');
		// Ensure screen is defined
		if (screen === undefined) {
			logger.error('Screen number is required', 'StreamManager');
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
				logger.warn(
					`Cannot start stream on screen ${screen} in state ${currentState}`,
					'StreamManager'
				);
				return {
					screen,
					success: false,
					error: `Screen is busy in state ${currentState}`
				};
			}

			// Set state to starting
			await this.setScreenState(screen, StreamState.STARTING);

			return safeAsync<StreamResponse>(
				async () => {
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
						startTime:
							typeof options.startTime === 'string'
								? Date.parse(options.startTime)
								: options.startTime,
						isRetry: options.isRetry
					});

					// Update state based on result
					if (result.success) {
						// Add the new stream to our map
						this.streams.set(screen, {
							url: options.url,
							screen: screen,
							quality: options.quality || 'best',
							platform: options.url.includes('twitch.tv')
								? ('twitch' as StreamPlatform)
								: options.url.includes('youtube.com')
									? ('youtube' as StreamPlatform)
									: ('twitch' as StreamPlatform),
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
				},
				`StreamManager:startStream:${screen}`,
				{
					screen,
					success: false,
					error: 'Unexpected error during stream start'
				}
			);
		});
	}

	// Implement stopStream with state machine
	async stopStream(screen: number, isManualStop: boolean = false): Promise<boolean> {
		return this.withLock(screen, 'stopStream', async () => {
			const currentState = this.getScreenState(screen);

			// Can't stop if already stopping or disabled
			if (currentState === StreamState.STOPPING || currentState === StreamState.DISABLED) {
				logger.warn(
					`Cannot stop stream on screen ${screen} in state ${currentState}`,
					'StreamManager'
				);
				return false;
			}

			// Update state to stopping
			await this.setScreenState(screen, StreamState.STOPPING);

			try {
				logger.info(
					`Stopping stream on screen ${screen}, manualStop=${isManualStop}`,
					'StreamManager'
				);

				const activeStream = this.streams.get(screen);
				if (activeStream) {
					logger.info(`Active stream on screen ${screen}: ${activeStream.url}`, 'StreamManager');
				} else {
					logger.info(`No active stream found in manager for screen ${screen}`, 'StreamManager');
				}

				if (isManualStop) {
					this.manuallyClosedScreens.add(screen);
					logger.info(
						`Screen ${screen} manually closed, added to manuallyClosedScreens`,
						'StreamManager'
					);
				}

				// Stop the stream in player service
				logger.info(`Calling player service to stop stream on screen ${screen}`, 'StreamManager');
				const success = await this.playerService.stopStream(screen, true, isManualStop);
				logger.info(
					`Player service stopStream result: ${success} for screen ${screen}`,
					'StreamManager'
				);

				// Clean up all related resources
				if (success) {
					logger.debug(
						`Successfully stopped stream on screen ${screen}, cleaning up resources`,
						'StreamManager'
					);
					this.streams.delete(screen);
				} else {
					logger.warn(
						`Failed to stop stream on screen ${screen}, forcing cleanup`,
						'StreamManager'
					);
					this.streams.delete(screen);
				}

				// Update state based on result
				await this.setScreenState(screen, StreamState.IDLE);
				return true;
			} catch (error) {
				await this.setScreenState(screen, StreamState.ERROR);
				logger.error(
					`Error stopping stream on screen ${screen}`,
					'StreamManager',
					error instanceof Error ? error : new Error(String(error))
				);

				// Force cleanup anyway on error
				logger.debug(`Forcing cleanup after error for screen ${screen}`, 'StreamManager');
				this.streams.delete(screen);

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

	/**
	 * Gets available organizations
	 */
	getOrganizations(): string[] {
		return this.config.organizations;
	}

	/**
	 * Fetches live streams from both Holodex and Twitch based on config
	 */
	async getLiveStreams(): Promise<StreamSource[]> {
		const now = Date.now();
		logger.info('Fetching fresh stream data...', 'StreamManager');

		return await safeAsync(
			async () => {
				const results: Array<
					StreamSource & { screen?: number; sourceName?: string; priority?: number }
				> = [];
				const streamConfigs = this.config.streams;

				// Defensive check for config
				if (!streamConfigs || !Array.isArray(streamConfigs)) {
					logger.warn('Stream configuration is missing or invalid', 'StreamManager');
					return [];
				}

				// Create fetch operations for all enabled screens
				const fetchOperations = streamConfigs
					.filter((streamConfig) => streamConfig.enabled)
					.map((streamConfig) => {
						const screenNumber = streamConfig.screen;
						return async () => {
							logger.debug(`Fetching streams for screen ${screenNumber}`, 'StreamManager');

							// Sort sources by priority first
							const sortedSources =
								streamConfig.sources && Array.isArray(streamConfig.sources)
									? [...streamConfig.sources]
											.filter((source) => source.enabled)
											.sort((a, b) => (a.priority || 999) - (b.priority || 999))
									: [];

							logger.debug(
								'Sources for screen %s: %s',
								String(screenNumber),
								sortedSources
									.map((s) => `${s.type}:${s.subtype || 'other'} (${s.priority || 999})`)
									.join(', ')
							);

							// Process each source for this screen
							const screenStreamsBySource = await parallelOps(
								sortedSources.map(
									(source) => () => this.fetchStreamsForSource(source, screenNumber)
								),
								`StreamManager:fetchScreenSources:${screenNumber}`,
								{ continueOnError: true }
							);

							// Flatten and return all streams for this screen
							return screenStreamsBySource.flat();
						};
					});

				// Run all screen fetches in parallel
				const screenStreams = await parallelOps(fetchOperations, 'StreamManager:fetchAllScreens', {
					continueOnError: true
				});

				// Combine all streams from all screens
				results.push(...screenStreams.flat());

				// Filter out any streams with 'ended' status
				const onFilterResults = await Promise.all(results.map(async (stream) => {
					// For ended streams, filter them out
					if (stream.sourceStatus === 'ended') {
						logger.debug(`Filtering out ended stream: ${stream.url}`, 'StreamManager');
						return undefined;
					}
					if(stream.platform === 'youtube') {	
						if(!await isYouTubeStreamLive(stream.url)) {
							logger.debug(`Filtering out live stream: ${stream.url}`, 'StreamManager');
							return undefined;
						}
					}

					// For upcoming streams, check if they're in the past
					if (stream.sourceStatus === 'upcoming' && stream.startTime) {
						// If the start time is in the past by more than 30 minutes, filter it out
						if (stream.startTime < now - 30 * 60 * 1000) {
							logger.debug(`Filtering out past upcoming stream: ${stream.url}`, 'StreamManager');
							return undefined;
						}
					}
					return stream;
				}));
				const filteredResults = onFilterResults.filter((stream) => stream !== undefined);

				logger.info(`Fetched ${filteredResults.length} streams from all sources`, 'StreamManager');

				return filteredResults;
			},
			'StreamManager:getLiveStreams',
			[]
		);
	}

	// Add this new helper method to fetch streams for a specific source
	private async fetchStreamsForSource(
		source: {
			type: string;
			subtype?: string;
			name?: string;
			limit?: number;
			priority?: number;
			tags?: string[];
		},
		screenNumber: number
	): Promise<StreamSource[]> {
		return safeAsync(
			async () => {
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
				sourceStreams.forEach((stream) => {
					stream.screen = screenNumber;
					stream.priority = source.priority || 999;
					stream.subtype = source.subtype;
				});

				return sourceStreams;
			},
			`StreamManager:fetchStreamsForSource:${source.type}:${source.subtype || 'other'}:${screenNumber}`,
			[]
		);
	}

	/**
	 * Gets VTuber streams from Twitch
	 */
	async getVTuberStreams(limit = 50): Promise<StreamSource[]> {
		return this.twitchService.getVTuberStreams(limit);
	}

	async autoStartStreams() {
		if (this.isShuttingDown) return;

		logger.info('Auto-starting streams...', 'StreamManager');

		try {
			// Get all enabled screens with autoStart enabled from streams config
			const autoStartScreens = this.config.streams
				.filter((stream) => stream.enabled && stream.autoStart)
				.map((stream) => stream.screen);

			if (autoStartScreens.length === 0) {
				logger.info('No screens configured for auto-start', 'StreamManager');
				return;
			}

			logger.info(
				`Auto-starting streams for screens: ${autoStartScreens.join(', ')}`,
				'StreamManager'
			);

			// First, fetch all available streams
			const allStreams = await this.getLiveStreams();
			logger.info(`Fetched ${allStreams.length} live streams for initialization`, 'StreamManager');

			// Process each screen
			for (const screen of autoStartScreens) {
				// Check if a stream is already playing on this screen
				const activeStreams = this.getActiveStreams();
				const isStreamActive = activeStreams.some((s) => s.screen === screen);

				if (isStreamActive) {
					logger.info(
						`Stream already active on screen ${screen}, skipping auto-start`,
						'StreamManager'
					);

					// Still update the queue for this screen
					const streamConfig = this.config.streams.find((s) => s.screen === screen);
					if (!streamConfig) {
						logger.warn(`No stream configuration found for screen ${screen}`, 'StreamManager');
						continue;
					}

					// Filter streams for this screen but exclude the currently playing one
					const currentStream = this.streams.get(screen);
					const currentUrl = currentStream?.url;

					const screenStreams = this.getFilteredStreamsForScreen(screen, currentUrl, allStreams);

					// Set up the queue first
					if (screenStreams.length > 0) {
						queueService.setQueue(screen, screenStreams);
						logger.info(
							`Initialized queue for screen ${screen} with ${screenStreams.length} streams`,
							'StreamManager'
						);
					}

					continue; // Skip to next screen
				}

				// Get stream configuration for this screen
				const streamConfig = this.config.streams.find((s) => s.screen === screen);
				if (!streamConfig) {
					logger.warn(`No stream configuration found for screen ${screen}`, 'StreamManager');
					continue;
				}

				// Filter and sort streams for this screen
				const screenStreams = allStreams
					.filter((stream) => {
						// Only include streams that are actually live
						if (!stream.sourceStatus || stream.sourceStatus !== 'live') {
							return false;
						}

						// Check if stream is already playing on another screen
						const isPlaying = activeStreams.some((s) => s.url === stream.url);

						// Never allow duplicate streams across screens
						if (isPlaying) {
							return false;
						}

						// Check if this stream matches the screen's configured sources
						return streamConfig.sources?.some((source) => {
							if (!source.enabled) return false;

							switch (source.type) {
								case 'holodex':
									if (stream.platform !== 'youtube') return false;
									if (
										source.subtype === 'favorites' &&
										stream.channelId &&
										this.isChannelInFavorites('holodex', stream.channelId)
									)
										return true;
									if (
										source.subtype === 'organization' &&
										source.name &&
										stream.organization === source.name
									)
										return true;
									break;
								case 'twitch':
									if (stream.platform !== 'twitch') return false;
									if (
										source.subtype === 'favorites' &&
										stream.channelId &&
										this.isChannelInFavorites('twitch', stream.channelId)
									)
										return true;
									if (!source.subtype && source.tags?.includes('vtuber')) return true;
									break;
							}
							return false;
						});
					})
					.sort((a, b) => {
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
						logger.info(
							`Initialized queue for screen ${screen} with ${queueStreams.length} streams`,
							'StreamManager'
						);
					}

					// Start playing the first stream
					logger.info(
						`Starting initial stream on screen ${screen}: ${firstStream.url}`,
						'StreamManager'
					);
					await timeoutPromise(
						this.startStream({
							url: firstStream.url,
							screen,
							quality: this.config.player.defaultQuality,
							windowMaximized: this.config.player.windowMaximized,
							volume: this.config.player.defaultVolume,
							title: firstStream.title,
							viewerCount: firstStream.viewerCount,
							startTime: firstStream.startTime
						}),
						this.DEFAULT_LOCK_TIMEOUT
					);
				} else {
					logger.info(
						`No live streams available for screen ${screen}, will try again later`,
						'StreamManager'
					);
				}
			}

			logger.info('Auto-start complete', 'StreamManager');
		} catch (error) {
			logger.error(
				`Error during auto-start: ${error instanceof Error ? error.message : String(error)}`,
				'StreamManager'
			);
		}
	}
	/**
	 * Disables a screen and optionally forces immediate stop
	 * @param screen The screen number to disable
	 * @param fast If true, uses force stop for immediate termination
	 */
	async disableScreen(screen: number, fast = false): Promise<void> {
		// Update state to disabled immediately (without lock)
		this.setScreenState(screen, StreamState.DISABLED);
	
		try {
			// Clear queue
			this.queues.delete(screen);
			await queueService.clearQueue(screen);
		
			// Stop the stream
			logger.info(`Stopping stream on screen ${screen} (fast=${fast})`, 'StreamManager');
			await this.playerService.stopStream(screen, fast, true);
		} catch (error) {
			logger.warn(
				`Error during stop of screen ${screen}: ${error instanceof Error ? error.message : String(error)}`,
				'StreamManager'
			);
			throw error; // Re-throw to allow callers to handle the error
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
	
			// Clear any retry timers
			this.clearRetryTimers(screen);
	}
	private clearRetryTimers(screen: number): void {
		const retryTimer = this.retryTimers.get(screen);
		if (retryTimer) {
			clearTimeout(retryTimer);
			this.retryTimers.delete(screen);
		}
		this.networkRetries.delete(screen);
		this.lastNetworkError.delete(screen);
	}

	async enableScreen(screen: number): Promise<void> {
		logger.info(`Enabling screen ${screen}`, 'StreamManager');
	
		try {
			// First update state and services
			this.setScreenState(screen, StreamState.IDLE);
			this.playerService.enableScreen(screen);
	
			const config = this.screenConfigs.get(screen);
			if (config) {
				config.enabled = true;
					this.screenConfigs.set(screen, config);
					this.emit('screenConfigUpdate', screen, config);
				}
	
				// Initialize queue if needed
				if (!this.queues.has(screen)) {
					this.queues.set(screen, []);
				}
	
				// Update queue first
				this.updateAllQueues();
	
				// Get the updated queue
				const queue = this.queues.get(screen) || [];
	
				if (queue.length > 0) {
					logger.info(
						`Found ${queue.length} streams in queue for screen ${screen}, starting first one`,
						'StreamManager'
					);
					const firstStream = queue[0];
	
					// Start the first stream
					const result = await this.startStream({
						url: firstStream.url,
						screen,
						quality: this.config.player.defaultQuality,
						title: firstStream.title,
						viewerCount: firstStream.viewerCount,
						startTime: firstStream.startTime
					});
	
					if (result.success) {
						logger.info(`Successfully started stream on screen ${screen}`, 'StreamManager');
						// Remove the started stream from queue
						queue.shift();
						this.queues.set(screen, queue);
						queueService.setQueue(screen, queue);
					} else {
						logger.error(
							`Failed to start stream on screen ${screen}: ${result.error}`,
							'StreamManager'
						);
						// Try next stream in queue
						await this.deferStartNextStream(screen);
					}
				} else {
					logger.info(
						`No streams available for screen ${screen}, setting to IDLE state`,
						'StreamManager'
					);
					await this.setScreenState(screen, StreamState.IDLE);
				}
			} catch (error) {
				logger.error(
					`Error enabling screen ${screen}`,
					'StreamManager',
					error instanceof Error ? error : new Error(String(error))
				);
				// Ensure we don't get stuck in an error state
				try {
					await this.setScreenState(screen, StreamState.IDLE);
				} catch (e) {
					logger.error(
						`Failed to reset screen ${screen} state after error`,
						'StreamManager',
						e
					);
				}
				throw error; // Re-throw to ensure the lock is released
			}
	
			logger.info(`Screen ${screen} enabled`, 'StreamManager');
	}
	
	// Add this helper method to ensure a screen is unlocked
	private async ensureUnlocked(screen: number): Promise<void> {
		if (!this.screenMutexes.has(screen)) {
			return;
		}
		
		const mutex = this.screenMutexes.get(screen)!;
		try {
			// Try to acquire and immediately release the lock
			const release = await mutex.acquire(1000, 'unlock-check', 'unlock-check');
			release();
		} catch (error) {
			// If we can't acquire the lock, force reset it
			logger.warn(`Force resetting lock for screen ${screen}`, 'StreamManager');
			this.screenMutexes.delete(screen);
		}
	}
	private async deferStartNextStream(screen: number) {
		try {
			const nextUrl = queueService.getNextStream(screen);

			if (nextUrl) {
				const streamOptions: StreamOptions = {
					url: nextUrl.url,
					title: nextUrl.title,
					viewerCount: nextUrl.viewerCount,
					startTime: nextUrl.startTime,
					quality: this.config.player.defaultQuality,
					screen: screen
				};

				await this.startStream(streamOptions);
			} else {
				logger.info(`Queue empty for screen ${screen}, setting to IDLE state`, 'StreamManager');
				await this.setScreenState(screen, StreamState.IDLE);
			}
		} catch (error) {
			logger.error(
				`Deferred stream start failed for screen ${screen}`,
				'StreamManager',
				error instanceof Error ? error : new Error(String(error))
			);
			await this.setScreenState(screen, StreamState.ERROR);
		}
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
	async restartStreams(screen?: number): Promise<void> {
		const restart = async (screen: number) => {
			logger.info(`Restarting stream on screen ${screen}`, 'StreamManager');

			const currentStream = this.streams.get(screen);
			if (!currentStream) {
				logger.warn(`No active stream found on screen ${screen} to restart`, 'StreamManager');
				await this.handleStreamEnd(screen); // Move to next
				return;
			}

			const url = currentStream.url;
			if (!url || url.trim() === '') {
				logger.warn(`Cannot restart, missing URL on screen ${screen}`, 'StreamManager');
				await this.handleStreamEnd(screen);
				return;
			}

			try {
				// Kill existing stream safely, with timeout
				await timeoutPromise(this.stopStream(screen), 10000);
			} catch (error) {
				logger.error(
					`Failed to stop stream on screen ${screen}, continuing restart anyway`,
					'StreamManager',
					error instanceof Error ? error : new Error(String(error))
				);
				// Don't bail here; maybe player is dead already
			}

			await this.setScreenState(screen, StreamState.STARTING);

			const result = await timeoutPromise(
				this.startStream({
					url: url,
					screen: screen,
					quality: this.config.player.defaultQuality || 'best',
					windowMaximized: true
				}),
				15000
			);

			if (result.success) {
				logger.info(`Successfully restarted stream on screen ${screen}`, 'StreamManager');
				await this.setScreenState(screen, StreamState.PLAYING);
			} else {
				logger.error(
					`Failed to restart stream on screen ${screen}: ${result.error}`,
					'StreamManager'
				);
				await this.handleStreamEnd(screen); // Bail to next stream
			}
		};
		if (screen) {
			await this.withLock(screen, 'restartStream', restart.bind(this, screen));
		} else {
			for (const screen of this.screenConfigs.keys()) {
				await this.withLock(screen, 'restartStream', restart.bind(this, screen));
				await new Promise((resolve) => setTimeout(resolve, 1000));
			}
		}
	}

	async reorderQueue(screen: number, sourceIndex: number, targetIndex: number): Promise<void> {
		const queue = queueService.getQueue(screen);
		if (
			sourceIndex < 0 ||
			sourceIndex >= queue.length ||
			targetIndex < 0 ||
			targetIndex >= queue.length
		) {
			throw new Error('Invalid source or target index');
		}

		// Reorder the queue
		const [item] = queue.splice(sourceIndex, 1);
		queue.splice(targetIndex, 0, item);
		queueService.setQueue(screen, queue);

		logger.info(
			`Reordered queue for screen ${screen}: moved item from ${sourceIndex} to ${targetIndex}`,
			'StreamManager'
		);
	}

	getQueueForScreen(screen: number): StreamSource[] {
		return queueService.getQueue(screen);
	}

	async setPlayerPriority(priority: string, restartStreams: boolean = true): Promise<void> {
		// Validate priority
		const validPriorities = [
			'realtime',
			'high',
			'above_normal',
			'normal',
			'below_normal',
			'low',
			'idle'
		];
		if (!validPriorities.includes(priority.toLowerCase())) {
			throw new Error(
				`Invalid priority: ${priority}. Valid values are: ${validPriorities.join(', ')}`
			);
		}

		// Update config
		if (!this.config.mpv) {
			this.config.mpv = {};
		}
		this.config.mpv.priority = priority;

		// Restart all streams to apply new priority if requested
		logger.info(
			`Setting player priority to ${priority}${restartStreams ? ' and restarting streams' : ' without restarting streams'}`,
			'StreamManager'
		);
		if (restartStreams) {
			await this.restartStreams();
		}
	}

	public markStreamAsWatched(url: string): void {
		logger.info(`Marking stream as watched: ${url}`, 'StreamManager');
		// Find any screens playing this URL and clear them
		for (const [screen, stream] of this.streams.entries()) {
			if (stream.url === url) {
				this.streams.delete(screen);
				logger.info(`Cleared active stream reference for ${url} on screen ${screen}`);
			}
		}
		// Only keep track of the most recent MAX_WATCHED_STREAMS
		if (this.watchedStreams.size >= this.MAX_WATCHED_STREAMS) {
			// Find the oldest entry
			let oldestUrl = '';
			let oldestTime = Date.now();

			for (const [streamUrl, timestamp] of this.watchedStreams.entries()) {
				if (timestamp < oldestTime) {
					oldestTime = timestamp;
					oldestUrl = streamUrl;
				}
			}

			// Remove the oldest entry
			if (oldestUrl) {
				this.watchedStreams.delete(oldestUrl);
				logger.debug(`Removed oldest watched entry: ${oldestUrl}`, 'StreamManager');
			}
		}

		// Add new entry
		this.watchedStreams.set(url, Date.now());

		// Sync with queueService
		queueService.markStreamAsWatched(url);

		logger.info(`Marked stream as watched: ${url}`, 'StreamManager');

		// Update all queues to remove this stream
		for (const [screen, queue] of this.queues.entries()) {
			const index = queue.findIndex((stream) => stream.url === url);
			if (index !== -1) {
				// Remove from queue
				queue.splice(index, 1);
				this.queues.set(screen, queue);

				// Update queueService
				queueService.setQueue(screen, queue);

				logger.info(
					`Removed watched stream ${url} from queue for screen ${screen}`,
					'StreamManager'
				);
				this.emit('queueUpdate', { screen, queue });
			}
		}
	}

	public getWatchedStreams(): string[] {
		// Clean up expired entries first
		const now = Date.now();
		for (const [url, timestamp] of this.watchedStreams.entries()) {
			if (now - timestamp > this.WATCHED_STREAM_RESET_TIME) {
				this.watchedStreams.delete(url);
				queueService.clearWatchedStreams(); // Clear in queueService too since we can't remove individual entries
				logger.debug(
					`Removed expired watched entry for ${url} during getWatchedStreams`,
					'StreamManager'
				);
			}
		}

		// Return combined watched streams from both sources to ensure consistency
		const localWatched = Array.from(this.watchedStreams.keys());
		const queueServiceWatched = queueService.getWatchedStreams();

		// Combine and deduplicate
		const allWatched = [...new Set([...localWatched, ...queueServiceWatched])];

		// If there's a discrepancy, sync them
		if (localWatched.length !== queueServiceWatched.length) {
			logger.debug(
				`Syncing watched streams between StreamManager (${localWatched.length}) and QueueService (${queueServiceWatched.length})`,
				'StreamManager'
			);

			// Update queueService to match our state
			queueService.clearWatchedStreams();
			for (const url of localWatched) {
				queueService.markStreamAsWatched(url);
			}
		}

		return allWatched;
	}

	public clearWatchedStreams(): void {
		this.watchedStreams.clear();
		queueService.clearWatchedStreams();
		logger.info('Cleared watched streams history', 'StreamManager');

		// Force update all queues to ensure they reflect the cleared watched status
		this.forceQueueRefresh().catch((error) => {
			logger.error(
				'Error refreshing queues after clearing watched streams',
				'StreamManager',
				error instanceof Error ? error : new Error(String(error))
			);
		});
	}

	async cleanup() {
		this.isShuttingDown = true;

		try {
			// Stop all keyboard listeners
			this.keyboardService.cleanup();

			// Get all active screens
			const activeScreens = Array.from(this.streams.keys());

			// Stop all streams
			const stopPromises = activeScreens.map((screen) =>
				this.stopStream(screen, true).catch((error) => {
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
		const exists = queue.some((item) => item.url === source.url);
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

	/**
	 * Get comprehensive information about a screen, including:
	 * - Current stream
	 * - Queue
	 * - Configuration
	 * - Status
	 */
	public getScreenInfo(screen: number) {
		// Get screen configuration
		const screenConfig = this.config.player.screens.find((s) => s.screen === screen);
		if (!screenConfig) {
			throw new Error(`Screen ${screen} not found`);
		}

		// Get active stream for this screen
		const activeStream = this.getActiveStreams().find((s) => s.screen === screen);

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

	public handlePlaylistUpdate(
		screen: number,
		playlist: Array<{
			filename: string;
			title?: string;
			current: boolean;
		}>
	): void {
		// Get or create stream instance
		let stream = this.streams.get(screen);

		// If no stream exists, but we have playlist data, create a new stream instance
		if (!stream && playlist.length > 0) {
			const currentItem = playlist.find((item) => item.current);
			if (currentItem) {
				// Get screen configuration
				const screenConfig = this.config.player.screens.find((s) => s.screen === screen);
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
			logger.warn(
				`No active stream found for screen ${screen} during playlist update`,
				'StreamManager'
			);
			return;
		}

		// Update the stream's playlist
		stream.playlist = playlist.map((item) => ({
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
		return this.config.streams.filter((stream) => stream.enabled).map((stream) => stream.screen);
	}

	/**
	 * Filter streams to remove those that have been watched already
	 * @param streams The list of stream sources to filter
	 * @param screen The screen number
	 * @returns Filtered list of streams with watched ones removed
	 */
	private filterUnwatchedStreams(streams: StreamSource[], screen: number): StreamSource[] {
		const now = Date.now();

		// Clean up old watched entries first
		for (const [url, timestamp] of this.watchedStreams.entries()) {
			if (now - timestamp > this.WATCHED_STREAM_RESET_TIME) {
				this.watchedStreams.delete(url);
				logger.debug(`Removed expired watched entry for ${url}`, 'StreamManager');
			}
		}

		// Get screen config to check if we should skip watched streams
		const screenConfig = this.getScreenConfig(screen);
		const skipWatched = screenConfig?.skipWatchedStreams ?? this.config.skipWatchedStreams ?? true;

		if (!skipWatched) {
			logger.debug(
				`Not filtering watched streams for screen ${screen} (disabled in config)`,
				'StreamManager'
			);
			return streams;
		}

		const filteredStreams = streams.filter((stream) => {
			const isWatched = this.watchedStreams.has(stream.url);
			if (isWatched) {
				logger.debug(`Filtering out watched stream: ${stream.url}`, 'StreamManager');
			}
			return !isWatched;
		});

		logger.info(
			`Filtered ${streams.length - filteredStreams.length} watched streams for screen ${screen}`,
			'StreamManager'
		);
		return filteredStreams;
	}

	/**
	 * Updates the queue for a specific screen, optionally forcing a refresh
	 * @param screen Screen number
	 */
	async updateQueue(screen: number): Promise<void> {
		try {
			const screenConfig = this.config.streams.find((s) => s.screen === screen);
			if (!screenConfig || !screenConfig.enabled) {
				logger.debug(
					`Screen ${screen} is disabled or has no config, skipping queue update`,
					'StreamManager'
				);
				return;
			}

			// Get streams from all sources
			logger.info(`Fetching streams for screen ${screen}`, 'StreamManager');
			let allStreams = await this.getAllStreamsForScreen(screen);
			if (allStreams.length === 0) {
				logger.info(`No streams found for screen ${screen}, queue will be empty`, 'StreamManager');
			}

			// Log stream status distribution
			const liveCount = allStreams.filter((s) => s.sourceStatus === 'live').length;
			const upcomingCount = allStreams.filter((s) => s.sourceStatus === 'upcoming').length;
			const otherCount = allStreams.length - liveCount - upcomingCount;

			logger.info(
				`Stream status breakdown for screen ${screen}: ${liveCount} live, ${upcomingCount} upcoming, ${otherCount} other (total: ${allStreams.length})`,
				'StreamManager'
			);

			// Get current stream to exclude from queue
			const currentStream = this.streams.get(screen);
			const currentStreamUrl = currentStream?.url;

			// Filter out watched streams and the current stream
			logger.info(`Filtering watched and current streams for screen ${screen}`, 'StreamManager');
			const streamConfig = this.config.streams.find((s) => s.screen === screen);
			const activeStreams = this.getActiveStreams();
			// Filter and sort streams for this screen
			const sortedStreams = allStreams
				.filter((stream) => {
					// Only include streams that are actually live
					if (!stream.sourceStatus || stream.sourceStatus !== 'live') {
						return false;
					}

					// Check if stream is already playing on another screen
					const isPlaying = activeStreams.some((s) => s.url === stream.url);

					// Never allow duplicate streams across screens
					if (isPlaying) {
						return false;
					}
					const isWatched = this.isStreamWatched(stream.url);
					if (isWatched) {
						logger.debug(`Excluding watched stream from queue: ${stream.url}`, 'StreamManager');
						return false;
					}

					// Check if this stream matches the screen's configured sources
					return screenConfig.sources?.some((source) => {
						if (!source.enabled) return false;

						switch (source.type) {
							case 'holodex':
								if (stream.platform !== 'youtube') return false;
								if (
									source.subtype === 'favorites' &&
									stream.channelId &&
									this.isChannelInFavorites('holodex', stream.channelId)
								)
									return true;
								if (
									source.subtype === 'organization' &&
									source.name &&
									stream.organization === source.name
								)
									return true;
								break;
							case 'twitch':
								if (stream.platform !== 'twitch') return false;
								if (
									source.subtype === 'favorites' &&
									stream.channelId &&
									this.isChannelInFavorites('twitch', stream.channelId)
								)
									return true;
								if (!source.subtype && source.tags?.includes('vtuber')) return true;
								break;
						}
						return false;
					});
				})
				.sort((a, b) => {
					// Sort by priority first
					const aPriority = a.priority ?? 999;
					const bPriority = b.priority ?? 999;
					if (aPriority !== bPriority) return aPriority - bPriority;

					return 0; //(b.viewerCount || 0) - (a.viewerCount || 0);
				});

			// Log filtering results
			const watchedCount = allStreams.length - sortedStreams.length;
			logger.info(
				`Filtered out ${watchedCount} watched/current streams for screen ${screen}, ${sortedStreams.length} streams remaining`,
				'StreamManager'
			);

			// Sort streams
		//	const sortedStreams = this.sortStreams(filteredStreams, screenConfig.sorting);

			// Update queue
			this.queues.set(screen, sortedStreams);
			queueService.setQueue(screen, sortedStreams);

			logger.info(
				`Updated queue for screen ${screen}: ${sortedStreams.length} streams`,
				'StreamManager'
			);

			// Emit queue update event
			this.emit('queueUpdate', { screen, queue: sortedStreams });
		} catch (error) {
			logger.error(
				`Error updating queue for screen ${screen}: ${error}`,
				'StreamManager',
				error instanceof Error ? error : new Error(String(error))
			);
		}
	}

	private isStreamWatched(url: string): boolean {
		// Use local watchedStreams to be consistent with markStreamAsWatched
		return this.watchedStreams.has(url);
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
				logger.info(
					`Screen ${screenConfig.screen} marked as disabled during initialization`,
					'StreamManager'
				);
			}
		}
	}

	// Add method to force queue refresh
	public async forceQueueRefresh(): Promise<void> {
		return safeAsync(
			async () => {
				logger.info('Forcing queue refresh for all screens', 'StreamManager');

				// Save ALL existing streams to preserve them
				const existingStreams = new Map<number, StreamSource[]>();
				for (const [screen, queue] of this.queues.entries()) {
					if (queue.length > 0) {
						existingStreams.set(screen, [...queue]);
						logger.info(
							`Preserving ${queue.length} existing streams for screen ${screen}`,
							'StreamManager'
						);
					}
				}
				// Do NOT clear existing queues before fetching - we'll merge instead
				logger.info('Fetching fresh stream data for all screens', 'StreamManager');

				// Force update all queues
				await this.updateAllQueues();

				// After fetching new streams, restore preserved streams for each screen
				for (const [screen, preserved] of existingStreams.entries()) {
					const currentQueue = this.queues.get(screen) || [];

					// Avoid duplicates by creating a Set of URLs in the current queue
					const currentUrls = new Set(currentQueue.map((stream) => stream.url));

					// Filter preserved streams to only include those not already in the queue
					const uniquePreserved = preserved.filter((stream) => !currentUrls.has(stream.url));

					if (uniquePreserved.length > 0) {
						// Merge current queue with preserved streams
						const newQueue = [...currentQueue, ...uniquePreserved];

						// Update the queue
						this.queues.set(screen, newQueue);
						queueService.setQueue(screen, newQueue);

						logger.info(
							`Restored ${uniquePreserved.length} preserved streams for screen ${screen}`,
							'StreamManager'
						);
					}
				}
			},
			'StreamManager:forceQueueRefresh',
			undefined
		);
	}

	// Add network recovery handler
	private setupNetworkRecovery(): void {
		// Listen for network offline event
		queueService.networkEmitter.on('offline', () => {
			logger.warn('Network connection lost, pausing stream updates', 'StreamManager');
			this.isOffline = true;
			// Don't force screens to IDLE - let them maintain their current state
			// The streams might still be buffering and could recover
		});
	
		// Listen for network online event
		queueService.networkEmitter.on('online', async () => {
			if (!this.isOffline) return;
	
			logger.info('Network connection restored, resuming stream updates', 'StreamManager');
			this.isOffline = false;
	
			try {
				// Refresh queues to get latest stream data
				await this.forceQueueRefresh();
	
				const enabledScreens = this.getEnabledScreens();
				if (enabledScreens.length === 0) {
					logger.info('No enabled screens found after network recovery', 'StreamManager');
					return;
				}
	
				logger.info(`Processing ${enabledScreens.length} screens after network recovery`, 'StreamManager');
	
				// Process screens with proper error isolation
				const recoveryPromises = enabledScreens.map(async (screen, index) => {
					try {
						// Stagger recovery to avoid system overload
						if (index > 0) {
							await new Promise(resolve => setTimeout(resolve, 1000));
						}
	
						const currentState = this.getScreenState(screen);
						const activeStream = this.streams.get(screen);
	
						logger.info(`Processing screen ${screen} (state: ${currentState})`, 'StreamManager');
	
						// Only intervene if the screen is in a problematic state
						if (currentState === StreamState.IDLE && !activeStream) {
							// Screen is idle, try to start a new stream
							await this.handleIdleScreenRecovery(screen.toString());
						} else if (currentState === StreamState.PLAYING && activeStream) {
							// Check if stream is actually working, restart if needed
							await this.handlePlayingScreenRecovery(screen.toString(), activeStream);
						} else if (currentState === StreamState.ERROR) {
							// Reset error state and try to recover
							await this.handleErrorScreenRecovery(screen.toString());
						}
						// For other states, let them be - they might recover naturally
	
					} catch (error) {
						logger.error(
							`Failed to recover screen ${screen}`,
							'StreamManager',
							error instanceof Error ? error : new Error(String(error))
						);
						// Don't force to IDLE - let the screen maintain its state
					}
				});
	
				// Wait for all recoveries to complete (or fail)
				await Promise.allSettled(recoveryPromises);
				logger.info('Network recovery process completed', 'StreamManager');
	
			} catch (error) {
				logger.error(
					'Failed to handle network recovery',
					'StreamManager',
					error instanceof Error ? error : new Error(String(error))
				);
			}
		});
	}
	
	private async handleIdleScreenRecovery(screen: string): Promise<void> {
		await this.updateQueue(Number(screen));
		const queue = this.queues.get(Number(screen)) || [];
		
		if (queue.length > 0) {
			const nextStream = queue.shift()!;
			this.queues.set(Number(screen), queue);
	
			logger.info(`Starting stream after network recovery: ${nextStream.url}`, 'StreamManager');
			
			try {
				const result = await timeoutPromise(
					this.startStream({
						url: nextStream.url,
						screen: Number(screen),
						quality: 'best',
						windowMaximized: true,
						title: nextStream.title,
						viewerCount: nextStream.viewerCount,
						startTime: nextStream.startTime
					}),
					15000 // More reasonable timeout
				);
	
				if (!result.success) {
					throw new Error(result.error || 'Stream start failed');
				}
			} catch (error) {
				logger.error(`Failed to start stream on screen ${screen}`, 'StreamManager', error);
				// Don't set to IDLE - let the retry mechanism handle it
			}
		}
	}
	
	private async handlePlayingScreenRecovery(screen: string, activeStream: any): Promise<void> {
		// Check if stream is actually responsive
		// This is where you'd implement stream health checking
		// For now, just log that we're monitoring it
		logger.info(`Monitoring active stream on screen ${screen} for health`, 'StreamManager');
		
		// You could add stream health checking here:
		// - Check if player is responding
		// - Check if stream is actually playing
		// - Restart only if stream is confirmed dead
	}
	
	private async handleErrorScreenRecovery(screen: string): Promise<void> {
		logger.info(`Attempting to recover screen ${screen} from error state`, 'StreamManager');
		
		// Clear error state and try to start fresh
		await this.setScreenState(Number(screen), StreamState.IDLE);
		
		// Then handle as idle screen
		await this.handleIdleScreenRecovery(screen);
	}
	
	public async forceRefreshAll(restart: boolean = false): Promise<void> {
		logger.info(
			`Force refreshing all streams${restart ? ' and restarting them' : ''}`,
			'StreamManager'
		);
	
		try {
			await this.forceQueueRefresh();
	
			if (restart) {
				const enabledScreens = this.getEnabledScreens();
				const restartPromises = enabledScreens.map(async (screen) => {
					try {
						const currentState = this.getScreenState(screen);
						if (currentState === StreamState.PLAYING) {
							// Gracefully restart only playing streams
							await this.playerService.stopStream(Number(screen), true);
							this.streams.delete(Number(screen));
							await this.handleIdleScreenRecovery(screen.toString());
						}
					} catch (error) {
						logger.error(`Failed to restart screen ${screen}`, 'StreamManager', error);
					}
				});
	
				await Promise.allSettled(restartPromises);
				logger.info('Stream restart process completed', 'StreamManager');
			}
		} catch (error) {
			logger.error('Failed to force refresh all streams', 'StreamManager', error);
			throw error;
		}
	}
	private async getAllStreamsForScreen(screen: number): Promise<StreamSource[]> {
		const screenConfig = this.config.streams.find((s) => s.screen === screen);
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
							organization: source.name as string,
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
				sourceStreams = sourceStreams.filter((stream) => {
					// Filter out watched streams at the source level
					if (this.isStreamWatched(stream.url)) {
						logger.debug(`Filtering out watched stream at source: ${stream.url}`, 'StreamManager');
						return false;
					}

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
				sourceStreams.forEach((stream) => {
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
	private isChannelInFavorites(
		platform: 'holodex' | 'twitch' | 'youtube',
		channelId: string
	): boolean {
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

	private sortStreams(
		streams: StreamSource[],
		sorting?: { field: string; order: 'asc' | 'desc' }
	): StreamSource[] {
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
				return order === 'asc' ? aValue.localeCompare(bValue) : bValue.localeCompare(aValue);
			}

			// Default comparison for other types
			const aStr = String(aValue);
			const bStr = String(bValue);
			return order === 'asc' ? aStr.localeCompare(bStr) : bStr.localeCompare(aStr);
		});
	}

	// Add the missing initializeScreenConfigs method
	private initializeScreenConfigs(): void {
		// Initialize screenConfigs from config
		this.screenConfigs = new Map(
			this.config.player.screens.map((screen) => [
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
			])
		);

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

				try {
					if (data.shouldRestart) {
						// If stream crashed with non-zero exit code, try to restart the same stream
						logger.info(
							`Stream crashed with code ${data.code}, attempting to restart same stream on screen ${data.screen}`,
							'StreamManager'
						);

						// Get current stream URL
						const url = data.url;
						if (url) {
							// Try to restart the same stream
							await this.setScreenState(data.screen, StreamState.STARTING);

							const result = await timeoutPromise(
								this.startStream({
									url: url,
									screen: data.screen,
									quality: this.config.player.defaultQuality || 'best',
									windowMaximized: true
								}),
								this.DEFAULT_LOCK_TIMEOUT
							);

							if (result.success) {
								logger.info(
									`Successfully restarted crashed stream on screen ${data.screen}`,
									'StreamManager'
								);
								await this.setScreenState(data.screen, StreamState.PLAYING);
							} else {
								logger.error(
									`Failed to restart crashed stream on screen ${data.screen}, will try queue: ${result.error}`,
									'StreamManager'
								);
								await this.handleStreamEnd(data.screen);
							}
						} else {
							logger.error(
								`No URL available to restart stream on screen ${data.screen}, will try queue`,
								'StreamManager'
							);
							await this.handleStreamEnd(data.screen);
						}
					} else if (data.moveToNext) {
						// Normal stream end or error where we should move to next stream
						logger.info(
							`Moving to next stream in queue for screen ${data.screen}`,
							'StreamManager'
						);
						await this.handleStreamEnd(data.screen);
					} else {
						// Default behavior for backward compatibility
						await this.handleStreamEnd(data.screen);
					}
				} catch (error) {
					logger.error(
						`Error handling stream error on screen ${data.screen}`,
						'StreamManager',
						error instanceof Error ? error : new Error(String(error))
					);
				}
			});

		// Set up queue update notifications
		queueService.on('queue:updated', (screen, queue) => {
			this.queues.set(screen, queue);
			logger.debug(`Queue updated for screen ${screen}, size: ${queue.length}`, 'StreamManager');
		});

		queueService.on('queue:empty', (screen) => {
			logger.info(`Queue is empty for screen ${screen}, handling empty queue`, 'StreamManager');
			this.handleEmptyQueue(screen).catch((error) => {
				logger.error(
					`Failed to handle empty queue for screen ${screen}`,
					'StreamManager',
					error instanceof Error ? error : new Error(String(error))
				);
			});
		});

		logger.info('Event listeners set up', 'StreamManager');
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

	/**
	 * Gets diagnostic information about active streams
	 * Useful for debugging race conditions and stream multiplication issues
	 */
	public getDiagnostics(): string {
		// Get active screens
		const activeScreens = Array.from(this.streams.keys());
		const activeStreamsInfo = activeScreens
			.map((screen) => {
				const stream = this.streams.get(screen);
				const state = this.getScreenState(screen);
				const isProcessing = this.processingScreens?.has(screen) || false;
				return `Screen ${screen}: state=${state}, URL=${stream?.url || 'none'}, isProcessing=${isProcessing}, time=${new Date().toISOString()}`;
			})
			.join('\n');

		// Log active player streams
		const playerStreams = this.playerService.getActiveStreams();
		const playerStreamsInfo = playerStreams
			.map((s) => `Screen ${s.screen}: URL=${s.url}, status=${s.status}`)
			.join('\n');

		return `--- STREAM MANAGER DIAGNOSTICS ---\nActive Streams:\n${activeStreamsInfo}\n\nPlayer Active Streams:\n${playerStreamsInfo}`;
	}

	private getFilteredStreamsForScreen(
		screenIndex: number,
		currentUrl: string | undefined,
		streams: StreamSource[]
	): StreamSource[] {
		if (this.processingScreens.has(screenIndex)) return [];

		const streamConfig = this.getScreenConfig(screenIndex);
		if (!streamConfig) return [];

		return streams
			.filter((stream) => {
				if (currentUrl && stream.url === currentUrl) return false;
				if (!stream.sourceStatus || stream.sourceStatus !== 'live') return false;

				return streamConfig.sources?.some((source) => {
					if (!source.enabled) return false;

					switch (source.type) {
						case 'holodex':
							if (stream.platform !== 'youtube') return false;
							if (
								source.subtype === 'favorites' &&
								stream.channelId &&
								this.isChannelInFavorites('holodex', stream.channelId)
							)
								return true;
							if (
								source.subtype === 'organization' &&
								source.name &&
								stream.organization === source.name
							)
								return true;
							break;
						case 'twitch':
							if (stream.platform !== 'twitch') return false;
							if (
								source.subtype === 'favorites' &&
								stream.channelId &&
								this.isChannelInFavorites('twitch', stream.channelId)
							)
								return true;
							if (!source.subtype && source.tags?.includes('vtuber')) return true;
							break;
					}
					return false;
				});
			})
			.sort((a, b) => {
				const aPriority = a.priority ?? 999;
				const bPriority = b.priority ?? 999;
				return aPriority - bPriority;
			});
	}

	/**
	 * Gets Japanese language streams
	 */
	async getJapaneseStreams(limit = 50): Promise<StreamSource[]> {
		return this.twitchService.getJapaneseStreams(limit);
	}
}

// Create singleton instance
const config = loadAllConfigs();
// Create flattened favorites arrays for services
const flattenedHolodexFavorites: string[] = [];
if (config.favoriteChannels && config.favoriteChannels.holodex) {
	Object.values(config.favoriteChannels.holodex).forEach((channels) => {
		if (Array.isArray(channels)) {
			flattenedHolodexFavorites.push(...channels);
		}
	});
}

const holodexService = new HolodexService(
	env.HOLODEX_API_KEY,
	config.filters?.filters
		? config.filters.filters.map((f) => (typeof f === 'string' ? f : f.value))
		: [],
	flattenedHolodexFavorites
);
const twitchService = new TwitchService(
	env.TWITCH_CLIENT_ID,
	env.TWITCH_CLIENT_SECRET,
	config.filters?.filters
		? config.filters.filters.map((f) => (typeof f === 'string' ? f : f.value))
		: []
);
// Create flattened YouTube favorites array
const flattenedYoutubeFavorites: string[] = [];
if (config.favoriteChannels && config.favoriteChannels.youtube) {
	Object.values(config.favoriteChannels.youtube).forEach((channels) => {
		if (Array.isArray(channels)) {
			flattenedYoutubeFavorites.push(...channels);
		}
	});
}

const playerService = new PlayerService(config);

export const streamManager = new StreamManager(
	config,
	holodexService,
	twitchService,
	playerService
);
