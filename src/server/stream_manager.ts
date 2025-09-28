import type {
	Config,
	FavoriteChannel,
	FavoriteChannels,
	PlayerSettings,
	ScreenConfig,
	StreamEnd,
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
    private manuallyClosedStreams: Map<string, number> = new Map();
	private lastUpdateTimestamp: Map<number, number> = new Map();
	private minUpdateSeconds: number = 60;
	// Add a map to track when screens entered the STARTING state
	private screenStartingTimestamps: Map<number, number> = new Map();
	private readonly MAX_STARTING_TIME = 45000; // 45 seconds max in starting state

	// Add a set to track screens that are currently being processed to prevent race conditions
	private processingScreens: Set<number> = new Set();
	private readonly DEFAULT_LOCK_TIMEOUT = 120000; // 15 seconds
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

		this.startQueueUpdates().catch((error) => {
			logger.error('Failed to start queue updates', 'StreamManager', error);
		});

		logger.info('StreamManager initialized', 'StreamManager');
	}

	private initializeScreenConfigs(): void {
		this.config.streams.forEach(screenConfig => {
			this.screenConfigs.set(screenConfig.screen, screenConfig);
		});
		logger.info('Screen configurations initialized', 'StreamManager');
	}

	private setupEventListeners(): void {
		this.playerService.onStreamOutput((data) => {
			this.emit('streamOutput', data);
		});

		this.playerService.onStreamError((data) => {
			this.emit('streamError', data);
			this.handleStreamError(data.screen, data.error, data.code, data.url, data.moveToNext, data.shouldRestart);
		});

		this.playerService.onStreamEnd((data) => {
			this.emit('streamEnd', data);
			this.handleStreamEnd(data.screen);
		});

		// Listen for queue service network events
		queueService.networkEmitter.on('offline', () => {
			this.emit('networkOffline');
		});

		queueService.networkEmitter.on('online', () => {
			this.emit('networkOnline');
		});
	}

	private async handleStreamError(
		screen: number,
		error: string,
		code?: number,
		url?: string,
		moveToNext?: boolean,
		shouldRestart?: boolean
	): Promise<void> {
		logger.error(`Stream error on screen ${screen}: ${error}`, 'StreamManager', { code, url });

		// If the error indicates a need to move to the next stream, or if it's a non-recoverable error
		if (moveToNext) {
			await this.setScreenState(screen, StreamState.ERROR, new Error(error));
			await this._handleStreamEndInternal(screen); // This will attempt to start the next stream
		} else if (shouldRestart) {
			// If the error suggests a restart might fix it (e.g., temporary network glitch)
			logger.info(`Attempting to restart stream on screen ${screen} due to error`, 'StreamManager');
			await this.setScreenState(screen, StreamState.ERROR, new Error(error));
			await this.restartStreams(screen);
		} else {
			// For other errors, just set the state to ERROR
			await this.setScreenState(screen, StreamState.ERROR, new Error(error));
		}
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

	public getActiveAndStartingStreamsCount(): number {
		let count = 0;
		for (const stateMachine of this.stateMachines.values()) {
			const state = stateMachine.getState();
			if (state === StreamState.PLAYING || state === StreamState.STARTING) {
				count++;
			}
		}
		return count;
	}

	// Simplified startQueueUpdates method using one central interval
	private async startQueueUpdates() {
		if (this.queueUpdateInterval !== null) {
			return; // Already running
		}

		// First run immediately
		await this.autoStartStreams();

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
	public async updateAllQueues(screens?: number[]) {
		if (this.isShuttingDown) {
			logger.debug('Skipping queue update - shutdown in progress', 'StreamManager');
			return;
		}

		// Get list of enabled screens that aren't currently being processed
		const screensToProcess =
			screens ??
			this.config.streams
				.filter((s) => s.enabled && !this.processingScreens.has(s.screen))
				.map((s) => s.screen);

		if (screensToProcess.length === 0) {
			logger.debug('No screens to process for queue update', 'StreamManager');
			return;
		}

		logger.info(`Updating queues for ${screensToProcess.length} screens`, 'StreamManager');

		// Process all screens in parallel with individual error handling
		await Promise.allSettled(
			screensToProcess.map((screen) =>
				this.withLock(screen, 'updateSingleScreen', () => this.updateSingleScreen(screen), 65000) // 30s timeout
					.catch((error) => {
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
				await this._handleStreamEndInternal(screen); // This will start the next stream
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
					`[Screen ${screen}] Stream has been in STARTING state for ${Math.round(elapsed / 1000)}s (> ${Math.round(
						timeoutMs / 1000
					)}s). Resetting.`,
					'StreamManager'
				);
				this.screenStartingTimestamps.delete(screen);
				await this.setScreenState(screen, StreamState.ERROR, new Error('Stuck in starting state'));
				await this._handleStreamEndInternal(screen); // Trigger recovery
			}
		});
	}


	/**
	 * Handles stream end events, cleans up, and starts the next stream in the queue.
	 * This is a central part of the stream lifecycle.
	 * @param screen The screen number where the stream ended or should be started.
	 */
	private async _handleStreamEndInternal(screen: number): Promise<void> {
		// Get screen config at the start of the function
		const screenConfig = this.getScreenConfig(screen);

		const currentState = this.getScreenState(screen);
		if (![StreamState.IDLE, StreamState.ERROR, StreamState.PLAYING, StreamState.STOPPING].includes(currentState)) {
			logger.debug(`handleStreamEnd called on screen ${screen} in state ${currentState}, skipping.`, 'StreamManager');
			return;
		}

		// Clean up any existing stream for this screen
		const existingStream = this.streams.get(screen);
		if (existingStream) {
			this.markStreamAsWatched(existingStream.url);
			this.streams.delete(screen);
		}

		await this.setScreenState(screen, StreamState.IDLE, undefined, true); // Force to IDLE to prepare for start

		// 2. Find the next valid stream from the queue
		const lastUpdate = this.lastUpdateTimestamp.get(screen);
		if (lastUpdate === undefined || lastUpdate < Date.now() - this.minUpdateSeconds * 1000) {
			this.updateQueue(screen).catch(err => logger.error(`Error in background queue update for screen ${screen}`, 'StreamManager', err));
		}
		const queue = this.queues.get(screen) || [];
		let nextStream: StreamSource | undefined;
		let streamIndex = -1;

		for (let i = 0; i < queue.length; i++) {
			const potentialStream = queue[i];
			const failRecord = this.failedStreamAttempts.get(potentialStream.url);
			const isWatched = this.isStreamWatched(potentialStream.url);
			const isManuallyClosed = this.manuallyClosedStreams.has(potentialStream.url);

			if (isManuallyClosed) {
				logger.debug(`Skipping manually closed stream on screen ${screen}: ${potentialStream.url}`, 'StreamManager');
				this.manuallyClosedStreams.delete(potentialStream.url); // Consume it
				continue;
			}

			if (isWatched && (screenConfig?.skipWatchedStreams ?? true)) {
				logger.debug(`Skipping watched stream on screen ${screen}: ${potentialStream.url}`, 'StreamManager');
				continue;
			}
	
			if (failRecord && Date.now() - failRecord.timestamp < this.STREAM_FAILURE_RESET_TIME) {
				if (failRecord.count >= this.MAX_STREAM_ATTEMPTS) {
					logger.warn(`Skipping stream with multiple recent failures: ${potentialStream.url}`, 'StreamManager');
					continue;
				}
			}
			
			nextStream = potentialStream;
			streamIndex = i;
			break;
		}
	
		if (!nextStream) {
			logger.info(`No valid streams in queue for screen ${screen}. Will refresh queue.`, 'StreamManager');
			this.updateQueue(screen).catch(err => logger.error(`Error in background queue update for screen ${screen}`, 'StreamManager', err));
			return;
		}
		
		if (streamIndex !== -1) {
			queue.splice(streamIndex, 1);
			this.queues.set(screen, queue);
			queueService.setQueue(screen, queue);
		}
	
		// 3. Transition state to STARTING, then start the stream process after releasing the lock
		logger.info(`Found next stream for screen ${screen}: ${nextStream.url}. Preparing to start.`, 'StreamManager');
		if (!screenConfig) {
			logger.error(`Cannot start stream, no config for screen ${screen}`, 'StreamManager');
			await this.setScreenState(screen, StreamState.ERROR, new Error(`No config for screen ${screen}`));
			return;
		}
	
		const transitionSuccess = await this.setScreenState(screen, StreamState.STARTING);
		if (transitionSuccess) {
			// Use setTimeout to release the current execution context (and the lock) before starting the stream.
			setTimeout(() => {
				const streamOptions: StreamOptions = {
					url: nextStream!.url,
					screen,
					title: nextStream!.title,
					viewerCount: nextStream!.viewerCount,
					startTime: nextStream!.startTime,
					quality: nextStream!.quality || screenConfig.quality || 'best',
					volume: nextStream!.volume ?? this.config.player.defaultVolume ?? screenConfig.volume ?? 50,
					windowMaximized: screenConfig.windowMaximized,
				};
				this.startStream(streamOptions).catch(err => {
					logger.error(`Error bubbled up from async startStream call for screen ${screen}`, 'StreamManager', err);
				});
			}, 0);
		} else {
			logger.error(`Failed to transition screen ${screen} to STARTING state. Aborting start.`, 'StreamManager');
		}
	}
	public async handleStreamEnd(screen: number): Promise<void> {
		await this.withLock(screen, `handleStreamEnd`, () => this._handleStreamEndInternal(screen), 65000); 
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
				volume: nextStream.volume ?? this.config.player.defaultVolume ?? screenConfig.volume ?? 50,
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
				setTimeout(() => this.handleStreamEnd(screen), 1000);
			}
		} catch (error) {
			logger.error(`Error starting next stream on screen ${screen}`, 'StreamManager', error);
			await this.setScreenState(screen, StreamState.ERROR, error instanceof Error ? error : new Error(String(error)));
			// Use setTimeout to avoid deep recursion and holding the lock.
			setTimeout(() => this.handleStreamEnd(screen), 1000);
		}
	}

	// Modify handleEmptyQueue to use state machine and locking
	public async handleEmptyQueue(screen: number): Promise<void> {
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

	async startStream(options: StreamOptions & { url: string }): Promise<StreamResponse> {
		// Ensure screen is defined and a number
		if (options.screen === undefined) {
			const error = 'Screen number is required';
			logger.error(error, 'StreamManager');
			return { screen: -1, success: false, error };
		}
		
		const screen = options.screen;
		const { url } = options;
	
		if (this.isShuttingDown) {
			return { screen, success: false, error: 'Manager is shutting down' };
		}
		
		logger.info(`Starting stream process for screen ${screen}: ${url}`, 'StreamManager');
		this.screenStartingTimestamps.set(screen, Date.now());
	
		try {
			const screenConfig = this.screenConfigs.get(screen);
			if (!screenConfig) {
				throw new Error(`Screen ${screen} not found in screenConfigs`);
			}
	
			const result = await this.playerService.startStream({ 
				...options, 
				screen, 
				config: screenConfig,
				startTime: options.startTime !== undefined 
					? (typeof options.startTime === 'string' ? parseInt(options.startTime, 10) : options.startTime)
					: undefined
			});
	
			this.screenStartingTimestamps.delete(screen);
	
			if (result.success) {
				this.streams.set(screen, {
					url: options.url,
					screen: screen,
					quality: options.quality || 'best',
					platform: options.url.includes('twitch.tv') ? 'twitch' : 'youtube',
					status: 'playing',
					volume: options.volume || screenConfig.volume,
					process: null,
					id: Date.now()
				});
				await this.setScreenState(screen, StreamState.PLAYING);
				return { screen, success: true, message: 'Stream started' };
			} else {
				const error = result.error || 'Failed to start stream';
				const failRecord = this.failedStreamAttempts.get(url) || { timestamp: 0, count: 0 };
				failRecord.count++;
				failRecord.timestamp = Date.now();
				this.failedStreamAttempts.set(url, failRecord);
				await this.setScreenState(screen, StreamState.ERROR, new Error(error));
				// If the error is max streams, wait longer before retrying.
				const retryDelay = error.includes('Maximum number of streams') ? 30000 : 1000;
				setTimeout(() => this.handleStreamEnd(screen), retryDelay);
				return { screen, success: false, error: error };
			}
		} catch (error) {
			this.screenStartingTimestamps.delete(screen);
			const err = error instanceof Error ? error : new Error(String(error));
			logger.error(`Unhandled error in startStream for screen ${screen}`, 'StreamManager', err);
			await this.setScreenState(screen, StreamState.ERROR, err);
			setTimeout(() => this.handleStreamEnd(screen), 1000);
			return { screen, success: false, error: err.message };
		}
	}
	async stopStream(screen: number, isManualStop: boolean = false): Promise<boolean> {
		return this.withLock(screen, 'stopStream', async () => {
			const currentState = this.getScreenState(screen);
			if (currentState === StreamState.STOPPING || currentState === StreamState.IDLE) {
				if (!this.streams.has(screen)) return true;
			}
			
			await this.setScreenState(screen, StreamState.STOPPING);
			        if (isManualStop) {
            const streamInstance = this.streams.get(screen);
            if (streamInstance) {
                this.manuallyClosedScreens.add(screen);
                this.manuallyClosedStreams.set(streamInstance.url, Date.now());
                logger.info(`Marked stream ${streamInstance.url} on screen ${screen} as manually closed.`, 'StreamManager');
            }
        }
			const success = await this.playerService.stopStream(screen, true, isManualStop);
			this.streams.delete(screen);
			await this.setScreenState(screen, StreamState.IDLE);
			return success;
	   }, 10000);
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

	private getFlattenedFavorites(platform: 'holodex' | 'twitch' | 'youtube'): FavoriteChannel[] {
		const favoritesByGroup = this.favoriteChannels[platform];
		if (!favoritesByGroup) return [];

		return Object.values(favoritesByGroup).flat();
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
						const favoriteChannels = this.getFlattenedFavorites('holodex');
						const channelIds = favoriteChannels.map((c) => c.id);
						sourceStreams = await this.holodexService.getLiveStreams({
							channels: channelIds,
							limit: source.limit || 50
						});
						sourceStreams.forEach((stream) => {
							const favorite = favoriteChannels.find((c: FavoriteChannel) => {
								logger.debug(`  Comparing stream channelId: ${stream.channelId} with favorite id: ${c.id}`, 'StreamManager');
								return c.id === stream.channelId;
							});
							if (favorite) {
								stream.score = favorite.score;
								logger.debug(`  Assigned score ${favorite.score} to stream with channelId: ${stream.channelId}`, 'StreamManager');
							} else {
								logger.debug(`  No matching favorite found for stream with channelId: ${stream.channelId}. Expected favorite IDs: ${favoriteChannels.map(c => c.id).join(', ')}`, 'StreamManager');
							}
						});
					}
				} else if (source.type === 'twitch') {
					if (source.subtype === 'favorites') {
						const favoriteChannels = this.getFlattenedFavorites('twitch');
						const channelIds = favoriteChannels.map((c) => c.id);
						sourceStreams = await this.twitchService.getStreams({
							channels: channelIds,
							limit: source.limit || 50
						});
						sourceStreams.forEach((stream) => {
							const favorite = favoriteChannels.find((c: FavoriteChannel) => {
								logger.debug(`  Comparing stream channelId: ${stream.channelId} with favorite id: ${c.id} for Twitch stream ${stream.title}`, 'StreamManager');
								return c.id === stream.channelId;
							});
							if (favorite) {
								stream.score = favorite.score;
								logger.debug(`  Assigned score ${favorite.score} to Twitch stream ${stream.title} (channelId: ${stream.channelId}) from favorite ${favorite.name} (id: ${favorite.id})`, 'StreamManager');
							} else {
								logger.debug(`  No matching favorite found for Twitch stream ${stream.title} (channelId: ${stream.channelId}). Expected favorite IDs: ${favoriteChannels.map(c => c.id).join(', ')}`, 'StreamManager');
							}
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

	async getJapaneseStreams(limit = 50): Promise<StreamSource[]> {
		// Combine streams from Holodex (Japanese organizations) and Twitch (Japanese language)
		const holodexJapaneseStreams = await this.holodexService.getLiveStreams({
			organization: 'Nijisanji', // Example: assuming Nijisanji is primarily Japanese
			limit
		});

		const twitchJapaneseStreams = await this.twitchService.getJapaneseStreams(limit);

		// Merge and deduplicate streams if necessary
		const allJapaneseStreams = [...holodexJapaneseStreams, ...twitchJapaneseStreams];

		// You might want to sort or filter these further
		return this.sortStreams(allJapaneseStreams).slice(0, limit);
	}

	async autoStartStreams() {
		if (this.isShuttingDown) return;
		logger.info('Auto-starting streams...', 'StreamManager');

		const autoStartScreens = this.config.streams
			.filter((s) => s.enabled && s.autoStart)
			.map((s) => s.screen);

		if (autoStartScreens.length === 0) {
			logger.info('No screens configured for auto-start', 'StreamManager');
			// Even if no screens are set to autostart, we should update all queues once at startup
			await this.updateAllQueues();
			return;
		}

		logger.info(`Auto-start process initiated for screens: ${autoStartScreens.join(', ')}`, 'StreamManager');
		// Trigger an update for the screens configured to auto-start.
		await this.updateAllQueues(autoStartScreens);
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
						screen: screen,
						volume: this.config.player.defaultVolume
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
			const restartPromises = Array.from(this.screenConfigs.keys()).map(s => {
				return this.withLock(s, 'restartStream', () => restart(s));
			});
			await Promise.all(restartPromises);
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

	private sortStreams(streams: StreamSource[], screenConfig?: ScreenConfig): StreamSource[] {
		const screenSortConfig = screenConfig?.sorting;
		const screenSortFields = screenSortConfig ? [screenSortConfig] : undefined;
		const globalSortFields = this.config.sorting?.fields;
		const sortFields = screenSortFields || globalSortFields;

		if (!sortFields || !Array.isArray(sortFields)) {
			// Fallback to a sensible default sort if config is not present
			return streams.sort((a, b) => {
				const priorityA = a.priority ?? 999;
				const priorityB = b.priority ?? 999;
				if (priorityA !== priorityB) {
					return priorityA - priorityB; // Lower priority number first
				}
				const scoreA = a.score ?? 0;
				const scoreB = b.score ?? 0;
				if (scoreA !== scoreB) {
					return scoreB - scoreA; // Higher score first
				}
				return (b.viewerCount ?? 0) - (a.viewerCount ?? 0); // Higher viewers first
			});
		}

		return streams.sort((a, b) => {
			logger.debug(`Comparing streams: A=${a.title} (score: ${a.score}, priority: ${a.priority}, subtype: ${a.subtype}) vs B=${b.title} (score: ${b.score}, priority: ${b.priority}, subtype: ${b.subtype})`, 'StreamManager');
			for (const rule of sortFields) {
				const { field, order, ignore } = rule as { field: string; order: 'asc' | 'desc'; ignore?: string | string[]; };
				logger.debug(`  Applying rule: field=${field}, order=${order}, ignore=${ignore}`, 'StreamManager');

				const aIsIgnored = ignore && ((Array.isArray(ignore) && a.subtype !== undefined && ignore.includes(a.subtype as string)) || (a.subtype !== undefined && a.subtype === ignore));
				const bIsIgnored = ignore && ((Array.isArray(ignore) && b.subtype !== undefined && ignore.includes(b.subtype as string)) || (b.subtype !== undefined && b.subtype === ignore));

				if (aIsIgnored && bIsIgnored) {
					logger.debug(`    Both A and B ignored for rule ${field}`, 'StreamManager');
					continue;
				}
				if (aIsIgnored) {
					logger.debug(`    A ignored for rule ${field}, pushing A to end`, 'StreamManager');
					return 1;
				}
				if (bIsIgnored) {
					logger.debug(`    B ignored for rule ${field}, pushing B to end`, 'StreamManager');
					return -1;
				}

				const valueA = a[field as keyof StreamSource] as number | undefined;
				const valueB = b[field as keyof StreamSource] as number | undefined;

				const valA = valueA ?? (order === 'desc' ? -Infinity : Infinity);
				const valB = valueB ?? (order === 'desc' ? -Infinity : Infinity);

				logger.debug(`    Comparing ${field}: A=${valA} vs B=${valB}`, 'StreamManager');

				if (valA !== valB) {
					const result = order === 'desc' ? valB - valA : valA - valB;
					logger.debug(`    Result for ${field}: ${result}`, 'StreamManager');
					return result;
				}
			}
			// Fallback
			logger.debug(`  Falling back to viewerCount sort`, 'StreamManager');
			return (b.viewerCount ?? 0) - (a.viewerCount ?? 0);
		});
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

	public async toggleScreen(screen: number): Promise<boolean> {
		const screenConfig = this.getScreenConfig(screen);
		if (!screenConfig) {
			throw new Error(`Screen ${screen} not found`);
		}

		if (screenConfig.enabled) {
			await this.disableScreen(screen);
			return false;
		} else {
			await this.enableScreen(screen);
			return true;
		}
	}

	public getDiagnostics() {
		const diagnostics = {
			activeStreams: Array.from(this.streams.entries()).map(([screen, stream]) => ({
				screen,
				url: stream.url,
				status: stream.status,
				pid: stream.process?.pid,
				platform: stream.platform,
				quality: stream.quality,
				volume: stream.volume,
				startTime: stream.startTime,
				title: stream.title,
			})),
			screenStates: Array.from(this.stateMachines.entries()).map(([screen, stateMachine]) => ({
				screen,
				state: stateMachine.getState(),
			})),
			queues: Array.from(this.queues.entries()).map(([screen, queue]) => ({
				screen,
				queueLength: queue.length,
				nextStream: queue.length > 0 ? queue[0].url : null,
			})),
			watchedStreamsCount: this.watchedStreams.size,
			failedStreamAttempts: Array.from(this.failedStreamAttempts.entries()).map(([url, data]) => ({
				url,
				...data,
			})),
			isShuttingDown: this.isShuttingDown,
			isOffline: this.isOffline,
			processingScreens: Array.from(this.processingScreens.values()),
		};
		return diagnostics;
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
			this.lastUpdateTimestamp.set(screen, Date.now());
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
			
			const sortedStreams = this.sortStreams(allStreams, screenConfig);

			// Assign score based on queue index
			sortedStreams.forEach((stream, index) => {
				if (stream.score === undefined) {
					stream.score = sortedStreams.length - index;
				}
			});

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
	public async getAllStreamsForScreen(screen: number): Promise<StreamSource[]> {
		const screenConfig = this.config.streams.find((s) => s.screen === screen);
		if (!screenConfig || !screenConfig.sources?.length) {
			return [];
		}

		const allStreams: StreamSource[] = [];
		for (const source of screenConfig.sources) {
			if (!source.enabled) continue;

			// Use the existing fetchStreamsForSource method
			const sourceStreams = await this.fetchStreamsForSource(source, screen);
			allStreams.push(...sourceStreams);
		}

		return allStreams;
	}
}

// Instantiate services and StreamManager
const config: Config = loadAllConfigs();

const holodexFilters: string[] = [];
if (config.filters?.filters) {
  for (const f of config.filters.filters) {
    if (typeof f === 'string') {
      holodexFilters.push(f as string);
    }
  }
}

const holodexFavoriteChannelIds: string[] = [];
if (config.favoriteChannels.holodex?.default) {
  for (const c of config.favoriteChannels.holodex.default) {
    holodexFavoriteChannelIds.push(c.id as string);
  }
}

const holodexService = new HolodexService(
  config.holodex.apiKey,
  holodexFilters as any,
  holodexFavoriteChannelIds as any
);

const twitchFilters: string[] = [];
if (config.filters?.filters) {
  for (const f of config.filters.filters) {
    if (typeof f === 'string') {
      twitchFilters.push(f as string);
    }
  }
}

const twitchService = new TwitchService(
  config.twitch.clientId,
  config.twitch.clientSecret,
  twitchFilters as any
);

const playerService = new PlayerService(config);

const streamManager = new StreamManager(
  config,
  holodexService,
  twitchService,
  playerService
);

export default streamManager;
