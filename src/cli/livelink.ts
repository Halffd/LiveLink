#!/usr/bin/env node
import { program } from 'commander';
import fetch, { Response } from 'node-fetch';
import chalk from 'chalk';
import type { Stream } from '../types/stream.js';
import { logger } from '../server/services/logger.js';

const API_URL = 'http://localhost:3001/api';

async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`HTTP error! status: ${response.status}, message: ${errorText}`);
  }
  return response.json() as Promise<T>;
}

program
  .name('livelink')
  .version('0.2.0')
  .description('LiveLink CLI - Control and manage LiveLink streams')
  .option('-d, --debug', 'Enable debug output');

// Create command categories for better organization
const streamCommands = program.command('stream').description('Stream management commands');
const queueCommands = program.command('queue').description('Queue management commands');
const playerCommands = program.command('player').description('Player control commands');
const screenCommands = program.command('screen').description('Screen management commands');
const serverCommands = program.command('server').description('Server control commands');

// Stream Management Commands
streamCommands
  .command('list')
  .description('List all active streams')
  .action(async () => {
    try {
      logger.info('Fetching active streams', 'CLI');
      const streams = await fetch(`${API_URL}/streams/active`)
        .then(res => handleResponse<Stream[]>(res));

      if (streams.length === 0) {
        console.log(chalk.yellow('No active streams found.'));
        return;
      }

      console.log(chalk.blue('Active Streams:'));
      streams.forEach((stream) => {
        console.log(chalk.green(`\nScreen ${stream.screen}:`));
        console.log(`URL: ${stream.url}`);
        console.log(`Quality: ${stream.quality}`);
        if (stream.title) console.log(`Title: ${stream.title}`);
        if (stream.viewerCount) console.log(`Viewers: ${stream.viewerCount}`);
        console.log(`Status: ${stream.status || 'playing'}`);
      });
    } catch (error) {
      console.error(chalk.red('Error:'), error);
    }
  });

