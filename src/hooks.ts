import { locale } from '$lib/i18n/index.js';

export const prerender = true;
export const trailingSlash = 'always';

// Initialize with default locale
locale.set('en');

// Add missing exports required by SvelteKit
export function reroute() {
  // This function is required by SvelteKit
  return null;
}

export function transport() {
  // This function is required by SvelteKit
  return null;
}
