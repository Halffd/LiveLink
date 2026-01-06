import { logger } from '../services/logger.js';

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

export async function withPromiseTimeout<T>(promise: Promise<T>, ms: number, errorMessage: string = `Promise timed out after ${ms} ms`): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new TimeoutError(errorMessage));
    }, ms);

    promise.then(
      (res) => {
        clearTimeout(timeoutId);
        resolve(res);
      },
      (err) => {
        clearTimeout(timeoutId);
        reject(err);
      }
    );
  });
}

/**
 * Helper function to safely execute async operations with consistent error handling
 * @param operation The async operation to execute
 * @param context A context string for logging (typically the class/method name)
 * @param fallback Optional fallback value to return on error
 */
export async function safeAsync<T>(
  operation: () => Promise<T>,
  context: string,
  fallback?: T
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    logger.error(
      `Error in ${context}`,
      context.split(':')[0],
      error instanceof Error ? error : new Error(String(error))
    );
    
    if (fallback !== undefined) {
      return fallback;
    }
    throw error; // Re-throw if no fallback provided
  }
}

/**
 * Helper function for parallel operations with consistent error handling
 * @param operations An array of operations to execute in parallel
 * @param context A context string for logging (typically the class/method name)
 * @param options Configuration options
 */
export async function parallelOps<T>(
  operations: Array<() => Promise<T>>,
  context: string,
  options: { 
    continueOnError?: boolean; 
    fallback?: T[];
    abortSignal?: AbortSignal;
  } = {}
): Promise<T[]> {
  const results: Array<T | undefined> = [];
  const errors: Error[] = [];
  
  // Early abort check
  if (options.abortSignal?.aborted) {
    logger.info(`Operation aborted before execution: ${context}`, context.split(':')[0]);
    return options.fallback || ([] as T[]);
  }
  
  // Execute operations with individual error handling
  const promises = operations.map(async (op, index) => {
    try {
      // Check for abort before each operation
      if (options.abortSignal?.aborted) {
        throw new Error('Operation aborted');
      }
      
      const result = await op();
      results[index] = result;
      return result;
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)));
      logger.error(
        `Error in parallel operation ${index} of ${context}`,
        context.split(':')[0],
        error instanceof Error ? error : new Error(String(error))
      );
      
      if (!options.continueOnError) {
        throw error;
      }
    }
  });
  
  // Wait for all operations to complete if continuing on error
  if (options.continueOnError) {
    await Promise.allSettled(promises);
    
    // Log a summary of errors if any occurred
    if (errors.length > 0) {
      logger.warn(
        `${errors.length} of ${operations.length} operations failed in ${context}`,
        context.split(':')[0]
      );
    }
    
    // Return results with undefined values for failed operations
    if (options.fallback) {
      return options.fallback;
    }
    
    // Filter out undefined values and cast to T[]
    return results.filter((item): item is T => item !== undefined);
  }
  
  // If not continuing on error, use Promise.all to fail fast
  try {
    // TypeScript is concerned about possible undefined values here
    // Since we're not in continueOnError mode, any operation that returns undefined
    // would have thrown and Promise.all would have rejected
    return await Promise.all(promises) as T[];
  } catch (error) {
    // If we have a fallback, return it
    if (options.fallback) {
      return options.fallback;
    }
    throw error;
  }
}

/**
 * Creates a cancellable operation with timeout support
 * @param timeoutMs Timeout in milliseconds
 * @param description Description for logging
 */
export function createCancellable(timeoutMs?: number, description = 'operation') {
  const controller = new AbortController();
  const { signal } = controller;
  
  let timeoutId: NodeJS.Timeout | null = null;
  
  // Set timeout if specified
  if (timeoutMs) {
    timeoutId = setTimeout(() => {
      logger.warn(`${description} timed out after ${timeoutMs}ms`, 'AsyncUtils');
      controller.abort();
    }, timeoutMs);
  }
  
  // Return cleanup function
  const cleanup = () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  };
  
  return { signal, abort: controller.abort.bind(controller), cleanup };
}

/**
 * Executes an operation with a timeout
 * @param operation The async operation to execute
 * @param timeoutMs Timeout in milliseconds
 * @param context A context string for logging
 * @param fallback Optional fallback value to return on timeout
 */
export async function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  context: string,
  fallback?: T
): Promise<T> {
  const { signal, cleanup } = createCancellable(timeoutMs, context);
  
  try {
    return await operation(signal);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      logger.warn(`Operation timed out after ${timeoutMs}ms: ${context}`, context.split(':')[0]);
      
      if (fallback !== undefined) {
        return fallback;
      }
    }
    
    logger.error(
      `Error in ${context}`,
      context.split(':')[0],
      error instanceof Error ? error : new Error(String(error))
    );
    throw error;
  } finally {
    cleanup();
  }
}

/**
 * Retries an operation with exponential backoff
 * @param operation The async operation to execute
 * @param options Retry options
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: {
    maxRetries?: number;
    initialDelayMs?: number;
    maxDelayMs?: number;
    backoffFactor?: number;
    context?: string;
    retryableErrors?: Array<string | RegExp>;
  } = {}
): Promise<T> {
  const {
    maxRetries = 3,
    initialDelayMs = 100,
    maxDelayMs = 5000,
    backoffFactor = 2,
    context = 'retry operation',
    retryableErrors = []
  } = options;
  
  let lastError: Error | null = null;
  let delay = initialDelayMs;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      
      // Check if we should retry this error
      if (retryableErrors.length > 0) {
        const errorStr = lastError.toString();
        const shouldRetry = retryableErrors.some(pattern => 
          typeof pattern === 'string' 
            ? errorStr.includes(pattern) 
            : pattern.test(errorStr)
        );
        
        if (!shouldRetry) {
          logger.error(
            `Non-retryable error in ${context}`,
            context.split(':')[0],
            lastError
          );
          throw lastError;
        }
      }
      
      // Check if we've exceeded max retries
      if (attempt >= maxRetries) {
        logger.error(
          `Failed after ${maxRetries} attempts in ${context}`,
          context.split(':')[0],
          lastError
        );
        throw lastError;
      }
      
      // Log retry attempt
      // Use lastError.message to get the string message instead of passing the Error object directly
      logger.warn(
        `Attempt ${attempt + 1}/${maxRetries} failed in ${context}, retrying in ${delay}ms: ${lastError.message}`,
        context.split(':')[0]
      );
      
      // Wait for the backoff delay
      await new Promise(resolve => setTimeout(resolve, delay));
      
      // Calculate next backoff delay
      delay = Math.min(delay * backoffFactor, maxDelayMs);
    }
  }
  
  // This should never happen due to the throw in the loop
  throw lastError || new Error(`Unknown error in ${context}`);
}