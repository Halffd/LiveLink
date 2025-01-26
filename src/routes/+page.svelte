<script lang="ts">
  import { onMount } from 'svelte';
  import { twitchUser } from '$lib/stores/auth';
f
  interface StreamSource {
    url: string;
    title: string;
    platform: 'youtube' | 'twitch';
    viewerCount?: number;
    organization?: string;
    channelId?: string;
  }

  let twitchStreams: StreamSource[] = [];
  let holodexStreams: StreamSource[] = [];
  let selectedOrg = 'Hololive';
  let organizations: string[] = [];

  async function fetchOrganizations() {
    const response = await fetch('/api/organizations');
    organizations = await response.json();
  }

  async function fetchStreams() {
    // Fetch Twitch VTuber streams
    const twitchResponse = await fetch('/api/streams/vtubers?limit=20');
    twitchStreams = await twitchResponse.json();

    // Fetch Holodex streams for selected organization
    const holodexResponse = await fetch(`/api/live?organization=${selectedOrg}&limit=20`);
    holodexStreams = await holodexResponse.json();
  }

  function login() {
    window.location.href = '/api/auth/twitch';
  }

  onMount(() => {
    fetchOrganizations();
    fetchStreams();
    const interval = setInterval(fetchStreams, 30000);
    return () => clearInterval(interval);
  });
</script>

<div class="container mx-auto p-4">
  <header class="mb-8">
    <nav class="flex justify-between items-center bg-gray-800 text-white p-4 rounded-lg">
      <div class="flex gap-4">
        <a href="/" class="hover:text-gray-300">Home</a>
        <a href="/manager" class="hover:text-gray-300">Stream Manager</a>
      </div>
      {#if !$twitchUser.isAuthenticated}
        <button 
          class="bg-purple-600 hover:bg-purple-700 px-4 py-2 rounded"
          on:click={login}
        >
          Login with Twitch
        </button>
      {:else}
        <span>Welcome, {$twitchUser.username}!</span>
      {/if}
    </nav>
  </header>

  <main>
    <!-- Organization Selector -->
    <div class="mb-6">
      <select 
        bind:value={selectedOrg}
        on:change={fetchStreams}
        class="p-2 border rounded"
      >
        {#each organizations as org}
          <option value={org}>{org}</option>
        {/each}
      </select>
    </div>

    <!-- Stream Grid -->
    <div class="grid grid-cols-1 md:grid-cols-2 gap-8">
      <!-- Twitch Streams -->
      <section>
        <h2 class="text-2xl font-bold mb-4">Twitch VTubers</h2>
        <div class="grid gap-4">
          {#each twitchStreams as stream}
            <div class="bg-white p-4 rounded-lg shadow hover:shadow-lg transition-shadow">
              <h3 class="font-bold truncate">{stream.title}</h3>
              <p class="text-gray-600">{new URL(stream.url).pathname.slice(1)}</p>
              <div class="flex justify-between items-center mt-2">
                <span class="text-sm text-gray-500">
                  {stream.viewerCount?.toLocaleString()} viewers
                </span>
                <button 
                  class="bg-blue-500 hover:bg-blue-600 text-white px-3 py-1 rounded"
                  on:click={() => window.location.href = `/manager?url=${stream.url}`}
                >
                  Watch
                </button>
              </div>
            </div>
          {/each}
        </div>
      </section>

      <!-- Holodex Streams -->
      <section>
        <h2 class="text-2xl font-bold mb-4">{selectedOrg} Streams</h2>
        <div class="grid gap-4">
          {#each holodexStreams as stream}
            <div class="bg-white p-4 rounded-lg shadow hover:shadow-lg transition-shadow">
              <h3 class="font-bold truncate">{stream.title}</h3>
              <p class="text-gray-600">{stream.channelId}</p>
              <div class="flex justify-between items-center mt-2">
                <span class="text-sm text-gray-500">
                  {stream.viewerCount?.toLocaleString()} viewers
                </span>
                <button 
                  class="bg-blue-500 hover:bg-blue-600 text-white px-3 py-1 rounded"
                  on:click={() => window.location.href = `/manager?url=${stream.url}`}
                >
                  Watch
                </button>
              </div>
            </div>
          {/each}
        </div>
      </section>
    </div>
  </main>
</div>
