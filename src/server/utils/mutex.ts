/**
 * Release function returned by acquire()/tryAcquire().
 */
export type Release = () => void;

/**
 * Basic logger interface. Defaults to console methods.
 */
export interface Logger {
	debug(message: string, context?: string): void;
	info(message: string, context?: string): void;
	warn(message: string, context?: string): void;
	error(message: string, context?: string): void;
}

const defaultLogger: Logger = {
	debug: (msg, ctx) => console.debug(`[${ctx ?? 'Mutex'}] ${msg}`),
	info:  (msg, ctx) => console.info(`[${ctx ?? 'Mutex'}] ${msg}`),
	warn:  (msg, ctx) => console.warn(`[${ctx ?? 'Mutex'}] ${msg}`),
	error: (msg, ctx) => console.error(`[${ctx ?? 'Mutex'}] ${msg}`),
};

/**
 * A simple non-reentrant mutex. One waiter queue.
 */
export class SimpleMutex {
	private locked = false;
	private waitQueue: Array<() => void> = [];
	private logger: Logger;
	private context: string;
	private lockAcquiredTime: number | null = null;
	private lockOwner: string | null = null;
	private maxLockTime = 30000; // 30 seconds max lock time
	private healthCheckInterval: NodeJS.Timeout | null = null;

	constructor(logger: Logger = defaultLogger, context = 'SimpleMutex') {
		this.logger = logger;
		this.context = context;

		// Start health check to prevent eternal locks
		this.healthCheckInterval = setInterval(() => this.checkLockHealth(), 10000);
	}

	/**
	 * Acquire the lock, waiting if necessary.
	 * @param timeout - Time to wait for lock
	 * @param owner - Identifier for debugging who holds the lock
	 * @returns a release function.
	 */
	async acquire(timeout = 15000, owner = 'unknown'): Promise<Release> {
		this.logger.debug(`Attempting acquire() by ${owner}`, this.context);

		// If not locked, acquire immediately
		if (!this.locked) {
			this.locked = true;
			this.lockAcquiredTime = Date.now();
			this.lockOwner = owner;
			this.logger.debug(`Lock acquired immediately by ${owner}`, this.context);
			return this.makeReleaser(owner);
		}

		// Otherwise, queue with timeout
		this.logger.debug(`Lock busy (held by ${this.lockOwner}), queuing caller ${owner}`, this.context);

		return new Promise<Release>((resolve, reject) => {
			// Track if this request has been canceled by timeout
			let isCanceled = false;

			// Set timeout to prevent infinite waiting
			const timeoutId = setTimeout(() => {
				isCanceled = true;

				// If lock has been held too long, force release it
				if (this.lockAcquiredTime && (Date.now() - this.lockAcquiredTime > this.maxLockTime)) {
					this.logger.warn(`Lock timeout - FORCE RELEASING lock held by ${this.lockOwner} for ${Date.now() - this.lockAcquiredTime}ms`, this.context);
					this.forceRelease();
				}

				reject(new Error(`Mutex acquire timeout after ${timeout}ms - lock held by ${this.lockOwner}`));
			}, timeout);

			// Add to wait queue
			this.waitQueue.push(() => {
				// Skip executing if this request timed out
				if (isCanceled) {
					// Just pass through to the next waiter
					return;
				}

				clearTimeout(timeoutId);
				this.locked = true;
				this.lockAcquiredTime = Date.now();
				this.lockOwner = owner;
				this.logger.debug(`Lock acquired from queue by ${owner}`, this.context);
				resolve(this.makeReleaser(owner));
			});
		});
	}

	/**
	 * Try to acquire without waiting.
	 * @param owner - Identifier for debugging
	 * @returns release function if acquired, else null.
	 */
	tryAcquire(owner = 'unknown'): Release | null {
		this.logger.debug(`Attempting tryAcquire() by ${owner}`, this.context);
		if (!this.locked) {
			this.locked = true;
			this.lockAcquiredTime = Date.now();
			this.lockOwner = owner;
			this.logger.debug(`Lock acquired via tryAcquire() by ${owner}`, this.context);
			return this.makeReleaser(owner);
		}
		this.logger.debug(`tryAcquire() by ${owner} failed, lock busy (held by ${this.lockOwner})`, this.context);
		return null;
	}

	/**
	 * Check if currently locked.
	 */
	isLocked(): boolean {
		return this.locked;
	}

	/**
	 * Number of waiters in queue.
	 */
	getQueueLength(): number {
		return this.waitQueue.length;
	}

	/**
	 * Get the duration the current lock has been held, in ms
	 */
	getLockDuration(): number {
		if (!this.lockAcquiredTime) return 0;
		return Date.now() - this.lockAcquiredTime;
	}

	/**
	 * Force release the lock in emergency situations
	 */
	forceRelease(): void {
		this.logger.warn(`FORCE RELEASING lock held by ${this.lockOwner} for ${this.getLockDuration()}ms`, this.context);
		this.locked = false;
		this.lockAcquiredTime = null;
		this.lockOwner = null;

		// If there are waiters, let the next one proceed
		if (this.waitQueue.length > 0) {
			const next = this.waitQueue.shift()!;
			setImmediate(() => {
				try {
					next();
				} catch (err) {
					this.logger.error(`Error in queued releaser after force: ${err}`, this.context);
				}
			});
		}
	}

