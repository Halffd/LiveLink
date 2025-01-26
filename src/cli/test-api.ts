#!/usr/bin/env node
import { program } from 'commander';
import fetch, { Response } from 'node-fetch';
import chalk from 'chalk';
import type { Stream, StreamSource, StreamResponse } from '../types/stream';

const API_URL = 'http://localhost:3001/api';

async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

program
  .version('1.0.0')
  .description('CLI tool for testing LiveLink API');

program
  .command('list-streams')
  .description('List all active streams')
  .action(async () => {
    try {
      const streams = await fetch(`${API_URL}/streams`)
        .then(res => handleResponse<Stream[]>(res));

      console.log(chalk.blue('Active Streams:'));
      streams.forEach((stream) => {
        console.log(chalk.green(`\nScreen ${stream.screen}:`));
        console.log(`URL: ${stream.url}`);
        console.log(`Quality: ${stream.quality}`);
        if (stream.title) console.log(`Title: ${stream.title}`);
      });
    } catch (error) {
      console.error(chalk.red('Error fetching streams:'), error);
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
      const response = await fetch(`${API_URL}/streams`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: options.url,
          quality: options.quality,
          screen: parseInt(options.screen),
          windowMaximized: true
        })
      });
      const result = await response.json();
      console.log(chalk.green('Stream started:'), result);
    } catch (error) {
      console.error(chalk.red('Error starting stream:'), error);
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
      const result = await response.json();
      console.log(chalk.green('Stream stopped:'), result);
    } catch (error) {
      console.error(chalk.red('Error stopping stream:'), error);
    }
  });

program
  .command('list-vtubers')
  .description('List VTuber streams')
  .option('-l, --limit <number>', 'Number of streams to fetch', '20')
  .action(async (options) => {
    try {
      const response = await fetch(`${API_URL}/streams/vtubers?limit=${options.limit}`);
      const streams = await response.json();
      console.log(chalk.blue('\nVTuber Streams:'));
      streams.forEach((stream: any) => {
        console.log(chalk.green(`\n${stream.title}`));
        console.log(`URL: ${stream.url}`);
        console.log(`Viewers: ${stream.viewerCount?.toLocaleString()}`);
      });
    } catch (error) {
      console.error(chalk.red('Error fetching VTuber streams:'), error);
    }
  });

program.parse(process.argv); 