streamCommands
  .command('start')
  .description('Start a new stream')
  .requiredOption('-u, --url <url>', 'Stream URL')
  .option('-q, --quality <quality>', 'Stream quality', 'best')
  .option('-s, --screen <number>', 'Screen number', '1')
  .option('-v, --volume <number>', 'Volume level (0-100)')
  .action(async (options) => {
    try {
      console.log(chalk.blue(`Starting stream on screen ${options.screen}...`));
      
      // First check if URL is already playing on any screen
      const activeStreams = await fetch(`${API_URL}/streams/active`)
        .then(res => handleResponse<Stream[]>(res));
      
      const existingStream = activeStreams.find(stream => stream.url === options.url);
      if (existingStream) {
        console.error(chalk.yellow(`Warning: URL is already playing on screen ${existingStream.screen}`));
        const proceed = process.argv.includes('--force');
        if (!proceed) {
          console.log(chalk.yellow('Use --force to start anyway.'));
          return;
        }
      }

      const requestBody: {
        url: string;
        quality: string;
        screen: number;
        volume?: number;
      } = {
        url: options.url,
        quality: options.quality,
        screen: parseInt(options.screen)
      };

      if (options.volume) {
        requestBody.volume = parseInt(options.volume);
      }

      const response = await fetch(`${API_URL}/streams/url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      });
      const result = await handleResponse(response);
      console.log(chalk.green('Stream started:'), result);
    } catch (error) {
      console.error(chalk.red('Error:'), error);
    }
  });

streamCommands
  .command('stop')
  .description('Stop a stream')
  .argument('<screen>', 'Screen number')
  .action(async (screen) => {
    try {
      console.log(chalk.blue(`Stopping stream on screen ${screen}...`));
      const response = await fetch(`${API_URL}/streams/${screen}`, {
        method: 'DELETE'
      });
      const result = await handleResponse(response);
      console.log(chalk.green('Stream stopped:'), result);
    } catch (error) {
      console.error(chalk.red('Error:'), error);
    }
  });

streamCommands
  .command('restart')
  .description('Restart streams')
  .option('-s, --screen <number>', 'Screen number (optional, restarts all screens if not specified)')
  .action(async (options) => {
    try {
      if (options.screen) {
        console.log(chalk.blue(`Restarting stream on screen ${options.screen}...`));
      } else {
        console.log(chalk.blue('Restarting all streams...'));
      }
      
      const response = await fetch(`${API_URL}/streams/restart`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(options.screen ? { screen: parseInt(options.screen) } : {})
      });
      const result = await handleResponse(response);
      console.log(chalk.green('Streams restarted:'), result);
    } catch (error) {
      console.error(chalk.red('Error:'), error);
    }
  });

// New stream refresh commands
streamCommands
  .command('refresh')
  .description('Force refresh streams data')
  .argument('[screen]', 'Screen number (optional, refreshes all screens if not specified)')
  .action(async (screen) => {
    try {
      if (screen) {
        console.log(chalk.blue(`Forcing refresh for screen ${screen}...`));
      } else {
        console.log(chalk.blue('Forcing refresh for all screens...'));
      }
      
      const endpoint = screen ? `${API_URL}/streams/refresh/${screen}` : `${API_URL}/streams/refresh`;
      
      const response = await fetch(endpoint, {
        method: 'POST'
      });
      const result = await handleResponse(response);
      console.log(chalk.green('Streams refreshed:'), result);
    } catch (error) {
      console.error(chalk.red('Error:'), error);
    }
  });

// Stream Category Commands
streamCommands
  .command('vtubers')
  .description('List VTuber streams')
  .option('-l, --limit <number>', 'Number of streams to fetch', '20')
  .action(async (options) => {
    try {
      console.log(chalk.blue('Fetching VTuber streams...'));
      const response = await fetch(`${API_URL}/streams/vtubers?limit=${options.limit}`);
      const streams = await handleResponse<Stream[]>(response);
      
      if (streams.length === 0) {
        console.log(chalk.yellow('No VTuber streams found.'));
        return;
      }
      
      console.log(chalk.blue(`\nFound ${streams.length} VTuber Streams:`));
      streams.forEach((stream, index) => {
        console.log(chalk.green(`\n${index + 1}. ${stream.title || 'Untitled'}`));
        console.log(`URL: ${stream.url}`);
        if (stream.viewerCount) console.log(`Viewers: ${stream.viewerCount}`);
      });
    } catch (error) {
      console.error(chalk.red('Error:'), error);
    }
  });

streamCommands
  .command('japanese')
  .description('List Japanese streams')
  .option('-l, --limit <number>', 'Number of streams to fetch', '20')
  .action(async (options) => {
    try {
      console.log(chalk.blue('Fetching Japanese streams...'));
      const response = await fetch(`${API_URL}/streams/japanese?limit=${options.limit}`);
      const streams = await handleResponse<Stream[]>(response);
      
      if (streams.length === 0) {
        console.log(chalk.yellow('No Japanese streams found.'));
        return;
      }
      
      console.log(chalk.blue(`\nFound ${streams.length} Japanese Streams:`));
      streams.forEach((stream, index) => {
        console.log(chalk.green(`\n${index + 1}. ${stream.title || 'Untitled'}`));
        console.log(`URL: ${stream.url}`);
        if (stream.viewerCount) console.log(`Viewers: ${stream.viewerCount}`);
      });
    } catch (error) {
      console.error(chalk.red('Error:'), error);
    }
  });

// Screen Management Commands
screenCommands
  .command('enable')
  .description('Enable a screen')
  .argument('<screen>', 'Screen number')
  .action(async (screen) => {
    try {
      console.log(chalk.blue(`Enabling screen ${screen}...`));
      const response = await fetch(`${API_URL}/screens/${screen}/enable`, {
        method: 'POST'
      });
      const result = await handleResponse(response);
      console.log(chalk.green('Screen enabled:'), result);
    } catch (error) {
      console.error(chalk.red('Error:'), error);
    }
  });

screenCommands
  .command('disable')
  .description('Disable a screen')
  .argument('<screen>', 'Screen number')
  .action(async (screen) => {
    try {
      console.log(chalk.blue(`Disabling screen ${screen}...`));
      const response = await fetch(`${API_URL}/screens/${screen}/disable`, {
        method: 'POST'
      });
      const result = await handleResponse(response);
      console.log(chalk.green('Screen disabled:'), result);
    } catch (error) {
      console.error(chalk.red('Error:'), error);
    }
  });

screenCommands
  .command('info')
  .description('Get current screen information')
  .argument('<screen>', 'Screen number')
  .action(async (screen) => {
    try {
      console.log(chalk.blue(`Fetching information for screen ${screen}...`));
      const response = await fetch(`${API_URL}/screens/${screen}`);
      const screenInfo = await handleResponse(response);
      console.log(chalk.blue(`\nScreen ${screen} Information:`));
      console.log(JSON.stringify(screenInfo, null, 2));
    } catch (error) {
      console.error(chalk.red('Error:'), error);
    }
  });

screenCommands
  .command('list')
  .description('List all screens and their status')
  .action(async () => {
    try {
      console.log(chalk.blue('Fetching all screens information...'));
      const response = await fetch(`${API_URL}/screens`);
      const screens = await handleResponse(response);
      console.log(chalk.blue('\nScreens Information:'));
      console.log(JSON.stringify(screens, null, 2));
    } catch (error) {
      console.error(chalk.red('Error:'), error);
    }
  });

// Queue Management Commands
queueCommands
  .command('show')
  .description('Show queue for a screen')
  .argument('<screen>', 'Screen number')
  .action(async (screen) => {
    try {
      console.log(chalk.blue(`Fetching queue for screen ${screen}...`));
      const response = await fetch(`${API_URL}/streams/queue/${screen}`);
      const queue = await handleResponse<Stream[]>(response);
      
      if (queue.length === 0) {
        console.log(chalk.yellow(`Queue for screen ${screen} is empty.`));
        return;
      }
      
      console.log(chalk.blue(`\nQueue for Screen ${screen} (${queue.length} items):`));
      queue.forEach((stream, index) => {
        console.log(chalk.green(`\n${index + 1}. ${stream.title || 'Untitled'}`));
        console.log(`URL: ${stream.url}`);
        if (stream.viewerCount) console.log(`Viewers: ${stream.viewerCount}`);
        if (stream.priority !== undefined) console.log(`Priority: ${stream.priority}`);
      });
    } catch (error) {
      console.error(chalk.red('Error:'), error);
    }
  });

queueCommands
  .command('reorder')
  .description('Reorder queue items')
  .argument('<screen>', 'Screen number')
  .argument('<fromIndex>', 'Source index (0-based)')
  .argument('<toIndex>', 'Target index (0-based)')
  .action(async (screen, fromIndex, toIndex) => {
    try {
      console.log(chalk.blue(`Reordering queue for screen ${screen}...`));
      const response = await fetch(`${API_URL}/streams/reorder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          screen: parseInt(screen),
          sourceIndex: parseInt(fromIndex),
          targetIndex: parseInt(toIndex)
        })
      });
      const result = await handleResponse(response);
      console.log(chalk.green('Queue reordered:'), result);
    } catch (error) {
      console.error(chalk.red('Error:'), error);
    }
  });

