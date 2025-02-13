<script lang="ts">
  import { activeStreams, streamQueues, screenConfigs } from '$lib/stores';
  import StreamCard from '$components/StreamCard.svelte';
  import QueueList from '$components/QueueList.svelte';
  import { onMount } from 'svelte';

  let loading = true;
  let error: string | null = null;

  async function startStream(url: string, screen: number) {
    try {
      const response = await fetch('/api/streams', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, screen })
      });
      
      if (!response.ok) throw new Error('Failed to start stream');
      
      const result = await response.json();
      if (result.error) throw new Error(result.error);
      
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to start stream';
    }
  }

  async function stopStream(screen: number) {
    try {
      const response = await fetch(`/api/streams/${screen}`, {
        method: 'DELETE'
      });
      
      if (!response.ok) throw new Error('Failed to stop stream');
      
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to stop stream';
    }
  }

  async function toggleScreen(screen: number, enabled: boolean) {
    try {
      const response = await fetch(`/api/screens/${screen}/${enabled ? 'enable' : 'disable'}`, {
        method: 'POST'
      });
      
      if (!response.ok) throw new Error(`Failed to ${enabled ? 'enable' : 'disable'} screen`);
      
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to toggle screen';
    }
  }

  onMount(() => {
    loading = false;
  });
</script>

<div class="space-y-8">
  <div class="flex justify-between items-center">
    <h1 class="text-2xl font-bold">Stream Manager</h1>
    <div class="space-x-4">
      <button
        class="px-4 py-2 bg-green-600 hover:bg-green-700 rounded text-white"
        on:click={() => {
          $screenConfigs.forEach((config, screen) => {
            if (config.enabled && !$activeStreams.find(s => s.screen === screen)) {
              startStream('', screen);
            }
          });
        }}
      >
        Start All
      </button>
      <button
        class="px-4 py-2 bg-red-600 hover:bg-red-700 rounded text-white"
        on:click={() => {
          $activeStreams.forEach(stream => stopStream(stream.screen));
        }}
      >
        Stop All
      </button>
    </div>
  </div>

  {#if error}
    <div class="bg-red-500 text-white p-4 rounded">
      {error}
      <button class="ml-4 underline" on:click={() => error = null}>Dismiss</button>
    </div>
  {/if}

  {#if loading}
    <div class="flex justify-center items-center h-64">
      <div class="animate-spin rounded-full h-32 w-32 border-b-2 border-white"></div>
    </div>
  {:else}
    <div class="grid grid-cols-1 md:grid-cols-2 gap-8">
      {#each Array.from($screenConfigs) as [screen, config]}
        <div class="bg-gray-800 rounded-lg p-6 space-y-6">
          <div class="flex justify-between items-center">
            <h2 class="text-xl font-semibold">Screen {screen}</h2>
            <label class="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                class="sr-only peer"
                checked={config.enabled}
                on:change={(e) => toggleScreen(screen, e.currentTarget.checked)}
              >
              <div class="w-11 h-6 bg-gray-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-green-600"></div>
            </label>
          </div>

          {#if config.enabled}
            {@const activeStream = $activeStreams.find(s => s.screen === screen)}
            {#if activeStream}
              <StreamCard 
                stream={activeStream}
                onStop={() => stopStream(screen)}
              />
            {:else}
              <div class="text-center py-8 bg-gray-700 rounded">
                <p class="text-gray-300">No active stream</p>
                <button
                  class="mt-4 px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded text-white"
                  on:click={() => startStream('', screen)}
                >
                  Start Stream
                </button>
              </div>
            {/if}

            <QueueList
              screen={screen}
              queue={$streamQueues.get(screen) || []}
            />
          {:else}
            <div class="text-center py-8 text-gray-400">
              Screen disabled
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div> 