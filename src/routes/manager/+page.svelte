<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { page } from '$app/stores';

  interface Stream {
    screen: number;
    url: string;
    quality: string;
    title?: string;
    platform?: 'youtube' | 'twitch';
  }

  let streams: Stream[] = [];
  let newStream = {
    url: $page.url.searchParams.get('url') || '',
    quality: 'best',
    screen: 1,
    volume: 0,
    windowMaximized: true
  };

  const API_URL = 'http://localhost:3001/api';

  async function fetchStreams() {
    const response = await fetch(`${API_URL}/streams`);
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
</script>

<div class="container mx-auto p-4">
  <header class="mb-8">
    <nav class="flex justify-between items-center bg-gray-800 text-white p-4 rounded-lg">
      <div class="flex gap-4">
        <a href="/" class="hover:text-gray-300">Home</a>
        <a href="/manager" class="hover:text-gray-300">Stream Manager</a>
      </div>
    </nav>
  </header>

  <main>
    <h1 class="text-2xl font-bold mb-6">Stream Manager</h1>

    <div class="mb-8 p-6 bg-gray-100 rounded-lg">
      <h2 class="text-xl mb-4">Add New Stream</h2>
      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <input
          type="text"
          bind:value={newStream.url}
          placeholder="Stream URL"
          class="p-2 border rounded"
        />
        <select bind:value={newStream.quality} class="p-2 border rounded">
          <option value="best">Best</option>
          <option value="1080p">1080p</option>
          <option value="720p">720p</option>
          <option value="480p">480p</option>
        </select>
        <input
          type="number"
          bind:value={newStream.screen}
          min="1"
          max="4"
          class="p-2 border rounded"
          placeholder="Screen"
        />
        <button
          on:click={startStream}
          class="bg-blue-500 hover:bg-blue-600 text-white p-2 rounded"
        >
          Start Stream
        </button>
      </div>
    </div>

    <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
      {#each streams as stream (stream.screen)}
        <div class="p-6 border rounded-lg shadow">
          <div class="flex justify-between items-start">
            <div>
              <h3 class="font-bold text-lg">Screen {stream.screen}</h3>
              <p class="text-gray-600 truncate mt-1">{stream.url}</p>
              <p class="text-sm text-gray-500 mt-1">Quality: {stream.quality}</p>
              {#if stream.title}
                <p class="text-sm text-gray-500 mt-1">Title: {stream.title}</p>
              {/if}
            </div>
            <button
              on:click={() => stopStream(stream.screen)}
              class="bg-red-500 hover:bg-red-600 text-white px-4 py-2 rounded"
            >
              Stop
            </button>
          </div>
        </div>
      {/each}
    </div>
  </main>
</div> 