queueCommands
  .command('clear')
  .description('Clear queue for a screen')
  .argument('<screen>', 'Screen number')
  .action(async (screen) => {
    try {
      console.log(chalk.blue(`Clearing queue for screen ${screen}...`));
      const response = await fetch(`${API_URL}/streams/queue/${screen}`, {
        method: 'DELETE'
      });
      const result = await handleResponse(response);
      console.log(chalk.green('Queue cleared:'), result);
    } catch (error) {
      console.error(chalk.red('Error:'), error);
    }
  });

// Watched Streams Commands
streamCommands
  .command('watched')
  .description('Show watched streams')
  .action(async () => {
    try {
      console.log(chalk.blue('Fetching watched streams...'));
      const response = await fetch(`${API_URL}/streams/watched`);
      const watched = await handleResponse<string[]>(response);
      
      if (watched.length === 0) {
        console.log(chalk.yellow('No watched streams found.'));
        return;
      }
      
      console.log(chalk.blue(`\nWatched Streams (${watched.length} total):`));
      watched.forEach((url, index) => {
        console.log(chalk.green(`${index + 1}. ${url}`));
      });
    } catch (error) {
      console.error(chalk.red('Error:'), error);
    }
  });

streamCommands
  .command('clear-watched')
  .description('Clear watched streams history')
  .action(async () => {
    try {
      console.log(chalk.blue('Clearing watched streams history...'));
      const response = await fetch(`${API_URL}/streams/watched`, {
        method: 'DELETE'
      });
      const result = await handleResponse(response);
      console.log(chalk.green('Watched streams cleared:'), result);
    } catch (error) {
      console.error(chalk.red('Error:'), error);
    }
  });

streamCommands
  .command('mark-watched')
  .description('Mark a stream as watched')
  .argument('<url>', 'Stream URL')
  .action(async (url) => {
    try {
      console.log(chalk.blue(`Marking stream as watched: ${url}`));
      const response = await fetch(`${API_URL}/streams/watched`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
      });
      const result = await handleResponse(response);
      console.log(chalk.green('Stream marked as watched:'), result);
    } catch (error) {
      console.error(chalk.red('Error:'), error);
    }
  });

