import type { Handle } from '@sveltejs/kit';
import { locale } from '$lib/i18n/index.js';
import type { Locale } from '$lib/i18n/index.js';

export const handle: Handle = async ({ event, resolve }) => {
  // Get locale from URL or default to 'en'
  const lang = event.url.pathname.split('/')[1];
  const validLocale = (lang === 'en' || lang === 'ja') ? lang as Locale : 'en';
  locale.set(validLocale);

  return resolve(event);
};
