import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import type { StreamOptions } from '../../types/stream.js';
import type {
	StreamInstance,
	StreamOutput,
	StreamError,
	StreamResponse
} from '../../types/stream_instance.js';
import { logger } from '../services/logger/index.js';
import { loadAllConfigs } from '../../config/loader.js';
import { exec } from 'child_process';
import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

// Get the directory name equivalent to __dirname in CommonJS
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load static configs
const mpvConfig = JSON.parse(
	fs.readFileSync(path.resolve(__dirname, '../../../config', 'mpv.json'), 'utf-8')
);
const streamlinkConfig = JSON.parse(
	fs.readFileSync(path.resolve(__dirname, '../../../config', 'streamlink.json'), 'utf-8')
);

export class PlayerService {
	private readonly BASE_LOG_DIR: string;
	private readonly MAX_RETRIES = 2;
	private readonly RETRY_INTERVAL = 500;
	private readonly STREAM_REFRESH_INTERVAL = 4 * 60 * 60 * 1000; // 4 hours
	private readonly INACTIVE_RESET_TIMEOUT = 5 * 60 * 1000; // 5 minutes
	private readonly STARTUP_TIMEOUT = 600000; // 10 minutes
	private readonly SHUTDOWN_TIMEOUT = 100; // 1 second (reduced from 5 seconds)

	private streams: Map<number, StreamInstance> = new Map();
	private streamRetries: Map<number, number> = new Map();
	private streamStartTimes: Map<number, number> = new Map();
	private streamRefreshTimers: Map<number, NodeJS.Timeout> = new Map();
	private inactiveTimers: Map<number, NodeJS.Timeout> = new Map();
	private healthCheckIntervals: Map<number, NodeJS.Timeout> = new Map();
	private startupLocks: Map<number, boolean> = new Map();
	private manuallyClosedScreens: Set<number> = new Set();
	private disabledScreens: Set<number> = new Set();
	private ipcPaths: Map<number, string> = new Map();

	private config = loadAllConfigs();
	private mpvPath: string;
	private isShuttingDown = false;
	private events = new EventEmitter();
	private outputCallback?: (data: StreamOutput) => void;
	private errorCallback?: (data: StreamError) => void;

