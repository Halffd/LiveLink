#!/usr/bin/env node --no-warnings --loader ts-node/esm
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
  .version('1.0.0')
  .description('CLI tool for testing LiveLink API')
  .option('-d, --debug', 'Enable debug output');

// Set debug mode if flag is present
program.parse();
const options = program.opts();
if (options.debug) {
  logger.setLevel('debug');
  logger.debug('Debug mode enabled', 'CLI');
}

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
      const response = await fetch(`${API_URL}/screens/${options.screen}/disable`, {
        method: 'POST'
      });
      const result = await handleResponse(response);
      console.log(chalk.green('Screen disabled:'), result);
    } catch (error) {
      console.error(chalk.red('Error:'), error);
    }
  });

// Queue Management Commands
program
  .command('show-queue')
  .description('Show queue for a screen')
  .requiredOption('-s, --screen <number>', 'Screen number')
  .action(async (options) => {
    try {
      const response = await fetch(`${API_URL}/streams/queue/${options.screen}`);
      const queue = await handleResponse<Stream[]>(response);
      console.log(chalk.blue(`Queue for Screen ${options.screen}:`));
      queue.forEach((stream: Stream, index: number) => {
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

// Add these commands
program
  .command('volume <level>')
  .description('Set volume (0-100)')
  .option('-s, --screen <number>', 'Target screen')
  .option('-a, --all', 'All screens')
  .action(async (level, options) => {
    await sendControlCommand('volume', { level: parseInt(level) }, options);
  });

program
  .command('pause')
  .description('Toggle pause')
  .option('-s, --screen <number>', 'Target screen')
  .option('-a, --all', 'All screens')
  .action(async (options) => {
    await sendControlCommand('pause', {}, options);
  });

program
  .command('seek <seconds>')
  .description('Seek in seconds (+/- values)')
  .option('-s, --screen <number>', 'Target screen')
  .option('-a, --all', 'All screens')
  .action(async (seconds, options) => {
    await sendControlCommand('seek', { seconds: parseFloat(seconds) }, options);
  });

program.parse(process.argv); 

// Helper function
async function sendControlCommand(
  action: string,
  body: Record<string, unknown>,
  options: { screen?: string; all?: boolean }
) {
  try {
    const target = options.all ? 'all' : options.screen;
    if (!target) {
      console.error(chalk.red('Error:'), 'Specify --screen or --all');
      return;
    }

    const response = await fetch(`${API_URL}/player/${action}/${target}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    
    const result = await handleResponse(response);
    console.log(chalk.green('Success:'), result);
  } catch (error) {
    console.error(chalk.red('Error:'), error);
  }
} 