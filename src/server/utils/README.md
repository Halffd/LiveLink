# Error Handling and Async Utilities

This directory contains utilities for consistent error handling and standardized async patterns throughout the codebase.

## Key Patterns

### 1. Safe Async Execution

Use `safeAsync` to handle errors consistently for any async operation:

```typescript
import { safeAsync } from './utils/async_helpers';

// Instead of try/catch blocks everywhere:
const result = await safeAsync(
  async () => {
    // Your async code here
    return await someAsyncOperation();
  },
  'ComponentName:methodName',
  fallbackValue // Optional
);
```

### 2. Parallel Operations

Use `parallelOps` for handling multiple async operations in parallel:

```typescript
import { parallelOps } from './utils/async_helpers';

const results = await parallelOps(
  [
    () => fetchDataA(),
    () => fetchDataB(),
    () => fetchDataC()
  ],
  'ComponentName:operation',
  { continueOnError: true } // Optional - continue even if some operations fail
);
```

### 3. Timeout-Protected Operations

Use `withTimeout` to ensure operations don't hang indefinitely:

```typescript
import { withTimeout } from './utils/async_helpers';

const result = await withTimeout(
  async (signal) => {
    // Pass the signal to fetch or other abortable operations
    return await fetch(url, { signal });
  },
  5000, // Timeout in milliseconds
  'ComponentName:fetchOperation',
  fallbackValue // Optional
);
```

### 4. Retry Logic

Use `withRetry` for operations that should retry on failure:

```typescript
import { withRetry } from './utils/async_helpers';

const result = await withRetry(
  async () => {
    return await networkOperation();
  },
  {
    maxRetries: 3,
    backoffFactor: 2,
    initialDelayMs: 100,
    context: 'ComponentName:criticalOperation',
    retryableErrors: ['Network error', 'ECONNRESET', /timeout/i]
  }
);
```

## Best Practices

1. Always include a descriptive context string that follows the format `ComponentName:operation`.
2. Use fallback values when appropriate to maintain graceful degradation.
3. For critical operations, combine patterns (e.g., `withRetry` + `withTimeout`).
4. Add AbortSignals to long-running operations for proper cancellation support.
5. Use `parallelOps` with `continueOnError: true` for non-critical parallel operations.

## Example: Combining Patterns

```typescript
// Retry with timeout for critical network operations
const result = await withRetry(
  async () => {
    return await withTimeout(
      async (signal) => {
        return await fetch(url, { signal });
      },
      3000,
      'Component:fetchWithRetryAndTimeout'
    );
  },
  {
    maxRetries: 3,
    context: 'Component:fetchWithRetryAndTimeout'
  }
);
``` 