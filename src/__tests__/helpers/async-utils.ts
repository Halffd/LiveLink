/**
 * Async testing utilities for handling race conditions and timing-based tests
 */

/**
 * Creates a promise that resolves after the specified time
 * @param ms Time to wait in milliseconds
 */
export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Creates a deferred promise that can be resolved or rejected externally
 */
export function createDeferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: any) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: any) => void;
  
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  
  return { promise, resolve, reject };
}

/**
 * Executes multiple promises with controlled timing
 * @param tasks Array of functions that return promises
 * @param delayBetweenTasks Delay between starting each task in milliseconds
 */
export async function executeWithDelay<T>(
  tasks: Array<() => Promise<T>>,
  delayBetweenTasks: number
): Promise<T[]> {
  const results: T[] = [];
  
  for (const task of tasks) {
    const promise = task();
    results.push(await promise);
    
    if (delayBetweenTasks > 0 && tasks.indexOf(task) < tasks.length - 1) {
      await delay(delayBetweenTasks);
    }
  }
  
  return results;
}

/**
 * Executes tasks in parallel with a controlled start time
 * @param tasks Array of functions that return promises
 * @param staggerMs Milliseconds to stagger the start of each task
 */
export async function executeStaggered<T>(
  tasks: Array<() => Promise<T>>,
  staggerMs: number = 10
): Promise<T[]> {
  const promises: Promise<T>[] = [];
  
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const taskPromise = delay(i * staggerMs).then(() => task());
    promises.push(taskPromise);
  }
  
  return Promise.all(promises);
}

/**
 * Retries a function until it succeeds or reaches max attempts
 * @param fn Function to retry
 * @param maxAttempts Maximum number of attempts
 * @param delayMs Delay between attempts in milliseconds
 */
export async function retry<T>(
  fn: () => Promise<T>,
  maxAttempts: number = 3,
  delayMs: number = 100
): Promise<T> {
  let lastError: any;
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        await delay(delayMs);
      }
    }
  }
  
  throw lastError;
}

/**
 * Creates a promise that times out after the specified duration
 * @param promise Promise to wrap with timeout
 * @param timeoutMs Timeout duration in milliseconds
 * @param errorMessage Custom error message for timeout
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorMessage: string = `Operation timed out after ${timeoutMs}ms`
): Promise<T> {
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
  });
  
  return Promise.race([promise, timeoutPromise]);
}

/**
 * Tracks the order of async operations for race condition testing
 */
export class ExecutionTracker {
  private events: Array<{ name: string; timestamp: number }> = [];
  
  /**
   * Records an event with the current timestamp
   * @param name Event name
   */
  record(name: string): void {
    this.events.push({ name, timestamp: Date.now() });
  }
  
  /**
   * Gets the recorded events in order
   */
  getEvents(): string[] {
    return this.events
      .sort((a, b) => a.timestamp - b.timestamp)
      .map(event => event.name);
  }
  
  /**
   * Clears all recorded events
   */
  clear(): void {
    this.events = [];
  }
  
  /**
   * Verifies events occurred in the expected order
   * @param expectedOrder Expected order of events
   * @returns True if events match expected order
   */
  verifyOrder(expectedOrder: string[]): boolean {
    const actualOrder = this.getEvents();
    
    if (actualOrder.length !== expectedOrder.length) {
      return false;
    }
    
    return expectedOrder.every((event, index) => event === actualOrder[index]);
  }
}
