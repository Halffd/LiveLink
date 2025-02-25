<script lang="ts">
  import { api } from '$lib/api';
  import type { Stream } from '../types/stream.js';

  let { stream } = $props<{
    stream: Stream;
  }>();

  let volume = $state(50);
  let seeking = $state(false);
  let error = $state<string | null>(null);

  async function handleVolumeChange(event: Event) {
    const target = event.target as HTMLInputElement;
    const newVolume = parseInt(target.value);
    try {
      await api.setVolume(stream.screen, newVolume);
      volume = newVolume;
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to set volume';
      setTimeout(() => error = null, 3000);
    }
  }

  async function togglePause() {
    try {
      await api.togglePause(stream.screen);
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to toggle pause';
      setTimeout(() => error = null, 3000);
    }
  }

  async function handleSeek(seconds: number) {
    if (seeking) return;
    seeking = true;
    try {
      await api.seek(stream.screen, seconds);
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to seek';
      setTimeout(() => error = null, 3000);
    } finally {
      seeking = false;
    }
  }

  async function restartStream() {
    try {
      await api.restartStream(stream.screen);
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to restart stream';
      setTimeout(() => error = null, 3000);
    }
  }
</script>

<div class="flex items-center space-x-4 bg-gray-800 p-4 rounded-lg">
  {#if error}
    <div class="absolute top-0 right-0 m-4 bg-red-500 text-white px-4 py-2 rounded shadow">
      {error}
    </div>
  {/if}

  <button
    class="p-2 hover:bg-gray-700 rounded"
    on:click={togglePause}
    title="Play/Pause"
  >
    <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-width="2"
        d="M14 5l7 7m0 0l-7 7m7-7H3"
      />
    </svg>
  </button>

  <div class="flex items-center space-x-2">
    <button
      class="p-2 hover:bg-gray-700 rounded"
      on:click={() => handleSeek(-10)}
      title="Rewind 10s"
      disabled={seeking}
    >
      <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width="2"
          d="M12.066 11.2a1 1 0 000 1.6l5.334 4A1 1 0 0019 16V8a1 1 0 00-1.6-.8l-5.333 4zM4.066 11.2a1 1 0 000 1.6l5.334 4A1 1 0 0011 16V8a1 1 0 00-1.6-.8l-5.334 4z"
        />
      </svg>
    </button>

    <button
      class="p-2 hover:bg-gray-700 rounded"
      on:click={() => handleSeek(10)}
      title="Forward 10s"
      disabled={seeking}
    >
      <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width="2"
          d="M11.933 12.8a1 1 0 000-1.6l-5.334-4A1 1 0 005 8v8a1 1 0 001.6.8l5.334-4zM19.933 12.8a1 1 0 000-1.6l-5.334-4A1 1 0 0013 8v8a1 1 0 001.6.8l5.334-4z"
        />
      </svg>
    </button>
  </div>

  <div class="flex items-center space-x-2 flex-1">
    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-width="2"
        d="M15.536 8.464a5 5 0 010 7.072M12 9.5l-3-3m0 0l-3 3m3-3v12"
      />
    </svg>
    <input
      type="range"
      min="0"
      max="100"
      bind:value={volume}
      on:change={handleVolumeChange}
      class="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer"
    />
  </div>

  <button
    class="p-2 hover:bg-gray-700 rounded"
    on:click={restartStream}
    title="Restart Stream"
  >
    <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-width="2"
        d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
      />
    </svg>
  </button>
</div> 