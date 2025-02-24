import { parentPort } from 'worker_threads';
import { GlobalKeyboardListener } from 'node-global-key-listener';

try {
  const keyboard = new GlobalKeyboardListener({
    x11: {
      // Disable automatic permission handling
      skipSudoPrompt: true,
      // Disable automatic input device detection
      skipDeviceInit: true,
      // Use a simpler event capture method
      useKeyboard: true,
      useMouseButtons: false,
      useMouseMove: false
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