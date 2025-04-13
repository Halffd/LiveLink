import { EventEmitter } from 'events';
import type { Config, StreamOptions } from '../../types/stream.js';
import type { StreamOutput, StreamError, StreamResponse } from '../../types/stream_instance.js';
import { logger } from './logger/index.js';
import path from 'path';
import fs from 'fs';
import net from 'net';
import { spawn, exec, execSync, type ChildProcess } from 'child_process';

interface LocalStreamInstance {
	id: number;
	screen: number;
	url: string;
	quality: string;
	status: string;
	volume: number;
	process: ChildProcess;
	platform: 'youtube' | 'twitch';
	title?: string;
	startTime?: number;
	options: StreamOptions & { screen: number };
}

interface LocalStreamEnd {
	screen: number;
	error?: Error | string;
	code?: number;
}

export class PlayerService {
	private readonly BASE_LOG_DIR: string;
	private readonly MAX_RETRIES = 2;
	private readonly RETRY_INTERVAL = 500;
	private readonly STREAM_REFRESH_INTERVAL = 4 * 60 * 60 * 1000; // 4 hours
	private readonly INACTIVE_RESET_TIMEOUT = 5 * 60 * 1000; // 5 minutes
	private readonly STARTUP_TIMEOUT = 30000; // 30 seconds for startup
	private readonly SHUTDOWN_TIMEOUT = 2000; // 2 seconds for shutdown
	private readonly SCRIPTS_PATH: string;
	private streams: Map<number, LocalStreamInstance> = new Map();
	// Track active screen slots separately from the streams map to guarantee accurate counts
	private activeScreenSlots: Set<number> = new Set();
	private streamRetries: Map<number, number> = new Map();
	private streamStartTimes: Map<number, number> = new Map();
	private streamRefreshTimers: Map<number, NodeJS.Timeout> = new Map();
	private inactiveTimers: Map<number, NodeJS.Timeout> = new Map();
	private healthCheckIntervals: Map<number, NodeJS.Timeout> = new Map();
	private startupLocks: Map<number, boolean> = new Map();
	private globalStartupLock = false;
	private manuallyClosedScreens: Set<number> = new Set();
	private disabledScreens: Set<number> = new Set();
	private ipcPaths: Map<number, string> = new Map();
	private retryTimers: Map<number, NodeJS.Timeout> = new Map();
	private fifoPaths: Map<number, string> = new Map();
	private shuttingDownScreens: Set<number> = new Set(); // Track screens being shut down

	private readonly config: Config;
	private readonly mpvPath: string;
	private isShuttingDown = false;
	private events = new EventEmitter();
	private outputCallback?: (data: StreamOutput) => void;
	private errorCallback?: (data: StreamError) => void;
	private endCallback?: (data: LocalStreamEnd) => void;

	constructor(config: Config) {
		this.config = config;
		this.BASE_LOG_DIR = path.join(process.cwd(), 'logs');
		this.SCRIPTS_PATH = path.join(process.cwd(), 'scripts/mpv');
		this.mpvPath = this.findMpvPath();

		// Initialize directories
		this.initializeDirectories();
		this.registerSignalHandlers();

		// Start health checks
		this.startHealthChecks();
	}

	private startHealthChecks(): void {
		// Check every 30 seconds
		setInterval(() => {
			if (this.isShuttingDown) return;

			for (const [screen, stream] of this.streams.entries()) {
				if (!stream.process || !stream.process.pid) continue;

				try {
					process.kill(stream.process.pid, 0); // Test if process exists
				} catch {
					// Process is dead but not cleaned up
					logger.warn(`Found dead process for screen ${screen}, cleaning up`, 'PlayerService');
					this.handleProcessExit(screen, -1, null);
				}
			}
		}, 30000);
	}

	private findMpvPath(): string {
		try {
			return execSync('which mpv').toString().trim();
		} catch {
			logger.warn('MPV not found in PATH, using default "mpv"', 'PlayerService');
			return 'mpv';
		}
	}

	private async initializeDirectories(): Promise<void> {
		try {
			// Create log directories
			const logDirs = ['mpv', 'streamlink'].map((dir) => path.join(this.BASE_LOG_DIR, dir));
			for (const dir of logDirs) {
				if (!fs.existsSync(dir)) {
					fs.mkdirSync(dir, { recursive: true });
				}
			}

			// Create .livelink directory in home
			const homedir = process.env.HOME || process.env.USERPROFILE;
			if (homedir) {
				const livelinkDir = path.join(homedir, '.livelink');
				if (!fs.existsSync(livelinkDir)) {
					fs.mkdirSync(livelinkDir, { recursive: true });
				}
			}

			// Clean old logs
			await this.cleanOldLogs();
		} catch (error) {
			logger.error(
				'Failed to initialize directories',
				'PlayerService',
				error instanceof Error ? error : new Error(String(error))
			);
			throw error;
		}
	}

	private async cleanOldLogs(): Promise<void> {
		const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days
		const now = Date.now();

		for (const dir of ['mpv', 'streamlink']) {
			const logDir = path.join(this.BASE_LOG_DIR, dir);
			if (!fs.existsSync(logDir)) continue;

			try {
				const files = fs.readdirSync(logDir);
				for (const file of files) {
					if (!file.endsWith('.log')) continue;

					const filePath = path.join(logDir, file);
					const stats = fs.statSync(filePath);
					if (now - stats.mtime.getTime() > maxAge) {
						fs.unlinkSync(filePath);
						logger.debug(`Deleted old log file: ${filePath}`, 'PlayerService');
					}
				}
			} catch (error) {
				logger.error(
					`Failed to clean logs in ${dir}`,
					'PlayerService',
					error instanceof Error ? error : new Error(String(error))
				);
			}
		}
	}

	private registerSignalHandlers(): void {
		['SIGINT', 'SIGTERM', 'SIGQUIT'].forEach((signal) => {
			process.once(signal, () => {
				if (!this.isShuttingDown) {
					logger.info(`Received ${signal} signal`, 'PlayerService');
					this.cleanup();
				}
			});
		});
	}