// Player Control Commands
playerCommands
  .command('set-priority')
  .description('Set player priority')
  .argument('<level>', 'Priority level (realtime, high, above_normal, normal, below_normal, low, idle)')
  .action(async (level) => {
    try {
      const validLevels = ['realtime', 'high', 'above_normal', 'normal', 'below_normal', 'low', 'idle'];
      if (!validLevels.includes(level)) {
        console.error(chalk.red('Error: Invalid priority level. Valid values are:'), validLevels.join(', '));
        return;
      }
      
      console.log(chalk.blue(`Setting player priority to ${level}...`));
      const response = await fetch(`${API_URL}/player/priority`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ priority: level })
      });
      const result = await handleResponse(response);
      console.log(chalk.green('Priority set:'), result);
    } catch (error) {
      console.error(chalk.red('Error:'), error);
    }
  });

playerCommands
  .command('command')
  .description('Send command to MPV player instance(s)')
  .argument('<command>', 'MPV command to send (e.g. "set pause yes")')
  .option('-s, --screen <number>', 'Send to specific screen')
  .option('-a, --all', 'Send to all screens')
  .action(async (command, options) => {
    try {
      if (!options.screen && !options.all) {
        console.error(chalk.red('Error:'), 'Must specify either --screen or --all');
        return;
      }

      const target = options.all ? 'all screens' : `screen ${options.screen}`;
      console.log(chalk.blue(`Sending command to ${target}: ${command}`));

      const endpoint = options.all ? 
        `${API_URL}/player/command/all` :
        `${API_URL}/player/command/${options.screen}`;

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command })
      });
      
      const result = await handleResponse(response);
      console.log(chalk.green('Command sent:'), result);
    } catch (error) {
      console.error(chalk.red('Error:'), error);
    }
  });

playerCommands
  .command('pause')
  .description('Toggle pause')
  .argument('<screen>', 'Screen number')
  .action(async (screen) => {
    try {
      console.log(chalk.blue(`Toggling pause for screen ${screen}...`));
      const response = await fetch(`${API_URL}/player/command/${screen}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'cycle pause' })
      });
      const result = await handleResponse(response);
      console.log(chalk.green('Pause toggled:'), result);
    } catch (error) {
      console.error(chalk.red('Error:'), error);
    }
  });

playerCommands
  .command('volume')
  .description('Set volume (0-100)')
  .argument('<screen>', 'Screen number')
  .argument('<level>', 'Volume level (0-100)')
  .action(async (screen, level) => {
    try {
      const volumeLevel = parseInt(level);
      if (isNaN(volumeLevel) || volumeLevel < 0 || volumeLevel > 100) {
        console.error(chalk.red('Error:'), 'Volume level must be between 0 and 100');
        return;
      }
      
      console.log(chalk.blue(`Setting volume for screen ${screen} to ${volumeLevel}...`));
      const response = await fetch(`${API_URL}/player/command/${screen}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: `set volume ${volumeLevel}` })
      });
      const result = await handleResponse(response);
      console.log(chalk.green('Volume set:'), result);
    } catch (error) {
      console.error(chalk.red('Error:'), error);
    }
  });

