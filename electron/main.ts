import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import * as path from 'path';
import * as url from 'url';
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as net from 'net';

let mainWindow: BrowserWindow | null = null;
let serverProcess: childProcess.ChildProcess | null = null;
let isServerStarting = false;

// Check if server is running on the specified port
function isServerRunning(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const test = net.createConnection({ port });

    test.on('connect', () => {
      test.end();
      resolve(true);
    });

    test.on('error', () => {
      resolve(false);
    });
  });
}

// Build and start the LiveLink server process
async function startServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (isServerStarting) {
      reject(new Error('Server is already starting'));
      return;
    }

    isServerStarting = true;

    console.log('Building server...');
    
    // First, build the server (this may take some time)
    const buildProcess = childProcess.spawn('npm', ['run', 'build:server'], {
      cwd: app.getAppPath(),
      stdio: 'pipe',
      shell: true,
    });

    let buildOutput = '';
    buildProcess.stdout?.on('data', (data) => {
      buildOutput += data.toString();
      console.log(`Build: ${data}`);
    });

    buildProcess.stderr?.on('data', (data) => {
      buildOutput += data.toString();
      console.error(`Build error: ${data}`);
    });

    buildProcess.on('close', (code) => {
      if (code !== 0) {
        console.error(`Build failed with code: ${code}`);
        console.error('Build output:', buildOutput);
        isServerStarting = false;
        reject(new Error(`Server build failed with code ${code}`));
        return;
      }

      console.log('Server built successfully, starting server process...');
      
      // Now start the server
      serverProcess = childProcess.spawn('node', ['dist/server/api.js'], {
        cwd: app.getAppPath(),
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'], // Include IPC
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } // Pass through environment
      });

      if (serverProcess.stdout) {
        serverProcess.stdout.on('data', (data) => {
          console.log(`Server: ${data.toString()}`);
        });
      }

      if (serverProcess.stderr) {
        serverProcess.stderr.on('data', (data) => {
          console.error(`Server error: ${data.toString()}`);
        });
      }

      serverProcess.on('error', (err) => {
        console.error('Server process error:', err);
        isServerStarting = false;
        reject(err);
      });

      serverProcess.on('close', (code) => {
        console.log(`Server process exited with code ${code}`);
        isServerStarting = false;
        serverProcess = null;
      });

      // Wait for server to be ready (check periodically)
      const checkServerReady = async () => {
        const running = await isServerRunning(3001); // Default port from api.ts
        if (running) {
          isServerStarting = false;
          console.log('Server is ready');
          resolve();
        } else {
          setTimeout(checkServerReady, 500);
        }
      };

      setTimeout(() => {
        // If server doesn't start within 30 seconds, consider it failed
        if (isServerStarting) {
          isServerStarting = false;
          reject(new Error('Server failed to start within 30 seconds'));
          if (serverProcess) {
            serverProcess.kill();
            serverProcess = null;
          }
        }
      }, 30000); // 30 second timeout

      checkServerReady();
    });
  });
}

// Create the main window
function createWindow() {
  mainWindow = new BrowserWindow({
    title: 'LiveLink',
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    icon: path.join(__dirname, '../build/icons/icon.png'), // TODO: Add icon
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // Determine the URL to load - load the server URL 
  // Since SvelteKit with adapter-node serves the frontend from the same server
  const startUrl = process.env.ELECTRON_START_URL || 'http://localhost:3001';
  
  mainWindow.loadURL(startUrl);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Open external links in default browser
  mainWindow.webContents.setWindowOpenHandler((details) => {
    require('electron').shell.openExternal(details.url);
    return { action: 'deny' };
  });
}

// Check server status and start if needed
async function checkAndStartServer(): Promise<boolean> {
  try {
    const isRunning = await isServerRunning(3001);
    if (!isRunning) {
      console.log('Server is not running, attempting to start...');
      await startServer();
      return true;
    }
    console.log('Server is already running');
    return false; // Server was already running
  } catch (error) {
    console.error('Error checking/starting server:', error);
    dialog.showErrorBox('Server Error', `Failed to start server: ${(error as Error).message}`);
    return false;
  }
}

// Handle app ready
app.on('ready', async () => {
  // Check if server is running, start if needed
  await checkAndStartServer();
  
  // Wait a bit for server to fully start before creating window
  setTimeout(createWindow, 1000);
  
  app.on('activate', function () {
    if (mainWindow === null) {
      createWindow();
    }
  });
});

// Clean shutdown
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  // Clean up server process if it's running
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill();
  }
});

// IPC handlers for server management
ipcMain.handle('check-server-status', async () => {
  return await isServerRunning(3001);
});

ipcMain.handle('start-server', async () => {
  if (await isServerRunning(3001)) {
    return { success: true, message: 'Server already running' };
  }
  try {
    await startServer();
    return { success: true, message: 'Server started successfully' };
  } catch (error) {
    return { success: false, message: (error as Error).message };
  }
});

ipcMain.handle('stop-server', () => {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill();
    serverProcess = null;
    return { success: true, message: 'Server stopped' };
  }
  return { success: true, message: 'No server running to stop' };
});