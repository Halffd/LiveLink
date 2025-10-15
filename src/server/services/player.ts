import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import type { Config, StreamlinkConfig, ScreenConfig } from '../../types/stream.js';
import type {
	StreamOutput,
	StreamError,
	StreamResponse,
	StreamEnd
} from '../../types/stream_instance.js';
import { logger } from './logger.js';
import * as path from 'path';
import * as fs from 'fs';
import * as net from 'net';
import { exec, execSync } from 'child_process';
import { format } from 'date-fns';
import { withTimeout } from '../utils/async_helpers.js';

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

export interface StreamOptions {
	screen: number;
	config: ScreenConfig;
	url: string;
	isLive?: boolean;
	isWatched?: boolean;
	isRetry?: boolean;
	title?: string;
	viewerCount?: number;
	startTime?: number;
	quality?: string;
	volume?: number;
	windowMaximized?: boolean;
}

// Add interface for start result type
interface StartResult {
	screen: number;
	success: boolean;
	error?: string;
}

export class PlayerService {
	private readonly logsDir = path.join(new URL('.', import.meta.url).pathname, '../../../logs');
	private getLogFilePath(prefix: string): string {
		const timestamp = format(new Date(), 'yyyyMMdd-HHmmss');
		return path.join(this.logsDir, `${prefix}-${timestamp}.log`);
	}
	private readonly BASE_LOG_DIR: string;
	private readonly MAX_RETRIES = 2; // Maximum number of retries
	private readonly MAX_NETWORK_RETRIES = 2; // Maximum network-specific retries
	private readonly RETRY_INTERVAL = 50; // 100ms (reduced from 200ms)
	private readonly NETWORK_RETRY_INTERVAL = 1000; // 1 second (reduced from 2 seconds)
	private readonly MAX_BACKOFF_TIME = 120000;
	private readonly INACTIVE_RESET_TIMEOUT = 60 * 1000; // 1 minute (reduced from 2 minutes)
	private readonly STARTUP_TIMEOUT = 60000; // 60 seconds
	private readonly SHUTDOWN_TIMEOUT = 1000; // 1 second
	private readonly SCRIPTS_PATH: string;
	private streams: Map<number, LocalStreamInstance> = new Map();
	private streamRetries: Map<number, number> = new Map();
	private networkRetries: Map<number, number> = new Map(); // Track network-specific retries separately
	private lastNetworkError: Map<number, number> = new Map(); // Track when the last network error occurred
	private streamStartTimes: Map<number, number> = new Map();
	private inactiveTimers: Map<number, NodeJS.Timeout> = new Map();
	private startupLocks: Map<number, boolean> = new Map();
	private manuallyClosedScreens: Set<number> = new Set();
	private disabledScreens: Set<number> = new Set();
	private ipcPaths: Map<number, string> = new Map();
	private isNetworkError: Map<number, boolean> = new Map(); // Track if error is network-related

	private config: Config;
	private mpvPath: string;
	private isShuttingDown = false;
	private events = new EventEmitter();
	private outputCallback?: (data: StreamOutput) => void;
	private errorCallback?: (data: StreamError) => void;
	private endCallback?: (data: StreamEnd) => void;

	public readonly DUMMY_SOURCE = ''; // Empty string instead of black screen URL

	private readonly streamlinkConfig: StreamlinkConfig;
	private readonly retryTimers: Map<number, NodeJS.Timeout>;
	private streamStartCooldowns = new Map<number, number>();
	private readonly STARTUP_COOLDOWN = 2000; // 2 seconds cooldown between stream starts

	constructor(config: Config) {
		this.config = config;
		this.streamlinkConfig = config.streamlink || {
			path: 'streamlink',
			options: {},
			http_header: {}
		};
		// Ensure logs directory exists
		if (!fs.existsSync(this.logsDir)) {
			fs.mkdirSync(this.logsDir, { recursive: true });
		}
		this.streams = new Map();
		this.ipcPaths = new Map();
		this.disabledScreens = new Set();
		this.retryTimers = new Map();

		// Set up paths
		this.BASE_LOG_DIR = path.join(new URL('.', import.meta.url).pathname, '../../../logs');
		this.SCRIPTS_PATH = path.join(process.cwd(), 'scripts/mpv');
		this.mpvPath = 'mpv';

		// Create log directory if it doesn't exist
		if (!fs.existsSync(this.BASE_LOG_DIR)) {
			fs.mkdirSync(this.BASE_LOG_DIR, { recursive: true });
		}

		this.initializeDirectories();
		this.registerSignalHandlers();
	}

	private initializeDirectories(): void {
		try {
			// Create log directories
			const logDirs = ['mpv', 'streamlink'].map((dir) => path.join(this.BASE_LOG_DIR, dir));
			logDirs.forEach((dir) => {
				if (!fs.existsSync(dir)) {
					fs.mkdirSync(dir, { recursive: true });
				}
			});

			// Create .livelink directory
			const homedir = process.env.HOME || process.env.USERPROFILE;
			if (homedir) {
				const livelinkDir = path.join(homedir, '.livelink');
				if (!fs.existsSync(livelinkDir)) {
					fs.mkdirSync(livelinkDir, { recursive: true });
				}
			}

			// Clean old logs
			this.clearOldLogs(path.join(this.BASE_LOG_DIR, 'mpv'));
			this.clearOldLogs(path.join(this.BASE_LOG_DIR, 'streamlink'));
		} catch (error) {
			logger.error(
				'Failed to initialize directories',
				'PlayerService',
				error instanceof Error ? error : new Error(String(error))
			);
		}
	}

