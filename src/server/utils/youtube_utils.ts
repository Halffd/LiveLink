import { logger } from '../services/logger.js';
import https from 'https';

/**
 * Extracts the video ID from a YouTube URL
 * @param url YouTube URL
 * @returns Video ID or null if not a valid YouTube URL
 */
function extractVideoId(url: string): string | null {
  try {
    // Handle different YouTube URL formats
    const regExp = /^.*(?:youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|&v=)([^#&?]{11}).*/;
    const match = url.match(regExp);
    return match ? match[1] : null;
  } catch (error) {
    logger.error(`Error extracting video ID from URL: ${url}`, 'YouTubeUtils');
    return null;
  }
}

/**
 * Makes an HTTP request to check if a YouTube stream is live
 * @param videoId YouTube video ID
 * @returns Promise that resolves to true if the stream is live, false otherwise
 */
async function checkStreamStatus(videoId: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const options = {
      hostname: 'www.youtube.com',
      path: `/watch?v=${videoId}`,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'text/html',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
      },
      timeout: 5000, // 5 second timeout
    };

    const req = https.request(options, (res) => {
      // If we get a redirect, the stream is likely not live
      if (res.statusCode === 302 || res.statusCode === 301) {
        logger.debug(`YouTube returned redirect for video ${videoId}`, 'YouTubeUtils');
        resolve(false);
        return;
      }

      let data = '';
      res.setEncoding('utf8');
      
      // Process response in chunks
      res.on('data', (chunk) => {
        data += chunk;
        
        // Early exit if we find the live indicator
        if (data.includes('isLiveBroadcast')) {
          res.destroy();
          resolve(true);
          return;
        }
        
        // Prevent excessive memory usage
        if (data.length > 500000) { // ~500KB max
          res.destroy();
          logger.warn(`Response too large for video ${videoId}`, 'YouTubeUtils');
          resolve(false);
          return;
        }
      });
      
      res.on('end', () => {
        const isLive = data.includes('isLiveBroadcast');
        logger.debug(`Stream check for video ${videoId}: ${isLive ? 'LIVE' : 'NOT LIVE'}`, 'YouTubeUtils');
        resolve(isLive);
      });
    });

    req.on('error', (error) => {
      logger.warn(`Request error for video ${videoId}: ${error.message}`, 'YouTubeUtils');
      resolve(false);
    });

    req.setTimeout(5000, () => {
      req.destroy();
      logger.warn(`Request timeout for video ${videoId}`, 'YouTubeUtils');
      resolve(false);
    });

    req.end();
  });
}

/**
 * Checks if a YouTube stream is live
 * @param url YouTube URL
 * @returns Promise that resolves to true if the stream is live, false otherwise
 */
export async function isYouTubeStreamLive(url: string): Promise<boolean> {
  const startTime = Date.now();
  
  try {
    const videoId = extractVideoId(url);
    if (!videoId) {
      logger.warn(`Invalid YouTube URL: ${url}`, 'YouTubeUtils');
      return false;
    }

    logger.debug(`Checking if YouTube stream is live: ${url}`, 'YouTubeUtils');
    
    // Try up to 2 times in case of temporary failures
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const isLive = await checkStreamStatus(videoId);
        const elapsed = Date.now() - startTime;
        logger.info(`YouTube stream check for ${url}: ${isLive ? 'LIVE' : 'NOT LIVE'} (${elapsed}ms)`, 'YouTubeUtils');
        return isLive;
      } catch (error) {
        if (attempt === 2) throw error; // Only throw on the last attempt
        logger.warn(`Attempt ${attempt} failed, retrying...`, 'YouTubeUtils');
        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1s between retries
      }
    }
    
    return false; // Should never reach here due to throw above
  } catch (error) {
    const elapsed = Date.now() - startTime;
    logger.error(
      `Error checking YouTube stream (${elapsed}ms): ${error instanceof Error ? error.message : String(error)}`,
      'YouTubeUtils'
    );
    return false; // Default to false on error to avoid blocking streams
  }
}
