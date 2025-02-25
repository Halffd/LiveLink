<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { twitchUser } from '$lib/stores/auth';

  interface StreamSource {
    url: string;
    title: string;
    platform?: string;
    viewerCount?: number;
    organization?: string;
    channelId?: string;
    thumbnail?: string;
  }

  interface ApiRoute {
    method: string;
    path: string;
    description: string;
    testable: boolean;
  }

  let twitchStreams: StreamSource[] = [];
  let holodexStreams: StreamSource[] = [];
  let selectedOrg = 'Hololive';
  let organizations: string[] = [];
  let loading = true;
  let error: string | null = null;
  let refreshInterval: number | null = null;
  let activeTab = 'streams';
  
  // API routes organized by category
  const apiRoutes: Record<string, ApiRoute[]> = {
    'Streams': [
      { method: 'GET', path: '/api/streams', description: 'Get all streams', testable: true },
      { method: 'GET', path: '/api/streams/active', description: 'Get active streams', testable: true },
      { method: 'GET', path: '/api/streams/vtubers', description: 'Get VTuber streams', testable: true },
      { method: 'GET', path: '/api/streams/japanese', description: 'Get Japanese streams', testable: true },
      { method: 'POST', path: '/api/streams/start', description: 'Start a stream', testable: false },
      { method: 'POST', path: '/api/streams/autostart', description: 'Auto-start streams', testable: false }
    ],
    'Player': [
      { method: 'GET', path: '/api/player/settings', description: 'Get player settings', testable: true },
      { method: 'POST', path: '/api/player/command/:screen', description: 'Send command to screen', testable: false },
      { method: 'POST', path: '/api/player/volume/:target', description: 'Set volume', testable: false },
      { method: 'POST', path: '/api/player/pause/:target', description: 'Toggle pause', testable: false }
    ],
    'Screens': [
      { method: 'GET', path: '/api/screens', description: 'Get all screen configs', testable: true },
      { method: 'PUT', path: '/api/screens/:screen', description: 'Update screen config', testable: false },
      { method: 'POST', path: '/api/screens/:screen/enable', description: 'Enable screen', testable: false },
      { method: 'POST', path: '/api/screens/:screen/disable', description: 'Disable screen', testable: false }
    ],
    'Config': [
      { method: 'GET', path: '/api/config', description: 'Get app config', testable: true },
      { method: 'PUT', path: '/api/config', description: 'Update app config', testable: false },
      { method: 'GET', path: '/api/organizations', description: 'Get organizations', testable: true }
    ]
  };

  let testResults: Record<string, { data: any, error: string | null }> = {};

  async function fetchData() {
    loading = true;
    error = null;
    
    try {
      // Fetch organizations
      try {
        const orgResponse = await fetch('/api/organizations');
        if (orgResponse.ok) {
          organizations = await orgResponse.json();
        } else {
          console.warn('Failed to fetch organizations:', orgResponse.status);
          organizations = ['Hololive', 'Nijisanji', 'VSpo', 'Independents'];
        }
      } catch (err) {
        console.warn('Error fetching organizations:', err);
        organizations = ['Hololive', 'Nijisanji', 'VSpo', 'Independents'];
      }

      // Fetch Twitch VTuber streams
      try {
        const twitchResponse = await fetch('/api/streams/vtubers?limit=10');
        if (twitchResponse.ok) {
          twitchStreams = await twitchResponse.json();
        } else {
          console.warn('Failed to fetch Twitch streams:', twitchResponse.status);
          twitchStreams = [];
        }
      } catch (err) {
        console.warn('Error fetching Twitch streams:', err);
        twitchStreams = [];
      }

      // Fetch Holodex streams for selected organization
      try {
        const holodexResponse = await fetch(`/api/streams?organization=${selectedOrg}&limit=10`);
        if (holodexResponse.ok) {
          holodexStreams = await holodexResponse.json();
        } else {
          console.warn('Failed to fetch Holodex streams:', holodexResponse.status);
          holodexStreams = [];
        }
      } catch (err) {
        console.warn('Error fetching Holodex streams:', err);
        holodexStreams = [];
      }
    } catch (err) {
      error = err instanceof Error ? err.message : 'An unknown error occurred';
      console.error('Error fetching data:', err);
    } finally {
      loading = false;
    }
  }

  async function testApiRoute(route: ApiRoute) {
    if (!route.testable) return;
    
    try {
      const response = await fetch(route.path);
      if (response.ok) {
        const data = await response.json();
        testResults[route.path] = { data, error: null };
      } else {
        testResults[route.path] = { 
          data: null, 
          error: `Status: ${response.status} - ${response.statusText}` 
        };
      }
    } catch (err) {
      testResults[route.path] = { 
        data: null, 
        error: err instanceof Error ? err.message : 'An unknown error occurred' 
      };
    }
    
    // Force update
    testResults = {...testResults};
  }

  function login() {
    window.location.href = '/api/auth/twitch';
  }

  function setRefreshInterval(seconds: number) {
    if (refreshInterval) {
      clearInterval(refreshInterval);
      refreshInterval = null;
    }
    
    if (seconds > 0) {
      refreshInterval = setInterval(fetchData, seconds * 1000) as unknown as number;
    }
  }

  onMount(() => {
    fetchData();
    setRefreshInterval(60); // Refresh every 60 seconds by default
  });

  onDestroy(() => {
    if (refreshInterval) {
      clearInterval(refreshInterval);
    }
  });
