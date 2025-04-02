#!/usr/bin/env node
import { program } from 'commander';
import fetch, { Response } from 'node-fetch';
import chalk from 'chalk';
import type { Stream, StreamSource } from '../types/stream.js';
import { logger } from '../server/services/logger.js';

const API_URL = 'http://localhost:3001/api';

function getTimestamp(): string {
  const now = new Date();
  return now.toLocaleTimeString();
}

function formatUptime(startTime: number | string): string {
  const start = typeof startTime === 'string' ? new Date(startTime).getTime() : startTime;
  const now = Date.now();
  const diff = Math.floor((now - start) / 1000);
  
  const hours = Math.floor(diff / 3600);
  const minutes = Math.floor((diff % 3600) / 60);
  const seconds = diff % 60;
  
  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  } else {
    return `${seconds}s`;
  }
}

async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`HTTP error! status: ${response.status}, message: ${errorText}`);
  }
  const data = await response.json();
  return data as T;
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
  .action(handleStreamList);

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

screenCommands
  .command('toggle')
  .description('Toggle screen enabled/disabled state')
  .argument('<screen>', 'Screen number')
  .action(async (screen) => {
    try {
      console.log(chalk.blue(`Toggling screen ${screen}...`));
      const response = await fetch(`${API_URL}/screens/${screen}/toggle`, {
        method: 'POST'
      });
      const result = await handleResponse<{ success: boolean; enabled: boolean }>(response);
      console.log(chalk.green(`Screen ${screen} ${result.enabled ? 'enabled' : 'disabled'}`));
    } catch (error) {
      console.error(chalk.red('Error:'), error);
    }
  });

screenCommands
  .command('new-player')
  .description('Start a new player instance for a screen')
  .argument('<screen>', 'Screen number')
  .action(async (screen) => {
    try {
      console.log(chalk.blue('Opening new player...'));
      const response = await fetch(`${API_URL}/screens/${screen}/new-player`, {
        method: 'POST'
      });
      const result = await handleResponse<{ success: boolean }>(response);
      if (result.success) {
        console.log(chalk.green('New player started successfully'));
      } else {
        console.log(chalk.yellow('Failed to start new player'));
      }
    } catch (error) {
      console.error(chalk.red('Error:'), error);
    }
  });

// Queue Management Commands
queueCommands
  .command('show')
  .description('Show queue for a screen')
  .argument('<screen>', 'Screen number')
  .action(async (screen: string) => handleQueueShow(parseInt(screen, 10)));

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
  .command('start')
  .description('Start only the LiveLink server (no frontend)')
  .argument('[players...]', 'Number of players to start on each screen (e.g., "1 3" for 1 on screen 1 and 3 on screen 2)')
  .action(async (players: string[]) => {
    try {
      // Convert arguments to numbers
      const screenPlayers = players.map(Number);
      
      // Set environment variables for screen configuration
      if (screenPlayers.length > 0) {
        process.env.START_SCREENS = screenPlayers.length.toString();
        screenPlayers.forEach((numPlayers: number, index: number) => {
          process.env[`START_SCREEN_${index + 1}`] = numPlayers.toString();
        });
      }

      // Import and start the server
      await import('../server/api.js');
      console.log(chalk.green('LiveLink server started'));
    } catch (error) {
      console.error(chalk.red('Failed to start server:'), error);
      process.exit(1);
    }
  });

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

// Web Control Commands
const webCommands = program.command('web').description('Web frontend control commands');

webCommands
  .command('start')
  .description('Start only the web frontend')
  .action(async () => {
    try {
      console.log(chalk.blue('Starting web frontend...'));
      console.log(chalk.yellow('Web frontend functionality is not yet implemented'));
      process.exit(1);
    } catch (error) {
      console.error(chalk.red('Failed to start web frontend:'), error);
      process.exit(1);
    }
  });

webCommands
  .command('stop')
  .description('Stop the web frontend')
  .action(async () => {
    try {
      console.log(chalk.blue('Stopping web frontend...'));
      console.log(chalk.yellow('Web frontend functionality is not yet implemented'));
      process.exit(1);
    } catch (error) {
      console.error(chalk.red('Failed to stop web frontend:'), error);
      process.exit(1);
    }
  });