	/**
	 * Gets the current count of active streams 
	 */
	private getActiveStreamCount(): number {
		// Use our dedicated slot tracking instead of trying to filter the streams map
		const count = this.activeScreenSlots.size;
		const activeScreens = Array.from(this.activeScreenSlots);
		logger.debug(`Active stream count: ${count}, slots: ${activeScreens.join(',')}`, 'PlayerService');
		return count;
	}

	async startStream(options: StreamOptions & { screen: number }): Promise<StreamResponse> {
		const { screen } = options;

		// Check global startup lock
		if (this.globalStartupLock) {
			return {
				screen,
				message: `Stream startup in progress`,
				success: false
			};
		}

		// Run an audit to ensure our stream tracking is accurate before checking limits
		this.auditActiveStreams();

		// Check maximum streams limit using our dedicated slot tracking
		const activeStreamCount = this.getActiveStreamCount();
		
		if (activeStreamCount >= this.config.player.maxStreams) {
			// Log detailed information to help diagnose the issue
			logger.warn(
				`Maximum number of streams (${this.config.player.maxStreams}) reached. Active screens: ${Array.from(this.activeScreenSlots).join(', ')}`,
				'PlayerService'
			);
			
			// Show any inconsistencies between our tracking and the streams map
			const streamsInMap = Array.from(this.streams.keys());
			if (streamsInMap.length !== this.activeScreenSlots.size) {
				logger.warn(
					`Stream tracking inconsistency: ${streamsInMap.length} streams in map, but ${this.activeScreenSlots.size} active slots. Map screens: ${streamsInMap.join(', ')}`,
					'PlayerService'
				);
				
				// Check if the screen we're trying to start is actually already in the map but not in active slots
				if (streamsInMap.includes(screen) && !this.activeScreenSlots.has(screen)) {
					logger.warn(
						`Found inconsistency: Screen ${screen} exists in streams map but not in activeScreenSlots, fixing...`,
						'PlayerService'
					);
					// Auto-fix by stopping the stream to clean up everything
					await this.stopStream(screen, true);
				}
			}
			
			return {
				screen,
				message: `Maximum number of streams (${this.config.player.maxStreams}) reached`,
				error: `Maximum number of streams (${this.config.player.maxStreams}) reached`,
				success: false
			};
		}

		// Check startup lock
		if (this.startupLocks.get(screen)) {
			return {
				screen,
				message: `Stream startup in progress for screen ${screen}`,
				success: false
			};
		}

		// Set global and screen startup locks
		this.globalStartupLock = true;
		this.startupLocks.set(screen, true);
		const lockTimeout = setTimeout(() => {
			this.globalStartupLock = false;
			this.startupLocks.set(screen, false);
		}, this.STARTUP_TIMEOUT);

		try {
			// If there's already a stream for this screen, stop it first
			// This ensures we clean up any resources before starting a new stream
			if (this.streams.has(screen) || this.activeScreenSlots.has(screen)) {
				logger.info(`Stopping existing stream on screen ${screen} before starting new one`, 'PlayerService');
				await this.stopStream(screen, true);
				
				// Double-check cleanup worked
				if (this.activeScreenSlots.has(screen)) {
					logger.warn(`Screen ${screen} still has an active slot after stopStream, forcing release`, 'PlayerService');
					this.activeScreenSlots.delete(screen);
				}
			}

			// Get screen configuration
			const screenConfig = this.config.player.screens.find((s) => s.screen === screen);
			if (!screenConfig) {
				throw new Error(`Invalid screen number: ${screen}`);
			}

			// Check if screen is disabled
			if (this.disabledScreens.has(screen)) {
				throw new Error(`Screen ${screen} is disabled`);
			}

			// Don't start during shutdown
			if (this.isShuttingDown) {
				throw new Error('Server is shutting down');
			}

			// Clear manually closed flag - we're explicitly starting a new stream
			this.manuallyClosedScreens.delete(screen);

			// Determine player type
			const useStreamlink =
				screenConfig.playerType === 'streamlink' ||
				(!screenConfig.playerType && this.config.player.preferStreamlink);

			// Ensure we have metadata for the title
			const streamTitle =
				options.title || this.extractTitleFromUrl(options.url) || 'Unknown Stream';

			// Get current date/time for the title
			const currentTime = new Date().toLocaleTimeString();

			// Add metadata to options for use in player commands
			options.title = streamTitle;
			options.viewerCount = options.viewerCount || 0;
			options.startTime = options.startTime || currentTime;

			logger.info(
				`Starting stream with title: ${streamTitle}, viewers: ${options.viewerCount}, time: ${options.startTime}, screen: ${screen}`,
				'PlayerService'
			);

			// Start the stream
			const process = useStreamlink
				? await this.startStreamlinkProcess(options)
				: await this.startMpvProcess(options);

			// Create stream instance
			const instance: LocalStreamInstance = {
				id: Date.now(),
				screen,
				url: options.url,
				quality: options.quality || 'best',
				status: 'playing',
				volume: options.volume || screenConfig.volume || this.config.player.defaultVolume,
				process,
				platform: options.url.includes('youtube.com') ? 'youtube' : 'twitch',
				title: streamTitle,
				startTime:
					typeof options.startTime === 'string'
						? new Date(options.startTime).getTime()
						: options.startTime,
				options: options
			};

			// Store stream instance and mark the slot as active
			this.streams.set(screen, instance);
			this.activeScreenSlots.add(screen);

			// Log active streams after adding the new one
			logger.info(
				`Stream started on screen ${screen}. Current active slots: ${Array.from(this.activeScreenSlots).join(', ')} (${this.activeScreenSlots.size} of ${this.config.player.maxStreams})`, 
				'PlayerService'
			);

			// Setup monitoring
			this.setupStreamMonitoring(screen, process, options);

			return {
				screen,
				message: `Stream started on screen ${screen}`,
				success: true
			};
		} catch (error) {
			logger.error(
				`Failed to start stream on screen ${screen}`,
				'PlayerService',
				error instanceof Error ? error.message : String(error)
			);
			
			// Make sure we clean up any partial state if stream failed to start
			this.activeScreenSlots.delete(screen);
			this.streams.delete(screen);
			
			return {
				screen,
				message: error instanceof Error ? error.message : String(error),
				success: false
			};
		} finally {
			clearTimeout(lockTimeout);
			this.globalStartupLock = false;
			this.startupLocks.set(screen, false);
		}
	}

