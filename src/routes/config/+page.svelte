<script lang="ts">
  import { onMount } from 'svelte';
  import ConfigEditor from '$components/ConfigEditor.svelte';
  import { writable } from 'svelte/store';

  let loading = true;
  let error: string | null = null;
  let success: string | null = null;
  
  const config = writable({
    streams: [],
    organizations: [],
    favoriteChannels: {
      holodex: [],
      twitch: []
    },
    holodex: {
      apiKey: ''
    },
    twitch: {
      clientId: '',
      clientSecret: '',
      streamersFile: 'config/streamers.txt'
    }
  });

  async function loadConfig() {
    try {
      const response = await fetch('/api/config');
      const data = await response.json();
      config.set(data);
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to load configuration';
    } finally {
      loading = false;
    }
  }

  async function saveConfig(updatedConfig: any) {
    try {
      const response = await fetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updatedConfig)
      });

      if (!response.ok) throw new Error('Failed to save configuration');

      success = 'Configuration saved successfully';
      setTimeout(() => success = null, 3000);
      
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to save configuration';
      setTimeout(() => error = null, 3000);
    }
  }

  onMount(() => {
    loadConfig();
  });
</script>

<div class="space-y-8">
  <div class="flex justify-between items-center">
    <h1 class="text-2xl font-bold">Configuration Editor</h1>
    
    <div class="space-x-4">
      <button
        class="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded text-white"
        on:click={loadConfig}
      >
        Reload
      </button>
    </div>
  </div>

  {#if error}
    <div class="bg-red-500 text-white p-4 rounded">
      {error}
      <button class="ml-4 underline" on:click={() => error = null}>Dismiss</button>
    </div>
  {/if}

  {#if success}
    <div class="bg-green-500 text-white p-4 rounded">
      {success}
      <button class="ml-4 underline" on:click={() => success = null}>Dismiss</button>
    </div>
  {/if}

  {#if loading}
    <div class="flex justify-center items-center h-64">
      <div class="animate-spin rounded-full h-32 w-32 border-b-2 border-white"></div>
    </div>
  {:else}
    <ConfigEditor 
      config={$config} 
      on:save={(e) => saveConfig(e.detail)}
    />
  {/if}
</div> 