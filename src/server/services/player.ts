import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import type { Config, StreamlinkConfig, StreamOptions } from '../../types/stream.js';
import type { StreamOutput, StreamError, StreamResponse } from '../../types/stream_instance.js';
import { logger } from './logger.js';
import { exec, execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import net from 'net';

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

export class PlayerService {
	private readonly BASE_LOG_DIR: string;
	private readonly MAX_RETRIES = 2;
	private readonly RETRY_INTERVAL = 500;
	private readonly STREAM_REFRESH_INTERVAL = 4 * 60 * 60 * 1000; // 4 hours
	private readonly INACTIVE_RESET_TIMEOUT = 5 * 60 * 1000; // 5 minutes
	private readonly STARTUP_TIMEOUT = 60000; // 10 minutes
	private readonly SHUTDOWN_TIMEOUT = 2000; // Increased from 100ms to 1 second
	private readonly SCRIPTS_PATH: string;
	private streams: Map<number, LocalStreamInstance> = new Map();
	private streamRetries: Map<number, number> = new Map();
	private streamStartTimes: Map<number, number> = new Map();
	private streamRefreshTimers: Map<number, NodeJS.Timeout> = new Map();
	private inactiveTimers: Map<number, NodeJS.Timeout> = new Map();
	private healthCheckIntervals: Map<number, NodeJS.Timeout> = new Map();
	private startupLocks: Map<number, boolean> = new Map();
	private manuallyClosedScreens: Set<number> = new Set();
	private disabledScreens: Set<number> = new Set();
	private ipcPaths: Map<number, string> = new Map();

	private config: Config;
	private mpvPath: string;
	private isShuttingDown = false;
	private events = new EventEmitter();
	private outputCallback?: (data: StreamOutput) => void;
	private errorCallback?: (data: StreamError) => void;

	private readonly DUMMY_SOURCE = '';  // Empty string instead of black screen URL

	private readonly streamlinkConfig: StreamlinkConfig;
	private readonly retryTimers: Map<number, NodeJS.Timeout>;

	constructor(config: Config) {
		this.config = config;
		this.streamlinkConfig = config.streamlink || {
			path: 'streamlink',
			options: {},
			http_header: {}
		};
		this.streams = new Map();
		this.ipcPaths = new Map();
		this.disabledScreens = new Set();
		this.retryTimers = new Map();
		
		// Set up paths
		this.BASE_LOG_DIR = path.join(process.cwd(), 'logs');
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
		} catch (err) {
			logger.error(
				'Failed to initialize directories',
				'PlayerService',
				err instanceof Error ? err : new Error(String(err))
			);
		}
	}

	private clearOldLogs(directory: string): void {
		try {
			if (!fs.existsSync(directory)) return;

			const files = fs.readdirSync(directory);
			const now = Date.now();
			const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days

			for (const file of files) {
				if (!file.endsWith('.log')) continue;

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
		const { screen } = options;

		// Check maximum streams limit
		const activeStreams = Array.from(this.streams.values()).filter((s) => s.process !== null);
		if (activeStreams.length >= this.config.player.maxStreams) {
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

		// Set startup lock with timeout
		this.startupLocks.set(screen, true);
		const lockTimeout = setTimeout(() => {
			this.startupLocks.set(screen, false);
		}, this.STARTUP_TIMEOUT);

		try {
			// Stop existing stream if any
			await this.stopStream(screen);

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

			// Initialize IPC path for this screen
			const homedir = process.env.HOME || process.env.USERPROFILE;
			const ipcPath = homedir
				? path.join(homedir, '.livelink', `mpv-ipc-${screen}`)
				: `/tmp/mpv-ipc-${screen}`;
			this.ipcPaths.set(screen, ipcPath);

			// Clear manually closed flag - we're explicitly starting a new stream
			this.manuallyClosedScreens.delete(screen);

			// Determine player type
			const useStreamlink =
				screenConfig.playerType === 'streamlink' ||
				screenConfig.playerType === 'both' && (options.url.includes('twitch.tv')) ||
				(!screenConfig.playerType && this.config.player.preferStreamlink);

			// Ensure we have metadata for the title
			const streamTitle =
				options.title || this.extractTitleFromUrl(options.url) || 'Unknown Stream';

			// Add metadata to options for use in player commands
			options.title = streamTitle;
			options.viewerCount = options.viewerCount || 0;
			options.startTime = options.startTime || Date.now();

			logger.info(
				`Starting stream with title: ${streamTitle}, viewers: ${options.viewerCount}, time: ${options.startTime}, screen: ${screen}`,
				'PlayerService'
			);

			// Start the stream
			let playerProcess: ChildProcess;
			if (useStreamlink) {
				playerProcess = await this.startStreamlinkProcess(options);
			} else {
				playerProcess = await this.startMpvProcess(options);
			}

			// Create stream instance
			const instance: LocalStreamInstance = {
				id: Date.now(),
				screen,
				url: options.url,
				quality: options.quality || 'best',
				status: 'playing',
				volume: options.volume || screenConfig.volume || this.config.player.defaultVolume,
				process: playerProcess,
				platform: options.url.includes('youtube.com') ? 'youtube' : 'twitch',
				title: streamTitle,
				startTime:
					typeof options.startTime === 'string'
						? new Date(options.startTime).getTime()
						: options.startTime,
				options: options
			};

			// Store stream instance
			this.streams.set(screen, instance);

			// Setup monitoring
			this.setupStreamMonitoring(screen, playerProcess, options);

			return {
				screen,
				message: `Stream started on screen ${screen}`,
				success: true
			};
		} catch (error) {
			logger.error(
				`Failed to start stream on screen ${screen}`,
				'PlayerService',
				error instanceof Error ? error : new Error(String(error))
			);
			return {
				screen,
				message: error instanceof Error ? error.message : String(error),
				success: false
			};
		} finally {
			clearTimeout(lockTimeout);
			this.startupLocks.set(screen, false);
		}
	}

	private async startMpvProcess(options: StreamOptions & { screen: number }): Promise<ChildProcess> {
		logger.info(`Starting MPV for screen ${options.screen}`, 'PlayerService');

		// Ensure IPC path is initialized
		if (!this.ipcPaths.has(options.screen)) {
			const homedir = process.env.HOME || process.env.USERPROFILE;
			const ipcPath = homedir
				? path.join(homedir, '.livelink', `mpv-ipc-${options.screen}`)
				: `/tmp/mpv-ipc-${options.screen}`;
			this.ipcPaths.set(options.screen, ipcPath);
		}

		const args = this.getMpvArgs(options);
		const env = this.getProcessEnv();

		logger.debug(`Starting MPV with command: ${this.mpvPath} ${args.join(' ')}`, 'PlayerService');

		const mpvProcess = spawn(this.mpvPath, args, {
			env,
			stdio: ['ignore', 'pipe', 'pipe']
		});

		// Set up logging for the process
		if (mpvProcess.stdout) {
			mpvProcess.stdout.on('data', (data: Buffer) => {
				logger.debug(`MPV stdout (screen ${options.screen}): ${data.toString().trim()}`, 'PlayerService');
			});
		}

		if (mpvProcess.stderr) {
			mpvProcess.stderr.on('data', (data: Buffer) => {
				logger.debug(`MPV stderr (screen ${options.screen}): ${data.toString().trim()}`, 'PlayerService');
			});
		}

		return mpvProcess;
	}

	private async startStreamlinkProcess(
		options: StreamOptions & { screen: number }
	): Promise<ChildProcess> {
		const args = this.getStreamlinkArgs(options.url, options);
		const env = this.getProcessEnv();

		logger.info(`Starting Streamlink for screen ${options.screen}`, 'PlayerService');
		logger.debug(`Streamlink command: streamlink ${args.join(' ')}`, 'PlayerService');

		// Check if there's already a process for this screen
		const existingStream = this.streams.get(options.screen);
		if (existingStream?.process) {
			try {
				existingStream.process.kill('SIGTERM');
				await new Promise<void>((resolve) => {
					const timeout = setTimeout(() => {
						try {
							existingStream.process?.kill('SIGKILL');
						} catch {
							// Process might already be gone
						}
						resolve();
					}, this.SHUTDOWN_TIMEOUT);

					existingStream.process?.once('exit', () => {
						clearTimeout(timeout);
						resolve();
					});
				});
			} catch (error) {
				logger.warn(
					`Error stopping existing process on screen ${options.screen}`,
					'PlayerService',
					error instanceof Error ? error.message : String(error)
				);
			}
		}

		// Clear any existing state
		this.clearMonitoring(options.screen);
		this.streams.delete(options.screen);
		logger.info(`Starting Streamlink for screen ${options.screen} Command: streamlink ${args.join(' ')}`, 'PlayerService');
		// Start new process
		const process = spawn('streamlink', args, {
			env,
			stdio: ['ignore', 'pipe', 'pipe']
		});

		// Set up process handlers
		this.setupProcessHandlers(process, options.screen);

		// Wait for streamlink to initialize
		await new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => {
				reject(new Error('Streamlink startup timeout'));
			}, this.STARTUP_TIMEOUT);

			const onData = (data: Buffer) => {
				const output = data.toString();
				if (output.includes('Available streams:')) {
					cleanup();
					resolve();
				}
			};

			const onError = (error: Error) => {
				cleanup();
				reject(error);
			};

			const onExit = (code: number | null) => {
				cleanup();
				if (code !== null && code !== 0) {
					reject(new Error(`Streamlink exited with code ${code}`));
				}
			};

			const cleanup = () => {
				clearTimeout(timeout);
				process.stdout?.removeListener('data', onData);
				process.removeListener('error', onError);
				process.on('exit', onExit);
			};

			process.stdout?.on('data', onData);
			process.on('error', onError);
			process.on('exit', onExit);
		});

		return process;
	}

	private setupProcessHandlers(process: ChildProcess, screen: number): void {
		let hasEndedStream = false;

		if (process.stdout) {
			process.stdout.on('data', (data: Buffer) => {
				const output = data.toString('utf8').trim();
				if (output && /[\x20-\x7E]/.test(output)) {
					// Log YouTube-specific state information
					if (output.includes('[youtube]')) {
						if (output.includes('Post-Live Manifestless mode')) {
							logger.info(`[Screen ${screen}] YouTube stream is in post-live state (ended)`, 'PlayerService');
							if (!hasEndedStream) {
								hasEndedStream = true;
								this.errorCallback?.({
									screen,
									error: 'Stream ended',
									code: 0
								});
							}
						} else if (output.includes('Downloading MPD manifest')) {
							logger.debug(`[Screen ${screen}] YouTube stream manifest download attempt`, 'PlayerService');
						}
					}

					logger.debug(`[Screen ${screen}] ${output}`, 'PlayerService');
					this.outputCallback?.({
						screen,
						data: output,
						type: 'stdout'
					});

					// Check for different types of stream endings
					if (output.includes('Exiting... (Quit)') || 
						output.includes('Quit') || 
						output.includes('Exiting normally') ||
						output.includes('EOF reached') ||
						output.includes('User stopped playback')) {
						logger.info(`Stream ended on screen ${screen}`, 'PlayerService');
						if (!hasEndedStream) {
							hasEndedStream = true;
							this.errorCallback?.({
								screen,
								error: 'Stream ended',
								code: 0
							});
						}
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
							if (!hasEndedStream) {
								hasEndedStream = true;
								this.errorCallback?.({
									screen,
									error: 'Stream ended',
									code: 0
								});
							}
						} else {
							logger.error(`[Screen ${screen}] ${output}`, 'PlayerService');
							if (!hasEndedStream) {
								hasEndedStream = true;
								this.errorCallback?.({
									screen,
									error: output,
									code: 0  // Always use code 0 to trigger next stream
								});
							}
						}
					}
				}
			});
		}

		process.on('error', (err: Error) => {
			this.logError(`Process error on screen ${screen}`, 'PlayerService', err);
			if (!hasEndedStream) {
				hasEndedStream = true;
				this.errorCallback?.({
					screen,
					error: err.message,
					code: 0  // Changed to 0 to always trigger next stream
				});
			}
		});

		process.on('exit', (code: number | null) => {
			logger.info(`Process exited on screen ${screen} with code ${code}`, 'PlayerService');
			// Only handle process exit if we haven't already handled stream end
			if (!hasEndedStream) {
				this.handleProcessExit(screen, code);
			} else {
				// Just clean up resources without triggering another stream end
				this.clearMonitoring(screen);
				this.streams.delete(screen);
				this.streamRetries.delete(screen);
			}
		});
	}

	private setupStreamMonitoring(
		screen: number,
		process: ChildProcess,
		options: StreamOptions
	): void {
		// Setup health check with more lenient timing
		const healthCheck = setInterval(() => {
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
					logger.warn(`Process mismatch detected for screen ${screen}, clearing health check`, 'PlayerService');
					clearInterval(healthCheck);
					this.healthCheckIntervals.delete(screen);
					return;
				}
			} catch (err) {
				// Only restart if the process is actually gone
				if (err && typeof err === 'object' && 'code' in err && err.code === 'ESRCH') {
					logger.warn(`Stream on screen ${screen} appears to be unresponsive`, 'PlayerService');
					this.restartStream(screen, options).catch((err) => {
						logger.error(
							`Failed to restart unresponsive stream on screen ${screen}`,
							'PlayerService',
							err
						);
					});
				}
			}
		}, 30000); // Increased from 60s to 30s for more responsive detection

		this.healthCheckIntervals.set(screen, healthCheck);

		// Setup refresh timer
		const refreshTimer = setTimeout(() => {
			logger.info(`Refreshing stream on screen ${screen}`, 'PlayerService');
			this.restartStream(screen, options).catch(error => {
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
				await new Promise(resolve => setTimeout(resolve, 200));
			} catch {
				// Process might already be gone
			}
		}
		
		await this.startStream({ ...options, screen });
	}

	private handleProcessExit(screen: number, code: number | null): void {
		// Clear monitoring
		this.clearMonitoring(screen);

		// Get stream options before removing the instance
		const stream = this.streams.get(screen);
		const streamOptions = stream?.options;

		// Remove stream instance
		this.streams.delete(screen);

		// Initialize retry count if not exists
		if (!this.streamRetries.has(screen)) {
			this.streamRetries.set(screen, 0);
		}

		const retryCount = this.streamRetries.get(screen) || 0;
		const MAX_RETRIES = 3;

		// Handle different exit codes
		if (code === 0) {
			// Normal exit - clear retries and move to next stream
			this.streamRetries.delete(screen);
			logger.info(
				`Stream ended normally on screen ${screen}, moving to next stream`,
				'PlayerService'
			);
			this.errorCallback?.({
				screen,
				error: 'Stream ended normally',
				code: 0
			});
		} else if (code === 2) {
			// Exit code 2 typically means a permanent error (like members-only content)
			// Don't retry, just move to next stream
			this.streamRetries.delete(screen);
			logger.error(
				`Stream failed with permanent error on screen ${screen} (code ${code}), moving to next stream`,
				'PlayerService'
			);
			this.errorCallback?.({
				screen,
				error: 'Stream unavailable (possibly members-only content)',
				code: -1
			});
		} else {
			// Other error codes - retry with backoff if under max retries
			if (retryCount < MAX_RETRIES && streamOptions) {
				const backoffTime = Math.min(1000 * Math.pow(2, retryCount), 10000); // Max 10 second backoff
				this.streamRetries.set(screen, retryCount + 1);
				logger.warn(
					`Stream error on screen ${screen} (code ${code}), retry ${retryCount + 1}/${MAX_RETRIES} in ${backoffTime}ms`,
					'PlayerService'
				);
				setTimeout(() => {
					this.startStream(streamOptions).catch(error => {
						logger.error(
							`Failed to restart stream on screen ${screen}`,
							'PlayerService',
							error
						);
					});
				}, backoffTime);
			} else {
				// Max retries reached or no options available - move to next stream
				this.streamRetries.delete(screen);
				logger.error(
					`Stream failed after ${MAX_RETRIES} retries on screen ${screen}, moving to next stream`,
					'PlayerService'
				);
				this.errorCallback?.({
					screen,
					error: `Stream failed after ${MAX_RETRIES} retries`,
					code: -1
				});
			}
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

		// Clear other state
		this.streamStartTimes.delete(screen);
		this.streamRetries.delete(screen);
	}

	/**
	 * Stop a stream that is currently playing on a screen
	 */
	async stopStream(screen: number, force: boolean = false): Promise<boolean> {
		logger.debug(`Stopping stream on screen ${screen}`, 'PlayerService');
		
		const player = this.streams.get(screen);
		if (!player || !player.process) {
			logger.debug(`No player to stop on screen ${screen}`, 'PlayerService');
			// Clean up any resources that might be left even if no player is active
			this.cleanup_after_stop(screen);
			return true; // Nothing to stop, so consider it a success
		}
		
		// Track the stream being terminated so we don't restart it automatically
		this.manuallyClosedScreens.add(screen);

		// Try graceful shutdown via IPC first
		let gracefulShutdown = false;
		try {
			// Send quit command via IPC
			await this.sendMpvCommand(screen, 'quit');
			
			// Give it a moment to shutdown gracefully (increased timeout)
			await new Promise((resolve) => setTimeout(resolve, 1000));
			
			// Check if the process has exited
			gracefulShutdown = !this.isProcessRunning(player.process.pid);
			if (gracefulShutdown) {
				logger.debug(`Graceful shutdown successful for screen ${screen}`, 'PlayerService');
			} else {
				logger.debug(`Graceful shutdown failed for screen ${screen}, will try force kill`, 'PlayerService');
			}
		} catch (error) {
			logger.debug(`IPC command failed for screen ${screen}, will try force kill: ${error instanceof Error ? error.message : String(error)}`, 'PlayerService');
		}
		
		// If not force but graceful shutdown worked, use normal cleanup
		if (gracefulShutdown && !force) {
			this.cleanup_after_stop(screen);
			return true;
		}
		
		// If graceful shutdown failed or force is true, use the forceful method
		try {
			// First, try to find and kill any child processes
			this.killChildProcesses(player.process.pid);
			
			// Now send SIGTERM to the main process
			player.process.kill('SIGTERM');
			
			// Give it a moment to respond to SIGTERM (increased timeout)
			await new Promise((resolve) => setTimeout(resolve, 500));
			
			// Check if we need to force kill with SIGKILL
			if (this.isProcessRunning(player.process.pid)) {
				logger.debug(`SIGTERM didn't work for screen ${screen}, using SIGKILL`, 'PlayerService');
				player.process.kill('SIGKILL');
				
				// Give it a moment for SIGKILL to take effect
				await new Promise((resolve) => setTimeout(resolve, 200));
				
				// If process still exists, try more aggressive approach with system kill command
				if (this.isProcessRunning(player.process.pid)) {
					logger.warn(`Process for screen ${screen} resistant to SIGKILL, using system kill command`, 'PlayerService');
					try {
						execSync(`kill -9 ${player.process.pid}`);
					} catch (error) {
						this.logError(`System kill failed for screen ${screen}`, 'PlayerService', error);
					}
				}
			}
		} catch (error) {
			this.logError(`Error killing process for screen ${screen}`, 'PlayerService', error);
		}
		
		// Clean up regardless of kill success
		this.cleanup_after_stop(screen);
		
		return true;
	}
	
	/**
	 * Kill child processes of a given parent process
	 */
	private killChildProcesses(parentPid?: number): void {
		if (!parentPid) return;
		
		try {
			// Get child processes
			const psOutput = execSync(`ps -o pid --ppid ${parentPid} --no-headers`).toString();
			const childPids = psOutput.trim().split('\n').filter(Boolean).map(pid => parseInt(pid.trim()));
			
			// Kill each child with increasing force
			for (const pid of childPids) {
				if (isNaN(pid)) continue;
				
				try {
					// Try SIGTERM first
					process.kill(pid, 'SIGTERM');
					setTimeout(() => {
						try {
							// Check if still running and use SIGKILL if needed
							if (this.isProcessRunning(pid)) {
								process.kill(pid, 'SIGKILL');
							}
						} catch {
							// Process might already be gone
						}
					}, 300);
				} catch {
					// Process might already be gone
				}
			}
		} catch (error) {
			// Ignore errors, this is a best-effort approach
			logger.debug(`Error killing child processes: ${error instanceof Error ? error.message : String(error)}`, 'PlayerService');
		}
	}
	
	/**
	 * Clean up resources after a stream is stopped
	 */
	private cleanup_after_stop(screen: number): void {
		// Clean up the monitoring interval
		const monitorInterval = this.healthCheckIntervals.get(screen);
		if (monitorInterval) {
			clearInterval(monitorInterval);
			this.healthCheckIntervals.delete(screen);
		}
		
		// Clean up refresh timer
		const refreshTimer = this.streamRefreshTimers.get(screen);
		if (refreshTimer) {
			clearTimeout(refreshTimer);
			this.streamRefreshTimers.delete(screen);
		}
		
		// Clean up inactive timer
		const inactiveTimer = this.inactiveTimers.get(screen);
		if (inactiveTimer) {
			clearTimeout(inactiveTimer);
			this.inactiveTimers.delete(screen);
		}
		
		// Clean up player state
		this.streams.delete(screen);
		this.streamRetries.delete(screen);
		this.streamStartTimes.delete(screen);
		
		// Clean up IPC socket if it exists
		const ipcPath = this.ipcPaths.get(screen);
		if (ipcPath && fs.existsSync(ipcPath)) {
			try {
				fs.unlinkSync(ipcPath);
			} catch (error) {
				logger.debug(`Failed to remove IPC socket ${ipcPath}: ${error instanceof Error ? error.message : String(error)}`, 'PlayerService');
			}
		}
		this.ipcPaths.delete(screen);
		
		logger.debug(`Cleaned up resources for screen ${screen}`, 'PlayerService');
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

	private getMpvArgs(options: StreamOptions & { screen: number }, includeUrl: boolean = true): string[] {
		const screenConfig = this.config.player.screens.find(s => s.screen === options.screen);
		if (!screenConfig) {
			throw new Error(`No screen configuration found for screen ${options.screen}`);
		}

		// Initialize IPC path if not already set
		if (!this.ipcPaths.has(options.screen)) {
			const homedir = process.env.HOME || process.env.USERPROFILE;
			const ipcPath = homedir
				? path.join(homedir, '.livelink', `mpv-ipc-${options.screen}`)
				: `/tmp/mpv-ipc-${options.screen}`;
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
			'--input-ipc-server=' + ipcPath,
			'--config-dir=' + path.join(process.cwd(), 'scripts', 'mpv'),
			'--log-file=' + logFile,
			'--msg-level=all=v',  // Increase logging verbosity
			'--force-window=no',  // Don't create window until we have content
			'--idle=yes',        // Stay open when playlist is empty
			'--geometry=' + `${screenConfig.width}x${screenConfig.height}+${screenConfig.x}+${screenConfig.y}`,
			'--volume=' + (options.volume || 0).toString(),
			'--title=' + `${options.screen}: ${options.title || 'No Title'}`
		);

		if (options.windowMaximized) {
			baseArgs.push('--window-maximized=yes');
		}

		// Add URL if requested
		if (includeUrl && options.url) {
			baseArgs.push(options.url);
		}

		logger.debug(`MPV args for screen ${options.screen}: ${baseArgs.join(' ')}`, 'PlayerService');
		return baseArgs;
	}

	private getStreamlinkArgs(url: string, options: StreamOptions & { screen: number }): string[] {
		const screenConfig = this.config.player.screens.find(s => s.screen === options.screen);
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

		// Properly quote and escape the MPV arguments
		const quotedMpvArgs = mpvArgs
			.map(arg => {
				// If arg already contains quotes, leave it as is
				if (arg.includes('"')) return arg;
				// If arg contains spaces, quote it
				if (arg.includes(' ')) return `"${arg}"`;
				return arg;
			})
			.join(' ');

		// Add player arguments
		streamlinkArgs.push('--player-args', quotedMpvArgs);

		// Add any additional streamlink arguments from config
		if (this.config.streamlink?.args) {
			streamlinkArgs.push(...this.config.streamlink.args);
		}

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
					this.logError(`Failed to send command to screen ${screen}`, 'PlayerService', err);
				}
			});
		} catch (err) {
			this.logError(`Command send error for screen ${screen}`, 'PlayerService', err);
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
			// Stop all streams with force=true to ensure they're killed
			const activeScreens = Array.from(this.streams.keys());
			
			// Attempt graceful shutdown first
			const promises = activeScreens.map((screen) => this.stopStream(screen, false));
			await Promise.allSettled(promises);
			
			// Wait a moment for graceful shutdown to complete
			await new Promise(resolve => setTimeout(resolve, 500));
			
			// Force kill any remaining streams
			const remainingScreens = Array.from(this.streams.keys());
			if (remainingScreens.length > 0) {
				logger.warn(`Forcing shutdown of ${remainingScreens.length} remaining streams`, 'PlayerService');
				const forcePromises = remainingScreens.map((screen) => this.stopStream(screen, true));
				await Promise.allSettled(forcePromises);
			}

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
					this.logError(`Failed to remove IPC socket ${ipcPath}`, 'PlayerService', error);
				}
			});
			
			// Kill any remaining streamlink processes
			try {
				logger.info('Checking for any remaining streamlink processes...', 'PlayerService');
				execSync('pkill -9 streamlink || true');
			} catch {
				// Ignore errors, this is just a precaution
			}
			
			// Reset all state
			this.ipcPaths.clear();
			this.streams.clear();
			this.manuallyClosedScreens.clear();
			this.disabledScreens.clear();
			this.streamRetries.clear();
			this.streamStartTimes.clear();

			logger.info('Player service cleanup complete', 'PlayerService');
		} catch (error) {
			logger.error(
				'Error during player service cleanup',
				'PlayerService',
				error instanceof Error ? error : new Error(String(error))
			);
			// Even if there's an error, try to kill remaining processes
			try {
				execSync('pkill -9 streamlink || true');
				execSync('pkill -9 mpv || true');
			} catch {
				// Ignore errors
			}
			throw error;
		}
	}

	public isRetrying(screen: number): boolean {
		return this.streamRetries.has(screen);
	}

	public disableScreen(screen: number): void {
		this.disabledScreens.add(screen);
	}

	public enableScreen(screen: number): void {
		this.disabledScreens.delete(screen);
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
	private async sendMpvCommand(screen: number, command: string): Promise<void> {
		const ipcPath = this.ipcPaths.get(screen);
		logger.info(`Sending command ${command} to screen ${screen} with IPC path ${ipcPath}`, 'PlayerService');
		if (!ipcPath) {
			logger.warn(`No IPC path found for screen ${screen}`, 'PlayerService');
			throw new Error(`No IPC socket for screen ${screen}`);
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
						this.logError(`Failed to send command to screen ${screen}`, 'PlayerService', err);
						reject(err);
					}
				});

				socket.on('timeout', () => {
					if (!hasResponded) {
						hasResponded = true;
						socket.destroy();
						logger.error(`Command send timeout for screen ${screen}`, 'PlayerService');
						reject(new Error('Socket timeout'));
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
				this.logError(`Command send error for screen ${screen}`, 'PlayerService', err instanceof Error ? err : String(err));
				reject(err);
			}
		});
	}

	private logError(message: string, service: string, error: unknown): void {
		if (error instanceof Error) {
			logger.error(message, service, error);
		} else {
			logger.error(message, service, new Error(String(error)));
		}
	}
}
