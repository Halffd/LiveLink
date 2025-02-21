#!/usr/bin/env node
import { program } from 'commander';
import fetch, { Response } from 'node-fetch';
import chalk from 'chalk';
import type { Stream } from '../types/stream.js';
import { logger } from '../server/services/logger.js';

const API_URL = 'http://localhost:3001/api';

async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

program
  .name('livelink')
  .version('0.0.1')
  .description('LiveLink CLI - Control and manage LiveLink streams')
  .option('-d, --debug', 'Enable debug output');

// Stream Management Commands
program
  .command('list-streams')
  .description('List all active streams')
  .action(async () => {
    try {
      logger.info('Fetching active streams', 'CLI');
      const streams = await fetch(`${API_URL}/streams/active`)
        .then(res => handleResponse<Stream[]>(res));

      console.log(chalk.blue('Active Streams:'));
      streams.forEach((stream) => {
        console.log(chalk.green(`\nScreen ${stream.screen}:`));
        console.log(`URL: ${stream.url}`);
        console.log(`Quality: ${stream.quality}`);
        if (stream.title) console.log(`Title: ${stream.title}`);
      });
    } catch (error) {
      console.error(chalk.red('Error:'), error);
    }
  });

program
  .command('start-stream')
  .description('Start a new stream')
  .requiredOption('-u, --url <url>', 'Stream URL')
  .option('-q, --quality <quality>', 'Stream quality', 'best')
  .option('-s, --screen <number>', 'Screen number', '1')
  .action(async (options) => {
    try {
      // First check if URL is already playing on any screen
      const activeStreams = await fetch(`${API_URL}/streams/active`)
        .then(res => handleResponse<Stream[]>(res));
      
      const existingStream = activeStreams.find(stream => stream.url === options.url);
      if (existingStream) {
        console.error(chalk.red('Error:'), `URL is already playing on screen ${existingStream.screen}`);
        return;
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

program
  .command('stop-stream')
  .description('Stop a stream')
  .requiredOption('-s, --screen <number>', 'Screen number')
  .action(async (options) => {
    try {
      const response = await fetch(`${API_URL}/streams/${options.screen}`, {
        method: 'DELETE'
      });
      const result = await handleResponse(response);
      console.log(chalk.green('Stream stopped:'), result);
    } catch (error) {
      console.error(chalk.red('Error:'), error);
    }
  });

// Screen Management Commands
program
  .command('enable-screen')
  .description('Enable a screen')
  .requiredOption('-s, --screen <number>', 'Screen number')
  .action(async (options) => {
    try {
      const response = await fetch(`${API_URL}/screens/${options.screen}/enable`, {
        method: 'POST'
      });
      const result = await handleResponse(response);
      console.log(chalk.green('Screen enabled:'), result);
    } catch (error) {
      console.error(chalk.red('Error:'), error);
    }
  });

program
  .command('disable-screen')
  .description('Disable a screen')
  .requiredOption('-s, --screen <number>', 'Screen number')
  .action(async (options) => {
    try {
      const screenNumber = parseInt(options.screen);
      const response = await fetch(`${API_URL}/screens/${screenNumber}/disable`, {
        method: 'POST'
      });
      const result = await handleResponse(response);
      console.log(chalk.green('Screen disabled:'), result);
    } catch (error) {
      console.error(chalk.red('Error:'), error);
    }
  });

program
  .command('get-screen')
  .description('Get current screen information')
  .argument('<screen>', 'Screen number')
  .action(async (screen) => {
    try {
      const screenNumber = parseInt(screen);
      const response = await fetch(`${API_URL}/screens/${screenNumber}`);
      const screenInfo = await handleResponse(response);
      console.log(chalk.blue(`Screen ${screenNumber} Information:`));
      console.log(JSON.stringify(screenInfo, null, 2));
    } catch (error) {
      console.error(chalk.red('Error:'), error);
    }
  });

// Queue Management Commands
program
  .command('show-queue')
  .description('Show queue for a screen')
  .argument('<screen>', 'Screen number')
  .action(async (screen) => {
    try {
      const screenNumber = parseInt(screen);
      const response = await fetch(`${API_URL}/streams/queue/${screenNumber}`);
      const queue = await handleResponse<Stream[]>(response);
      console.log(chalk.blue(`Queue for Screen ${screenNumber}:`));
      queue.forEach((stream, index) => {
        console.log(chalk.green(`\n${index + 1}. ${stream.title || 'Untitled'}`));
        console.log(`URL: ${stream.url}`);
      });
    } catch (error) {
      console.error(chalk.red('Error:'), error);
    }
  });

program
  .command('reorder-queue')
  .description('Reorder queue items')
  .requiredOption('-s, --screen <number>', 'Screen number')
  .requiredOption('-f, --from <number>', 'Source index')
  .requiredOption('-t, --to <number>', 'Target index')
  .action(async (options) => {
    try {
      const response = await fetch(`${API_URL}/streams/reorder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          screen: parseInt(options.screen),
          sourceIndex: parseInt(options.from),
          targetIndex: parseInt(options.to)
        })
      });
      const result = await handleResponse(response);
      console.log(chalk.green('Queue reordered:'), result);
    } catch (error) {
      console.error(chalk.red('Error:'), error);
    }
  });

// Stream Category Commands
program
  .command('list-vtubers')
  .description('List VTuber streams')
  .option('-l, --limit <number>', 'Number of streams to fetch', '20')
  .action(async (options) => {
    try {
      const response = await fetch(`${API_URL}/streams/vtubers?limit=${options.limit}`);
      const streams = await handleResponse<Stream[]>(response);
      console.log(chalk.blue('\nVTuber Streams:'));
      streams.forEach((stream) => {
        console.log(chalk.green(`\n${stream.title || 'Untitled'}`));
        console.log(`URL: ${stream.url}`);
      });
    } catch (error) {
      console.error(chalk.red('Error:'), error);
    }
  });

program
  .command('list-japanese')
  .description('List Japanese streams')
  .option('-l, --limit <number>', 'Number of streams to fetch', '20')
  .action(async (options) => {
    try {
      const response = await fetch(`${API_URL}/streams/japanese?limit=${options.limit}`);
      const streams = await handleResponse<Stream[]>(response);
      console.log(chalk.blue('\nJapanese Streams:'));
      streams.forEach((stream) => {
        console.log(chalk.green(`\n${stream.title || 'Untitled'}`));
        console.log(`URL: ${stream.url}`);
      });
    } catch (error) {
      console.error(chalk.red('Error:'), error);
    }
  });

// Player Control Commands
program
  .command('set-priority')
  .description('Set player priority')
  .requiredOption('-p, --priority <level>', 'Priority level (realtime, high, above_normal, normal, below_normal, low, idle)')
  .action(async (options) => {
    try {
      const response = await fetch(`${API_URL}/player/priority`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ priority: options.priority })
      });
      const result = await handleResponse(response);
      console.log(chalk.green('Priority set:'), result);
    } catch (error) {
      console.error(chalk.red('Error:'), error);
    }
  });

program
  .command('send-command')
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

program
  .command('pause')
  .description('Toggle pause')
  .argument('<screen>', 'Screen number')
  .action(async (screen) => {
    try {
      const screenNumber = parseInt(screen);
      const response = await fetch(`${API_URL}/player/command/${screenNumber}`, {
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

// Watched Streams Commands
program
  .command('show-watched')
  .description('Show watched streams')
  .action(async () => {
    try {
      const response = await fetch(`${API_URL}/streams/watched`);
      const watched = await handleResponse<string[]>(response);
      console.log(chalk.blue('\nWatched Streams:'));
      watched.forEach((url, index) => {
        console.log(chalk.green(`${index + 1}. ${url}`));
      });
    } catch (error) {
      console.error(chalk.red('Error:'), error);
    }
  });

program
  .command('clear-watched')
  .description('Clear watched streams history')
  .action(async () => {
    try {
      const response = await fetch(`${API_URL}/streams/watched`, {
        method: 'DELETE'
      });
      const result = await handleResponse(response);
      console.log(chalk.green('Watched streams cleared:'), result);
    } catch (error) {
      console.error(chalk.red('Error:'), error);
    }
  });

// Stream Control Commands
program
  .command('restart-streams')
  .description('Restart streams')
  .option('-s, --screen <number>', 'Screen number (optional)')
  .action(async (options) => {
    try {
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

// Server Control Commands
program
  .command('stop-server')
  .description('Stop the server')
  .action(async () => {
    try {
      const response = await fetch(`${API_URL}/server/stop`, {
        method: 'POST'
      });
      const result = await handleResponse(response);
      console.log(chalk.green('Server stopping:'), result);
    } catch (error) {
      console.error(chalk.red('Error:'), error);
    }
  });

// Remove the volume command since sendControlCommand is not defined
program
  .command('volume')
  .description('Set volume (0-100)')
  .argument('<screen>', 'Screen number')
  .argument('<level>', 'Volume level (0-100)')
  .action(async (screen, level) => {
    try {
      const screenNumber = parseInt(screen);
      const volumeLevel = parseInt(level);
      const response = await fetch(`${API_URL}/player/command/${screenNumber}`, {
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

// Set debug mode if flag is present
const options = program.opts();
if (options.debug) {
  logger.setLevel('debug');
  logger.debug('Debug mode enabled', 'CLI');
}

// Parse command line arguments
program.parse(process.argv);