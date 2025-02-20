import { get } from 'svelte/store';
import { locale, t, type Locale } from './index.js';

export function useTranslation() {
  return {
    t,
    locale,
    setLocale: (newLocale: Locale) => locale.set(newLocale),
    getLocale: () => get(locale)
  };
}

export function getLocaleFromPath(path: string): Locale {
  const lang = path.split('/')[1];
  return (lang === 'en' || lang === 'ja') ? lang as Locale : 'en';
} 