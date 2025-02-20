import type { BaseTranslation } from 'typesafe-i18n';

export type Translations = {
  welcome: string;
  streams: string;
  settings: string;
  queue: string;
  connectTwitch: string;
  streamControl: {
    play: string;
    pause: string;
    stop: string;
    volume: string;
    quality: string;
  };
  errors: {
    streamStart: string;
    streamStop: string;
    connection: string;
  };
}

export type Translation = {
  [K in 'en' | 'ja']: Translations;
}

export type Formatters = {}
export type Locales = keyof Translation; 