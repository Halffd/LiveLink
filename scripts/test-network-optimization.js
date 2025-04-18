#!/usr/bin/env node

/**
 * Network Optimization Test Script
 * 
 * This script tests the performance of network-related code by simulating network
 * failures and measuring recovery time, resource usage, and stability.
 */

import { spawn } from 'child_process';
import { setTimeout } from 'timers/promises';
import fs from 'fs';
import path from 'path';

// Configuration
const TEST_DURATION = 5 * 60 * 1000; // 5 minutes
const NETWORK_DISCONNECT_INTERVAL = 30 * 1000; // 30 seconds
const NETWORK_DISCONNECT_DURATION = 10 * 1000; // 10 seconds
const METRICS_INTERVAL = 5 * 1000; // 5 seconds
const RESULTS_FILE = 'network-optimization-results.json';

// Track metrics
const metrics = {
  startTime: Date.now(),
  totalDisconnects: 0,
  recoveryTimes: [],
  resourceUsage: [],
  errors: [],
  disconnectTimestamps: [],
  reconnectTimestamps: []
};

// Start the server process
console.log('Starting server process for network testing...');
const serverProcess = spawn('node', ['dist/server/api.js'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, LOG_LEVEL: 'debug', NODE_ENV: 'test' }
});

let isDisconnected = false;
let disconnectTime = 0;
let intervalId;

// Handle server process output
serverProcess.stdout.on('data', (data) => {
  const output = data.toString();
  
  // Look for network-related log messages
  if (output.includes('Network connection lost')) {
    console.log('🔴 Network disconnection detected');
    disconnectTime = Date.now();
    metrics.disconnectTimestamps.push(disconnectTime);
  } else if (output.includes('Network connection restored')) {
    const reconnectTime = Date.now();
    const recoveryTime = reconnectTime - disconnectTime;
    console.log(`🟢 Network reconnection detected (recovery took ${recoveryTime}ms)`);
    metrics.reconnectTimestamps.push(reconnectTime);
    metrics.recoveryTimes.push(recoveryTime);
  } else if (output.includes('error') || output.includes('Error')) {
    console.error('❌ Server error:', output);
    metrics.errors.push({
      timestamp: Date.now(),
      message: output
    });
  }
});

serverProcess.stderr.on('data', (data) => {
  console.error('❌ Server error:', data.toString());
  metrics.errors.push({
    timestamp: Date.now(),
    message: data.toString()
  });
});

// Simulate network disconnects
async function simulateNetworkFailure() {
  if (isDisconnected) return;
  
  console.log('🔴 Simulating network disconnect...');
  isDisconnected = true;
  metrics.totalDisconnects++;
  
  // Send SIGUSR1 to server - we'll need to add a handler for this in our app
  // that simulates a network disconnect
  serverProcess.kill('SIGUSR1');
  
  // Wait for disconnect duration
  await setTimeout(NETWORK_DISCONNECT_DURATION);
  
  // Reconnect network
  console.log('🟢 Simulating network reconnect...');
  isDisconnected = false;
  
  // Send SIGUSR2 to server - we'll need to add a handler for this in our app
  // that simulates a network reconnect
  serverProcess.kill('SIGUSR2');
}

// Collect resource usage metrics
function collectMetrics() {
  const usage = process.memoryUsage();
  const cpuUsage = process.cpuUsage();
  
  metrics.resourceUsage.push({
    timestamp: Date.now(),
    memory: {
      rss: usage.rss / 1024 / 1024, // MB
      heapTotal: usage.heapTotal / 1024 / 1024, // MB
      heapUsed: usage.heapUsed / 1024 / 1024, // MB
      external: usage.external / 1024 / 1024, // MB
    },
    cpu: {
      user: cpuUsage.user,
      system: cpuUsage.system
    }
  });
}

// Start the test
async function runTest() {
  console.log(`🧪 Starting network optimization test (duration: ${TEST_DURATION / 60000} minutes)`);
  
  // Wait for server to start up
  await setTimeout(5000);
  
  // Start metrics collection
  const metricsIntervalId = setInterval(collectMetrics, METRICS_INTERVAL);
  
  // Schedule network disconnects
  intervalId = setInterval(simulateNetworkFailure, NETWORK_DISCONNECT_INTERVAL);
  
  // Run for test duration
  await setTimeout(TEST_DURATION);
  
  // Clean up
  clearInterval(intervalId);
  clearInterval(metricsIntervalId);
  
  // Stop the server
  console.log('🛑 Stopping server process...');
  serverProcess.kill();
  
  // Wait for server to shut down
  await setTimeout(2000);
  
  // Save results
  saveResults();
  
  console.log(`✅ Test completed. Results saved to ${RESULTS_FILE}`);
  process.exit(0);
}

// Save test results
function saveResults() {
  const results = {
    ...metrics,
    summary: {
      duration: Date.now() - metrics.startTime,
      averageRecoveryTime: metrics.recoveryTimes.reduce((sum, time) => sum + time, 0) / metrics.recoveryTimes.length,
      maxRecoveryTime: Math.max(...metrics.recoveryTimes),
      minRecoveryTime: Math.min(...metrics.recoveryTimes),
      totalErrors: metrics.errors.length,
      averageMemoryUsage: metrics.resourceUsage.reduce((sum, m) => sum + m.memory.heapUsed, 0) / metrics.resourceUsage.length
    }
  };
  
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
  
  // Print summary
  console.log('\n📊 Test Summary:');
  console.log(`Total test duration: ${results.summary.duration / 1000} seconds`);
  console.log(`Number of simulated disconnects: ${metrics.totalDisconnects}`);
  console.log(`Average recovery time: ${results.summary.averageRecoveryTime.toFixed(2)}ms`);
  console.log(`Max recovery time: ${results.summary.maxRecoveryTime}ms`);
  console.log(`Min recovery time: ${results.summary.minRecoveryTime}ms`);
  console.log(`Total errors: ${results.summary.totalErrors}`);
  console.log(`Average memory usage: ${results.summary.averageMemoryUsage.toFixed(2)}MB`);
}

// Handle process termination
process.on('SIGINT', async () => {
  console.log('⚠️ Test interrupted');
  clearInterval(intervalId);
  serverProcess.kill();
  await setTimeout(1000);
  saveResults();
  process.exit(0);
});

// Start the test
runTest().catch(err => {
  console.error('Test failed:', err);
  serverProcess.kill();
  process.exit(1);
}); 