
// src/server/stream_manager.ts
import type {
	Config,
	FavoriteChannels,
	PlayerSettings,
	ScreenConfig,
	StreamOptions,
	StreamResponse,
	StreamSource
} from '../types/stream.js';
import type { StreamOptions as PlayerServiceStreamOptions } from './services/player.js';
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
export enum StreamState {
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
	async transition(newState: StreamState, callback?: () => Promise<void>, force = false): Promise<boolean> {
		const validTransitions: Record<StreamState, StreamState[]> = {
			[StreamState.IDLE]: [
				StreamState.STARTING,
				StreamState.DISABLED,
				StreamState.NETWORK_RECOVERY,
				StreamState.ERROR
			],
			[StreamState.STARTING]: [StreamState.PLAYING, StreamState.ERROR, StreamState.STOPPING, StreamState.IDLE],
			[StreamState.PLAYING]: [
				StreamState.STOPPING,
				StreamState.ERROR,
				StreamState.NETWORK_RECOVERY,
				StreamState.IDLE
			],
			[StreamState.STOPPING]: [StreamState.IDLE, StreamState.ERROR],
			[StreamState.DISABLED]: [StreamState.IDLE],
			[StreamState.ERROR]: [StreamState.IDLE, StreamState.STARTING, StreamState.NETWORK_RECOVERY],
			[StreamState.NETWORK_RECOVERY]: [StreamState.IDLE, StreamState.STARTING, StreamState.ERROR]
		};

		if (!force && !validTransitions[this.currentState].includes(newState) && this.currentState !== newState) {
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
	private checkYouTubeStreamLive = false;
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
	private readonly MAX_STREAM_ATTEMPTS = 3;
	private readonly STREAM_FAILURE_RESET_TIME = 10 * 60 * 1000; // 10 minutes in ms

	// Add a map to track when screens entered the STARTING state
	private screenStartingTimestamps: Map<number, number> = new Map();
	private readonly MAX_STARTING_TIME = 45000; // 45 seconds max in starting state

	// Add a set to track screens that are currently being processed to prevent race conditions
	private processingScreens: Set<number> = new Set();
	private readonly DEFAULT_LOCK_TIMEOUT = 15000; // 15 seconds
	private static readonly DEFAULT_QUEUE_UPDATE_TIMEOUT = 30_000; // 30 seconds
	private static readonly MAX_QUEUE_UPDATE_RETRIES = 2;
	private static readonly QUEUE_UPDATE_RETRY_DELAY = 5_000; // 5 seconds for normal operations
	private readonly RETRY_TIMEOUT = 20000; // 20 seconds
	private readonly OPERATION_TIMEOUT = 5000; // 5 seconds
	// for normal operations
	private readonly ERROR_HANDLER_TIMEOUT = 30_000; // 30 seconds
	private retryTimers: Map<number, NodeJS.Timeout> = new Map();
	private networkRetries: Map<number, number> = new Map();
	private lastNetworkError: Map<number, number> = new Map();

	// Add new properties at the top of the class
	private watchedStreams: Map<string, number> = new Map(); // URL -> timestamp
	private readonly MAX_WATCHED_STREAMS = 50;
	private readonly WATCHED_STREAM_RESET_TIME = 12 * 60 * 60 * 1000; // 12 hours

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

		// Initialize state machines for each screen
		this.initializeStateMachines();

		// Initialize event listeners
		this.setupEventListeners();

		// Start queue updates
		this.startQueueUpdates().catch((error) => {
			logger.error('Failed to start queue updates', 'StreamManager', error);
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


	/**
	 * Gets the current state of a screen
	 * @param screen The screen number to check
	 * @returns The current StreamState of the screen
	 */
	private getScreenState(screen: number): StreamState {
		if (!this.stateMachines.has(screen)) {
			// If a state machine doesn't exist for some reason, create one.
			const screenConfig = this.screenConfigs.get(screen);
			const initialState = screenConfig?.enabled ? StreamState.IDLE : StreamState.DISABLED;
			this.stateMachines.set(screen, new StreamStateMachine(screen, initialState));
			logger.warn(`Created missing state machine for screen ${screen}`, 'StreamManager');
		}

		const stateMachine = this.stateMachines.get(screen)!;
		const currentState = stateMachine.getState();

		// If we think we're playing, verify the stream is actually working
		if (currentState === StreamState.PLAYING) {
			const stream = this.streams.get(screen);
			if (!stream || !this.isStreamHealthy(stream)) {
				// Stream is dead/unhealthy, transition to error
				logger.warn(`Stream on screen ${screen} appears unhealthy, transitioning to error state`, 'StreamManager');
				// Use the setScreenState method to ensure a valid transition
				this.setScreenState(screen, StreamState.ERROR, new Error('Unhealthy stream detected'));
				return StreamState.ERROR;
			}
		}

		return currentState;
	}

	/**
	 * Safely transitions a screen to a new state with optional error and force flags
	 * @param screen The screen number to update
	 * @param state The new state to transition to
	 * @param error Optional error information for ERROR state
	 * @param force If true, forces the state transition even if it's not a valid transition
	 * @returns boolean indicating if the state was successfully updated
	 */
	public async setScreenState(
		screen: number,
		state: StreamState,
		error?: Error,
		force = false
	): Promise<boolean> {
		try {
			const stateMachine = this.stateMachines.get(screen);
			if (!stateMachine) {
				logger.error(`No state machine found for screen ${screen}`, 'StreamManager');
				return false;
			}

			// Skip if already in the target state and not forcing
			if (stateMachine.getState() === state && !force) {
				return true;
			}
			
			const success = await stateMachine.transition(state, undefined, force);

			if (success) {
				this.emit('screenStateChanged', {
					screen,
					oldState: stateMachine.getState(), // this is now the new state, need to get old state before transition
					newState: state,
					error
				});

				if (state === StreamState.ERROR && error) {
					logger.error(`Screen ${screen} entered ERROR state: ${error.message}`, 'StreamManager');
				}
			}

			return success;

		} catch (err) {
			const errorMessage = err instanceof Error ? err.message : String(err);
			logger.error(
				`Failed to transition screen ${screen} to ${state}: ${errorMessage}`,
				'StreamManager',
				err
			);
			return false;
		}
	}


	/**
	 * Executes an async operation with a mutex lock for the specified screen
	 * Uses AbortController to handle timeouts and cleanup
	 * @param screen The screen number to lock
	 * @param operation Name of the operation for logging
	 * @param callback Async function to execute with the lock held
	 * @param customTimeout Optional custom timeout in milliseconds
	 * @returns Promise that resolves with the result of the callback
	 */
	private async withLock<T>(
		screen: number,
		operation: string,
		callback: (signal: AbortSignal) => Promise<T>,
		customTimeout?: number
	): Promise<T> {
		if (!this.screenMutexes.has(screen)) {
			this.screenMutexes.set(screen, new SimpleMutex(logger, `Screen${screen}Mutex`));
		}
		const mutex = this.screenMutexes.get(screen)!;

		// Generate a unique operation ID for tracking
		const opId = `${operation}_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
		const abortController = new AbortController();

		let release: (() => void) | null = null;
		try {
			logger.debug(
				`Attempting to acquire lock for screen ${screen} during ${operation} (${opId})`,
				'StreamManager'
			);

			release = await mutex.acquire(
				customTimeout || this.DEFAULT_LOCK_TIMEOUT,
				operation,
				opId
			);

			logger.debug(
				`Acquired lock for screen ${screen} during ${operation} (${opId})`,
				'StreamManager'
			);

			// Execute the callback with the lock held and abort signal
			return await Promise.race([
				// Main operation
				callback(abortController.signal),

				// Timeout handler
				new Promise<T>((_, reject) => {
					const timeout = customTimeout || this.DEFAULT_LOCK_TIMEOUT;
					setTimeout(() => {
						abortController.abort();
						reject(new Error(`Operation ${operation} timed out after ${timeout}ms`));
					}, timeout).unref?.(); // Use unref to prevent keeping the process alive
				})
			]);
		} catch (error) {
			abortController.abort(); // Ensure we abort on any error

			if (error instanceof Error) {
				if (error.message.includes('timeout') || error.message.includes('Timeout')) {
					logger.warn(
						`Timeout acquiring or executing lock for screen ${screen} during ${operation} (${opId}): ${error.message}`,
						'StreamManager'
					);
				} else if (error.name === 'AbortError') {
					logger.warn(
						`Operation aborted for screen ${screen} during ${operation} (${opId})`,
						'StreamManager'
					);
				} else {
					logger.error(
						`Error in withLock for screen ${screen} during ${operation} (${opId}): ${error.message}`,
						'StreamManager'
					);
				}
			}
			throw error;
		} finally {
			abortController.abort(); // Clean up any remaining listeners

			// Always release the lock if we acquired it
			if (release) {
				try {
					release();
					logger.debug(
						`Released lock for screen ${screen} after ${operation} (${opId})`,
						'StreamManager'
					);
				} catch (releaseError) {
					logger.error(
						`Error releasing lock for screen ${screen} after ${operation} (${opId})`,
						'StreamManager',
						releaseError instanceof Error ? releaseError : new Error(String(releaseError))
					);
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
				logger.error(
					`Error cleaning up mutex for screen ${screen} after ${operation} (${opId})`,
					'StreamManager',
					cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError))
				);
			}
		}
	}


	/**
	 * Gets all currently active streams across all screens
	 * @returns A map of screen numbers to their active stream information
	 */
	public getActiveStreamsInfo(): Map<number, { url: string; startTime: number; metadata?: any }> {
		const activeStreams = new Map<number, { url: string; startTime: number; metadata?: any }>();

		for (const [screen, stateMachine] of this.stateMachines.entries()) {
			const state = stateMachine.getState();
			if (state === StreamState.PLAYING) {
				const streamInfo = this.streams.get(screen);
				if (streamInfo) {
					activeStreams.set(screen, {
						url: streamInfo.url,
						startTime: streamInfo.id, // Assuming id is the start timestamp
						metadata: streamInfo
					});
				}
			}
		}

		return activeStreams;
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
				this.withLock(screen, 'updateSingleScreen', () => this.updateSingleScreen(screen), 30000) // 30s timeout
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
	 */
	private async updateSingleScreen(screen: number, attempt = 1): Promise<void> {
		// Mark this screen as being processed
		if (this.processingScreens.has(screen)) {
			logger.debug(`Screen ${screen} is already being processed, skipping update`, 'StreamManager');
			return;
		}
		this.processingScreens.add(screen);

		try {
			// Get the current state once to avoid race conditions
			const currentState = this.getScreenState(screen);

			// Quick state checks first
			if (currentState === StreamState.STARTING) {
				await this.handleStuckStarting(screen);
				return;
			}

			// Skip if screen is disabled or playing
			if (currentState === StreamState.DISABLED || currentState === StreamState.PLAYING) {
				logger.debug(`Screen ${screen} is in state ${currentState}, skipping update`, 'StreamManager');
				return;
			}

			// Reset ERROR state to IDLE to allow retries
			if (currentState === StreamState.ERROR) {
				logger.info(`Resetting screen ${screen} from ERROR to IDLE state`, 'StreamManager');
				await this.setScreenState(screen, StreamState.IDLE);
			}

			// Only proceed if in IDLE state
			if (this.getScreenState(screen) !== StreamState.IDLE) {
				logger.debug(
					`Screen ${screen} is not in IDLE state (current: ${this.getScreenState(screen)}), skipping update`,
					'StreamManager'
				);
				return;
			}

			// Update the queue for this screen with a timeout and retry logic
			logger.debug(`Updating queue for idle screen ${screen}`, 'StreamManager');
			await this.updateQueue(screen);

			// Get the queue and start a stream if available
			const queue = this.queues.get(screen) || [];
			if (queue.length > 0) {
				await this.handleStreamEnd(screen); // This will start the next stream
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
	 * Checks if a stream is healthy
	 * @param stream The stream instance to check
	 * @returns boolean indicating if the stream is healthy
	 */
	private isStreamHealthy(stream: StreamInstance): boolean {
		// Check if process is alive AND if it's actually streaming
		// This is where you'd check for recent data, network connectivity, etc.
		return this.playerService.isStreamHealthy(stream.screen);
	}
	
	/**
	 * Handles stuck STARTING state by resetting to IDLE and logging the issue
	 * @param screen The screen number that's stuck in STARTING state
	 * @param timeoutMs Maximum allowed time in 'starting' state before considering it stuck
	 */
	private async handleStuckStarting(screen: number, timeoutMs: number = this.MAX_STARTING_TIME): Promise<void> {
		await this.withLock(screen, 'handleStuckStarting', async () => {
			const state = this.getScreenState(screen);

			// Only proceed if the screen is in 'starting' state
			if (state !== StreamState.STARTING) {
				return;
			}

			const startTime = this.screenStartingTimestamps.get(screen);

			if (!startTime) {
				this.screenStartingTimestamps.set(screen, Date.now());
				return;
			}

			const elapsed = Date.now() - startTime;

			if (elapsed >= timeoutMs) {
				logger.warn(
					`[Screen ${screen}] Stream has been in STARTING state for ${Math.round(elapsed / 1000)}s (> ${Math.round(timeoutMs/1000)}s). Resetting.`,
					'StreamManager'
				);
				this.screenStartingTimestamps.delete(screen);
				await this.setScreenState(screen, StreamState.ERROR, new Error('Stuck in starting state'));
				await this.handleStreamEnd(screen); // Trigger recovery
			}
		});
	}


	/**
	 * Handles stream end events, cleans up, and starts the next stream in the queue.
	 * This is a central part of the stream lifecycle.
	 * @param screen The screen number where the stream ended or should be started.
	 */
	private async handleStreamEnd(screen: number): Promise<void> {
		await this.withLock(screen, `handleStreamEnd`, async () => {
			try {
				// 1. Cleanup existing stream (if any)
				const currentStream = this.streams.get(screen);
				if (currentStream) {
					logger.info(`Cleaning up previous stream on screen ${screen}: ${currentStream.url}`, 'StreamManager');
					this.markStreamAsWatched(currentStream.url);
					await this.stopStream(screen, true); // Force stop to ensure cleanup
				}
				await this.setScreenState(screen, StreamState.IDLE);
	
				// 2. Find the next valid stream from the queue
				const queue = this.queues.get(screen) || [];
				let nextStream: StreamSource | undefined;
				let streamIndex = -1;
	
				for (let i = 0; i < queue.length; i++) {
					const potentialStream = queue[i];
					const failRecord = this.failedStreamAttempts.get(potentialStream.url);
					const isWatched = this.isStreamWatched(potentialStream.url);
	
					if (isWatched) {
						logger.debug(`Skipping watched stream on screen ${screen}: ${potentialStream.url}`, 'StreamManager');
						continue;
					}
	
					if (failRecord && Date.now() - failRecord.timestamp < this.STREAM_FAILURE_RESET_TIME) {
						if (failRecord.count >= this.MAX_STREAM_ATTEMPTS) {
							logger.warn(`Skipping stream with multiple recent failures: ${potentialStream.url}`, 'StreamManager');
							continue;
						}
					}
					
					// Found a valid stream
					nextStream = potentialStream;
					streamIndex = i;
					break;
				}
	
				// If no valid stream is found, update the queue and try again later.
				if (!nextStream) {
					logger.info(`No valid streams in queue for screen ${screen}. Will refresh queue.`, 'StreamManager');
					// Use fire-and-forget to avoid holding the lock
					this.updateQueue(screen).catch(err => logger.error(`Error in background queue update for screen ${screen}`, 'StreamManager', err));
					return;
				}
				
				// Remove the stream we are about to start from the queue
				if (streamIndex !== -1) {
					queue.splice(streamIndex, 1);
					this.queues.set(screen, queue);
					queueService.setQueue(screen, queue);
				}
	
				// 3. Start the next stream
				logger.info(`Starting next stream on screen ${screen}: ${nextStream.url}`, 'StreamManager');
				await this.startNextStream(screen, nextStream);
	
			} catch (error) {
				logger.error(`Error in handleStreamEnd for screen ${screen}`, 'StreamManager', error);
				await this.setScreenState(screen, StreamState.ERROR, error instanceof Error ? error : new Error(String(error)));
			}
		}, 30000); // Give this critical operation a longer timeout
	}


	/**
	 * Starts the next stream in the queue for a screen
	 * @param screen The screen number
	 * @param nextStream The next stream to play
	 */
	private async startNextStream(screen: number, nextStream: StreamSource): Promise<void> {
		const screenConfig = this.getScreenConfig(screen);
		if (!screenConfig) {
			const err = new Error(`Cannot start next stream, no config for screen ${screen}`);
			logger.error(err.message, 'StreamManager');
			await this.setScreenState(screen, StreamState.ERROR, err);
			return;
		}
	
		try {
			const streamOptions: StreamOptions = {
				url: nextStream.url,
				screen,
				title: nextStream.title,
				viewerCount: nextStream.viewerCount,
				startTime: nextStream.startTime,
				quality: nextStream.quality || screenConfig.quality || 'best',
				volume: nextStream.volume ?? screenConfig.volume ?? 50,
				windowMaximized: screenConfig.windowMaximized,
			};
	
			const startResult = await this.startStream(streamOptions);
	
			if (!startResult.success) {
				logger.error(`Failed to start next stream on screen ${screen}: ${startResult.error}`, 'StreamManager');
				
				// Log the failure
				const failRecord = this.failedStreamAttempts.get(nextStream.url) || { timestamp: 0, count: 0 };
				failRecord.count++;
				failRecord.timestamp = Date.now();
				this.failedStreamAttempts.set(nextStream.url, failRecord);
	
				// Mark as error and try the next one
				await this.setScreenState(screen, StreamState.ERROR, new Error(startResult.error));
				// Use setTimeout to avoid deep recursion and holding the lock.
				setTimeout(() => this.handleStreamEnd(screen), 200);
			}
		} catch (error) {
			logger.error(`Error starting next stream on screen ${screen}`, 'StreamManager', error);
			await this.setScreenState(screen, StreamState.ERROR, error instanceof Error ? error : new Error(String(error)));
			// Use setTimeout to avoid deep recursion and holding the lock.
			setTimeout(() => this.handleStreamEnd(screen), 200);
		}
	}

	// Modify handleEmptyQueue to use state machine and locking
	private async handleEmptyQueue(screen: number): Promise<void> {
		await this.withLock(screen, 'handleEmptyQueue', async () => {
			const currentState = this.getScreenState(screen);

			if (currentState !== StreamState.IDLE) {
				logger.info(`Ignoring empty queue handling for screen ${screen} in state ${currentState}`, 'StreamManager');
				return;
			}
			try {
				logger.info(`Handling empty queue for screen ${screen}, fetching fresh streams`, 'StreamManager');
				await this.updateQueue(screen); // This populates this.queues
				
				// handleStreamEnd will pick up the newly populated queue and start the first valid stream.
				await this.handleStreamEnd(screen);

			} catch (error) {
				logger.error(`Error handling empty queue for screen ${screen}`, 'StreamManager', error);
				await this.setScreenState(screen, StreamState.ERROR, error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	// Modify startStream to use state machine and locking
	async startStream(options: StreamOptions & { url: string }): Promise<StreamResponse> {
		const screen = options.screen;
		logger.info(`Starting stream on screen ${screen}: ${options.url}`, 'StreamManager');

		if (screen === undefined) {
			return { screen: 0, success: false, error: 'Screen number is required' };
		}
	
		// No lock here, it should be acquired by the calling function (e.g., handleStreamEnd)
		// This prevents nested lock acquisitions.
	
		// Stop any existing stream on the screen before starting a new one
		if (this.streams.has(screen)) {
			logger.info(`Stopping existing stream on screen ${screen} before starting new one.`, 'StreamManager');
			await this.stopStream(screen, true);
		}
	
		const transitionSuccess = await this.setScreenState(screen, StreamState.STARTING);
		if (!transitionSuccess) {
			return { screen, success: false, error: 'Could not transition to STARTING state' };
		}
		this.screenStartingTimestamps.set(screen, Date.now());
	
		return safeAsync<StreamResponse>(
			async () => {
				const screenConfig = this.screenConfigs.get(screen);
				if (!screenConfig) throw new Error(`Screen ${screen} not found in screenConfigs`);
	
				const result = await this.playerService.startStream({ 
					...options, 
					screen, 
					config: screenConfig,
					startTime: options.startTime !== undefined 
					  ? (typeof options.startTime === 'string' ? parseInt(options.startTime, 10) : options.startTime)
    : undefined
});
	
				if (result.success) {
					this.streams.set(screen, {
						url: options.url,
						screen: screen,
						quality: options.quality || 'best',
						platform: options.url.includes('twitch.tv') ? 'twitch' : 'youtube',
						status: 'playing',
						volume: 100,
						process: null, // PlayerService will manage the process
						id: Date.now()
					});
					this.screenStartingTimestamps.delete(screen); // Clear timestamp on success
					await this.setScreenState(screen, StreamState.PLAYING);
					return { screen, success: true };
				} else {
					this.screenStartingTimestamps.delete(screen);
					await this.setScreenState(screen, StreamState.ERROR, new Error(result.error || 'Failed to start stream'));
					return { screen, success: false, error: result.error || 'Failed to start stream' };
				}
			},
			`StreamManager:startStream:${screen}`,
			{
				screen,
				success: false,
				error: 'Unexpected error during stream start'
			}
		);
	}

	// Implement stopStream with state machine
	async stopStream(screen: number, isManualStop: boolean = false): Promise<boolean> {
		// No lock here, should be acquired by caller (e.g. handleStreamEnd)
		const currentState = this.getScreenState(screen);

		if ([StreamState.STOPPING, StreamState.DISABLED, StreamState.IDLE].includes(currentState) && !this.streams.has(screen)) {
			return true;
		}

		await this.setScreenState(screen, StreamState.STOPPING);

		try {
			logger.info(`Stopping stream on screen ${screen}, manualStop=${isManualStop}`, 'StreamManager');

			if (isManualStop) {
				this.manuallyClosedScreens.add(screen);
			}

			const success = await this.playerService.stopStream(screen, true, isManualStop);
			
			this.streams.delete(screen);
			await this.setScreenState(screen, StreamState.IDLE);
			return success;

		} catch (error) {
			await this.setScreenState(screen, StreamState.ERROR, error instanceof Error ? error : new Error(String(error)));
			logger.error(`Error stopping stream on screen ${screen}`, 'StreamManager', error);
			this.streams.delete(screen);
			return false;
		}
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
					if(stream.platform === 'youtube' && this.checkYouTubeStreamLive) {
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
				const filteredResults = onFilterResults.filter((stream): stream is StreamSource => stream !== undefined);

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
	
		const autoStartScreens = this.config.streams
			.filter((s) => s.enabled && s.autoStart)
			.map((s) => s.screen);
	
		if (autoStartScreens.length === 0) {
			logger.info('No screens configured for auto-start', 'StreamManager');
			return;
		}
	
		// Trigger an update for all screens. The main loop will handle starting streams on idle screens.
		// This is much safer than starting them directly here.
		await this.updateAllQueues();
	
		logger.info(`Auto-start process initiated for screens: ${autoStartScreens.join(', ')}`, 'StreamManager');
	}
	/**
	 * Disables a screen and optionally forces immediate stop
	 * @param screen The screen number to disable
	 * @param fast If true, uses force stop for immediate termination
	 */
	async disableScreen(screen: number, fast = false): Promise<void> {
		await this.withLock(screen, 'disableScreen', async () => {
			// Update state to disabled immediately
			await this.setScreenState(screen, StreamState.DISABLED, undefined, true); // force transition
		
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
				// Don't rethrow, as the main goal is to disable the screen.
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
		});
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
		await this.withLock(screen, 'enableScreen', async () => {
			logger.info(`Enabling screen ${screen}`, 'StreamManager');
		
			try {
				// First update state and services
				await this.setScreenState(screen, StreamState.IDLE);
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
	
				// Trigger a queue update to find available streams
				await this.updateSingleScreen(screen);
	
			} catch (error) {
				logger.error(
					`Error enabling screen ${screen}`,
					'StreamManager',
					error instanceof Error ? error : new Error(String(error))
				);
				// Ensure we don't get stuck in an error state
				await this.setScreenState(screen, StreamState.ERROR, error instanceof Error ? error : new Error(String(error)));
				throw error; // Re-throw to ensure the lock is released correctly
			}
		
			logger.info(`Screen ${screen} enabled`, 'StreamManager');
		});
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
			logger.warn(
				`Force resetting lock for screen ${screen}: ${error instanceof Error ? error.message : String(error)}`,
				'StreamManager'
			);
			this.screenMutexes.delete(screen);
		}
	}
	private async deferStartNextStream(screen: number) {
		setTimeout(async () => {
			try {
				const nextStream = queueService.getNextStream(screen);
	
				if (nextStream) {
					const streamOptions: StreamOptions = {
						url: nextStream.url,
						title: nextStream.title,
						viewerCount: nextStream.viewerCount,
						startTime: nextStream.startTime,
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
				await this.setScreenState(screen, StreamState.ERROR, error instanceof Error ? error : new Error(String(error)));
			}
		}, 500); // Short delay
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
		const restart = async (s: number) => {
			logger.info(`Restarting stream on screen ${s}`, 'StreamManager');
			await this.handleStreamEnd(s);
		};
		if (screen) {
			await this.withLock(screen, 'restartStream', () => restart(screen));
		} else {
			for (const s of this.screenConfigs.keys()) {
				await this.withLock(s, 'restartStream', () => restart(s));
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
				logger.debug(
					`Removed expired watched entry for ${url} during getWatchedStreams`,
					'StreamManager'
				);
			}
		}

		// Update queueService to match local state
		queueService.clearWatchedStreams();
		for (const url of this.watchedStreams.keys()) {
			queueService.markStreamAsWatched(url);
		}


		return Array.from(this.watchedStreams.keys());
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
		this.emit('queueUpdate', { screen, queue });
	}

	public async removeFromQueue(screen: number, index: number): Promise<void> {
		const queue = this.queues.get(screen) || [];
		if (index >= 0 && index < queue.length) {
			queue.splice(index, 1);
			this.queues.set(screen, queue);
			queueService.setQueue(screen, queue);
			this.emit('queueUpdate', { screen, queue });
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
			status: this.getScreenState(screen),
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
			quality: stream!.quality,
			status: item.current ? 'playing' : 'stopped',
			platform: item.filename.includes('youtube.com') ? 'youtube' : 'twitch',
			volume: stream!.volume,
			process: item.current ? stream!.process : null
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
			const allStreams = await this.getAllStreamsForScreen(screen);
			if (allStreams.length === 0) {
				logger.info(`No streams found for screen ${screen}, queue will be empty`, 'StreamManager');
				this.queues.set(screen, []);
				queueService.setQueue(screen, []);
				this.emit('queueUpdate', { screen, queue: [] });
				return;
			}
			
			const sortedStreams = this.sortStreams(allStreams, screenConfig.sorting);

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
				await this.updateAllQueues();
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
			this.config.streams.forEach(s => this.setScreenState(s.screen, StreamState.NETWORK_RECOVERY));
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
					await this.withLock(screen, `networkRecovery`, async () => {
						try {
							// Stagger recovery to avoid system overload
							if (index > 0) {
								await new Promise(resolve => setTimeout(resolve, 1000));
							}
		
							const currentState = this.getScreenState(screen);
							const activeStream = this.streams.get(screen);
		
							logger.info(`Processing screen ${screen} (state: ${currentState}) for network recovery`, 'StreamManager');
		
							// Only intervene if the screen is in a problematic state
							if (currentState === StreamState.NETWORK_RECOVERY || currentState === StreamState.ERROR || currentState === StreamState.IDLE) {
								await this.setScreenState(screen, StreamState.IDLE);
								await this.handleStreamEnd(screen); // This will try to find a new stream
							} else if (currentState === StreamState.PLAYING && activeStream) {
								// Check if stream is actually working, restart if needed
								await this.handlePlayingScreenRecovery(screen, activeStream);
							}
							
						} catch (error) {
							logger.error(
								`Failed to recover screen ${screen}`,
								'StreamManager',
								error instanceof Error ? error : new Error(String(error))
							);
							await this.setScreenState(screen, StreamState.ERROR, error instanceof Error ? error : new Error(String(error)));
						}
					});
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
	
	private async handleIdleScreenRecovery(screen: number): Promise<void> {
		await this.withLock(screen, `idleRecovery`, async () => {
			try {
				await this.updateQueue(screen);
				const queue = this.queues.get(screen) || [];
				
				if (queue.length > 0) {
					logger.info(`Found ${queue.length} streams for screen ${screen} after recovery.`, 'StreamManager');
					await this.handleStreamEnd(screen); // Let it find the next stream from the new queue
				} else {
					logger.info(`No streams in queue for screen ${screen} after recovery.`, 'StreamManager');
				}
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error);
				logger.error(`Failed to start stream on screen ${screen}: ${errorMessage}`, 'StreamManager');
				await this.setScreenState(screen, StreamState.ERROR, error instanceof Error ? error : new Error(errorMessage));
			}
		});
	}
	
	/**
	 * Handles recovery for a screen that should be playing a stream
	 * @param screen The screen number
	 * @param activeStream The active stream instance to monitor
	 */
	private async handlePlayingScreenRecovery(screen: number, activeStream: StreamInstance): Promise<void> {
		await this.withLock(screen, `playingRecovery`, async () => {
			logger.info(
				`Monitoring active stream on screen ${screen} for health: ${activeStream.url}`,
				'StreamManager'
			);
			
			// Check if the stream is still healthy
			if (!this.isStreamHealthy(activeStream)) {
				logger.warn(
					`Stream on screen ${screen} is not healthy, attempting recovery by restarting`,
					'StreamManager'
				);
				await this.restartStreams(screen);
			} else {
				logger.info(`Stream on screen ${screen} is healthy. No action needed.`, 'StreamManager');
			}
		});
	}
	
	private async handleErrorScreenRecovery(screen: number): Promise<void> {
		await this.withLock(screen, `errorRecovery`, async () => {
			logger.info(`Attempting to recover screen ${screen} from error state`, 'StreamManager');
			
			// Clear error state and try to start fresh
			await this.setScreenState(screen, StreamState.IDLE);
			
			// Then handle as idle screen
			await this.handleIdleScreenRecovery(screen);
		});
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
					await this.withLock(screen, `forceRestart`, async () => {
						try {
							const currentState = this.getScreenState(screen);
							if (currentState === StreamState.PLAYING || currentState === StreamState.ERROR) {
								await this.restartStreams(screen);
							}
						} catch (error) {
							logger.error(`Failed to restart screen ${screen}`, 'StreamManager', error);
						}
					});
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
						return false;
					}

					if (stream.sourceStatus === 'ended') {
						return false;
					}

					// For upcoming streams, check if they're in the past
					if (stream.sourceStatus === 'upcoming' && stream.startTime) {
						const now = Date.now();
						// If the start time is in the past by more than 30 minutes, filter it out
						if (stream.startTime < now - 30 * 60 * 1000) {
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
			if (Object.prototype.hasOwnProperty.call(platformFavorites, groupName)) {
				if (platformFavorites[groupName]?.includes(channelId)) {
					return true;
				}
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
					...screen,
					volume: screen.volume ?? this.config.player.defaultVolume,
					quality: screen.quality ?? this.config.player.defaultQuality,
					windowMaximized: screen.windowMaximized ?? this.config.player.windowMaximized,
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
		this.playerService.onStreamError(async (data: StreamError) => {
			if (this.isShuttingDown || this.manuallyClosedScreens.has(data.screen)) {
				logger.info(`Ignoring error for manually closed/shutting down screen ${data.screen}`, 'StreamManager');
				return;
			}
			
			await this.withLock(data.screen, 'onStreamError', async () => {
				logger.info(`Stream error on screen ${data.screen}: ${data.error}`, 'StreamManager');
	
				try {
					await this.setScreenState(data.screen, StreamState.ERROR, new Error(data.error));
					// The main loop will now see the error state and attempt recovery via handleStreamEnd.
					// Use setTimeout to decouple from the current execution context.
					setTimeout(() => this.handleStreamEnd(data.screen), 500);
				} catch (error) {
					logger.error(`Error handling stream error on screen ${data.screen}`, 'StreamManager', error);
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
	public getDiagnostics(): object {
		const diagnostics: Record<string, any> = {};
		
		diagnostics.manager = {
			isShuttingDown: this.isShuttingDown,
			isOffline: this.isOffline,
			processingScreens: Array.from(this.processingScreens),
			manuallyClosedScreens: Array.from(this.manuallyClosedScreens),
		};

		diagnostics.screens = {};
		for (const screen of this.screenConfigs.keys()) {
			const stateMachine = this.stateMachines.get(screen);
			const stream = this.streams.get(screen);
			const queue = this.queues.get(screen) || [];
			diagnostics.screens[screen] = {
				state: stateMachine?.getState() || 'unknown',
				isLocked: this.screenMutexes.get(screen)?.isLocked() || false,
				streamUrl: stream?.url || 'none',
				queueLength: queue.length,
				playerIsHealthy: this.playerService.isStreamHealthy(screen),
			};
		}

		diagnostics.failedStreams = Object.fromEntries(this.failedStreamAttempts.entries());
		diagnostics.watchedStreams = Array.from(this.watchedStreams.keys());

		return diagnostics;
	}

	private getFilteredStreamsForScreen(
		screenIndex: number,
		currentUrl: string | undefined,
		streams: StreamSource[]
	): StreamSource[] {
		if (this.processingScreens.has(screenIndex)) return [];

		const streamConfig = this.getScreenConfig(screenIndex);
		if (!streamConfig) return [];

		const activeUrls = new Set(this.getActiveStreams().map(s => s.url));

		return streams
			.filter((stream) => {
				if (currentUrl && stream.url === currentUrl) return false;
				if (activeUrls.has(stream.url)) return false; // Exclude streams active on other screens
				if (!stream.sourceStatus || stream.sourceStatus !== 'live') return false;
				if(this.isStreamWatched(stream.url)) return false;

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