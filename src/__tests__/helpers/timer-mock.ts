/**
 * Timer mock for testing time-based operations
 * 
 * This utility allows precise control over timers in tests by:
 * 1. Replacing setTimeout/setInterval with controlled versions
 * 2. Allowing manual advancement of time
 * 3. Tracking all timer operations for verification
 */

type TimerFunction = (...args: any[]) => void;

interface MockTimer {
  id: number;
  callback: TimerFunction;
  delay: number;
  args: any[];
  type: 'timeout' | 'interval';
  scheduledTime: number;
  callCount: number;
  isCleared: boolean;
}

export class TimerMock {
  private timers: Map<number> = new Map();
  private timerCounter: number = 1;
  private currentTime: number = 0;
  private originalSetTimeout: typeof setTimeout;
  private originalClearTimeout: typeof clearTimeout;
  private originalSetInterval: typeof setInterval;
  private originalClearInterval: typeof clearInterval;
  private originalDateNow: typeof Date.now;

  constructor() {
    // Store original timer functions
    this.originalSetTimeout = global.setTimeout;
    this.originalClearTimeout = global.clearTimeout;
    this.originalSetInterval = global.setInterval;
    this.originalClearInterval = global.clearInterval;
    this.originalDateNow = Date.now;
  }

  /**
   * Install mock timers
   */
  install(): void {
    // Replace global timer functions with mocks
    global.setTimeout = this.mockSetTimeout.bind(this);
    global.clearTimeout = this.mockClearTimeout.bind(this);
    global.setInterval = this.mockSetInterval.bind(this);
    global.clearInterval = this.mockClearInterval.bind(this);
    Date.now = () => this.currentTime;
  }

  /**
   * Restore original timer functions
   */
  restore(): void {
    global.setTimeout = this.originalSetTimeout;
    global.clearTimeout = this.originalClearTimeout;
    global.setInterval = this.originalSetInterval;
    global.clearInterval = this.originalClearInterval;
    Date.now = this.originalDateNow;
  }

  /**
   * Reset all timers and time
   */
  reset(): void {
    this.timers.clear();
    this.timerCounter = 1;
    this.currentTime = 0;
  }

  /**
   * Mock implementation of setTimeout
   */
  private mockSetTimeout(callback: TimerFunction, delay: number, ...args: any[]): NodeJS.Timeout {
    const id = this.timerCounter++;
    
    this.timers.set(id, {
      id,
      callback,
      delay,
      args,
      type: 'timeout',
      scheduledTime: this.currentTime + delay,
      callCount: 0,
      isCleared: false
    });
    
    return id as unknown as NodeJS.Timeout;
  }

  /**
   * Mock implementation of clearTimeout
   */
  private mockClearTimeout(id: NodeJS.Timeout): void {
    const numericId = id as unknown as number;
    const timer = this.timers.get(numericId);
    
    if (timer) {
      timer.isCleared = true;
    }
  }

  /**
   * Mock implementation of setInterval
   */
  private mockSetInterval(callback: TimerFunction, delay: number, ...args: any[]): NodeJS.Timeout {
    const id = this.timerCounter++;
    
    this.timers.set(id, {
      id,
      callback,
      delay,
      args,
      type: 'interval',
      scheduledTime: this.currentTime + delay,
      callCount: 0,
      isCleared: false
    });
    
    return id as unknown as NodeJS.Timeout;
  }

  /**
   * Mock implementation of clearInterval
   */
  private mockClearInterval(id: NodeJS.Timeout): void {
    this.mockClearTimeout(id);
  }

  /**
   * Advance time by the specified amount and run due timers
   * @param ms Milliseconds to advance
   */
  advanceTime(ms: number): void {
    const targetTime = this.currentTime + ms;
    this.runTimersToTime(targetTime);
    this.currentTime = targetTime;
  }

  /**
   * Run all timers that are due by the target time
   * @param targetTime Target time to run timers up to
   */
  private runTimersToTime(targetTime: number): void {
    // Get all timers sorted by scheduled time
    const sortedTimers = Array.from(this.timers.values())
      .filter(timer => !timer.isCleared)
      .sort((a, b) => a.scheduledTime - b.scheduledTime);
    
    for (const timer of sortedTimers) {
      if (timer.isCleared || timer.scheduledTime > targetTime) {
        continue;
      }
      
      // Set current time to the timer's scheduled time
      this.currentTime = timer.scheduledTime;
      
      // Execute the timer callback
      timer.callback(...timer.args);
      timer.callCount++;
      
      // For intervals, reschedule
      if (timer.type === 'interval') {
        timer.scheduledTime = this.currentTime + timer.delay;
      } else {
        timer.isCleared = true;
      }
    }
  }

  /**
   * Run all pending timers immediately
   */
  runAllTimers(): void {
    // Find the latest scheduled timer
    const latestTimer = Array.from(this.timers.values())
      .filter(timer => !timer.isCleared)
      .reduce((latest, timer) => {
        return timer.scheduledTime > latest ? timer.scheduledTime : latest;
      }, this.currentTime);
    
    this.runTimersToTime(latestTimer);
    this.currentTime = latestTimer;
  }

  /**
   * Run only pending timers, but not newly created ones
   */
  runOnlyPendingTimers(): void {
    const pendingTimers = Array.from(this.timers.values())
      .filter(timer => !timer.isCleared && timer.scheduledTime > this.currentTime);
    
    const timerIds = new Set(pendingTimers.map(timer => timer.id));
    
    let timer: MockTimer | undefined;
    while ((timer = this.getNextTimer()) !== undefined) {
      if (!timerIds.has(timer.id)) {
        continue;
      }
      
      this.currentTime = timer.scheduledTime;
      
      if (!timer.isCleared) {
        timer.callback(...timer.args);
        timer.callCount++;
        
        if (timer.type === 'interval') {
          timer.scheduledTime = this.currentTime + timer.delay;
        } else {
          timer.isCleared = true;
        }
      }
    }
  }

  /**
   * Get the next timer that should be executed
   */
  private getNextTimer(): MockTimer | undefined {
    let nextTimer: MockTimer | undefined;
    let nextTime = Infinity;
    
    for (const timer of this.timers.values()) {
      if (!timer.isCleared && timer.scheduledTime < nextTime) {
        nextTime = timer.scheduledTime;
        nextTimer = timer;
      }
    }
    
    return nextTimer;
  }

  /**
   * Get all active timers
   */
  getTimers(): MockTimer[] {
    return Array.from(this.timers.values())
      .filter((timer: MockTimer) => !timer.isCleared);
  }

  /**
   * Get the current mock time
   */
  getCurrentTime(): number {
    return this.currentTime;
  }

  /**
   * Set the current mock time
   */
  setCurrentTime(time: number): void {
    this.currentTime = time;
  }
}
