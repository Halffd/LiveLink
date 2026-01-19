/**
 * Release function returned by acquire().
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
	private acquireTime = 0;
	private lastOperation = '';
	private readonly MAX_LOCK_TIME = 30000; // ms
	private lockCheckInterval: NodeJS.Timeout;
	private logger: Logger;
	private context: string;

	// Pending waiters
	private waitQueue: Array<{ owner: string; resolve: (release: Release) => void; reject: (err: Error) => void; timeout: NodeJS.Timeout; }> = [];

	constructor(logger: Logger = defaultLogger, context = 'SimpleMutex') {
		this.logger = logger;
		this.context = context;
		this.lockCheckInterval = setInterval(() => this.checkStuckLock(), this.MAX_LOCK_TIME / 3);
	}

	/**
	 * Periodically checks for locks held too long and force-releases them.
	 */
	private checkStuckLock() {
		if (!this.locked) return;
		const duration = Date.now() - this.acquireTime;
		if (duration > this.MAX_LOCK_TIME) {
			this.logger.warn(
				`[MUTEX] Lock held by ${this.owner} for ${duration}ms during ${this.lastOperation} - forcing release`,
				this.context
			);
			this.forceRelease();
		}
	}

	/**
	 * Forcefully releases the current lock and wakes the next waiter.
	 */
	private forceRelease(): void {
		this.locked = false;
		this.owner = null;
		this.acquireTime = 0;
		const previousOperation = this.lastOperation;
		this.lastOperation = '';
		this.logger.warn(`[MUTEX] Force releasing stale lock from ${previousOperation}`, this.context);
		this.wakeNext();
	}

	/**
	 * Acquire the lock, waiting up to `timeout` ms. Returns a release callback.
	 */
	acquire(timeout = 15000, owner = 'unknown', operation = 'unknown'): Promise<Release> {
		this.lastOperation = operation;

		// Immediate acquire
		if (!this.locked) {
			this.locked = true;
			this.owner = owner;
			this.acquireTime = Date.now();
			this.logger.debug(`Lock acquired by ${owner} for ${operation}`, this.context);
			return Promise.resolve(this.makeReleaser(owner));
		}

		// Otherwise queue
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				// remove self
				this.waitQueue = this.waitQueue.filter(w => w.resolve !== resolve);
				// force release stale if needed
				if (this.locked && Date.now() - this.acquireTime > this.MAX_LOCK_TIME) {
					this.logger.warn(
						`[MUTEX] Stale lock - forcing release in acquire timeout by ${owner}`,
						this.context
					);
					this.forceRelease();
				}
				const heldBy = this.locked ? this.owner : 'none';
				reject(new Error(`Mutex acquire timeout after ${timeout}ms - lock held by ${heldBy}`));
			}, timeout);

			this.waitQueue.push({ owner, resolve, reject, timeout: timer });
		});
	}

	/**
	 * Create a release function bound to `owner`.
	 */
	private makeReleaser(owner: string): Release {
		let released = false;
		return () => {
			if (released) return;
			released = true;
			if (this.owner !== owner) {
				this.logger.warn(`Release by non-owner ${owner}, ignoring`, this.context);
				return;
			}
			this.locked = false;
			this.owner = null;
			this.acquireTime = 0;
			this.lastOperation = '';
			this.logger.debug(`Lock released by ${owner}`, this.context);
			this.wakeNext();
		};
	}

	/**
	 * Wake the next waiter if any.
	 */
	private wakeNext() {
		if (this.locked || this.waitQueue.length === 0) return;
		const { owner, resolve, timeout } = this.waitQueue.shift()!;
		clearTimeout(timeout);
		this.locked = true;
		this.owner = owner;
		this.acquireTime = Date.now();
		resolve(this.makeReleaser(owner));
	}

	/**
	 * Check if locked.
	 */
	isLocked(): boolean { return this.locked; }

	/**
	 * Cleanup intervals and pending waiters.
	 */
	dispose() {
		clearInterval(this.lockCheckInterval);
		this.waitQueue.forEach(({ timeout, reject }) => {
			clearTimeout(timeout);
			reject(new Error('Mutex disposed'));
		});
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
