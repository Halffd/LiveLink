<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { twitchUser } from '$lib/stores/auth';

  interface Stream {
    screen: number;
    url: string;
    quality: string;
  }

  let streams: Stream[] = [];
  let newStream = {
    url: '',
    quality: 'best',
    screen: 1
  };

  const API_URL = 'http://localhost:3001/api';

  async function fetchStreams() {
    let endpoint = '/api/streams';
    
    switch (streamType) {
      case 'following':
        if ($twitchUser.isAuthenticated) {
          endpoint = `/api/streams/following/${$twitchUser.id}`;
        }
        break;
      case 'vtubers':
        endpoint = '/api/streams/vtubers';
        break;
      case 'japanese':
        endpoint = '/api/streams/japanese';
        break;
    }

    const response = await fetch(endpoint);
    streams = await response.json();
  }

  async function startStream() {
    await fetch(`${API_URL}/streams`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newStream)
    });
    await fetchStreams();
  }

  async function stopStream(screen: number) {
    await fetch(`${API_URL}/streams/${screen}`, {
      method: 'DELETE'
    });
    await fetchStreams();
  }

  let interval: number;
  onMount(() => {
    fetchStreams();
    interval = setInterval(fetchStreams, 5000);
  });

  onDestroy(() => {
    clearInterval(interval);
  });

  let streamType: 'all' | 'following' | 'vtubers' | 'japanese' = 'all';

  function login() {
    window.location.href = '/api/auth/twitch';
  }
</script>

<div class="container mx-auto p-4">
  <div class="flex justify-between items-center mb-4">
    <h1 class="text-2xl font-bold">Stream Manager</h1>
    {#if !$twitchUser.isAuthenticated}
      <button 
        class="bg-purple-600 text-white px-4 py-2 rounded"
        on:click={login}
      >
        Login with Twitch
      </button>
    {:else}
      <span>Welcome, {$twitchUser.username}!</span>
    {/if}
  </div>

  <div class="mb-4">
    <select 
      bind:value={streamType} 
      on:change={fetchStreams}
      class="p-2 border rounded"
    >
      <option value="all">All Streams</option>
      <option value="following">Following</option>
      <option value="vtubers">VTubers</option>
      <option value="japanese">Japanese</option>
    </select>
  </div>

  <div class="mb-6 p-4 bg-gray-100 rounded">
    <h2 class="text-xl mb-2">Add New Stream</h2>
    <div class="flex gap-2">
      <input
        type="text"
        bind:value={newStream.url}
        placeholder="Stream URL"
        class="flex-1 p-2 border rounded"
      />
      <select bind:value={newStream.quality} class="p-2 border rounded">
        <option value="best">Best</option>
        <option value="720p">720p</option>
        <option value="480p">480p</option>
      </select>
      <input
        type="number"
        bind:value={newStream.screen}
        min="1"
        max="4"
        class="w-20 p-2 border rounded"
      />
      <button
        on:click={startStream}
        class="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
      >
        Start Stream
      </button>
    </div>
  </div>

  <div class="grid grid-cols-2 gap-4">
    {#each streams as stream (stream.screen)}
      <div class="p-4 border rounded shadow">
        <h3 class="font-bold">Screen {stream.screen}</h3>
        <p class="truncate">{stream.url}</p>
        <p>Quality: {stream.quality}</p>
        <button
          on:click={() => stopStream(stream.screen)}
          class="mt-2 px-3 py-1 bg-red-500 text-white rounded hover:bg-red-600"
        >
          Stop
        </button>
      </div>
    {/each}
  </div>
</div> 