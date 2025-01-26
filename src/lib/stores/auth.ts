import { writable } from 'svelte/store';

interface TwitchUser {
  id: string;
  username: string;
  isAuthenticated: boolean;
}

export const twitchUser = writable<TwitchUser>({
  id: '',
  username: '',
  isAuthenticated: false
}); 