	/**
	 * Periodically check lock health
	 */
	private checkLockHealth(): void {
		if (this.locked && this.lockAcquiredTime && (Date.now() - this.lockAcquiredTime > this.maxLockTime)) {
			this.logger.warn(`Health check - Lock held by ${this.lockOwner} for ${Date.now() - this.lockAcquiredTime}ms exceeds max time, force releasing`, this.context);
			this.forceRelease();
		}
	}

	private makeReleaser(owner: string): Release {
		let released = false;
		return () => {
			if (released) {
				this.logger.error(`Release called multiple times by ${owner}`, this.context);
				throw new Error('Mutex release called twice');
			}
			released = true;
			this.logger.debug(`Releasing lock held by ${owner}`, this.context);

			if (this.waitQueue.length > 0) {
				const next = this.waitQueue.shift()!;
				// Schedule next unlock to avoid deep recursion
				setImmediate(() => {
					try {
						next();
					} catch (err) {
						this.logger.error(`Error in queued releaser: ${err}`, this.context);
					}
				});
			} else {
				this.locked = false;
				this.lockAcquiredTime = null;
				this.lockOwner = null;
				this.logger.debug(`Lock fully released by ${owner}`, this.context);
			}
		};
	}

	/**
	 * Clean up resources
	 */
	dispose(): void {
		if (this.healthCheckInterval) {
			clearInterval(this.healthCheckInterval);
			this.healthCheckInterval = null;
		}
	}
}
/**
 * A reentrant mutex implementation.
 * The same async context can acquire multiple times without deadlock.
 */
export class ReentrantMutex {
	private ownerId = 0;
	private lockCount = 0;
	private queue: Array<() => void> = [];
	private logger: Logger;
	private context: string;

	private static nextId = 1;

	constructor(logger: Logger = defaultLogger, context = 'ReentrantMutex') {
		this.logger = logger;
		this.context = context;
	}

	/**
	 * Acquire the lock, reentrantly if already owner.
	 * @returns a release function.
	 */
	async acquire(): Promise<Release> {
		const myId = ReentrantMutex.nextId++;
		this.logger.info(`Attempting acquire() id=${myId}`, this.context);

		if (this.ownerId === 0) {
			// No owner
			this.ownerId = myId;
			this.lockCount = 1;
			this.logger.debug(`Lock acquired id=${myId}`, this.context);
			return this.makeReleaser(myId);
		}

		if (this.ownerId === myId) {
			// Reentrant
			this.lockCount++;
			this.logger.debug(`Reentrant acquire id=${myId}, count=${this.lockCount}`, this.context);
			return this.makeReleaser(myId);
		}

		// Otherwise, queue
		this.logger.debug(`Lock busy, queuing id=${myId}`, this.context);
		return new Promise<Release>((resolve) => {
			this.queue.push(() => {
				this.ownerId = myId;
				this.lockCount = 1;
				this.logger.debug(`Lock acquired from queue id=${myId}`, this.context);
				resolve(this.makeReleaser(myId));
			});
		});
	}

	/**
	 * Try to acquire without waiting.
	 * @returns release function if acquired, else null.
	 */
	tryAcquire(): Release | null {
		const myId = ReentrantMutex.nextId++;
		this.logger.debug(`Attempting tryAcquire() id=${myId}`, this.context);

		if (this.ownerId === 0 || this.ownerId === myId) {
			// Acquire or reentrant
			this.ownerId = myId;
			this.lockCount++;
			this.logger.debug(`tryAcquire success id=${myId}, count=${this.lockCount}`, this.context);
			return this.makeReleaser(myId);
		}

		this.logger.debug(`tryAcquire failed id=${myId}, owner=${this.ownerId}`, this.context);
		return null;
	}

	/**
	 * Check if currently locked.
	 */
	isLocked(): boolean {
		return this.ownerId !== 0;
	}

	/**
	 * Number of times current owner has reentered.
	 */
	getLockCount(): number {
		return this.lockCount;
	}

	/**
	 * Number of waiters in queue.
	 */
	getQueueLength(): number {
		return this.queue.length;
	}

	private makeReleaser(myId: number): Release {
		let released = false;
		return () => {
			if (released) {
				this.logger.error(`Release called twice id=${myId}`, this.context);
				throw new Error('Mutex release called twice');
			}
			if (this.ownerId !== myId) {
				this.logger.error(`Non-owner release attempt id=${myId}, owner=${this.ownerId}`, this.context);
				throw new Error('Mutex released by non-owner');
			}
			released = true;
			this.lockCount--;
			this.logger.debug(`Releasing id=${myId}, count=${this.lockCount}`, this.context);

			if (this.lockCount === 0) {
				// Fully released
				this.ownerId = 0;
				this.logger.debug(`Lock fully released id=${myId}`, this.context);
				const next = this.queue.shift();
				if (next) {
					setImmediate(() => {
						try {
							next();
						} catch (err) {
							this.logger.error(`Error in queued releaser: ${err}`, this.context);
						}
					});
				}
			}
		};
	}
}
