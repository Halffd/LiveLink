<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { twitchUser } from '$lib/stores/auth';
  import { page } from '$app/stores';

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

  interface ConfigSection {
    title: string;
    description: string;
    fields: ConfigField[];
  }

  interface ConfigField {
    name: string;
    type: 'text' | 'number' | 'boolean' | 'select';
    label: string;
    value: any;
    options?: string[];
    description?: string;
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
    ],
    'Queue': [
      { method: 'GET', path: '/api/streams/queue/:screen', description: 'Get queue for screen', testable: true },
      { method: 'POST', path: '/api/streams/queue/:screen', description: 'Add to queue', testable: false },
      { method: 'DELETE', path: '/api/streams/queue/:screen/:index', description: 'Remove from queue', testable: false },
      { method: 'POST', path: '/api/streams/reorder', description: 'Reorder queue', testable: false }
    ],
    'Watched': [
      { method: 'GET', path: '/api/streams/watched', description: 'Get watched streams', testable: true },
      { method: 'POST', path: '/api/streams/watched', description: 'Mark stream as watched', testable: false },
      { method: 'DELETE', path: '/api/streams/watched', description: 'Clear watched streams', testable: false }
    ]
  };

  // Configuration sections
  const configSections: ConfigSection[] = [
    {
      title: 'Player Settings',
      description: 'Configure global player settings',
      fields: [
        { name: 'defaultQuality', type: 'select', label: 'Default Quality', value: 'best', options: ['best', 'high', 'medium', 'low'] },
        { name: 'defaultVolume', type: 'number', label: 'Default Volume', value: 50 },
        { name: 'processPriority', type: 'select', label: 'Process Priority', value: 'normal', options: ['normal', 'high', 'realtime', 'above_normal', 'below_normal', 'low', 'idle'] },
        { name: 'windowMode', type: 'select', label: 'Window Mode', value: 'windowed', options: ['windowed', 'fullscreen', 'borderless'] },
        { name: 'preferStreamlink', type: 'boolean', label: 'Prefer Streamlink', value: false },
        { name: 'windowMaximized', type: 'boolean', label: 'Maximize Window', value: true },
        { name: 'maxStreams', type: 'number', label: 'Max Streams', value: 4 },
        { name: 'autoStart', type: 'boolean', label: 'Auto-Start Streams', value: true }
      ]
    },
    {
      title: 'Twitch Settings',
      description: 'Configure Twitch API settings',
      fields: [
        { name: 'clientId', type: 'text', label: 'Client ID', value: '' },
        { name: 'clientSecret', type: 'text', label: 'Client Secret', value: '' },
        { name: 'streamersFile', type: 'text', label: 'Streamers File', value: 'config/streamers.txt' }
      ]
    },
    {
      title: 'Holodex Settings',
      description: 'Configure Holodex API settings',
      fields: [
        { name: 'apiKey', type: 'text', label: 'API Key', value: '' }
      ]
    },
    {
      title: 'MPV Settings',
      description: 'Configure MPV player settings',
      fields: [
        { name: 'priority', type: 'select', label: 'Priority', value: 'normal', options: ['normal', 'high', 'realtime', 'above_normal', 'below_normal', 'low', 'idle'] },
        { name: 'gpu-context', type: 'text', label: 'GPU Context', value: 'auto' }
      ]
    }
  ];

  let testResults: Record<string, { data: any, error: string | null }> = {};
  let expandedConfig: string | null = null;

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

  function toggleConfigSection(title: string) {
    expandedConfig = expandedConfig === title ? null : title;
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

<div class="container-fluid py-4">
  <header class="mb-4">
    <nav class="navbar navbar-expand-lg navbar-dark bg-dark rounded">
      <div class="container-fluid">
        <a class="navbar-brand" href={$page.url.pathname !== '/login' &&
                                      $page.url.pathname !== '/register' ? (
                                      currentUser && currentUser.admin ?
                                      '/admin' :
                                      '/'
                                  ) : '/'}>LiveLink</a>
        <button 
          class="navbar-toggler" 
          type="button" 
          data-bs-toggle="collapse" 
          data-bs-target="#navbarNav"
          aria-label="Toggle navigation"
        >
          <span class="navbar-toggler-icon"></span>
        </button>
        <div class="collapse navbar-collapse" id="navbarNav">
          <ul class="navbar-nav me-auto">
            <li class="nav-item">
              <a class="nav-link" href="/">Home</a>
            </li>
            <li class="nav-item">
              <a class="nav-link" href="/streams">Streams</a>
            </li>
            <li class="nav-item">
              <a class="nav-link" href="/settings">Settings</a>
            </li>
          </ul>
          {#if !$twitchUser.isAuthenticated}
            <button 
              class="btn btn-outline-light"
              onclick={login}
            >
              Login with Twitch
            </button>
          {:else}
            <span class="navbar-text">Welcome, {$twitchUser.username}!</span>
          {/if}
        </div>
      </div>
    </nav>
  </header>

  <main>
    <!-- Tab Navigation -->
    <ul class="nav nav-tabs mb-4">
      <li class="nav-item">
        <button 
          class="nav-link {activeTab === 'streams' ? 'active' : ''}"
          onclick={() => activeTab = 'streams'}
        >
          Live Streams
        </button>
      </li>
      <li class="nav-item">
        <button 
          class="nav-link {activeTab === 'api' ? 'active' : ''}"
          onclick={() => activeTab = 'api'}
        >
          API Explorer
        </button>
      </li>
      <li class="nav-item">
        <button 
          class="nav-link {activeTab === 'config' ? 'active' : ''}"
          onclick={() => activeTab = 'config'}
        >
          Configuration
        </button>
      </li>
    </ul>

    {#if error}
      <div class="alert alert-danger alert-dismissible fade show mb-4">
        <strong>Error!</strong> {error}
        <button 
          type="button" 
          class="btn-close" 
          onclick={() => error = null}
          aria-label="Close"
        ></button>
      </div>
    {/if}

    <!-- Streams Tab -->
    {#if activeTab === 'streams'}
      <div class="mb-4 d-flex justify-content-between align-items-center">
        <div class="d-flex align-items-center">
          <label for="orgSelect" class="me-2">Organization:</label>
          <select 
            id="orgSelect"
            class="form-select"
            bind:value={selectedOrg}
            onchange={() => fetchData()}
          >
            {#each organizations as org}
              <option value={org}>{org}</option>
            {/each}
          </select>
        </div>
        <div>
          <button 
            class="btn btn-primary"
            onclick={fetchData}
            disabled={loading}
          >
            {loading ? 'Loading...' : 'Refresh'}
          </button>
        </div>
      </div>

      <!-- Stream Grid -->
      <div class="row g-4">
        <!-- Twitch Streams -->
        <div class="col-md-6">
          <div class="card card-dark h-100">
            <div class="card-header card-header-dark d-flex justify-content-between align-items-center">
              <h5 class="mb-0">Twitch VTubers</h5>
              <span class="badge bg-info">{twitchStreams.length}</span>
            </div>
            <div class="card-body">
              {#if loading && twitchStreams.length === 0}
                <div class="d-flex justify-content-center">
                  <div class="spinner-border text-primary" role="status">
                    <span class="visually-hidden">Loading...</span>
                  </div>
                </div>
              {:else if twitchStreams.length === 0}
                <div class="alert alert-secondary">No streams available</div>
              {:else}
                <div class="list-group">
                  {#each twitchStreams as stream}
                    <div class="list-group-item list-group-item-action bg-dark text-light border-secondary">
                      <div class="d-flex justify-content-between align-items-start">
                        <div>
                          <h6 class="mb-1 text-truncate" style="max-width: 300px;">{stream.title || 'Untitled Stream'}</h6>
                          <p class="mb-1 text-muted small">{stream.url ? new URL(stream.url).pathname.slice(1) : 'Unknown'}</p>
                          <div class="d-flex align-items-center">
                            <span class="badge bg-secondary me-2">
                              {stream.viewerCount?.toLocaleString() || 0} viewers
                            </span>
                            {#if stream.platform}
                              <span class="badge bg-primary">{stream.platform}</span>
                            {/if}
                          </div>
                        </div>
                        <a 
                          href={`/streams?url=${stream.url}`}
                          class="btn btn-sm btn-primary"
                        >
                          Watch
                        </a>
                      </div>
                    </div>
                  {/each}
                </div>
              {/if}
            </div>
          </div>
        </div>

        <!-- Holodex Streams -->
        <div class="col-md-6">
          <div class="card card-dark h-100">
            <div class="card-header card-header-dark d-flex justify-content-between align-items-center">
              <h5 class="mb-0">{selectedOrg} Streams</h5>
              <span class="badge bg-info">{holodexStreams.length}</span>
            </div>
            <div class="card-body">
              {#if loading && holodexStreams.length === 0}
                <div class="d-flex justify-content-center">
                  <div class="spinner-border text-primary" role="status">
                    <span class="visually-hidden">Loading...</span>
                  </div>
                </div>
              {:else if holodexStreams.length === 0}
                <div class="alert alert-secondary">No streams available</div>
              {:else}
                <div class="list-group">
                  {#each holodexStreams as stream}
                    <div class="list-group-item list-group-item-action bg-dark text-light border-secondary">
                      <div class="d-flex justify-content-between align-items-start">
                        <div>
                          <h6 class="mb-1 text-truncate" style="max-width: 300px;">{stream.title || 'Untitled Stream'}</h6>
                          <p class="mb-1 text-muted small">{stream.channelId || 'Unknown channel'}</p>
                          <div class="d-flex align-items-center">
                            <span class="badge bg-secondary me-2">
                              {stream.viewerCount?.toLocaleString() || 0} viewers
                            </span>
                            {#if stream.platform}
                              <span class="badge bg-danger">{stream.platform}</span>
                            {/if}
                          </div>
                        </div>
                        <a 
                          href={`/streams?url=${stream.url}`}
                          class="btn btn-sm btn-primary"
                        >
                          Watch
                        </a>
                      </div>
                    </div>
                  {/each}
                </div>
              {/if}
            </div>
          </div>
        </div>
      </div>
    {/if}

    <!-- API Explorer Tab -->
    {#if activeTab === 'api'}
      <div class="card card-dark mb-4">
        <div class="card-header card-header-dark">
          <h4 class="mb-0">API Explorer</h4>
        </div>
        <div class="card-body">
          <p class="text-muted mb-4">
            This page allows you to explore the available API endpoints. Click "Test" to see the response from GET endpoints.
          </p>
          
          <div class="accordion" id="apiAccordion">
            {#each Object.entries(apiRoutes) as [category, routes], i}
              <div class="accordion-item bg-dark text-light border-secondary">
                <h2 class="accordion-header" id="heading{i}">
                  <button 
                    class="accordion-button bg-dark text-light collapsed" 
                    type="button" 
                    data-bs-toggle="collapse" 
                    data-bs-target="#collapse{i}"
                  >
                    {category} <span class="badge bg-secondary ms-2">{routes.length}</span>
                  </button>
                </h2>
                <div 
                  id="collapse{i}" 
                  class="accordion-collapse collapse" 
                  data-bs-parent="#apiAccordion"
                >
                  <div class="accordion-body p-0">
                    <div class="table-responsive">
                      <table class="table table-dark table-hover mb-0">
                        <thead>
                          <tr>
                            <th>Method</th>
                            <th>Path</th>
                            <th>Description</th>
                            <th class="text-end">Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {#each routes as route}
                            <tr>
                              <td>
                                <span class="badge {route.method === 'GET' ? 'bg-success' : route.method === 'POST' ? 'bg-primary' : route.method === 'PUT' ? 'bg-warning text-dark' : 'bg-danger'}">
                                  {route.method}
                                </span>
                              </td>
                              <td><code>{route.path}</code></td>
                              <td>{route.description}</td>
                              <td class="text-end">
                                {#if route.testable}
                                  <button 
                                    class="btn btn-sm btn-outline-primary"
                                    onclick={() => testApiRoute(route)}
                                  >
                                    Test
                                  </button>
                                {/if}
                              </td>
                            </tr>
                            {#if testResults[route.path]}
                              <tr>
                                <td colspan="4" class="p-0">
                                  <div class="p-3 bg-dark">
                                    {#if testResults[route.path].error}
                                      <div class="alert alert-danger mb-0">
                                        Error: {testResults[route.path].error}
                                      </div>
                                    {:else}
                                      <div class="bg-dark border border-secondary rounded p-2">
                                        <pre class="text-success mb-0" style="max-height: 300px; overflow-y: auto;">{JSON.stringify(testResults[route.path].data, null, 2)}</pre>
                                      </div>
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
                </div>
              </div>
            {/each}
          </div>
        </div>
      </div>
    {/if}

    <!-- Configuration Tab -->
    {#if activeTab === 'config'}
      <div class="row g-4">
        {#each configSections as section}
          <div class="col-md-6">
            <div class="card card-dark h-100">
              <div class="card-header card-header-dark">
                <h5 class="mb-0">{section.title}</h5>
              </div>
              <div class="card-body">
                <p class="text-muted mb-3">{section.description}</p>
                
                <div class="list-group">
                  {#each section.fields as field}
                    <div class="list-group-item bg-dark text-light border-secondary">
                      <div class="mb-3">
                        <label for="{field.name}" class="form-label">{field.label}</label>
                        
                        {#if field.type === 'text'}
                          <input 
                            type="text" 
                            class="form-control bg-dark text-light border-secondary" 
                            id="{field.name}" 
                            bind:value={field.value}
                          />
                        {:else if field.type === 'number'}
                          <input 
                            type="number" 
                            class="form-control bg-dark text-light border-secondary" 
                            id="{field.name}" 
                            bind:value={field.value}
                          />
                        {:else if field.type === 'boolean'}
                          <div class="form-check form-switch">
                            <input 
                              class="form-check-input" 
                              type="checkbox" 
                              id="{field.name}" 
                              bind:checked={field.value}
                            />
                          </div>
                        {:else if field.type === 'select' && field.options}
                          <select 
                            class="form-select bg-dark text-light border-secondary" 
                            id="{field.name}" 
                            bind:value={field.value}
                          >
                            {#each field.options as option}
                              <option value={option}>{option}</option>
                            {/each}
                          </select>
                        {/if}
                        
                        {#if field.description}
                          <div class="form-text text-muted">{field.description}</div>
                        {/if}
                      </div>
                    </div>
                  {/each}
                </div>
                
                <div class="d-flex justify-content-end mt-3">
                  <button class="btn btn-primary">Save {section.title}</button>
                </div>
              </div>
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
  
  .card-dark {
    background-color: #2c2c2c;
    border-color: #444;
    color: #f8f9fa;
  }
  
  .card-header-dark {
    background-color: #222;
    border-color: #444;
    color: #f8f9fa;
  }
  
  /* Override Bootstrap dark theme */
  .bg-dark {
    background-color: #222 !important;
  }
  
  .text-light {
    color: #f8f9fa !important;
  }
  
  .border-secondary {
    border-color: #444 !important;
  }
  
  /* Custom scrollbar for dark theme */
  ::-webkit-scrollbar {
    width: 8px;
    height: 8px;
  }
  
  ::-webkit-scrollbar-track {
    background: #333;
  }
  
  ::-webkit-scrollbar-thumb {
    background: #666;
    border-radius: 4px;
  }
  
  ::-webkit-scrollbar-thumb:hover {
    background: #888;
  }
</style>