	private clearOldLogs(directory: string): void {
		try {
			const files = fs.readdirSync(directory);
			const now = Date.now();
			const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days

			for (const file of files) {
				const filePath = path.join(directory, file);
				const stats = fs.statSync(filePath);
				const age = now - stats.mtime.getTime();

				if (age > maxAge) {
					fs.unlinkSync(filePath);
					logger.debug(`Deleted old log file: ${filePath}`, 'PlayerService');
				}
			}
		} catch (error) {
			logger.error(
				`Failed to clean old logs in ${directory}`,
				'PlayerService',
				error instanceof Error ? error : new Error(String(error))
			);
		}
	}

	private findMpvPath(): string {
		try {
			return execSync('which mpv').toString().trim();
		} catch (error) {
			logger.error(
				'Failed to find MPV',
				'PlayerService',
				error instanceof Error ? error : new Error(String(error))
			);
			return 'mpv';
		}
	}

	/**
	 * Check if an executable exists at the given path
	 * @param execPath Path to the executable to check
	 * @returns Promise that resolves to true if the executable exists and is executable
	 */
	private async checkExecutableExists(execPath: string): Promise<boolean> {
		try {
			// Try with 'which' first
			const { exec } = await import('child_process');
			return new Promise<boolean>((resolve) => {
				exec(`which ${execPath}`, (error) => {
					if (error) {
						// Try with 'command -v' as a fallback
						exec(`command -v ${execPath}`, (err2) => {
							resolve(!err2);
						});
					} else {
						resolve(true);
					}
				});
			});
		} catch (error) {
			logger.error(
				'Error checking executable existence',
				'PlayerService',
				error instanceof Error ? error : new Error(String(error))
			);
			return false;
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

	async startStream(options: StreamOptions & { screen: number }): Promise<StreamResponse> {
		const { screen, url } = options;
	
		const lastStart = this.streamStartCooldowns.get(screen) || 0;
		const now = Date.now();
		if (now - lastStart < this.STARTUP_COOLDOWN) {
			const errorMsg = `Stream startup cooldown for screen ${screen}`;
			logger.warn(errorMsg, 'PlayerService');
			return { screen, success: false, error: errorMsg };
		}
		this.streamStartCooldowns.set(screen, now);
	
		logger.info(`Attempting to start stream on screen ${screen}: ${url}`, 'PlayerService');
	
		if (this.disabledScreens.has(screen)) {
			return { screen, success: false, error: 'Screen is disabled' };
		}
	
		const activeStreamsCount = Array.from(this.streams.values()).filter(s => s.process && this.isProcessRunning(s.process.pid)).length;
		if (this.startupLocks.get(screen)) {
			return { screen, success: false, error: 'Stream startup already in progress' };
		}
		this.startupLocks.set(screen, true);
	
		try {
			await this.stopStream(screen, true, false); 
	
			const activeStreamsCount = Array.from(this.streams.values()).filter(s => s.process && this.isProcessRunning(s.process.pid)).length;
			if (activeStreamsCount >= this.config.player.maxStreams) {
				return { screen, success: false, error: `Maximum number of streams (${this.config.player.maxStreams}) reached` };
			} 
	
			const ipcPath = this.initializeIpcPath(screen);
			logger.info(`Starting stream with IPC path: ${ipcPath}`, 'PlayerService');
	
			let playerProcess: ChildProcess;
			if (this.config.player.preferStreamlink || url.includes('twitch.tv')) {
				playerProcess = await this.startStreamlinkProcess(options);
			} else {
				playerProcess = await this.startMpvProcess(options);
			}
	
			if (!playerProcess || !playerProcess.pid || !this.isProcessRunning(playerProcess.pid)) {
				throw new Error('Failed to start player process or it exited immediately.');
			}
	
			logger.info(`Player process started with PID ${playerProcess.pid} for screen ${screen}`, 'PlayerService');
	
			const streamInstance: LocalStreamInstance = {
				id: Date.now(),
				screen,
				url,
				quality: options.quality || this.config.player.defaultQuality,
				status: 'playing',
				volume: options.volume || 0,
				process: playerProcess,
				platform: url.includes('twitch.tv') ? 'twitch' : 'youtube',
				title: options.title,
				startTime: typeof options.startTime === 'string' ? new Date(options.startTime).getTime() : options.startTime,
				options
			};
	
			this.streams.set(screen, streamInstance);
			this.setupProcessHandlers(playerProcess, screen);
			this.manuallyClosedScreens.delete(screen);
			this.streamRetries.set(screen, 0);
			this.networkRetries.set(screen, 0);
	
			return { screen, success: true };
	
		} catch (error) {
			logger.error(`Failed to start stream on screen ${screen}: ${url}`, 'PlayerService', error);
			await this.stopStream(screen, true, false);
			return { screen, success: false, error: error instanceof Error ? error.message : String(error) };
		} finally {
			this.startupLocks.set(screen, false);
		}
	}

	private initializeIpcPath(screen: number): string {
		const homedir = process.env.HOME || process.env.USERPROFILE || '/tmp';
		const ipcDir = path.join(homedir, '.livelink');
		if (!fs.existsSync(ipcDir)) {
			fs.mkdirSync(ipcDir, { recursive: true });
		}
		const ipcPath = path.join(ipcDir, `mpv-ipc-${screen}`);
		this.ipcPaths.set(screen, ipcPath);
	
		// Clean up old socket file
		if (fs.existsSync(ipcPath)) {
			try {
				fs.unlinkSync(ipcPath);
				logger.info(`Removed existing socket file: ${ipcPath}`, 'PlayerService');
			} catch (e) {
				logger.warn(`Could not remove existing socket at ${ipcPath}`, 'PlayerService', e);
			}
		}
		return ipcPath;
	}

	private async startMpvProcess(
		options: StreamOptions & { screen: number }
	): Promise<ChildProcess> {
		logger.info(`Starting MPV for screen ${options.screen}`, 'PlayerService');

		const args = this.getMpvArgs(options);
		const env = this.getProcessEnv();

		logger.debug(`MPV command: ${this.mpvPath} ${args.join(' ')}`, 'PlayerService');
		const mpvLogFile = this.getLogFilePath(`mpv-screen-${options.screen}`);
		const mpvLogStream = fs.createWriteStream(mpvLogFile, { flags: 'a' });
		logger.info(`MPV logs will be written to: ${mpvLogFile}`, 'PlayerService');

		const mpvProcess = spawn(this.mpvPath, args, {
			env,
			stdio: ['ignore', 'pipe', 'pipe']
		});

		// Set up logging for the process
		if (mpvProcess.stdout) {
			mpvProcess.stdout.on('data', (data: Buffer) => {
				const logData = data.toString().trim();
				mpvLogStream.write(`[${new Date().toISOString()}] ${logData}\n`);
			});
		}

		if (mpvProcess.stderr) {
			mpvProcess.stderr.on('data', (data: Buffer) => {
				const logData = data.toString().trim();
				mpvLogStream.write(`[${new Date().toISOString()}] [ERROR] ${logData}\n`);
			});
		}

		mpvProcess.on('close', () => mpvLogStream.end());

		// Wait for IPC socket to be created
		const ipcPath = this.ipcPaths.get(options.screen);
		if (!ipcPath) {
			mpvProcess.kill();
			throw new Error('IPC path not found for screen ' + options.screen);
		}

		const maxWait = 120000; // 70 seconds
		try {
			await this.waitForIpcSocket(ipcPath, maxWait);
			logger.info(`IPC socket found for screen ${options.screen} at ${ipcPath}`, 'PlayerService');
		} catch (error) {
			mpvProcess.kill();
			throw error;
		}

		return mpvProcess;
	}

	private async startStreamlinkProcess(
		options: StreamOptions & { screen: number }
	): Promise<ChildProcess> {
		const args = this.getStreamlinkArgs(options.url, options);
		const env = this.getProcessEnv();
		logger.info(`Streamlink args: streamlink ${args.join(' ')}`, 'PlayerService');
		try {
			const streamlinkLogFile = this.getLogFilePath(`streamlink-screen-${options.screen}`);
			const streamlinkLogStream = fs.createWriteStream(streamlinkLogFile, { flags: 'a' });
			logger.info(`Streamlink logs will be written to: ${streamlinkLogFile}`, 'PlayerService');

			const process = spawn(this.streamlinkConfig.path || 'streamlink', args, {
				env,
				stdio: ['ignore', 'pipe', 'pipe']
			});

			let stderrOutput = '';
			process.stderr?.on('data', (data) => {
				stderrOutput += data.toString();
			});

			return new Promise((resolve, reject) => {
				const startTimeout = setTimeout(() => {
					process.kill();
					reject(new Error(`Streamlink start timeout. Stderr: ${stderrOutput}`));
				}, this.STARTUP_TIMEOUT);
	
				process.on('error', (err) => {
					clearTimeout(startTimeout);
					reject(err);
				});
	
				process.on('exit', (code) => {
					clearTimeout(startTimeout);
					if (code !== 0) {
						reject(new Error(`Streamlink exited with code ${code}. Stderr: ${stderrOutput}`));
					}
				});

				// Wait for IPC socket to be created
                const ipcPath = this.ipcPaths.get(options.screen);
                if (!ipcPath) {
                    clearTimeout(startTimeout);
                    process.kill();
                    return reject(new Error('IPC path not found for screen ' + options.screen));
                }

                const checkInterval = 250; // ms
                const maxWait = 120000; // 15 seconds
                let waited = 0;

                const intervalId = setInterval(() => {
                    if (fs.existsSync(ipcPath)) {
                        clearInterval(intervalId);
                        clearTimeout(startTimeout);
                        logger.info(`IPC socket found for screen ${options.screen} at ${ipcPath}`, 'PlayerService');
                        resolve(process);
                    } else {
                        waited += checkInterval;
                        if (waited >= maxWait) {
                            clearInterval(intervalId);
                            clearTimeout(startTimeout);
                            process.kill();
                            reject(new Error(`IPC socket at ${ipcPath} not created after ${maxWait / 1000}s. Stderr: ${stderrOutput}`));
                        }
                    }
                }, checkInterval);
			});

		} catch (error) {
			this.logError(
				`Failed to spawn streamlink process for screen ${options.screen}`,
				'PlayerService',
				error
			);
			throw error;
		}
	}

	private setupProcessHandlers(process: ChildProcess, screen: number): void {
		let hasEnded = false;
		const onExit = (code: number | null) => {
			if (hasEnded) return;
			hasEnded = true;

			this.cleanup_after_stop(screen);

			const stream = this.streams.get(screen);
			const url = stream?.url || 'unknown';
			logger.info(`Process for screen ${screen} (${url}) exited with code ${code}`, 'PlayerService');
	
			const normalExit = code === 0;
			const shouldRestart = !normalExit && !this.manuallyClosedScreens.has(screen) && !this.isShuttingDown;

			this.endCallback?.({ screen, code: code ?? undefined });
			
			if (!normalExit) {
				this.errorCallback?.({
					screen,
					error: `Stream ended with code ${code}`,
					code: code ?? 1,
					url,
					moveToNext: true,
					shouldRestart,
				});
			}
		};
	
		process.on('exit', onExit);
		process.on('error', (err) => {
			logger.error(`Process error on screen ${screen}`, 'PlayerService', err);
			onExit(1);
		});
	}

	

	private handleProcessExit(screen: number, code: number | null): void {
		// Get stream info before any cleanup happens
		const stream = this.streams.get(screen);

		// Check if stream is already marked as stopping to avoid race conditions
		if (!stream || stream.status === 'stopping') {
			logger.debug(
				`Stream on screen ${screen} already in stopping state or doesn't exist, ignoring duplicate exit handling`,
				'PlayerService'
			);
			return;
		}

		const url = stream?.url || '';
		const options = stream?.options;

		// IMPORTANT: Set state flag immediately to prevent race conditions
		// Flag this stream as being processed for exit to prevent duplicate handling
		if (stream) {
			stream.status = 'stopping';
		}

		// Log with URL for better tracking
		logger.info(
			`Process exited on screen ${screen} with code ${code}${url ? ` (${url})` : ''}`,
			'PlayerService'
		);

		// Check if this is a network-related error
		const isNetworkError = this.isNetworkErrorCode(code);
		this.isNetworkError.set(screen, isNetworkError);

		// External kill (code null) or missing URL should not be retried to prevent infinite loops
		const isMissingUrl = !url || url.trim() === '';
		const isExternalKill = code === null;

		// Handle network errors with valid URLs that are not external kills
		if (isNetworkError && url && !isMissingUrl && !isExternalKill && options) {
			const networkRetryCount = this.networkRetries.get(screen) || 0;
			const now = Date.now();
			const lastError = this.lastNetworkError.get(screen) || 0;
			const timeSinceLastError = now - lastError;

			// Check for persistent issues
			if (this.isPersistentIssue(screen)) {
				logger.warn(
					`Persistent network issues detected for screen ${screen}, skipping retry`,
					'PlayerService'
				);
				this.cleanup_after_stop(screen);
				this.clearMonitoring(screen);

				// Emit error to trigger external recovery
				this.errorCallback?.({
					screen,
					error: 'Persistent network issues detected',
					code: code || 0,
					url,
					moveToNext: true // Signal to move to next stream
				});
				return;
			}

			// Reset network retry count if it's been a while since the last error
			if (timeSinceLastError > 2 * 60 * 1000) {
				// Reduced from 5 minutes to 2 minutes
				logger.info(
					`Resetting network retry count for screen ${screen} as it's been ${Math.round(timeSinceLastError / 1000)}s since last error`,
					'PlayerService'
				);
				this.networkRetries.set(screen, 0);
			}

			// Update last error time
			this.lastNetworkError.set(screen, now);

			// Check if we should retry
			if (networkRetryCount < this.MAX_NETWORK_RETRIES) {
				// Calculate backoff time with exponential backoff
				const backoffTime = Math.min(
					this.NETWORK_RETRY_INTERVAL * Math.pow(1.5, networkRetryCount),
					this.MAX_BACKOFF_TIME
				);

				logger.info(
					`Network error detected for ${url} on screen ${screen}, retry ${networkRetryCount + 1}/${this.MAX_NETWORK_RETRIES} in ${Math.round(backoffTime / 1000)}s`,
					'PlayerService'
				);

				// Increment retry count
				this.networkRetries.set(screen, networkRetryCount + 1);
				logger.info(
					`Incremented retry count for screen ${screen} to ${this.networkRetries.get(screen)}`,
					'PlayerService'
				);
				// Clean up but don't emit error yet
				this.cleanup_after_stop(screen);
				this.clearMonitoring(screen);

				// Set up retry timer with timeout protection
				const retryTimer = setTimeout(async () => {
					try {
						logger.info(
							`Attempting to restart stream ${url} on screen ${screen} after network error`,
							'PlayerService'
						);
						const startResult = await Promise.race([
							this.startStream({
								...options,
								isRetry: true
							}),
							new Promise<StartResult>((_, reject) =>
								setTimeout(() => reject(new Error('Start timeout')), 120000)
							)
						]);

						if (!startResult || !startResult.success) {
							throw new Error(startResult?.error || 'Unknown error');
						}
					} catch (error) {
						logger.error(
							`Failed to restart stream after network error on screen ${screen}`,
							'PlayerService',
							error instanceof Error ? error : new Error(String(error))
						);

						// Now emit the error since retry failed
						this.errorCallback?.({
							screen,
							error: `Failed to restart stream after network error: ${error instanceof Error ? error.message : String(error)}`,
							code: code || 0,
							url,
							moveToNext: true
						});
					}
				}, backoffTime);

				// Store the timer
				this.retryTimers.set(screen, retryTimer);
				return; // Don't emit error yet, we're handling it with retry
			} else {
				logger.warn(
					`Maximum network retries (${this.MAX_NETWORK_RETRIES}) reached for screen ${screen}, giving up`,
					'PlayerService'
				);
				// Reset retry count for future attempts
				this.networkRetries.set(screen, 0);
			}
		} else if (isExternalKill) {
			logger.warn(
				`Process on screen ${screen} was killed externally (code: ${code}), skipping retry`,
				'PlayerService'
			);
		} else if (isMissingUrl) {
			logger.warn(
				`Process on screen ${screen} has no URL, skipping retry to prevent infinite loop`,
				'PlayerService'
			);
		}

		// For non-network errors or if max retries reached, clean up and emit error
		this.cleanup_after_stop(screen);
		this.clearMonitoring(screen);

		// Calculate whether to move to next or restart
		const normalExit = code === 0;
		const missingUrl = !url || url.trim() === '';
		const externalKill = code === null;
		const moveToNext = normalExit || missingUrl || externalKill;
		const shouldRestart = !normalExit && !missingUrl && !externalKill && !this.isShuttingDown;
		logger.info(`Stream on screen ${screen} ended with code ${code}${url ? ` (${url})` : ''}`, 'PlayerService');
		logger.info(`Move to next: ${moveToNext}, should restart: ${shouldRestart} is shutting down: ${this.isShuttingDown} normal exit: ${normalExit} missing url: ${missingUrl} external kill: ${externalKill} code: ${code}`, 'PlayerService');
		// Emit stream error with URL if we have it
		this.errorCallback?.({
			screen,
			error: normalExit ? 'Stream ended normally' : `Stream ended with code ${code}`,
			code: code || 0,
			url,
			moveToNext,
			shouldRestart
		});
	}

	    public clearMonitoring(screen: number): void {
		logger.debug(`Clearing monitoring for screen ${screen}`, 'PlayerService');

		// Clear inactive timer
		const inactiveTimer = this.inactiveTimers.get(screen);
		if (inactiveTimer) {
			clearTimeout(inactiveTimer);
			this.inactiveTimers.delete(screen);
		}

		// Clear retry timer if exists
		const retryTimer = this.retryTimers.get(screen);
		if (retryTimer) {
			clearTimeout(retryTimer);
			this.retryTimers.delete(screen);
		}

		// Clear other state
		this.streamStartTimes.delete(screen);
		this.streamRetries.delete(screen);
		this.startupLocks.set(screen, false);
	}

	/**
	 * Determines if an exit code is likely related to network issues
	 */
	private isNetworkErrorCode(code: number | null): boolean {
		// Common network-related exit codes
		const networkErrorCodes = new Set([2, 1, 9]);

		// Check if it's a known network error code
		if (code !== null && networkErrorCodes.has(code)) {
			return true;
		}

		return false;
	}

	/**
	 * Stop a stream that is currently playing on a screen
	 */
	async stopStream(
		screen: number,
		force: boolean = false,
		isManualStop: boolean = false
	): Promise<boolean> {
		const streamInstance = this.streams.get(screen);
		if (!streamInstance) {
			this.cleanup_after_stop(screen);
			return true;
		}
	
		if (streamInstance.status === 'stopping') {
			return true; // Already being stopped
		}
	
		logger.info(`Stopping stream on screen ${screen} (manual=${isManualStop}, force=${force})`, 'PlayerService');
		streamInstance.status = 'stopping';
	
		if (isManualStop) {
			this.manuallyClosedScreens.add(screen);
		}
	
		const { process } = streamInstance;
		if (process && this.isProcessRunning(process.pid)) {
			process.removeAllListeners('exit');
			process.removeAllListeners('error');
			try {
				const signal = force ? 'SIGKILL' : 'SIGTERM';
				process.kill(signal);
	
				await new Promise<void>(resolve => {
					const timeout = setTimeout(() => {
						if (this.isProcessRunning(process.pid)) {
							logger.warn(`Process ${process.pid} did not exit gracefully, sending SIGKILL.`, 'PlayerService');
							process.kill('SIGKILL');
						}
						resolve();
					}, this.SHUTDOWN_TIMEOUT);
	
					process.once('exit', () => {
						clearTimeout(timeout);
						resolve();
					});
				});
			} catch (error) {
				logger.error(`Error stopping process on screen ${screen}`, 'PlayerService', error);
				if (this.isProcessRunning(process.pid)) process.kill('SIGKILL');
			}
		}
	
		this.cleanup_after_stop(screen);
		return true;
	}
	/**
	 * Kill child processes of a given parent process
	 * Only kills processes that are directly related to our managed streams
	 */
	private killChildProcesses(parentPid?: number): void {
		if (!parentPid || !this.isProcessRunning(parentPid)) {
			return;
		}
	
		try {
			// Using pkill is more reliable for finding and killing child process trees
			exec(`pkill -P ${parentPid}`, (error) => {
				if (error && !error.message.includes('No such process')) {
					logger.warn(`Error killing child processes for ${parentPid}`, 'PlayerService', error);
				} else {
					logger.debug(`Sent kill signal to child processes of ${parentPid}`, 'PlayerService');
				}
			});
		} catch (error) {
			logger.error(`Failed to execute pkill for parent PID ${parentPid}`, 'PlayerService', error);
		}
	}

	/**
	 * Clean up resources after a stream is stopped
	 */
	cleanup_after_stop(screen: number): void {
		const stream = this.streams.get(screen);
		logger.info(`Running cleanup for screen ${screen}, stream URL: ${stream?.url ?? 'N/A'}`, 'PlayerService');
		if (stream?.process?.pid) {
			this.killChildProcesses(stream.process.pid);
		}
	
		this.clearMonitoring(screen);
		this.streams.delete(screen);
		
		const ipcPath = this.ipcPaths.get(screen);
		if (ipcPath && fs.existsSync(ipcPath)) {
			try {
				fs.unlinkSync(ipcPath);
			} catch (error) {
				logger.warn(`Failed to remove IPC socket ${ipcPath}`, 'PlayerService', error);
			}
		}
		this.ipcPaths.delete(screen);
	
		logger.info(`Cleanup complete for screen ${screen}.`, 'PlayerService');
	}

	/**
	 * Check if a process is still running without sending a signal
	 */
	private isProcessRunning(pid: number | undefined): boolean {
		if (!pid) return false;
		try {
			// The kill with signal 0 doesn't actually kill the process, it just checks for existence.
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	}

	private getTitle(options: StreamOptions & { screen: number }): string {
		// Simplify the escaping - just replace double quotes with single quotes
		const title =
			`Screen ${options.screen}: ${options.url} - ${options.title} - Viewers: ${options.viewerCount} - start time: ${options.startTime}`.replace(
				/"/g,
				"'"
			);

		return title; // No need to add extra quotes - those will be added by the argument handling
	}
	private getMpvArgs(
		options: StreamOptions & { screen: number },
		includeUrl: boolean = true
	): string[] {
		const screenConfig = this.config.player.screens.find((s) => s.screen === options.screen);
		if (!screenConfig) {
			throw new Error(`No screen configuration found for screen ${options.screen}`);
		}

		// Initialize IPC path if not already set
		if (!this.ipcPaths.has(options.screen)) {
			const ipcPath = `/tmp/mpv-socket-${options.screen}`;
			this.ipcPaths.set(options.screen, ipcPath);
		}

		// Ensure log directory exists
		if (!fs.existsSync(this.BASE_LOG_DIR)) {
			fs.mkdirSync(this.BASE_LOG_DIR, { recursive: true });
		}

		const logFile = path.join(this.BASE_LOG_DIR, `screen_${options.screen}.log`);
		const ipcPath = this.ipcPaths.get(options.screen);

		if (!ipcPath) {
			throw new Error(`No IPC path found for screen ${options.screen}`);
		}

		const baseArgs: string[] = [];

		// Add global MPV arguments from config
		if (this.config.mpv) {
			for (const [key, value] of Object.entries(this.config.mpv)) {
				if (value !== undefined && value !== null) {
					baseArgs.push(`--${key}=${value}`);
				}
			}
		}

		// Add screen-specific MPV arguments from streamlink config
		if (this.config.streamlink?.mpv) {
			for (const [key, value] of Object.entries(this.config.streamlink.mpv)) {
				if (value !== undefined && value !== null) {
					baseArgs.push(`--${key}=${value}`);
				}
			}
		}

		// Essential arguments
		baseArgs.push(
			`--input-ipc-server=${ipcPath}`,
			`--config-dir=${path.join(process.cwd(), 'scripts', 'mpv')}`,
			`--log-file=${logFile}`,
			`--geometry=${screenConfig.width}x${screenConfig.height}+${screenConfig.x}+${screenConfig.y}`,
			`--volume=${(options.volume || 0).toString()}`,
			//			`--title="${this.getTitle(options)}"`,
			'--msg-level=all=debug'
		);

		if (options.windowMaximized) {
			baseArgs.push('--window-maximized=yes');
		}

		// Add URL if requested
		if (includeUrl && options.url) {
			baseArgs.push(options.url);
		}

		logger.info(`MPV args for screen ${options.screen}: ${baseArgs.join(' ')}`, 'PlayerService');
		return baseArgs;
	}

	private getStreamlinkArgs(url: string, options: StreamOptions & { screen: number }): string[] {
		const screenConfig = this.config.player.screens.find((s) => s.screen === options.screen);
		if (!screenConfig) {
			throw new Error(`No screen config found for screen ${options.screen}`);
		}

		// Start with streamlink-specific arguments
		const streamlinkArgs = [
			url,
			options.quality || screenConfig.quality || this.config.player.defaultQuality || 'best',
			'--player',
			this.mpvPath
		];

		// Add streamlink options from config
		if (this.config.streamlink?.options) {
			Object.entries(this.config.streamlink.options).forEach(([key, value]) => {
				if (value === true) {
					streamlinkArgs.push(`--${key}`);
				} else if (value !== false && value !== undefined && value !== null) {
					streamlinkArgs.push(`--${key}`, String(value));
				}
			});
		}

		// Add HTTP headers if configured
		if (this.config.streamlink?.http_header) {
			Object.entries(this.config.streamlink.http_header).forEach(([key, value]) => {
				streamlinkArgs.push('--http-header', `${key}=${value}`);
			});
		}

		// Get MPV arguments without the URL (we don't want streamlink to pass the URL to MPV)
		const mpvArgs = this.getMpvArgs(options, false);

		// FIXED: Don't join MPV args into a single quoted string
		// Instead, add --player-args and then each argument properly
		streamlinkArgs.push('--player-args');

				// Join all MPV args into a properly escaped single string
		// This is the critical fix - we need one properly escaped string
		const mpvArgsString = mpvArgs
			.map((arg) => {
				// Handle special characters in arguments
				return arg.replace(/"/g, '\"');
			})
			.join(' ');

		// Add the entire MPV command as a single quoted argument
		streamlinkArgs.push(mpvArgsString);

		// Add any additional streamlink arguments from config
		if (this.config.streamlink?.args) {
			streamlinkArgs.push(...this.config.streamlink.args);
		}

		logger.debug(`Streamlink args: ${streamlinkArgs.join(' ')}`, 'PlayerService');
		return streamlinkArgs;
	}

	private getProcessEnv(): NodeJS.ProcessEnv {
		return {
			...process.env,
			MPV_HOME: undefined,
			XDG_CONFIG_HOME: undefined,
			DISPLAY: process.env.DISPLAY || ':0',
			SDL_VIDEODRIVER: 'x11',
		};
	}
	public isStreamHealthy(screen: number): boolean {
		const activeStream = this.streams.get(screen);
		if (!activeStream || !activeStream.process) return false;
	
		// Process is running
		return this.isProcessRunning(activeStream.process.pid);
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

	public sendCommandToScreen(screen: number, command: string | string[]): void {
		const commandArray = Array.isArray(command) ? command : [command];
		this.sendMpvCommand(screen, commandArray).catch(err => {
			logger.error(`Failed to send IPC command to screen ${screen}: ${commandArray.join(' ')}`, 'PlayerService', err);
		});
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

	public onStreamEnd(callback: (data: StreamEnd) => void): void {
		this.endCallback = callback;
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

		const stopPromises = Array.from(this.streams.keys()).map(screen => this.stopStream(screen, true));
		await Promise.allSettled(stopPromises);
	
		this.ipcPaths.forEach((ipcPath) => {
			try {
				if (fs.existsSync(ipcPath)) {
					fs.unlinkSync(ipcPath);
				}
			} catch (error) {
				this.logError(`Failed to remove IPC socket ${ipcPath}`, 'PlayerService', error);
			}
		});
	
		// Clear all timers
		this.retryTimers.forEach(timer => clearTimeout(timer));
	
		// Clear all state maps
		this.streams.clear();
		this.ipcPaths.clear();
		this.retryTimers.clear();
		this.startupLocks.clear();
	
		logger.info('Player service cleanup complete', 'PlayerService');
	}

	public isRetrying(screen: number): boolean {
		return this.streamRetries.has(screen);
	}

	public disableScreen(screen: number): void {
		logger.info(`Disabling screen ${screen} in player service`, 'PlayerService');
		this.disabledScreens.add(screen);
		this.stopStream(screen, true, true);
	}

	/**
	 * Last resort attempt to kill MPV for a specific screen using multiple methods
	 * to ensure the process is terminated and all resources are cleaned up
	 */
	private killProcessByScreenNumber(screen: number): void {
		const logPrefix = `[Screen ${screen}]`;
		const ipcPath = this.ipcPaths.get(screen);
		const commands: string[] = [];

		try {
			logger.info(`${logPrefix} Starting forceful cleanup of MPV processes`, 'PlayerService');

			// 1. First try to kill by IPC socket path if we have it
			if (ipcPath) {
				// Kill using the IPC socket path (most reliable)
				commands.push(
					`lsof -t "${ipcPath}" | xargs -r kill -9 2>/dev/null || true`,
					`fuser -k "${ipcPath}" 2>/dev/null || true`
				);
			}

			// 2. Kill by matching the specific IPC socket in command line
			commands.push(
				`pkill -f "mpv.*--input-ipc-server=.*/mpv-ipc-${screen}(\\s|$)" || true`,
				`pkill -f "mpv.*--input-ipc-server=mpv-ipc-${screen}(\\s|$)" || true`
			);

			// 3. Kill by matching screen-specific IPC file
			commands.push(
				`pkill -f "mpv.*/mpv-ipc-${screen}$" || true`,
				`pkill -f "mpv.*mpv-ipc-${screen}$" || true`
			);

			// Execute all kill commands in sequence
			const executeKillCommands = async () => {
				for (const cmd of commands) {
					try {
						logger.debug(`${logPrefix} Executing: ${cmd}`, 'PlayerService');
						await new Promise<void>((resolve) => {
							exec(cmd, (error) => {
								if (error && error.code !== 1) { // code 1 means no process found
									logger.debug(
									`${logPrefix} Command failed: ${error.message}`,
									'PlayerService'
								);
								}
								resolve();
							});
						});
					} catch (error) {
						logger.debug(
							`${logPrefix} Error executing kill command: ${error instanceof Error ? error.message : String(error)}`,
							'PlayerService'
						);
					}
				}

				// Clean up IPC socket file if it still exists
				if (ipcPath && fs.existsSync(ipcPath)) {
					try {
						fs.unlinkSync(ipcPath);
						logger.debug(`${logPrefix} Removed IPC socket file`, 'PlayerService');
					} catch (error) {
						logger.debug(
							`${logPrefix} Failed to remove IPC socket: ${error instanceof Error ? error.message : String(error)}`,
							'PlayerService'
						);
					}
				}
			};

			// Execute cleanup and don't wait for it to complete
			executeKillCommands().catch(error => {
				logger.error(
					`${logPrefix} Error during process cleanup: ${error instanceof Error ? error.message : String(error)}`,
					'PlayerService'
				);
			});

		} catch (error) {
			logger.error(
				`${logPrefix} Error in killProcessByScreenNumber: ${error instanceof Error ? error.message : String(error)}`,
				'PlayerService'
			);
		}
	}

	public enableScreen(screen: number): void {
		logger.info(`Enabling screen ${screen} in player service`, 'PlayerService');
		this.disabledScreens.delete(screen);
		this.manuallyClosedScreens.delete(screen);
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
			this.logError('Failed to extract title from URL', 'PlayerService', err);
			return 'Unknown Stream';
		}
	}

	/**
	 * Sends a command directly to the MPV IPC socket
	 */
	private async sendMpvCommand(screen: number, command: string[]): Promise<any> {
		const ipcPath = this.ipcPaths.get(screen);
		if (!ipcPath) {
			throw new Error(`No IPC socket for screen ${screen}`);
		}
	
		return new Promise((resolve, reject) => {
			const socket = net.createConnection(ipcPath);
			let responseData = '';
	
			const timeout = setTimeout(() => {
				socket.destroy();
				reject(new Error('Socket timeout'));
			}, 30000);
	
			socket.on('connect', () => {
				const mpvCommand = JSON.stringify({ command });
				socket.write(mpvCommand + '\n');
			});
	
			socket.on('data', (data) => {
				responseData += data.toString();
				// MPV responses are newline-terminated JSON
				if (responseData.includes('\n')) {
					clearTimeout(timeout);
					socket.end();
					try {
						const jsonResponse = JSON.parse(responseData);
						resolve(jsonResponse);
					} catch (e) {
						reject(new Error('Failed to parse MPV response'));
					}
				}
			});
	
			socket.on('error', (err) => {
				clearTimeout(timeout);
				reject(err);
			});
	
			socket.on('close', () => {
				clearTimeout(timeout);
				if (!responseData) {
					reject(new Error('Socket closed without response'));
				}
			});
		});
	}

	private async waitForIpcSocket(ipcPath: string, timeout: number): Promise<void> {
		const checkInterval = 250;
		let waited = 0;
		while (waited < timeout) {
			if (fs.existsSync(ipcPath)) {
				return;
			}
			await new Promise(resolve => setTimeout(resolve, checkInterval));
			waited += checkInterval;
		}
		throw new Error(`IPC socket at ${ipcPath} not created after ${timeout / 1000}s`);
	}

	private logError(message: string, service: string, error: unknown): void {
		if (error instanceof Error) {
			logger.error(message, service, error);
		} else {
			logger.error(message, service, new Error(String(error)));
		}
	}

	/**
	 * Set up heartbeat monitoring for a stream to detect if it becomes unresponsive
	 */
	

	// Add method to check if stream is having persistent issues
	private isPersistentIssue(screen: number): boolean {
		const retryCount = this.networkRetries.get(screen) || 0;
		const now = Date.now();
		const lastError = this.lastNetworkError.get(screen) || 0;
		const timeSinceLastError = now - lastError;

		// If we've had multiple retries in a short time period
		if (retryCount >= 2 && timeSinceLastError < 60000) {
			// 1 minute
			return true;
		}

		return false;
	}
}
