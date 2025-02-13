<script lang="ts">
  import type { Stream } from '$types/stream';
  import { createEventDispatcher } from 'svelte';

  const $props = {
    stream: {} as Stream
  };
  
  const dispatch = createEventDispatcher();

  const volume = $state(50);
  const showControls = $state(false);

  async function sendCommand(command: string) {
    try {
      await fetch(`/api/player/command/${$props.stream.screen}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command })
      });
    } catch (error) {
      console.error('Failed to send command:', error);
    }
  }

  async function setVolume(value: number) {
    volume = value;
    await sendCommand(`set volume ${value}`);
  }

  async function togglePause() {
    await sendCommand('cycle pause');
  }

  async function seek(seconds: number) {
    await sendCommand(`seek ${seconds}`);
  }
</script>

<div class="bg-gray-700 rounded-lg p-4 relative group">
  <div class="flex justify-between items-start">
    <div class="space-y-2">
      <h3 class="font-semibold truncate max-w-[300px]">
        {stream.title || 'Untitled Stream'}
      </h3>
      <p class="text-sm text-gray-300 truncate max-w-[300px]">
        {stream.url}
      </p>
      <p class="text-sm text-gray-400">
        Quality: {stream.quality}
      </p>
    </div>

    <div class="flex space-x-2">
      <button
        class="p-2 rounded hover:bg-gray-600 transition-colors"
        on:click={() => showControls = !showControls}
      >
        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z" />
        </svg>
      </button>
      
      <button
        class="p-2 rounded bg-red-500 hover:bg-red-600 transition-colors"
        on:click={() => dispatch('stop')}
      >
        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  </div>

  {#if showControls}
    <div class="mt-4 space-y-4">
      <div class="flex items-center space-x-4">
        <button
          class="p-2 rounded hover:bg-gray-600 transition-colors"
          on:click={togglePause}
        >
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14 5l7 7m0 0l-7 7m7-7H3" />
          </svg>
        </button>

        <button
          class="p-2 rounded hover:bg-gray-600 transition-colors"
          on:click={() => seek(-10)}
        >
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12.066 11.2a1 1 0 000 1.6l5.334 4A1 1 0 0019 16V8a1 1 0 00-1.6-.8l-5.333 4zM4.066 11.2a1 1 0 000 1.6l5.334 4A1 1 0 0011 16V8a1 1 0 00-1.6-.8l-5.334 4z" />
          </svg>
        </button>

        <button
          class="p-2 rounded hover:bg-gray-600 transition-colors"
          on:click={() => seek(10)}
        >
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11.933 12.8a1 1 0 000-1.6l-5.334-4A1 1 0 005 8v8a1 1 0 001.6.8l5.334-4zM19.933 12.8a1 1 0 000-1.6l-5.334-4A1 1 0 0013 8v8a1 1 0 001.6.8l5.334-4z" />
          </svg>
        </button>
      </div>

      <div class="flex items-center space-x-4">
        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.536 8.464a5 5 0 010 7.072M12 9.5l-3-3m0 0l-3 3m3-3v12" />
        </svg>
        
        <input
          type="range"
          min="0"
          max="100"
          bind:value={volume}
          on:change={() => setVolume(volume)}
          class="w-full h-2 bg-gray-600 rounded-lg appearance-none cursor-pointer"
        />
        
        <span class="text-sm text-gray-300 min-w-[3ch]">
          {volume}
        </span>
      </div>
    </div>
  {/if}
</div> 