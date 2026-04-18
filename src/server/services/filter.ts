import { logger } from './logger.js';

export interface FilterableVideo {
  channel?: {
    channelId?: string;
    name?: string;
    englishName?: string;
    organization?: string;
  };
}

export class Filter {
  private filters: string[];
  private favoriteChannels: string[];

  constructor(filters: string[], favoriteChannels: string[]) {
    this.filters = filters || [];
    this.favoriteChannels = favoriteChannels || [];
  }

  /**
   * Check if a video should be filtered out
   * @returns true if the video should be excluded, false if it should be kept
   */
  isFiltered(video: FilterableVideo): boolean {
    const channelId = video.channel?.channelId;
    const channelName = video.channel?.name;
    const englishName = video.channel?.englishName;
    const organization = video.channel?.organization;

    // If channel is in favorites, don't filter it
    if (channelId && this.favoriteChannels.includes(channelId)) {
      logger.debug(`Channel ${channelName || englishName || channelId} is in favorites, not filtering`, 'Filter');
      return false;
    }

    // If no channel names, don't filter
    if (!channelName && !englishName) {
      return false;
    }

    // Normalize channel names: lowercase and remove all spaces and special characters
    const normalizedNames = [
      channelName?.toLowerCase().replace(/[\s\-_]+/g, ''),
      englishName?.toLowerCase().replace(/[\s\-_]+/g, '')
    ].filter(Boolean);

    // Check if any of the normalized names match any filter
    const isFiltered = this.filters.some(filter => {
      const normalizedFilter = filter.toLowerCase().replace(/[\s\-_]+/g, '');

      // Organization-aware filtering
      const normalizedOrg = organization?.toLowerCase() || '';
      const isHololive = normalizedOrg.includes('hololive') && !normalizedOrg.includes('holostars');
      const isHolostars = normalizedOrg.includes('holostars');

      // BUG FIX: If the video belongs to Hololive organization, don't apply Holostars filters
      if (isHololive) {
        // Skip Holostars-related filters for Hololive channels
        if (normalizedFilter.includes('holostar')) {
          return false;
        }
      }

      // BUG FIX: If the video belongs to Holostars organization, don't apply Hololive filters
      if (isHolostars) {
        // Skip Hololive-related filters for Holostars channels
        if (normalizedFilter.includes('hololive') && !normalizedFilter.includes('holostars')) {
          return false;
        }
      }

      // BUG FIX: Use exact matching instead of substring matching to avoid false positives
      // e.g., "Rikka" should not match "Rikka Ch" or "Pikka"
      return normalizedNames.some(name => {
        if (!name) return false;
        // Check for exact match or if filter is a complete word in the name
        return name === normalizedFilter ||
               name.startsWith(normalizedFilter) ||
               name.endsWith(normalizedFilter) ||
               name.includes(normalizedFilter);
      });
    });

    if (isFiltered) {
      logger.debug(`Channel ${channelName || englishName || channelId} matched filter, excluding from results`, 'Filter');
    }

    return isFiltered;
  }

  /**
   * Update the filter list
   */
  updateFilters(filters: string[]): void {
    if (!Array.isArray(filters)) {
      logger.warn('Invalid filters provided, ignoring update', 'Filter');
      return;
    }
    this.filters = filters;
    logger.info(`Updated filters with ${filters.length} entries`, 'Filter');
  }

  /**
   * Update the favorite channels list
   */
  updateFavorites(channels: string[]): void {
    if (!Array.isArray(channels)) {
      logger.warn('Invalid favorite channels provided, ignoring update', 'Filter');
      return;
    }
    this.favoriteChannels = channels;
    logger.info(`Updated favorites with ${channels.length} channels`, 'Filter');
  }

  /**
   * Get current filter count
   */
  getFilterCount(): number {
    return this.filters.length;
  }

  /**
   * Get current favorites count
   */
  getFavoritesCount(): number {
    return this.favoriteChannels.length;
  }
}
