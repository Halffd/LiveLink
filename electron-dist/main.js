import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import * as path from 'path';
import * as childProcess from 'child_process';
import * as net from 'net';
let mainWindow = null;
let serverProcess = null;
let isServerStarting = false;
function isServerRunning(port) {
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
async function startServer() {
    return new Promise((resolve, reject) => {
        if (isServerStarting) {
            reject(new Error('Server is already starting'));
            return;
        }
        isServerStarting = true;
        console.log('Building server...');
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
            serverProcess = childProcess.spawn('node', ['dist/server/api.js'], {
                cwd: app.getAppPath(),
                stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
                env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
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
            const checkServerReady = async () => {
                const running = await isServerRunning(3001);
                if (running) {
                    isServerStarting = false;
                    console.log('Server is ready');
                    resolve();
                }
                else {
                    setTimeout(checkServerReady, 500);
                }
            };
            setTimeout(() => {
                if (isServerStarting) {
                    isServerStarting = false;
                    reject(new Error('Server failed to start within 30 seconds'));
                    if (serverProcess) {
                        serverProcess.kill();
                        serverProcess = null;
                    }
                }
            }, 30000);
            checkServerReady();
        });
    });
}
function createWindow() {
    mainWindow = new BrowserWindow({
        title: 'LiveLink',
        width: 1200,
        height: 800,
        minWidth: 800,
        minHeight: 600,
        icon: path.join(__dirname, '../build/icons/icon.png'),
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js'),
        },
    });
    const startUrl = process.env.ELECTRON_START_URL || 'http://localhost:3001';
    mainWindow.loadURL(startUrl);
    mainWindow.on('closed', () => {
        mainWindow = null;
    });
    mainWindow.webContents.setWindowOpenHandler((details) => {
        require('electron').shell.openExternal(details.url);
        return { action: 'deny' };
    });
}
async function checkAndStartServer() {
    try {
        const isRunning = await isServerRunning(3001);
        if (!isRunning) {
            console.log('Server is not running, attempting to start...');
            await startServer();
            return true;
        }
        console.log('Server is already running');
        return false;
    }
    catch (error) {
        console.error('Error checking/starting server:', error);
        dialog.showErrorBox('Server Error', `Failed to start server: ${error.message}`);
        return false;
    }
}
app.on('ready', async () => {
    await checkAndStartServer();
    setTimeout(createWindow, 1000);
    app.on('activate', function () {
        if (mainWindow === null) {
            createWindow();
        }
    });
});
app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});
app.on('before-quit', () => {
    if (serverProcess && !serverProcess.killed) {
        serverProcess.kill();
    }
});
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
    }
    catch (error) {
        return { success: false, message: error.message };
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
//# sourceMappingURL=main.js.map