// Server Control Commands
serverCommands
  .command('stop')
  .description('Stop the LiveLink server')
  .action(async () => {
    try {
      console.log(chalk.blue('Stopping LiveLink server...'));
      
      // Create AbortController for timeout
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      
      try {
        const response = await fetch('http://localhost:3001/api/server/stop', {
          method: 'POST',
          signal: controller.signal
        });
        
        clearTimeout(timeout);
        
        if (response.ok) {
          console.log(chalk.green('Server shutdown initiated successfully'));
          // Wait a moment for cleanup to complete
          await new Promise(resolve => setTimeout(resolve, 2000));
          process.exit(0);
        } else {
          const error = await response.text();
          console.error(chalk.red('Failed to stop server:'), error);
          process.exit(1);
        }
      } catch (error) {
        clearTimeout(timeout);
        if (error instanceof Error) {
          if (error.name === 'AbortError') {
            console.error(chalk.red('Server shutdown timed out'));
          } else {
            console.error(chalk.red('Failed to stop server:'), error.message);
          }
        } else {
          console.error(chalk.red('Failed to stop server:'), String(error));
        }
        process.exit(1);
      }
    } catch (error) {
      console.error(chalk.red('Failed to stop server:'), error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

serverCommands
  .command('stop-all')
  .description('Stop all players and the LiveLink server')
  .action(async () => {
    try {
      console.log(chalk.blue('Stopping all players and the LiveLink server...'));
      
      // Create AbortController for timeout (longer timeout since we're stopping all players first)
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      
      try {
        const response = await fetch('http://localhost:3001/api/server/stop-all', {
          method: 'POST',
          signal: controller.signal
        });
        
        clearTimeout(timeout);
        
        if (response.ok) {
          console.log(chalk.green('All players and server shutdown initiated successfully'));
          console.log(chalk.yellow('Waiting for processes to terminate...'));
          // Wait a moment for cleanup to complete
          await new Promise(resolve => setTimeout(resolve, 3000));
          process.exit(0);
        } else {
          const error = await response.text();
          console.error(chalk.red('Failed to stop players and server:'), error);
          process.exit(1);
        }
      } catch (error) {
        clearTimeout(timeout);
        if (error instanceof Error) {
          if (error.name === 'AbortError') {
            console.error(chalk.red('Stop-all command timed out'));
          } else {
            console.error(chalk.red('Failed to stop players and server:'), error.message);
          }
        } else {
          console.error(chalk.red('Failed to stop players and server:'), String(error));
        }
        process.exit(1);
      }
    } catch (error) {
      console.error(chalk.red('Failed to stop players and server:'), error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

serverCommands
  .command('status')
  .description('Get server status')
  .action(async () => {
    try {
      console.log(chalk.blue('Checking server status...'));
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      
      try {
        const response = await fetch('http://localhost:3001/api/server/status', {
          signal: controller.signal
        });
        
        clearTimeout(timeout);
        
        if (response.ok) {
          const status = await response.json();
          console.log(chalk.green('Server is running'));
          console.log(JSON.stringify(status, null, 2));
        } else {
          console.log(chalk.red('Server is not responding properly'));
        }
      } catch (error) {
        clearTimeout(timeout);
        if (error instanceof Error && error.name === 'AbortError') {
          console.log(chalk.red('Server is not responding (timeout)'));
        } else if (error instanceof Error && 'code' in error && error.code === 'ECONNREFUSED') {
          console.log(chalk.red('Server is not running'));
        } else {
          console.log(chalk.red('Failed to check server status:'), error instanceof Error ? error.message : String(error));
        }
      }
    } catch (error) {
      console.error(chalk.red('Error:'), error);
    }
  });

// Add backwards compatibility for old command structure
program
  .command('list-streams')
  .description('List all active streams (legacy command)')
  .action(async () => {
    console.log(chalk.yellow('Note: This command is deprecated. Use "stream list" instead.'));
    try {
      logger.info('Fetching active streams', 'CLI');
      const streams = await fetch(`${API_URL}/streams/active`)
        .then(res => handleResponse<Stream[]>(res));

      if (streams.length === 0) {
        console.log(chalk.yellow('No active streams found.'));
        return;
      }

      console.log(chalk.blue('Active Streams:'));
      streams.forEach((stream) => {
        console.log(chalk.green(`\nScreen ${stream.screen}:`));
        console.log(`URL: ${stream.url}`);
        console.log(`Quality: ${stream.quality}`);
        if (stream.title) console.log(`Title: ${stream.title}`);
        if (stream.viewerCount) console.log(`Viewers: ${stream.viewerCount}`);
        console.log(`Status: ${stream.status || 'playing'}`);
      });
    } catch (error) {
      console.error(chalk.red('Error:'), error);
    }
  });

program
  .command('start-stream')
  .description('Start a new stream (legacy command)')
  .requiredOption('-u, --url <url>', 'Stream URL')
  .option('-q, --quality <quality>', 'Stream quality', 'best')
  .option('-s, --screen <number>', 'Screen number', '1')
  .action(async (options) => {
    console.log(chalk.yellow('Note: This command is deprecated. Use "stream start" instead.'));
    try {
      console.log(chalk.blue(`Starting stream on screen ${options.screen}...`));
      
      // First check if URL is already playing on any screen
      const activeStreams = await fetch(`${API_URL}/streams/active`)
        .then(res => handleResponse<Stream[]>(res));
      
      const existingStream = activeStreams.find(stream => stream.url === options.url);
      if (existingStream) {
        console.error(chalk.yellow(`Warning: URL is already playing on screen ${existingStream.screen}`));
        const proceed = process.argv.includes('--force');
        if (!proceed) {
          console.log(chalk.yellow('Use --force to start anyway.'));
          return;
        }
      }

      const response = await fetch(`${API_URL}/streams/url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: options.url,
          quality: options.quality,
          screen: parseInt(options.screen)
        })
      });
      const result = await handleResponse(response);
      console.log(chalk.green('Stream started:'), result);
    } catch (error) {
      console.error(chalk.red('Error:'), error);
    }
  });

// Set debug mode if flag is present
const options = program.opts();
if (options.debug) {
  logger.setLevel('debug');
  logger.debug('Debug mode enabled', 'CLI');
}

// Parse command line arguments
program.parse(process.argv);

// Show help if no arguments provided
if (process.argv.length <= 2) {
  program.help();
}