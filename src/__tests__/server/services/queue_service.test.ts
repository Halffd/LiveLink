/**
 * Unit tests for QueueService
 * 
 * These tests focus on verifying the behavior of the QueueService,
 * particularly around handling watched streams and the skipWatchedStreams option.
 */
import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { QueueService } from '../../../server/services/queue_service';
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
  let queueService: QueueService;
  let executionTracker: ExecutionTracker;
  
  beforeEach(() => {
    // Reset all mocks
    jest.clearAllMocks();
    
    // Create execution tracker for tracking operations
    executionTracker = new ExecutionTracker();
  });
});