// Add start command at root level
program
  .command('start')
  .description('Start both server and web frontend')
  .argument('[players...]', 'Number of players to start on each screen (e.g., "1 3" for 1 on screen 1 and 3 on screen 2)')
  .action(async (players: string[]) => {
    try {
      // Convert arguments to numbers
      const screenPlayers = players.map(Number);
      
      // Set environment variables for screen configuration
      if (screenPlayers.length > 0) {
        process.env.START_SCREENS = screenPlayers.length.toString();
        screenPlayers.forEach((numPlayers: number, index: number) => {
          process.env[`START_SCREEN_${index + 1}`] = numPlayers.toString();
        });
      }

      // Start both server and frontend
      console.log(chalk.blue('Starting LiveLink server and web frontend...'));
      await import('../server/api.js');
      console.log(chalk.green('LiveLink server started'));
      console.log(chalk.yellow('Web frontend functionality is not yet implemented'));
    } catch (error) {
      console.error(chalk.red('Failed to start:'), error);
      process.exit(1);
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

// Start both server and frontend if no arguments provided (except for help)
if (process.argv.length <= 2 && !process.argv.includes('-h') && !process.argv.includes('--help')) {
  // Get the number of players to start on each screen from arguments
  const args = process.argv.slice(2);
  const screenPlayers = args.map(Number);
  
  // Set environment variables for screen configuration
  if (screenPlayers.length > 0) {
    process.env.START_SCREENS = screenPlayers.length.toString();
    screenPlayers.forEach((numPlayers: number, index: number) => {
      process.env[`START_SCREEN_${index + 1}`] = numPlayers.toString();
    });
  }

  // Start both server and frontend
  console.log(chalk.blue('Starting LiveLink server and web frontend...'));
  import('../server/api.js').then(() => {
    console.log(chalk.green('LiveLink server started'));
    console.log(chalk.yellow('Web frontend functionality is not yet implemented'));
  }).catch((error) => {
    console.error(chalk.red('Failed to start:'), error);
    process.exit(1);
  });
} else if (process.argv.length <= 2) {
  // Show help if only -h or --help is provided
  program.help();
}

streamCommands
  .command('switch')
  .description('Switch current stream to a new URL')
  .requiredOption('-u, --url <url>', 'New stream URL')
  .option('-s, --screen <number>', 'Screen number', '1')
  .option('-q, --quality <quality>', 'Stream quality', 'best')
  .action(async (options) => {
    try {
      const screen = parseInt(options.screen);
      console.log(chalk.blue(`Switching stream on screen ${screen} to ${options.url}...`));

      // First get current stream to mark as watched
      const activeStreams = await fetch(`${API_URL}/streams/active`)
        .then(res => handleResponse<Stream[]>(res));
      
      const currentStream = activeStreams.find(s => s.screen === screen);
      if (currentStream?.url) {
        // Mark current stream as watched
        await fetch(`${API_URL}/streams/watched`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: currentStream.url })
        });
        console.log(chalk.gray(`Marked current stream as watched: ${currentStream.url}`));
      }

      // Stop current stream
      await fetch(`${API_URL}/streams/${screen}`, {
        method: 'DELETE'
      });

      // Start new stream
      const response = await fetch(`${API_URL}/streams/url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: options.url,
          quality: options.quality,
          screen
        })
      });
      const result = await handleResponse(response);
      console.log(chalk.green('Stream switched successfully:'), result);
    } catch (error) {
      console.error(chalk.red('Error:'), error);
    }
  });

interface ScreenInfo {
  enabled: boolean;
  queueProcessing?: boolean;
}

async function handleQueueShow(screen: number) {
  console.log(chalk.blue(`Fetching queue for screen ${screen}...`));
  try {
    // First, trigger a queue refresh
    const refreshResponse = await fetch(`${API_URL}/streams/queue/${screen}/refresh`, {
      method: 'POST'
    });
    if (!refreshResponse.ok) {
      console.log(chalk.yellow('Warning: Could not refresh queue'));
    }

    // Then get the queue
    const response = await fetch(`${API_URL}/streams/queue/${screen}`);
    if (!response.ok) {
      if (response.status === 404) {
        console.log(chalk.yellow(`No queue found for screen ${screen}`));
        return;
      }
      throw new Error(`HTTP error! status: ${response.status}, message: ${response.statusText}`);
    }

    const queue = await response.json() as StreamSource[];
    if (!queue || queue.length === 0) {
      console.log(chalk.yellow('Queue is empty'));
      return;
    }

    // Get screen info to show enabled/disabled status
    const screenInfoResponse = await fetch(`${API_URL}/screens/${screen}`);
    const screenInfo = screenInfoResponse.ok ? await screenInfoResponse.json() as ScreenInfo : null;
    
    // Display screen status if available
    if (screenInfo) {
      const screenStatus = screenInfo.enabled ? chalk.green('Enabled') : chalk.red('Disabled');
      console.log(chalk.blue(`\nScreen ${screen} Status: ${screenStatus}`));
    }

    console.log(chalk.blue(`\nQueue for Screen ${screen} (${queue.length} items):`));
    console.log(chalk.gray('----------------------------------------'));
    
    queue.forEach((stream: StreamSource, index: number) => {
      // Title with source type and priority indicator
      const sourceType = stream.subtype === 'favorites' ? chalk.magenta('[FAV]') :
                        stream.organization ? chalk.cyan(`[${stream.organization}]`) :
                        '';
      const priorityIndicator = stream.priority !== undefined ? 
        chalk.gray(`(P${stream.priority})`) : '';
      
      console.log(chalk.green(`\n${index + 1}. ${sourceType} ${priorityIndicator} ${stream.title || 'No Title'}`));
      console.log(`Platform: ${stream.platform || 'Unknown'}`);
      console.log(`URL: ${stream.url}`);
      if (stream.viewerCount) console.log(`Viewers: ${stream.viewerCount.toLocaleString()}`);
      if (stream.organization) console.log(`Organization: ${stream.organization}`);
      if (stream.sourceStatus) {
        const statusColor = stream.sourceStatus === 'live' ? chalk.green :
                          stream.sourceStatus === 'upcoming' ? chalk.yellow :
                          chalk.red;
        console.log(`Status: ${statusColor(stream.sourceStatus)}`);
      }
      console.log(chalk.gray('----------------------------------------'));
    });

    // Show queue processing status if available
    if (screenInfo?.queueProcessing) {
      console.log(chalk.yellow('\nQueue is currently being processed...'));
    }
  } catch (error) {
    console.error(chalk.red('Error:'), error instanceof Error ? error.message : String(error));
  }
}

async function handleStreamList() {
  console.log(getTimestamp(), '[INFO] [CLI] Fetching active streams');
  try {
    const response = await fetch(`${API_URL}/streams/active`);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const streams = await response.json() as Stream[];
    if (!streams || streams.length === 0) {
      console.log('No active streams');
      return;
    }

    console.log('\nActive Streams:\n');

    for (const stream of streams) {
      // Get additional details for each stream
      const detailsResponse = await fetch(`${API_URL}/streams/${stream.screen}/details`);
      const details = detailsResponse.ok ? await detailsResponse.json() as Stream : null;
      
      console.log(`Screen ${stream.screen} ${stream.status === 'playing' ? '●' : '○'}`);
      console.log(`Title: ${stream.title || details?.title || 'No Title'}`);
      console.log(`URL: ${stream.url}`);
      console.log(`Platform: ${stream.platform}`);
      console.log(`Quality: ${stream.quality}`);
      console.log(`Status: ${stream.status}`);
      
      if (details) {
        if (details.viewerCount) console.log(`Viewers: ${details.viewerCount.toLocaleString()}`);
        if (details.organization) console.log(`Organization: ${details.organization}`);
        if (stream.startTime) {
          const uptime = formatUptime(stream.startTime);
          console.log(`Uptime: ${uptime}`);
        }
      }
      console.log('');
    }
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : String(error));
  }
}