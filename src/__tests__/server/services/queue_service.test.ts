/**
 * Unit tests for QueueService
 * 
 * These tests focus on verifying the behavior of the QueueService,
 * particularly around handling watched streams and the skipWatchedStreams option.
 */
import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { queueService as queueServiceInstance } from '../../../server/services/queue_service';
import { createMockStreamSource } from '../../helpers/mock-factory';
import { ExecutionTracker } from '../../helpers/async-utils';

// Mock the logger to reduce noise
jest.mock('../../../server/services/logger', () => {
  return {
    logger: {
      info: jest.fn(),
      debug: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    }
  };
});

describe('QueueService Tests', () => {
  let queueService: typeof queueServiceInstance;
  let executionTracker: ExecutionTracker;
  
  beforeEach(() => {
    // Reset all mocks
    jest.clearAllMocks();
    
    // Assign the imported instance
    queueService = queueServiceInstance;
    
    // Create execution tracker for tracking operations
    executionTracker = new ExecutionTracker();
  });
});