	private async startMpvProcess(
		options: StreamOptions & { screen: number }
	): Promise<ChildProcess> {
		const args = this.getMpvArgs(options);
		const env = this.getProcessEnv();

		// Add screen-specific environment variables
		const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
		env.SCREEN = options.screen.toString();
		env.DATE = timestamp;

		// Sanitize title components to avoid issues with shell escaping
		const streamTitle = (options.title || 'Unknown Title').replace(/['"]/g, '');
		const viewerCount =
			options.viewerCount !== undefined ? `${options.viewerCount} viewers` : 'Unknown viewers';
		const startTime = options.startTime
			? new Date(options.startTime).toLocaleTimeString()
			: 'Unknown time';

		// Set environment variables without quotes
		env.TITLE = `${streamTitle} - ${viewerCount} - ${startTime} - Screen ${options.screen}`;
		env.STREAM_URL = options.url;

		logger.info(`Starting MPV for screen ${options.screen}`, 'PlayerService');
		logger.debug(`MPV command: ${this.mpvPath} ${args.join(' ')}`, 'PlayerService');

		const process = spawn(this.mpvPath, args, {
			env,
			stdio: ['ignore', 'pipe', 'pipe']
		});

		this.setupProcessHandlers(process, options.screen);
		return process;
	}

	private async startStreamlinkProcess(
		options: StreamOptions & { screen: number }
	): Promise<ChildProcess> {
		try {
			const args = this.getStreamlinkArgs(options.url, options);
			const env = this.getProcessEnv();

			logger.info(`Starting Streamlink for screen ${options.screen}`, 'PlayerService');
			logger.debug(`Streamlink command: streamlink ${args.join(' ')}`, 'PlayerService');

			const process = spawn('streamlink', args, {
				env,
				stdio: ['ignore', 'pipe', 'pipe']
			});

			return new Promise((resolve, reject) => {
				let errorOutput = '';
				let hasStarted = false;
				const startTimeout = setTimeout(() => {
					const error = new Error('Stream start timeout exceeded');
					process.kill();
					reject(error);
				}, this.STARTUP_TIMEOUT);

				const onData = (data: Buffer) => {
					const output = data.toString();
					if (output.includes('Starting player')) {
						hasStarted = true;
						clearTimeout(startTimeout);
						resolve(process);
					}
					// Check for common error patterns
					if (output.toLowerCase().includes('error')) {
						errorOutput += output + '\n';
					}
				};

				const onError = (error: Error) => {
					clearTimeout(startTimeout);
					logger.error(`Streamlink error for screen ${options.screen}`, 'PlayerService', error);
					reject(error);
				};

				const onExit = (code: number | null) => {
					clearTimeout(startTimeout);
					if (!hasStarted) {
						let errorMessage = 'Stream failed to start';

						// Enhanced error detection
						if (errorOutput.toLowerCase().includes('members-only')) {
							errorMessage = 'Stream unavailable (members-only content)';
						} else if (errorOutput.toLowerCase().includes('no playable streams')) {
							errorMessage = 'No playable streams found';
						} else if (errorOutput.toLowerCase().includes('404')) {
							errorMessage = 'Stream not found (404)';
						} else if (errorOutput.toLowerCase().includes('private')) {
							errorMessage = 'Stream is private';
						} else if (code === 1) {
							errorMessage = 'Stream unavailable (possibly members-only content)';
						} else if (code === 130) {
							errorMessage = 'Stream process interrupted';
						} else if (code === 2) {
							errorMessage = 'Stream unavailable or invalid URL';
						}

						reject(new Error(errorMessage));
					}
				};

				process.stdout?.on('data', onData);
				process.stderr?.on('data', (data: Buffer) => {
					errorOutput += data.toString() + '\n';
					onData(data);
				});
				process.on('error', onError);
				process.on('exit', onExit);
			});
		} catch (err) {
			logger.error(
				`Failed to spawn streamlink process for screen ${options.screen}`,
				'PlayerService',
				err instanceof Error ? err.message : String(err)
			);
			throw err;
		}
	}

	private setupProcessHandlers(process: ChildProcess, screen: number): void {
		let hasEndedStream = false;
		let cleanupTimeout: NodeJS.Timeout | null = null;

		const cleanup = () => {
			if (cleanupTimeout) {
				clearTimeout(cleanupTimeout);
				cleanupTimeout = null;
			}
			this.clearMonitoring(screen);
			this.streams.delete(screen);
			this.streamRetries.delete(screen);
			
			// Clean up FIFO/IPC immediately instead of with delay
			const fifoPath = this.fifoPaths.get(screen);
			if (fifoPath) {
				try { 
					fs.unlinkSync(fifoPath); 
				} catch {
					// Ignore error, file may not exist
					logger.debug(`Failed to remove FIFO file ${fifoPath}`, 'PlayerService');
				}
				this.fifoPaths.delete(screen);
			}
			this.ipcPaths.delete(screen);
		};

		const handleStreamEnd = (error: string | Error, code: number = 0) => {
			if (!hasEndedStream) {
				hasEndedStream = true;
				logger.info(`Stream ended on screen ${screen}`, 'PlayerService');
				this.errorCallback?.({
					screen,
					error: error instanceof Error ? error.message : error,
					code
				});
				// Reduce cleanup delay to minimize overlap
				cleanupTimeout = setTimeout(cleanup, 100);
			}
		};

		if (process.stdout) {
			process.stdout.on('data', (data: Buffer) => {
				const output = data.toString('utf8').trim();
				if (output && /[\x20-\x7E]/.test(output)) {
					// Log YouTube-specific state information
					if (output.includes('[youtube]')) {
						if (output.includes('Post-Live Manifestless mode')) {
							logger.info(
								`[Screen ${screen}] YouTube stream is in post-live state (ended)`,
								'PlayerService'
							);
							handleStreamEnd('Stream ended (post-live)');
						} else if (output.includes('Downloading MPD manifest')) {
							logger.debug(
								`[Screen ${screen}] YouTube stream manifest download attempt`,
								'PlayerService'
							);
						}
					}

					logger.debug(`[Screen ${screen}] ${output}`, 'PlayerService');
					this.outputCallback?.({
						screen,
						data: output,
						type: 'stdout'
					});

					// Check for different types of stream endings
					if (
						output.includes('Exiting... (Quit)') ||
						output.includes('Quit') ||
						output.includes('Exiting normally') ||
						output.includes('EOF reached') ||
						output.includes('User stopped playback')
					) {
						handleStreamEnd('Stream ended normally');
					}
				}
			});
		}

		if (process.stderr) {
			process.stderr.on('data', (data: Buffer) => {
				const output = data.toString('utf8').trim();
				if (output && /[\x20-\x7E]/.test(output)) {
					// Filter out common PipeWire warnings that don't affect functionality
					if (output.includes('pw.conf') && output.includes('deprecated')) {
						logger.debug(`[Screen ${screen}] PipeWire config warning: ${output}`, 'PlayerService');
					} else {
						// Log YouTube-specific errors with more context
						if (output.includes('youtube-dl failed')) {
							logger.info(
								`[Screen ${screen}] YouTube stream error - may be ended or unavailable: ${output}`,
								'PlayerService'
							);
							handleStreamEnd(new Error('Stream unavailable or ended'));
						} else {
							logger.error(`[Screen ${screen}] ${output}`, 'PlayerService');
							this.handleError(screen, new Error(`Stream error: ${output}`));
						}
					}
				}
			});
		}

		process.on('error', (err: Error) => {
			logger.error(`Process error on screen ${screen}`, 'PlayerService', err);
			this.handleError(screen, err);
		});

		process.on('exit', (code: number | null) => {
			logger.info(`Process exited on screen ${screen} with code ${code}`, 'PlayerService');
			handleStreamEnd(new Error(`Process exited with code ${code}`));
		});
	}

	private setupStreamMonitoring(
		screen: number,
		process: ChildProcess,
		options: StreamOptions
	): void {
		// Track last output time to detect stream health
		let lastOutputTime = Date.now();
		let consecutiveFailures = 0;
		const MAX_OUTPUT_SILENCE = 15000; // 15 seconds without output is suspicious
		const HEALTH_CHECK_INTERVAL = 5000; // Check every 5 seconds
		const MAX_CONSECUTIVE_FAILURES = 3;

		// Update last output time when we get data
		if (process.stdout) {
			process.stdout.on('data', () => {
				lastOutputTime = Date.now();
				consecutiveFailures = 0; // Reset failures on successful output
			});
		}
		if (process.stderr) {
			process.stderr.on('data', () => {
				lastOutputTime = Date.now();
				consecutiveFailures = 0; // Reset failures on successful output
			});
		}

		// Setup more frequent health checks
		const healthCheck = setInterval(async () => {
			if (!process.pid) {
				logger.warn(`No PID found for stream on screen ${screen}`, 'PlayerService');
				return;
			}

			try {
				// Check if process exists and responds
				process.kill(0);

				// Also verify the process hasn't been replaced
				const currentProcess = this.streams.get(screen)?.process;
				if (currentProcess !== process) {
					logger.warn(
						`Process mismatch detected for screen ${screen}, clearing health check`,
						'PlayerService'
					);
					clearInterval(healthCheck);
					this.healthCheckIntervals.delete(screen);
					return;
				}

				// Check if we haven't received output for too long
				const timeSinceLastOutput = Date.now() - lastOutputTime;
				if (timeSinceLastOutput > MAX_OUTPUT_SILENCE) {
					consecutiveFailures++;
					logger.warn(
						`No output from stream on screen ${screen} for ${Math.round(timeSinceLastOutput / 1000)}s (failure ${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`,
						'PlayerService'
					);

					// After multiple consecutive failures, try to restart
					if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
						logger.warn(
							`Stream on screen ${screen} appears frozen, attempting restart`,
							'PlayerService'
						);
						await this.restartStream(screen, options);
						consecutiveFailures = 0; // Reset after restart attempt
					}
				}
			} catch (err) {
				// Only restart if the process is actually gone
				if (err && typeof err === 'object' && 'code' in err && err.code === 'ESRCH') {
					logger.warn(`Stream on screen ${screen} appears to be unresponsive`, 'PlayerService');
					await this.restartStream(screen, options).catch((err) => {
						logger.error(
							`Failed to restart unresponsive stream on screen ${screen}`,
							'PlayerService',
							err
						);
					});
				}
			}
		}, HEALTH_CHECK_INTERVAL);

		this.healthCheckIntervals.set(screen, healthCheck);

		// Setup refresh timer
		const refreshTimer = setTimeout(() => {
			logger.info(`Refreshing stream on screen ${screen}`, 'PlayerService');
			this.restartStream(screen, options).catch((error) => {
				logger.error(`Failed to refresh stream on screen ${screen}`, 'PlayerService', error);
			});
		}, this.STREAM_REFRESH_INTERVAL);

		this.streamRefreshTimers.set(screen, refreshTimer);
		this.streamStartTimes.set(screen, Date.now());
	}

	private async restartStream(screen: number, options: StreamOptions): Promise<void> {
		// Don't restart if the screen was manually closed
		if (this.manuallyClosedScreens.has(screen)) {
			logger.info(
				`Not restarting stream on screen ${screen} as it was manually closed`,
				'PlayerService'
			);
			return;
		}

		logger.info(`Restarting stream on screen ${screen}: ${options.url}`, 'PlayerService');

		// Stop existing stream and wait for cleanup
		await this.stopStream(screen);

		// Add a longer delay to ensure cleanup is complete
		await new Promise((resolve) => setTimeout(resolve, 500));

		// Double check no existing process before starting new one
		const existingStream = this.streams.get(screen);
		if (existingStream?.process) {
			logger.warn(`Found existing process for screen ${screen}, forcing cleanup`, 'PlayerService');
			try {
				existingStream.process.kill('SIGKILL');
				await new Promise((resolve) => setTimeout(resolve, 200));
			} catch {
				// Process might already be gone
			}
		}

		await this.startStream({ ...options, screen });
	}

	/**
	 * Stop a stream running on a specific screen
	 * @param screen - The screen number
	 * @param isForced - If true, this is a forced stop (e.g. for starting a new stream)
	 * @returns Promise that resolves when the stream is stopped
	 */
	async stopStream(screen: number, isForced = false): Promise<StreamResponse> {
		logger.info(`Stopping stream on screen ${screen}${isForced ? ' (forced)' : ''}`, 'PlayerService');
		
		// Log active screens before stopping
		this.logActiveSlots('Before stopping stream');
		
		// Get the stream instance
		const instance = this.streams.get(screen);
		if (!instance) {
			// Check if we need to clean up an orphaned active slot
			if (this.activeScreenSlots.has(screen)) {
				logger.warn(`Found orphaned active slot for screen ${screen}, cleaning up`, 'PlayerService');
				this.activeScreenSlots.delete(screen);
				this.logActiveSlots('After orphaned slot cleanup');
			}
			
			return {
				screen,
				message: `No stream running on screen ${screen}`,
				success: true
			};
		}

		// Track manual closures if this isn't a forced stop
		if (!isForced) {
			this.manuallyClosedScreens.add(screen);
		}

		// Don't try to kill the process if it's already gone
		if (instance.process && !instance.process.killed) {
			try {
				// Kill the process
				const signal = process.platform === 'win32' ? 'SIGTERM' : 'SIGTERM';
				logger.info(`Killing process for screen ${screen} with signal ${signal}`, 'PlayerService');
				instance.process.kill(signal);
			} catch (error) {
				logger.error(
					`Failed to kill process for screen ${screen}`,
					'PlayerService',
					error instanceof Error ? error.message : String(error)
				);
			}
		} else {
			logger.info(`Process for screen ${screen} already killed or doesn't exist`, 'PlayerService');
		}

		// Remove from streams map
		this.streams.delete(screen);
		
		// Immediately release the slot 
		this.activeScreenSlots.delete(screen);
		
		// Log active screens after stopping
		this.logActiveSlots('After stopping stream');
		
		return {
			screen,
			message: `Stream stopped on screen ${screen}`,
			success: true
		};
	}

	/**
	 * Handle process exit event
	 * @param screen - The screen number
	 * @param code - The exit code
	 * @param signal - The signal that caused the exit
	 */
	private handleProcessExit(screen: number, code: number | null, signal: NodeJS.Signals | null): void {
		logger.info(
			`Process for screen ${screen} exited with code ${code !== null ? code : 'null'} and signal ${
				signal !== null ? signal : 'null'
			}`,
			'PlayerService'
		);

		// Log active screens before cleanup
		this.logActiveSlots('Before process exit cleanup');

		// Check if manual close
		const wasManuallyClosedBefore = this.manuallyClosedScreens.has(screen);
		
		// Get the stream instance before deleting it
		const instance = this.streams.get(screen);
		
		// Always remove the stream from our tracking
		this.streams.delete(screen);
		
		// Always release the slot when the process exits
		if (this.activeScreenSlots.has(screen)) {
			logger.info(`Releasing slot for screen ${screen} after process exit`, 'PlayerService');
			this.activeScreenSlots.delete(screen);
		}
		
		// Run an audit to verify our stream tracking state is consistent
		this.auditActiveStreams();

		// Log active screens after cleanup
		this.logActiveSlots('After process exit cleanup');

		// Emit stream stopped event
		this.events.emit('streamStopped', {
			screen,
			code: code || undefined,
			signal: signal || undefined,
			wasManuallyClosedBefore,
			hadOpenSocket: !!instance?.process
		});
	}
	
	/**
	 * Audit active streams to ensure consistency between streams map and activeScreenSlots
	 * This helps prevent "ghost" slots that block new streams
	 */
	private auditActiveStreams(): void {
		logger.debug('Auditing active streams', 'PlayerService');
		
		// Check for orphaned active slots (slots with no corresponding stream in the map)
		for (const screen of this.activeScreenSlots) {
			if (!this.streams.has(screen)) {
				logger.warn(`Found orphaned active slot for screen ${screen}, cleaning up`, 'PlayerService');
				this.activeScreenSlots.delete(screen);
			}
		}
		
		// Check for streams that exist in the map but don't have an active slot
		for (const [screen, instance] of this.streams.entries()) {
			// Only check streams with a valid process
			if (instance.process && !instance.process.killed) {
				// Additional process validity check - make sure PID exists and is actually running
				try {
					if (instance.process.pid) {
						process.kill(instance.process.pid, 0); // This just tests if process exists
					} else {
						// No PID means invalid process
						throw new Error("No valid PID");
					}
					
					if (!this.activeScreenSlots.has(screen)) {
						logger.warn(`Found stream for screen ${screen} without an active slot, fixing`, 'PlayerService');
						this.activeScreenSlots.add(screen);
					}
				} catch {
					// Process doesn't exist or can't be signaled
					logger.warn(`Stream process for screen ${screen} doesn't exist or can't be signaled, cleaning up`, 'PlayerService');
					this.streams.delete(screen);
					this.activeScreenSlots.delete(screen);
				}
			} else {
				// The process is gone/killed but the stream entry still exists
				logger.warn(`Found stream entry for screen ${screen} with invalid process, cleaning up`, 'PlayerService');
				this.streams.delete(screen);
				this.activeScreenSlots.delete(screen); // Also make sure we remove from active slots
			}
		}
		
		// Perform a final validity check on the active slots and explicitly log results
		logger.info(`After audit: ${this.activeScreenSlots.size} active slots, ${this.streams.size} stream entries`, 'PlayerService');
	}
	
	/**
	 * Log the current state of active slots and streams for debugging
	 */
	private logActiveSlots(context: string): void {
		const activeSlots = Array.from(this.activeScreenSlots);
		const streamScreens = Array.from(this.streams.keys());
		
		logger.debug(
			`${context}: Active slots (${activeSlots.length}): ${activeSlots.join(', ')}`,
			'PlayerService'
		);
		logger.debug(
			`${context}: Stream entries (${streamScreens.length}): ${streamScreens.join(', ')}`,
			'PlayerService'
		);
		
		// Log additional details for each stream entry to help diagnose issues
		for (const [screen, stream] of this.streams.entries()) {
			const processStatus = stream.process 
				? `PID:${stream.process.pid || 'none'} killed:${stream.process.killed || false}`
				: 'No process';
			logger.debug(
				`${context}: Stream ${screen} details: ${processStatus}, status:${stream.status}`,
				'PlayerService'
			);
		}
	}

	private clearMonitoring(screen: number): void {
		// Clear health check
		const healthCheck = this.healthCheckIntervals.get(screen);
		if (healthCheck) {
			clearInterval(healthCheck);
			this.healthCheckIntervals.delete(screen);
		}

		// Clear refresh timer
		const refreshTimer = this.streamRefreshTimers.get(screen);
		if (refreshTimer) {
			clearTimeout(refreshTimer);
			this.streamRefreshTimers.delete(screen);
		}

		// Clear inactive timer
		const inactiveTimer = this.inactiveTimers.get(screen);
		if (inactiveTimer) {
			clearTimeout(inactiveTimer);
			this.inactiveTimers.delete(screen);
		}

		// Clear retry timer
		const retryTimer = this.retryTimers.get(screen);
		if (retryTimer) {
			clearTimeout(retryTimer);
			this.retryTimers.delete(screen);
		}

		// Clear other state
		this.streamStartTimes.delete(screen);
		// Don't clear retry count here to maintain retry state across restarts
		// this.streamRetries.delete(screen);
	}

	/**
	 * Check if a process is still running without sending a signal
	 */
	private isProcessRunning(pid: number | undefined): boolean {
		if (!pid) return false;

		try {
			// The kill with signal 0 doesn't actually kill the process
			// It just checks if the process exists
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	}

	private getMpvArgs(options: StreamOptions & { screen: number }): string[] {
		const screenConfig = this.config.player.screens.find((s) => s.screen === options.screen);
		if (!screenConfig) {
			throw new Error(`Invalid screen number: ${options.screen}`);
		}

		const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
		const logFile = path.join(
			this.BASE_LOG_DIR,
			'mpv',
			`mpv-screen${options.screen}-${timestamp}.log`
		);
		const homedir = process.env.HOME || process.env.USERPROFILE;
		const ipcPath = homedir
			? path.join(homedir, '.livelink', `mpv-ipc-${options.screen}`)
			: `/tmp/mpv-ipc-${options.screen}`;
		this.ipcPaths.set(options.screen, ipcPath);

		// Get stream metadata for title
		const streamTitle = options.title || 'Unknown Title';
		const viewerCount =
			options.viewerCount !== undefined ? `${options.viewerCount} viewers` : 'Unknown viewers';

		// Sanitize title components to avoid issues with shell escaping
		const sanitizedTitle = streamTitle.replace(/['"]/g, '');

		// Format the title without quotes in the argument
		const titleArg = `--title="${sanitizedTitle} - ${viewerCount} - Screen ${options.screen}"`;

		// Base arguments for MPV direct playback
		const baseArgs = [
			// IPC and config
			`--input-ipc-server=${ipcPath}`,
			`--config-dir=${this.SCRIPTS_PATH}`,
			`--log-file=${logFile}`,

			// Window position and size
			`--geometry=${screenConfig.width}x${screenConfig.height}+${screenConfig.x}+${screenConfig.y}`,

			// Audio settings
			`--volume=${options.volume !== undefined ? options.volume : screenConfig.volume !== undefined ? screenConfig.volume : this.config.player.defaultVolume}`,

			// Title
			titleArg,

			// URL must be last
			options.url
		];

		// Combine all arguments
		const allArgs = [
			...baseArgs,
			...(options.windowMaximized || screenConfig.windowMaximized ? ['--window-maximized=yes'] : [])
		];

		return allArgs;
	}

	private getStreamlinkArgs(url: string, options: StreamOptions & { screen: number }): string[] {
		const screen = options.screen;
		const screenConfig = this.config.player.screens.find((s) => s.screen === screen);
		if (!screenConfig) {
			throw new Error(`Invalid screen number: ${screen}`);
		}

		const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
		const logFile = path.join(this.BASE_LOG_DIR, 'mpv', `mpv-screen${screen}-${timestamp}.log`);
		const homedir = process.env.HOME || process.env.USERPROFILE;
		const ipcPath = homedir
			? path.join(homedir, '.livelink', `mpv-ipc-${screen}`)
			: `/tmp/mpv-ipc-${screen}`;
		this.ipcPaths.set(screen, ipcPath);

		// Get stream metadata for title
		const streamTitle = options.title || 'Unknown Title';
		const viewerCount =
			options.viewerCount !== undefined ? `${options.viewerCount} viewers` : 'Unknown viewers';
		const sanitizedTitle = streamTitle.replace(/['"]/g, '');
		const titleArg = `--title="${sanitizedTitle} - ${viewerCount} - Screen ${options.screen}"`;

		// MPV arguments specifically for Streamlink
		const mpvArgs = [
			// Window position and size
			`--geometry=${screenConfig.width}x${screenConfig.height}+${screenConfig.x}+${screenConfig.y}`,

			// Audio settings
			`--volume=${screenConfig.volume !== undefined ? screenConfig.volume : this.config.player.defaultVolume}`,

			// IPC and config
			`--input-ipc-server=${ipcPath}`,
			`--config-dir=${this.SCRIPTS_PATH}`,
			`--log-file=${logFile}`,

			// Title
			titleArg,

			// Window state
			...(options.windowMaximized || screenConfig.windowMaximized ? ['--window-maximized=yes'] : [])
		].filter(Boolean);

		// Streamlink-specific arguments
		const streamlinkArgs = [
			url,
			'best', // Quality selection
			...(url.includes('youtube.com')
				? [
						'--stream-segment-threads=2', // Reduced from 3 to 2
						'--stream-timeout=60',
						'--hls-segment-threads=2', // Reduced from 3 to 2
						'--ringbuffer-size=32M', // Limit ring buffer size
						'--hls-segment-stream-data', // Stream segments directly
						'--hls-live-edge=2', // Reduce live edge buffer
						'--stream-segment-attempts=3', // Limit segment retry attempts
						'--player-no-close', // Don't close player on stream end
						'--hls-playlist-reload-time=2' // Faster playlist reload
					]
				: []),
			'--player',
			this.mpvPath,
			'--player-args',
			mpvArgs.join(' ')
		];

		return streamlinkArgs;
	}

	private getProcessEnv(): NodeJS.ProcessEnv {
		const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

		return {
			...process.env,
			MPV_HOME: undefined,
			XDG_CONFIG_HOME: undefined,
			DISPLAY: process.env.DISPLAY || ':0',
			SDL_VIDEODRIVER: 'x11',
			DATE: timestamp
		};
	}

	public getActiveStreams() {
		return Array.from(this.streams.entries()).map(([screen, stream]) => ({
			screen,
			url: stream.url,
			quality: stream.quality,
			platform: stream.platform,
			status: stream.status
		}));
	}

	public sendCommandToScreen(screen: number, command: string): void {
		const ipcPath = this.ipcPaths.get(screen);
		if (!ipcPath) {
			logger.warn(`No IPC path found for screen ${screen}`, 'PlayerService');
			return;
		}

		try {
			exec(`echo "${command}" | socat - ${ipcPath}`, (err) => {
				if (err) {
					logger.error(
						`Failed to send command to screen ${screen}`,
						'PlayerService',
						err instanceof Error ? err : new Error(String(err))
					);
				}
			});
		} catch (err) {
			logger.error(
				`Command send error for screen ${screen}`,
				'PlayerService',
				err instanceof Error ? err : new Error(String(err))
			);
		}
	}

	public sendCommandToAll(command: string): void {
		this.ipcPaths.forEach((_, screen) => {
			this.sendCommandToScreen(screen, command);
		});
	}

	public onStreamOutput(callback: (data: StreamOutput) => void): void {
		this.outputCallback = callback;
	}

	public onStreamError(callback: (data: StreamError) => void): void {
		this.errorCallback = callback;
	}

	public handleLuaMessage(screen: number, type: string, data: Record<string, unknown>): void {
		if (type === 'log' && typeof data.level === 'string' && typeof data.message === 'string') {
			logger[data.level as 'debug' | 'info' | 'warn' | 'error'](
				`[MPV-${screen}] ${data.message}`,
				'PlayerService'
			);
		} else {
			logger.debug(
				`Received message from screen ${screen}: ${type} - ${JSON.stringify(data)}`,
				'PlayerService'
			);
		}
	}

	public async cleanup(): Promise<void> {
		if (this.isShuttingDown) return;

		this.isShuttingDown = true;
		logger.info('Cleaning up player service...', 'PlayerService');

		try {
			// Stop all streams
			const activeScreens = Array.from(this.streams.keys());
			await Promise.all(activeScreens.map((screen) => this.stopStream(screen, true)));

			// Clear all timers and state
			activeScreens.forEach((screen) => {
				this.clearMonitoring(screen);
			});

			// Clean up IPC sockets
			this.ipcPaths.forEach((ipcPath) => {
				try {
					if (fs.existsSync(ipcPath)) {
						fs.unlinkSync(ipcPath);
					}
				} catch (error) {
					logger.warn(
						`Failed to remove IPC socket ${ipcPath}`,
						'PlayerService',
						error instanceof Error ? error : new Error(String(error))
					);
				}
			});

			this.ipcPaths.clear();
			this.streams.clear();
			this.activeScreenSlots.clear(); // Clear the active slots
			this.manuallyClosedScreens.clear();
			this.disabledScreens.clear();
			this.shuttingDownScreens.clear();

			logger.info('Player service cleanup complete', 'PlayerService');
		} catch (error) {
			logger.error(
				'Error during player service cleanup',
				'PlayerService',
				error instanceof Error ? error : new Error(String(error))
			);
			throw error;
		}
	}

	public isRetrying(screen: number): boolean {
		return this.streamRetries.has(screen);
	}

	public async ensurePlayersRunning(): Promise<void> {
		try {
			// Check all screen configs and ensure they have players running if enabled
			for (const screen of this.config.player.screens) {
				// Skip if screen is disabled
				if (
					!screen.enabled ||
					this.disabledScreens.has(screen.screen) ||
					this.manuallyClosedScreens.has(screen.screen)
				) {
					logger.debug(
						`Skipping disabled or manually closed screen ${screen.screen}`,
						'PlayerService'
					);
					continue;
				}

				// Skip if a stream is already running on this screen
				const isStreamRunning = this.streams.has(screen.screen);
				if (isStreamRunning) {
					continue;
				}

				// Start a player with a dummy source
				const options: StreamOptions & { screen: number } = {
					url: 'about:blank', // Use about:blank as dummy source
					screen: screen.screen,
					quality: 'best',
					volume: screen.volume || this.config.player.defaultVolume
				};

				try {
					await this.startStream(options);
					logger.info(`Started player for screen ${screen.screen}`, 'PlayerService');
				} catch (error) {
					logger.error(
						`Failed to start player for screen ${screen.screen}`,
						'PlayerService',
						error instanceof Error ? error : new Error(String(error))
					);
				}
			}
		} catch (error) {
			logger.error(
				'Failed to ensure players are running',
				'PlayerService',
				error instanceof Error ? error : new Error(String(error))
			);
		}
	}

	public disableScreen(screen: number): void {
		logger.debug(`PlayerService: Disabling screen ${screen}`, 'PlayerService');
		this.disabledScreens.add(screen);

		// Stop any running stream for this screen
		this.stopStream(screen, true).catch((error) => {
			logger.error(`Failed to stop stream when disabling screen ${screen}`, 'PlayerService', error);
		});
	}

	public enableScreen(screen: number): void {
		logger.debug(`PlayerService: Enabling screen ${screen}`, 'PlayerService');
		this.disabledScreens.delete(screen);
		this.manuallyClosedScreens.delete(screen);

		// Ensure players get restarted on this screen in the next ensurePlayersRunning call
		// We don't start it immediately to allow for proper initialization
	}

	// Helper method to extract title from URL
	private extractTitleFromUrl(url: string): string | null {
		try {
			// Extract video ID from YouTube URL
			if (url.includes('youtube.com') || url.includes('youtu.be')) {
				const urlObj = new URL(url);
				let videoId;

				if (url.includes('youtube.com/watch')) {
					videoId = urlObj.searchParams.get('v');
				} else if (url.includes('youtu.be/')) {
					videoId = url.split('youtu.be/')[1]?.split(/[/?#]/)[0];
				} else if (url.includes('youtube.com/live/')) {
					videoId = url.split('youtube.com/live/')[1]?.split(/[/?#]/)[0];
				} else if (url.includes('youtube.com/channel/')) {
					const channelId = url.split('youtube.com/channel/')[1]?.split(/[/?#]/)[0];
					return channelId ? `YouTube Channel (${channelId})` : 'YouTube Stream';
				}

				return videoId ? `YouTube Video (${videoId})` : 'YouTube Stream';
			}

			// Extract channel name from Twitch URL
			if (url.includes('twitch.tv')) {
				const channelName = url.split('twitch.tv/')[1]?.split(/[/?#]/)[0];
				return channelName ? `Twitch Stream (${channelName})` : 'Twitch Stream';
			}

			// For other URLs, use the hostname
			const hostname = new URL(url).hostname;
			return hostname ? `Stream from ${hostname}` : 'Unknown Stream';
		} catch (err) {
			logger.warn(
				`Failed to extract title from URL: ${url}`,
				'PlayerService',
				err instanceof Error ? err : new Error(String(err))
			);
			return 'Unknown Stream';
		}
	}

	/**
	 * Sends a command directly to the MPV IPC socket
	 */
	private async sendMpvCommand(screen: number, command: string): Promise<void> {
		const ipcPath = this.ipcPaths.get(screen);
		if (!ipcPath) {
			const errorMessage = `No IPC socket for screen ${screen}`;
			logger.error(errorMessage, 'PlayerService');
			throw new Error(errorMessage);
		}

		// Special handling for quit command
		if (command === 'quit' && this.isShuttingDown) {
			logger.debug(`Skipping quit command for screen ${screen} during application shutdown`, 'PlayerService');
			return;
		}

		return new Promise((resolve, reject) => {
			try {
				const socket = net.createConnection(ipcPath);
				let hasResponded = false;

				// Set a shorter connection timeout
				socket.setTimeout(500);

				socket.on('connect', () => {
					const mpvCommand = JSON.stringify({ command: [command] });
					socket.write(mpvCommand + '\n', () => {
						// Wait a brief moment after writing to ensure command is sent
						setTimeout(() => {
							if (!hasResponded) {
								hasResponded = true;
								socket.end();
								resolve();
							}
						}, 100);
					});
				});

				socket.on('error', (err: Error) => {
					if (!hasResponded) {
						hasResponded = true;
						socket.destroy();
						logger.error(
							`Failed to send command to screen ${screen}`,
							'PlayerService',
							err.message
						);
						reject(err);
					}
				});

				socket.on('timeout', () => {
					if (!hasResponded) {
						hasResponded = true;
						socket.destroy();
						const error = new Error('Socket timeout');
						logger.error(
							`Command send timeout for screen ${screen}`,
							'PlayerService',
							error.message
						);
						reject(error);
					}
				});

				// Cleanup socket on any response
				socket.on('data', () => {
					if (!hasResponded) {
						hasResponded = true;
						socket.end();
						resolve();
					}
				});

				// Handle socket close
				socket.on('close', () => {
					if (!hasResponded) {
						hasResponded = true;
						reject(new Error('Socket closed unexpectedly'));
					}
				});
			} catch (err) {
				logger.error(
					`Command send error for screen ${screen}`,
					'PlayerService',
					err instanceof Error ? err.message : String(err)
				);
				reject(err);
			}
		});
	}

	private handleError(screen: number, error: unknown): void {
		const errorMessage = error instanceof Error ? error.message : String(error);
		logger.error(
			`Stream error on screen ${screen}: ${errorMessage}`,
			'PlayerService',
			errorMessage
		);

		if (this.errorCallback) {
			this.errorCallback({
				screen,
				error: errorMessage,
				code: -1
			});
		}
	}

	private handleStreamEnd(screen: number, error?: unknown): void {
		const errorMessage = error instanceof Error ? error.message : error ? String(error) : undefined;

		if (this.endCallback) {
			this.endCallback({
				screen,
				error: errorMessage
			});
		}

		logger.info(
			`Stream ended on screen ${screen}${errorMessage ? `: ${errorMessage}` : ''}`,
			'PlayerService'
		);
	}

	private logError(message: string): void {
		logger.error(message, 'PlayerService');
	}

	private handleProcessError(screen: number, error: unknown): void {
		const errorMessage = error instanceof Error ? error.message : String(error);
		this.handleError(screen, errorMessage);
	}
}