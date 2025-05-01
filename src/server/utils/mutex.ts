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
 * A simple non-reentrant mutex with FIFO queue and timeouts.
 */
export class SimpleMutex {
	private locked = false;
	private owner: string | null = null;
	private acquireTime: number = 0;
	private lastOperation: string = '';
	private readonly MAX_LOCK_TIME = 30000; // 30 seconds max lock time
	private lockCheckInterval: NodeJS.Timeout | null = null;
	private logger: Logger;
	private context: string;
	private waking = false; // Flag to prevent concurrent wake operations
	private nextWaiterId = 0; // Counter for unique waiter IDs

	// Queue of pending waiters
	private waitQueue: Array<{
		resolve: (release: Release) => void;
		reject: (error: Error) => void;
		owner: string;
		waiterId: number; // Unique ID for each waiter
		timeout: NodeJS.Timeout;
	}> = [];

	constructor(logger: Logger = defaultLogger, context = 'SimpleMutex') {
		this.logger = logger;
		this.context = context;

		// Start periodic check for stuck locks
		this.lockCheckInterval = setInterval(() => {
			this.checkStuckLock();
		}, 5000);
	}

	private checkStuckLock() {
		if (!this.locked) return;

		const duration = this.getLockDuration();
		if (duration > this.MAX_LOCK_TIME) {
			this.logger.warn(
				`[MUTEX] Lock held for ${duration}ms by ${this.owner} during ${this.lastOperation}. ` +
				'Possible causes: deadlock, infinite loop, or crashed operation. ' +
				'Check recent errors in logs and consider increasing timeout if needed.',
				this.context
			);
			this.forceRelease();
		}
	}

	private forceRelease() {
		const duration = this.getLockDuration();
		this.logger.warn(
			`[MUTEX] Force releasing lock held by ${this.owner} for ${duration}ms during ${this.lastOperation}`,
			this.context
		);

		this.locked = false;
		this.owner = null;
		this.acquireTime = 0;
		this.lastOperation = '';

		// Wake up next waiter if any
		this.wakeNextWaiter();
	}

	private async wakeNextWaiter() {
		if (this.waking || this.locked || this.waitQueue.length === 0) return;
		
		this.waking = true;
		try {
			const next = this.waitQueue.shift();
			if (!next) return;

			// Clear their timeout since we're processing them now
			clearTimeout(next.timeout);

			this.locked = true;
			this.owner = next.owner;
			this.acquireTime = Date.now();

			const release = this.makeReleaser(next.owner);
			next.resolve(release);
		} catch (error) {
			this.logger.error(`Error waking next waiter: ${error}`, this.context);
			// Try next waiter
			setImmediate(() => this.wakeNextWaiter());
		} finally {
			this.waking = false;
		}
	}

	/**
	 * Acquire the lock with FIFO queuing.
	 * @param timeout - Time to wait for lock
	 * @param owner - Identifier for debugging who holds the lock
	 * @param operation - Description of the operation being performed
	 * @returns a release function.
	 */
	async acquire(timeout: number = 15000, owner: string = 'unknown', operation: string = 'unknown'): Promise<Release> {
		// If not locked, acquire immediately
		if (!this.locked) {
			this.locked = true;
			this.owner = owner;
			this.acquireTime = Date.now();
			this.lastOperation = operation;
			this.logger.debug(`Lock acquired immediately by ${owner} for ${operation}`, this.context);
			return this.makeReleaser(owner);
		}

		// Otherwise queue with timeout
		this.logger.debug(
			`Lock busy (held by ${this.owner} for ${this.lastOperation}), queuing ${owner} for ${operation}`,
			this.context
		);

		return new Promise<Release>((resolve, reject) => {
			const waiterId = ++this.nextWaiterId;

			// Create timeout for this waiter
			const timeoutId = setTimeout(() => {
				// Remove self from queue by waiterId instead of owner
				const index = this.waitQueue.findIndex(w => w.waiterId === waiterId);
				if (index !== -1) {
					this.waitQueue.splice(index, 1);
				}

				// If lock has been held too long, force release it
				if (this.getLockDuration() > this.MAX_LOCK_TIME) {
					this.logger.warn(
						`Lock timeout - forcing release of lock held by ${this.owner} for ${this.lastOperation}`,
						this.context
					);
					this.forceRelease();
				}

				reject(new Error(
					`Mutex acquire timeout after ${timeout}ms - lock held by ${this.owner} for ${this.lastOperation}`
				));
			}, timeout);

			// Add to wait queue with unique ID
			this.waitQueue.push({
				resolve,
				reject,
				owner,
				waiterId,
				timeout: timeoutId
			});
		});
	}

	private makeReleaser(owner: string): Release {
		let released = false;
		return () => {
			if (released) {
				this.logger.error(`Release called multiple times by ${owner}`, this.context);
				throw new Error('Mutex release called twice');
			}

			if (this.owner !== owner) {
				this.logger.error(
					`Non-owner release attempt by ${owner}, current owner is ${this.owner}`,
					this.context
				);
				throw new Error('Mutex released by non-owner');
			}

			released = true;
			this.locked = false;
			this.owner = null;
			this.acquireTime = 0;
			this.lastOperation = '';

			this.logger.debug(`Lock released by ${owner}`, this.context);

			// Wake up next waiter if any
			this.wakeNextWaiter();
		};
	}

	isLocked(): boolean {
		return this.locked;
	}

	getOwner(): string | null {
		return this.owner;
	}

	getLockDuration(): number {
		if (!this.locked) return 0;
		return Date.now() - this.acquireTime;
	}

	getQueueLength(): number {
		return this.waitQueue.length;
	}

	getLastOperation(): string {
		return this.lastOperation;
	}

	/**
	 * Clean up resources
	 */
	dispose(): void {
		if (this.lockCheckInterval) {
			clearInterval(this.lockCheckInterval);
			this.lockCheckInterval = null;
		}

		// Clear any pending waiters
		for (const waiter of this.waitQueue) {
			clearTimeout(waiter.timeout);
			waiter.reject(new Error('Mutex disposed'));
		}
		this.waitQueue = [];
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
