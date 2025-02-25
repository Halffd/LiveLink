import type { HandleClientError } from '@sveltejs/kit';

// Cache for API responses
const apiCache = new Map<string, { data: any; timestamp: number }>();
const CACHE_TTL = 30000; // 30 seconds cache lifetime

// Debounce timers for API requests
const debounceTimers = new Map<string, NodeJS.Timeout>();
const DEBOUNCE_TIME = 300; // 300ms debounce time

// Handle client-side errors
export const handleError: HandleClientError = ({ error, event }) => {
  const errorId = crypto.randomUUID();
  
  // Log the error with a unique ID
  console.error(`[${errorId}] Client error:`, error);
  
  // Return a user-friendly error
  return {
    message: 'An unexpected error occurred',
    errorId
  };
};

// Add these functions to the window object for use in components
if (typeof window !== 'undefined') {
  // Cached fetch function to reduce API calls
  window.cachedFetch = async (url: string, options?: RequestInit) => {
    const cacheKey = `${options?.method || 'GET'}:${url}`;
    
    // Return cached data if it's still valid
    const cached = apiCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return { ...cached.data, fromCache: true };
    }
    
    // Make the actual fetch request
    const response = await fetch(url, options);
    
    // Only cache successful GET requests
    if (response.ok && (!options?.method || options.method === 'GET')) {
      try {
        const data = await response.clone().json();
        apiCache.set(cacheKey, { data, timestamp: Date.now() });
        return data;
      } catch (error) {
        console.warn('Failed to cache response:', error);
        return await response.json();
      }
    }
    
    return await response.json();
  };
  
  // Debounced fetch to prevent rapid API calls
  window.debouncedFetch = (url: string, options?: RequestInit) => {
    return new Promise((resolve, reject) => {
      const cacheKey = `${options?.method || 'GET'}:${url}`;
      
      // Clear existing timer
      if (debounceTimers.has(cacheKey)) {
        clearTimeout(debounceTimers.get(cacheKey));
      }
      
      // Set new timer
      debounceTimers.set(
        cacheKey,
        setTimeout(async () => {
          try {
            const response = await fetch(url, options);
            const data = await response.json();
            resolve(data);
          } catch (error) {
            reject(error);
          } finally {
            debounceTimers.delete(cacheKey);
          }
        }, DEBOUNCE_TIME)
      );
    });
  };
}

// Add type definitions
declare global {
  interface Window {
    cachedFetch: (url: string, options?: RequestInit) => Promise<any>;
    debouncedFetch: (url: string, options?: RequestInit) => Promise<any>;
  }
} 