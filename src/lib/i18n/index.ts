import { writable, derived } from 'svelte/store';

export type Locale = 'en' | 'ja';

export const translations = {
  en: {
    welcome: 'Welcome to LiveLink',
    streams: 'Streams',
    settings: 'Settings',
    queue: 'Queue',
    connectTwitch: 'Connect Twitch',
    streamControl: {
      play: 'Play',
      pause: 'Pause',
      stop: 'Stop',
      volume: 'Volume',
      quality: 'Quality'
    },
    errors: {
      streamStart: 'Failed to start stream',
      streamStop: 'Failed to stop stream',
      connection: 'Connection error'
    }
  },
  ja: {
    welcome: 'LiveLinkへようこそ',
    streams: 'ストリーム',
    settings: '設定',
    queue: 'キュー',
    connectTwitch: 'Twitchと接続',
    streamControl: {
      play: '再生',
      pause: '一時停止',
      stop: '停止',
      volume: '音量',
      quality: '画質'
    },
    errors: {
      streamStart: 'ストリームの開始に失敗しました',
      streamStop: 'ストリームの停止に失敗しました',
      connection: '接続エラー'
    }
  }
} as const;

export type Translation = typeof translations;
export type TranslationKeys = keyof Translation['en'];

export const locale = writable<Locale>('en');

export const t = derived(locale, ($locale) => translations[$locale]); 