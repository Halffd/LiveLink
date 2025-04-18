import { jest } from '@jest/globals';
import * as fs from 'fs';
import { PlayerService } from '../player';
import type { Config } from '../../../types/stream';

// Mock fs module
jest.mock('fs', () => ({
  existsSync: jest.fn(),
  unlinkSync: jest.fn(),
  mkdirSync: jest.fn(),
  writeFileSync: jest.fn(),
  readFileSync: jest.fn()
}));

// Mock child_process module
jest.mock('child_process', () => ({
  spawn: jest.fn(() => {
    const mockProcess = {
      on: jest.fn(),
      stdout: { on: jest.fn() },
      stderr: { on: jest.fn() },
      kill: jest.fn(),
      pid: 12345
    };
    return mockProcess;
  })
}));

describe('PlayerService Catch Blocks', () => {
  let playerService: PlayerService;
  let mockConfig: Config;

  beforeEach(() => {
    jest.clearAllMocks();

    // Mock process.cwd()
    jest.spyOn(process, 'cwd').mockReturnValue('/fake/path');

    // Setup mock config
    mockConfig = {
      player: {
        defaultVolume: 50,
        defaultQuality: 'best',
        windowMaximized: true,
        screens: [
          { screen: 1, enabled: true, id: 'screen1' }
        ]
      }
    } as Config;

    // Create PlayerService instance
    playerService = new PlayerService(mockConfig);
  });

  test('should handle unlink errors gracefully', async () => {
    // Set up the test to trigger the catch block
    const fsModule = require('fs');
    fsModule.existsSync.mockReturnValue(true);
    fsModule.unlinkSync.mockImplementation(() => {
      throw new Error('Cannot unlink file');
    });

    // This should not throw an error even though unlinkSync fails
    expect(() => {
      // Access the private startMpvProcess method through type assertion
      (playerService as any).startMpvProcess({
        screen: 1,
        url: 'https://example.com/stream',
        quality: 'best'
      });
    }).not.toThrow();

    // Verify the catch block was triggered
    expect(fsModule.unlinkSync).toHaveBeenCalled();
  });

  test('should handle IPC command failures gracefully', async () => {
    // Mock sendMpvCommand to throw an error
    jest.spyOn(playerService as any, 'sendMpvCommand').mockImplementation(() => {
      throw new Error('IPC command failed');
    });

    // Mock isProcessRunning
    jest.spyOn(playerService as any, 'isProcessRunning').mockReturnValue(false);

    // Set up a fake stream in the instance
    (playerService as any).streams.set(1, {
      process: { pid: 12345 },
      screen: 1,
      url: 'https://example.com/stream'
    });

    // This should not throw even though sendMpvCommand fails
    await playerService.stopStream(1);

    // Verify the sendMpvCommand was called and its error was handled
    expect((playerService as any).sendMpvCommand).toHaveBeenCalled();
  });
}); 