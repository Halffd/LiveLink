import { parentPort } from 'worker_threads';
import { GlobalKeyboardListener } from 'node-global-key-listener';
import { execSync } from 'child_process';

function checkInputPermissions() {
  try {
    // Check if user has access to input devices
    const result = execSync('ls -l /dev/input/event* 2>/dev/null || true', { encoding: 'utf8' });
    const hasAccess = result.split('\n').some(line => 
      line.includes(`input`) || line.includes(process.env.USER || '')
    );
    
    if (!hasAccess) {
      throw new Error('No access to input devices. Please run: sudo usermod -a -G input $USER');
    }

    // Check if uinput module is loaded
    const modules = execSync('lsmod | grep uinput || true', { encoding: 'utf8' });
    if (!modules.includes('uinput')) {
      throw new Error('uinput module not loaded. Please run: sudo modprobe uinput');
    }

    // Check if streamlink is installed
    try {
      execSync('which streamlink', { encoding: 'utf8' });
    } catch (error) {
      throw new Error('streamlink is not installed. Please install it with: sudo pacman -S streamlink');
    }

    return true;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Permission check failed: ${errorMessage}`);
  }
}

try {
  // Check permissions first
  checkInputPermissions();

  // Initialize keyboard listener with minimal configuration
  const keyboard = new GlobalKeyboardListener({
    x11: {
      onError: (errorCode) => {
        if (errorCode !== null) {
          parentPort?.postMessage({ 
            type: 'error', 
            error: `X11 keyboard error: ${errorCode}. Please ensure you have the correct permissions:
1. Add user to input group: sudo usermod -a -G input $USER
2. Load uinput module: sudo modprobe uinput
3. Set permissions: sudo chmod 660 /dev/input/event*
4. Log out and log back in for group changes to take effect` 
          });
        }
      },
      onInfo: (data) => {
        parentPort?.postMessage({ 
          type: 'info', 
          data 
        });
      }
    }
  });

  keyboard.addListener((e, down) => {
    // Alt + L: Auto-start screen 1
    if (e.state === 'DOWN' && e.name === 'L' && (down['LEFT ALT'] || down['RIGHT ALT'])) {
      parentPort?.postMessage({ type: 'autostart', screen: 1 });
    }
    
    // Alt + K: Auto-start screen 2
    if (e.state === 'DOWN' && e.name === 'K' && (down['LEFT ALT'] || down['RIGHT ALT'])) {
      parentPort?.postMessage({ type: 'autostart', screen: 2 });
    }
    
    // Alt + F1: Close all players
    if (e.state === 'DOWN' && e.name === 'F1' && (down['LEFT ALT'] || down['RIGHT ALT'])) {
      parentPort?.postMessage({ type: 'closeall' });
    }

    // Return true to prevent the event from being propagated
    return true;
  });

  // Handle cleanup message from main thread
  parentPort?.on('message', (message) => {
    if (message === 'cleanup') {
      keyboard.kill();
      process.exit(0);
    }
  });

  // Notify main thread that initialization was successful
  parentPort?.postMessage({ type: 'ready' });
} catch (error) {
  parentPort?.postMessage({ 
    type: 'error', 
    error: error instanceof Error ? error.message : String(error)
  });
  process.exit(1);
} 