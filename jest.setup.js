// Global test setup
import { jest } from '@jest/globals';

jest.setTimeout(10000); // Longer timeout for async tests

// Mock console methods to reduce noise during tests
global.console = {
  ...console,
  // Keep error logging but suppress other logs during tests
  log: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn(),
  // Keep error for debugging test failures
  error: console.error,
};

// Helper to reset all mocks between tests
beforeEach(() => {
  jest.clearAllMocks();
});

// Clean up any pending timers
afterEach(() => {
  jest.clearAllTimers();
});