</script>

<div class="container mx-auto p-4">
  <header class="mb-8">
    <nav class="flex justify-between items-center bg-gray-800 text-white p-4 rounded-lg">
      <div class="flex gap-4">
        <a href="/" class="hover:text-gray-300">Home</a>
        <a href="/streams" class="hover:text-gray-300">Streams</a>
        <a href="/settings" class="hover:text-gray-300">Settings</a>
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
    <!-- Tab Navigation -->
    <div class="mb-6 border-b border-gray-700">
      <div class="flex space-x-4">
        <button 
          class="py-2 px-4 {activeTab === 'streams' ? 'border-b-2 border-blue-500 text-blue-500' : 'text-gray-400 hover:text-gray-300'}"
          on:click={() => activeTab = 'streams'}
        >
          Live Streams
        </button>
        <button 
          class="py-2 px-4 {activeTab === 'api' ? 'border-b-2 border-blue-500 text-blue-500' : 'text-gray-400 hover:text-gray-300'}"
          on:click={() => activeTab = 'api'}
        >
          API Explorer
        </button>
      </div>
    </div>

    {#if error}
      <div class="bg-red-500 text-white p-4 rounded mb-6">
        <p>{error}</p>
        <button class="underline mt-2" on:click={fetchData}>Retry</button>
      </div>
    {/if}

    <!-- Streams Tab -->
    {#if activeTab === 'streams'}
      <div class="mb-6 flex justify-between items-center">
        <div>
          <select 
            bind:value={selectedOrg}
            on:change={() => fetchData()}
            class="p-2 border rounded bg-gray-700 text-white"
          >
            {#each organizations as org}
              <option value={org}>{org}</option>
            {/each}
          </select>
        </div>
        <div>
          <button 
            class="bg-blue-600 hover:bg-blue-700 px-4 py-2 rounded text-white"
            on:click={fetchData}
            disabled={loading}
          >
            {loading ? 'Loading...' : 'Refresh'}
          </button>
        </div>
      </div>

      <!-- Stream Grid -->
      <div class="grid grid-cols-1 md:grid-cols-2 gap-8">
        <!-- Twitch Streams -->
        <section>
          <h2 class="text-2xl font-bold mb-4">Twitch VTubers</h2>
          {#if loading && twitchStreams.length === 0}
            <div class="bg-gray-800 p-4 rounded-lg">Loading...</div>
          {:else if twitchStreams.length === 0}
            <div class="bg-gray-800 p-4 rounded-lg">No streams available</div>
          {:else}
            <div class="grid gap-4">
              {#each twitchStreams as stream}
                <div class="bg-gray-800 p-4 rounded-lg shadow hover:shadow-lg transition-shadow">
                  <h3 class="font-bold truncate text-white">{stream.title || 'Untitled Stream'}</h3>
                  <p class="text-gray-400">{stream.url ? new URL(stream.url).pathname.slice(1) : 'Unknown'}</p>
                  <div class="flex justify-between items-center mt-2">
                    <span class="text-sm text-gray-400">
                      {stream.viewerCount?.toLocaleString() || 0} viewers
                    </span>
                    <button 
                      class="bg-blue-500 hover:bg-blue-600 text-white px-3 py-1 rounded"
                      on:click={() => window.location.href = `/streams?url=${stream.url}`}
                    >
                      Watch
                    </button>
                  </div>
                </div>
              {/each}
            </div>
          {/if}
        </section>

        <!-- Holodex Streams -->
        <section>
          <h2 class="text-2xl font-bold mb-4">{selectedOrg} Streams</h2>
          {#if loading && holodexStreams.length === 0}
            <div class="bg-gray-800 p-4 rounded-lg">Loading...</div>
          {:else if holodexStreams.length === 0}
            <div class="bg-gray-800 p-4 rounded-lg">No streams available</div>
          {:else}
            <div class="grid gap-4">
              {#each holodexStreams as stream}
                <div class="bg-gray-800 p-4 rounded-lg shadow hover:shadow-lg transition-shadow">
                  <h3 class="font-bold truncate text-white">{stream.title || 'Untitled Stream'}</h3>
                  <p class="text-gray-400">{stream.channelId || 'Unknown channel'}</p>
                  <div class="flex justify-between items-center mt-2">
                    <span class="text-sm text-gray-400">
                      {stream.viewerCount?.toLocaleString() || 0} viewers
                    </span>
                    <button 
                      class="bg-blue-500 hover:bg-blue-600 text-white px-3 py-1 rounded"
                      on:click={() => window.location.href = `/streams?url=${stream.url}`}
                    >
                      Watch
                    </button>
                  </div>
                </div>
              {/each}
            </div>
          {/if}
        </section>
      </div>
    {/if}

    <!-- API Explorer Tab -->
    {#if activeTab === 'api'}
      <div class="space-y-8">
        <div class="bg-gray-800 p-4 rounded-lg">
          <h2 class="text-xl font-bold mb-4">API Explorer</h2>
          <p class="text-gray-400 mb-4">
            This page allows you to explore the available API endpoints. Click "Test" to see the response from GET endpoints.
          </p>
        </div>

        {#each Object.entries(apiRoutes) as [category, routes]}
          <div class="bg-gray-800 p-4 rounded-lg">
            <h3 class="text-lg font-bold mb-4">{category}</h3>
            <div class="overflow-x-auto">
              <table class="w-full">
                <thead>
                  <tr class="border-b border-gray-700">
                    <th class="text-left p-2">Method</th>
                    <th class="text-left p-2">Path</th>
                    <th class="text-left p-2">Description</th>
                    <th class="text-right p-2">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {#each routes as route}
                    <tr class="border-b border-gray-700">
                      <td class="p-2">
                        <span class="inline-block px-2 py-1 rounded {route.method === 'GET' ? 'bg-green-700' : route.method === 'POST' ? 'bg-blue-700' : 'bg-yellow-700'}">
                          {route.method}
                        </span>
                      </td>
                      <td class="p-2 font-mono text-sm">{route.path}</td>
                      <td class="p-2">{route.description}</td>
                      <td class="p-2 text-right">
                        {#if route.testable}
                          <button 
                            class="bg-blue-600 hover:bg-blue-700 px-3 py-1 rounded text-white text-sm"
                            on:click={() => testApiRoute(route)}
                          >
                            Test
                          </button>
                        {/if}
                      </td>
                    </tr>
                    {#if testResults[route.path]}
                      <tr>
                        <td colspan="4" class="p-2">
                          <div class="bg-gray-900 p-3 rounded">
                            {#if testResults[route.path].error}
                              <div class="text-red-400">Error: {testResults[route.path].error}</div>
                            {:else}
                              <pre class="text-green-400 overflow-x-auto text-sm">{JSON.stringify(testResults[route.path].data, null, 2)}</pre>
                            {/if}
                          </div>
                        </td>
                      </tr>
                    {/if}
                  {/each}
                </tbody>
              </table>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </main>
</div>

<style>
  pre {
    max-height: 300px;
    overflow-y: auto;
  }
</style>
