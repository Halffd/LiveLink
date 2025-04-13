// Global test setup for Jest
/* global jest, beforeEach, afterEach */

// Set longer timeout for async tests
jest.setTimeout(10000);

// Create mock functions for console to reduce noise
const originalConsole = { ...console };
global.console = {
  ...console,
  // Keep error logging but suppress other logs during tests
  log: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn(),
  // Keep error for debugging test failures
  error: originalConsole.error,
};

// Helper to reset all mocks between tests
beforeEach(() => {
  jest.clearAllMocks();
});

// Clean up any pending timers
afterEach(() => {
  jest.clearAllTimers();
});