	constructor() {
		this.BASE_LOG_DIR = path.join(process.cwd(), 'logs');
		this.mpvPath = this.findMpvPath();
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
			const instance: StreamInstance = {
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
						: options.startTime
			};

			// Store stream instance
			this.streams.set(screen, instance);

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
					error instanceof Error ? error : new Error(String(error))
				);
			}
		}

		// Clear any existing state
		this.clearMonitoring(options.screen);
		this.streams.delete(options.screen);

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
		if (process.stdout) {
			process.stdout.on('data', (data: Buffer) => {
				const output = data.toString('utf8').trim();
				if (output && /[\x20-\x7E]/.test(output)) {
					logger.debug(`[Screen ${screen}] ${output}`, 'PlayerService');
					this.outputCallback?.({
						screen,
						data: output,
						type: 'stdout'
					});

					// Check for user quit signals in the output
					if (
						output.includes('Exiting... (Quit)') ||
						output.includes('Exiting normally') ||
						output.includes('Quit') ||
						output.includes('User stopped playback')
					) {
						logger.info(`Detected user quit in output for screen ${screen}`, 'PlayerService');
						// Mark as manually closed to prevent auto-restart of the same stream
						this.manuallyClosedScreens.delete(screen);
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
						logger.error(`[Screen ${screen}] ${output}`, 'PlayerService');
						this.errorCallback?.({
							screen,
							error: output
						});
					}
				}
			});
		}

		process.on('error', (err: Error) => {
			const errorMessage = err.message;
			logger.error(`Process error on screen ${screen}`, 'PlayerService', errorMessage);
			this.errorCallback?.({
				screen,
				error: errorMessage,
				code: -1
			});
		});

		process.on('exit', (code: number | null) => {
			logger.info(`Process exited on screen ${screen} with code ${code}`, 'PlayerService');
			this.handleProcessExit(screen, code);
		});
	}

	private setupStreamMonitoring(
		screen: number,
		process: ChildProcess,
		options: StreamOptions
	): void {
		// Setup health check
		const healthCheck = setInterval(() => {
			try {
				process.kill(0); // Check if process is responding
			} catch {
				logger.warn(`Stream on screen ${screen} appears to be unresponsive`, 'PlayerService');
				this.restartStream(screen, options).catch((err) => {
					logger.error(
						`Failed to restart unresponsive stream on screen ${screen}`,
						'PlayerService',
						err
					);
				});
			}
		}, 60000);

		this.healthCheckIntervals.set(screen, healthCheck);

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
		await this.stopStream(screen);
		await new Promise((resolve) => setTimeout(resolve, 100));
		await this.startStream({ ...options, screen });
	}

	private handleProcessExit(screen: number, code: number | null): void {
		// Clear monitoring
		this.clearMonitoring(screen);

		// Get the stream before removing it
		const stream = this.streams.get(screen);

		// Remove stream instance
		this.streams.delete(screen);

		// Don't retry or trigger next stream if manually closed
		if (this.manuallyClosedScreens.has(screen)) {
			logger.info(`Screen ${screen} was manually closed`, 'PlayerService');
			this.streamRetries.delete(screen); // Reset retry counter for manually closed screens
		}

		// Handle non-zero exit
		if (code !== 0 && code !== null) {
			// Handle SIGINT (130), SIGTERM (143), and SIGQUIT (131) as normal exits - these are typically user-initiated
			if (code === 130 || code === 143 || code === 131) {
				logger.info(
					`Stream on screen ${screen} was terminated with code ${code}, treating as normal exit and moving to next stream`,
					'PlayerService'
				);
				this.streamRetries.delete(screen);
				// Signal to move to next stream
				this.errorCallback?.({
					screen,
					error: 'Stream ended by user',
					code: 0 // Use code 0 to indicate normal exit
				});
				return;
			}

			const retryCount = this.streamRetries.get(screen) || 0;
			if (retryCount < this.MAX_RETRIES) {
				const delay = this.RETRY_INTERVAL * Math.pow(2, retryCount);
				this.streamRetries.set(screen, retryCount + 1);

				logger.info(
					`Stream crashed on screen ${screen}, retry ${retryCount + 1}/${this.MAX_RETRIES} in ${delay / 1000}s`,
					'PlayerService'
				);

				setTimeout(() => {
					if (stream) {
						this.restartStream(screen, stream).catch((error) => {
							logger.error(`Failed to restart stream on screen ${screen}`, 'PlayerService', error);
						});
					}
				}, delay);
			} else {
				logger.error(`Max retries reached for screen ${screen}`, 'PlayerService');
				this.streamRetries.delete(screen);
				this.errorCallback?.({
					screen,
					error: 'Max retries reached',
					code: -1
				});
			}
		} else {
			// Stream ended normally or player closed, reset retry counter and trigger next stream
			this.streamRetries.delete(screen);
			logger.info(
				`Stream ended normally on screen ${screen}, triggering next stream`,
				'PlayerService'
			);
			this.errorCallback?.({
				screen,
				error: 'Stream ended',
				code: 0
			});
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

	async stopStream(screen: number, isManualStop: boolean = false): Promise<boolean> {
		const stream = this.streams.get(screen);
		if (!stream) return false;

		try {
			if (isManualStop) {
				this.manuallyClosedScreens.add(screen);
			}

			// Stop the process
			if (stream.process) {
				try {
					// Try graceful shutdown first
					stream.process.kill('SIGTERM');

					// Force kill after timeout
					await Promise.race([
						new Promise<void>((resolve) => {
							stream.process?.once('exit', () => resolve());
						}),
						new Promise<void>((_, reject) => {
							setTimeout(() => {
								try {
									stream.process?.kill('SIGKILL');
								} catch {
									// Process might already be gone
								}
								reject(new Error('Process kill timeout'));
							}, this.SHUTDOWN_TIMEOUT);
						})
					]);
				} catch (error) {
					logger.warn(
						`Error stopping process on screen ${screen}`,
						'PlayerService',
						error instanceof Error ? error : new Error(String(error))
					);
				}
			}

			// Clear monitoring and state
			this.clearMonitoring(screen);
			this.streams.delete(screen);

			// Clean up IPC socket
			const ipcPath = this.ipcPaths.get(screen);
			if (ipcPath && fs.existsSync(ipcPath)) {
				try {
					fs.unlinkSync(ipcPath);
				} catch (error) {
					logger.warn(
						`Failed to remove IPC socket for screen ${screen}`,
						'PlayerService',
						error instanceof Error ? error : new Error(String(error))
					);
				}
			}
			this.ipcPaths.delete(screen);

			return true;
		} catch (error) {
			logger.error(
				`Failed to stop stream on screen ${screen}`,
				'PlayerService',
				error instanceof Error ? error : new Error(String(error))
			);
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

		// Convert mpvConfig object to arguments array
		const staticArgs = Object.entries(mpvConfig)
			.map(([key, value]) => {
				if (typeof value === 'boolean') {
					return value ? `--${key}` : undefined;
				}
				return `--${key}=${value}`;
			})
			.filter((arg): arg is string => arg !== undefined);

		// Get stream metadata for title
		const streamTitle = options.title || 'Unknown Title';
		const viewerCount =
			options.viewerCount !== undefined ? `${options.viewerCount} viewers` : 'Unknown viewers';

		// Sanitize title components to avoid issues with shell escaping
		const sanitizedTitle = streamTitle.replace(/['"]/g, '');

		// Format the title without quotes in the argument
		// eslint-disable-next-line no-useless-escape
		const titleArg = `--title=\\\"${sanitizedTitle} - ${viewerCount} - Screen ${options.screen}\\\"`;

		// Dynamic arguments that depend on runtime values
		const dynamicArgs = [
			options.url,
			`--input-ipc-server=${ipcPath}`,
			`--log-file=${logFile}`,
			`--volume=${options.volume !== undefined ? options.volume : screenConfig.volume !== undefined ? screenConfig.volume : this.config.player.defaultVolume}`,
			`--geometry=${screenConfig.width}x${screenConfig.height}+${screenConfig.x}+${screenConfig.y}`,
			titleArg,
			...(options.windowMaximized || screenConfig.windowMaximized ? ['--window-maximized=yes'] : [])
		];

		// Combine static and dynamic arguments
		return [...staticArgs, ...dynamicArgs];
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
		// Sanitize title components to avoid issues with shell escaping
		const sanitizedTitle = streamTitle.replace(/['"]/g, '');

		// Format the title without quotes in the argument
		// eslint-disable-next-line no-useless-escape
		const titleArg = `--title=\\\"${sanitizedTitle} - ${viewerCount} - Screen ${options.screen}\\\"`;

		// Build MPV player arguments in a more organized way
		const mpvArgs = [
			// Basic window setup
			titleArg,
			`--geometry=${screenConfig.width}x${screenConfig.height}+${screenConfig.x}+${screenConfig.y}`,
			screenConfig.windowMaximized ? '--window-maximized=yes' : '',

			// Audio settings
			`--volume=${screenConfig.volume !== undefined ? screenConfig.volume : this.config.player.defaultVolume}`,

			// IPC and logging
			`--input-ipc-server=${ipcPath}`,
			`--log-file=${logFile}`
		].filter(Boolean);

		// Convert streamlink config options to command line arguments
		const streamlinkArgs = Object.entries(streamlinkConfig.options)
			.map(([key, value]): string | undefined => {
				if (typeof value === 'boolean') {
					return value ? `--${key}` : undefined;
				}
				return `--${key}=${value}`;
			})
			.filter((arg): arg is string => arg !== undefined);

		// Properly escape the player args for the shell
		const escapedMpvArgs = mpvArgs.map((arg) => arg.replace(/"/g, '\\"')).join(' ');

		// Return streamlink arguments in proper order:
		// 1. URL and quality
		// 2. Streamlink-specific options
		// 3. Player command and args
		return [
			url,
			'best',
			...streamlinkArgs,
			`--player=${this.mpvPath}`,
			`--player-args=${escapedMpvArgs}`
		];
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
					logger.error(`Failed to send command to screen ${screen}`, 'PlayerService', err);
				}
			});
		} catch (err) {
			if (err instanceof Error) {
				logger.error(`Command send error for screen ${screen}`, 'PlayerService', err);
			}
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
			this.manuallyClosedScreens.clear();
			this.disabledScreens.clear();

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
		const enabledScreens = this.config.player.screens.filter((s) => s.enabled);

		for (const screen of enabledScreens) {
			const isPlayerRunning = this.getActiveStreams().some((s) => s.screen === screen.screen);
			if (!isPlayerRunning) {
				try {
					await this.startStream({
						url: 'about:blank',
						screen: screen.screen,
						quality: screen.quality || this.config.player.defaultQuality,
						volume: screen.volume !== undefined ? screen.volume : this.config.player.defaultVolume,
						windowMaximized:
							screen.windowMaximized !== undefined
								? screen.windowMaximized
								: this.config.player.windowMaximized
					});
					logger.info(`Started player for screen ${screen.screen}`, 'PlayerService');
				} catch (error) {
					logger.error(
						`Failed to start player for screen ${screen.screen}`,
						'PlayerService',
						error instanceof Error ? error : new Error(String(error))
					);
				}
			}
		}
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
}
