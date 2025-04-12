# LiveLink Testing Strategy

This document outlines the comprehensive testing strategy for the LiveLink application, focusing on race conditions, complexity reduction, and code quality.

## Table of Contents

1. [Testing Setup](#testing-setup)
2. [Test Types](#test-types)
3. [Running Tests](#running-tests)
4. [Test Helpers](#test-helpers)
5. [Race Condition Testing](#race-condition-testing)
6. [Test Coverage](#test-coverage)
7. [Test Matrix](#test-matrix)

## Testing Setup

The LiveLink project uses Jest for unit and integration testing. The setup includes:

- **Jest**: Main testing framework
- **ts-jest**: TypeScript support for Jest
- **jest-mock-extended**: Advanced mocking capabilities
- **TimerMock**: Custom timer mocking for time-based tests

### Configuration Files

- `jest.config.js`: Main Jest configuration
- `jest.setup.js`: Global test setup and teardown
- `tsconfig.test.json`: TypeScript configuration for tests

## Test Types

The testing strategy includes several types of tests:

### Unit Tests

Unit tests focus on testing individual components in isolation. They use mocks for dependencies and verify the behavior of a single unit of code.

Example: `queue_service.test.ts`

### Race Condition Tests

These tests specifically target potential race conditions in the codebase by simulating concurrent operations, delayed responses, and out-of-order completions.

Example: `stream_manager.race.test.ts`

### Integration Tests

Integration tests verify that multiple components work together correctly. They focus on the interaction between components and ensure proper behavior across boundaries.

Example: `skipWatchedStreams.test.ts`

## Running Tests

To run the tests, use the following npm scripts:

```bash
# Run all tests
npm run test:jest

# Run tests in watch mode
npm run test:jest:watch

# Generate coverage report
npm run test:jest:coverage

# Run only race condition tests
npm run test:race
```

## Test Helpers

Several helper utilities have been created to facilitate testing:

### Async Utilities (`async-utils.ts`)

- `delay()`: Creates a promise that resolves after a specified time
- `createDeferred()`: Creates a deferred promise that can be resolved externally
- `executeWithDelay()`: Executes promises with controlled timing
- `executeStaggered()`: Executes tasks in parallel with staggered start times
- `ExecutionTracker`: Tracks the order of async operations

### Mock Factory (`mock-factory.ts`)

- `createMockChildProcess()`: Creates a mock child process
- `createMockEventEmitter()`: Creates a mock event emitter
- `createMockStreamSource()`: Creates a mock stream source
- `createMockConfig()`: Creates a mock configuration
- `createMockServices()`: Creates mock services
- `createFetchMock()`: Creates a controlled fetch mock

### Timer Mock (`timer-mock.ts`)

- `TimerMock`: Provides precise control over timers in tests
  - `advanceTime()`: Advances time by a specified amount
  - `runAllTimers()`: Runs all pending timers
  - `runOnlyPendingTimers()`: Runs only currently pending timers

## Race Condition Testing

Race conditions are particularly challenging to test. Our approach includes:

1. **Controlled Timing**: Using custom timer mocks to control when operations occur
2. **Execution Tracking**: Recording the order of operations to verify correct sequencing
3. **Concurrent Operations**: Simulating multiple operations happening simultaneously
4. **Delayed Responses**: Testing behavior when operations complete out of order
5. **Network Failures**: Simulating network failures and verifying recovery

### Example Race Condition Test

```typescript
test('should prevent concurrent handleStreamEnd calls for the same screen', async () => {
  // Set up test data
  
  // Execute multiple operations concurrently
  await executeStaggered([
    () => streamManager.handleStreamEnd(1),
    () => streamManager.handleStreamEnd(1),
    () => streamManager.handleStreamEnd(1)
  ], 10);
  
  // Verify correct behavior
  expect(streamManager.startStream).toHaveBeenCalledTimes(1);
});
```

## Test Coverage

The test coverage report can be generated using:

```bash
npm run test:jest:coverage
```

This will generate a coverage report in the `coverage` directory, which includes:

- Line coverage
- Branch coverage
- Function coverage
- Statement coverage

### Coverage Goals

- **Unit Tests**: 80%+ coverage of core services
- **Race Condition Tests**: Coverage of all identified race condition scenarios
- **Integration Tests**: Coverage of key user workflows

## Test Matrix

The following matrix outlines the key test scenarios covered:

| Component       | Unit Tests | Race Tests | Integration Tests |
|-----------------|------------|------------|------------------|
| StreamManager   | ✅         | ✅         | ✅               |
| PlayerService   | ✅         | ✅         | ✅               |
| QueueService    | ✅         | ❌         | ✅               |
| skipWatchedStreams | ✅      | ✅         | ✅               |
| Network Resilience | ✅      | ✅         | ❌               |
| Resource Cleanup | ✅        | ✅         | ❌               |

### Key Test Scenarios

1. **Stream Processing**
   - Concurrent stream processing
   - Stream end handling
   - Queue management

2. **Network Resilience**
   - Network failure handling
   - Retry mechanisms
   - Backoff strategies

3. **Resource Management**
   - Timer cleanup
   - Process cleanup
   - Memory leak prevention

4. **skipWatchedStreams Feature**
   - Global setting behavior
   - Screen-specific setting behavior
   - Interaction with favorites

5. **Race Conditions**
   - Multiple simultaneous stream starts
   - Network race conditions
   - Concurrent queue updates
