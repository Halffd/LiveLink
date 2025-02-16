<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import type { StreamSourceConfig } from '$types/stream';
  
  let { config } = $props<{
    config: {
      streams: Array<{
        id: number;
        enabled: boolean;
        screen: number;
        sources: StreamSourceConfig[];
        sorting: {
          field: string;
          order: 'asc' | 'desc';
        };
        refresh: number;
        autoStart: boolean;
        quality: string;
        volume: number;
        windowMaximized: boolean;
      }>;
      organizations: string[];
      favoriteChannels: {
        holodex: string[];
        twitch: string[];
      };
      holodex: {
        apiKey: string;
      };
      twitch: {
        clientId: string;
        clientSecret: string;
        streamersFile: string;
      };
    };
  }>();

  const dispatch = createEventDispatcher();
  
  let editingStream = $state<number | null>(null);
  let editingSource = $state<number | null>(null);
  
  const sourceTypes = ['holodex', 'twitch'] as const;
  const sourceSubtypes = ['favorites', 'organization'] as const;
  const sortFields = ['viewerCount', 'startTime', 'title'] as const;
  const sortOrders = ['asc', 'desc'] as const;
  const qualities = ['best', '1080p', '720p', '480p', 'worst'] as const;

  function addStream() {
    config.streams = [
      ...config.streams,
      {
        id: Math.max(0, ...config.streams.map(s => s.id)) + 1,
        enabled: true,
        screen: config.streams.length + 1,
        sources: [],
        sorting: {
          field: 'viewerCount',
          order: 'desc'
        },
        refresh: 300,
        autoStart: true,
        quality: 'best',
        volume: 50,
        windowMaximized: true
      }
    ];
  }

  function removeStream(index: number) {
    config.streams = config.streams.filter((_, i) => i !== index);
  }

  function addSource(streamIndex: number) {
    const stream = config.streams[streamIndex];
    stream.sources = [
      ...stream.sources,
      {
        type: 'holodex',
        subtype: 'favorites',
        enabled: true,
        limit: 25,
        priority: stream.sources.length + 1
      }
    ];
    config.streams = [...config.streams];
  }

  function removeSource(streamIndex: number, sourceIndex: number) {
    const stream = config.streams[streamIndex];
    stream.sources = stream.sources.filter((_, i) => i !== sourceIndex);
    config.streams = [...config.streams];
  }

  function addOrganization() {
    config.organizations = [...config.organizations, ''];
  }

  function removeOrganization(index: number) {
    config.organizations = config.organizations.filter((_, i) => i !== index);
  }

  function addFavoriteChannel(platform: 'holodex' | 'twitch') {
    config.favoriteChannels[platform] = [...config.favoriteChannels[platform], ''];
  }

  function removeFavoriteChannel(platform: 'holodex' | 'twitch', index: number) {
    config.favoriteChannels[platform] = config.favoriteChannels[platform].filter((_, i) => i !== index);
  }

  function save() {
    dispatch('save', config);
  }
</script>

<div class="space-y-8">
  <!-- Streams Configuration -->
  <div class="bg-gray-800 rounded-lg p-6">
    <div class="flex justify-between items-center mb-6">
      <h2 class="text-xl font-semibold">Streams</h2>
      <button
        class="px-3 py-1.5 bg-green-600 hover:bg-green-700 rounded text-sm"
        on:click={addStream}
      >
        Add Stream
      </button>
    </div>

    <div class="space-y-6">
      {#each config.streams as stream, streamIndex}
        <div class="border-t border-gray-700 pt-4 first:border-0 first:pt-0">
          <div class="flex justify-between items-start mb-4">
            <div>
              <h3 class="text-lg font-medium">Stream {stream.id}</h3>
              <p class="text-sm text-gray-400">Screen {stream.screen}</p>
            </div>
            <div class="flex items-center space-x-2">
              <button
                class="p-1.5 hover:bg-gray-700 rounded"
                on:click={() => editingStream = streamIndex}
              >
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                </svg>
              </button>
              <button
                class="p-1.5 hover:bg-red-600 rounded"
                on:click={() => removeStream(streamIndex)}
              >
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>

          {#if editingStream === streamIndex}
            <div class="grid grid-cols-2 gap-4 mb-4">
              <label class="block">
                <span class="text-sm text-gray-300">Screen</span>
                <input
                  type="number"
                  class="mt-1 block w-full rounded-md bg-gray-700 border-gray-600"
                  bind:value={stream.screen}
                />
              </label>

              <label class="block">
                <span class="text-sm text-gray-300">Refresh (seconds)</span>
                <input
                  type="number"
                  class="mt-1 block w-full rounded-md bg-gray-700 border-gray-600"
                  bind:value={stream.refresh}
                />
              </label>

              <label class="block">
                <span class="text-sm text-gray-300">Quality</span>
                <select
                  class="mt-1 block w-full rounded-md bg-gray-700 border-gray-600"
                  bind:value={stream.quality}
                >
                  {#each qualities as quality}
                    <option value={quality}>{quality}</option>
                  {/each}
                </select>
              </label>

              <label class="block">
                <span class="text-sm text-gray-300">Volume</span>
                <input
                  type="range"
                  min="0"
                  max="100"
                  class="mt-1 block w-full"
                  bind:value={stream.volume}
                />
              </label>

              <div class="col-span-2 flex items-center space-x-4">
                <label class="flex items-center space-x-2">
                  <input
                    type="checkbox"
                    class="rounded bg-gray-700 border-gray-600"
                    bind:checked={stream.enabled}
                  />
                  <span class="text-sm text-gray-300">Enabled</span>
                </label>

                <label class="flex items-center space-x-2">
                  <input
                    type="checkbox"
                    class="rounded bg-gray-700 border-gray-600"
                    bind:checked={stream.autoStart}
                  />
                  <span class="text-sm text-gray-300">Auto Start</span>
                </label>

                <label class="flex items-center space-x-2">
                  <input
                    type="checkbox"
                    class="rounded bg-gray-700 border-gray-600"
                    bind:checked={stream.windowMaximized}
                  />
                  <span class="text-sm text-gray-300">Maximized</span>
                </label>
              </div>

              <div class="col-span-2">
                <label class="block text-sm text-gray-300 mb-2">Sorting</label>
                <div class="flex space-x-4">
                  <select
                    class="rounded-md bg-gray-700 border-gray-600"
                    bind:value={stream.sorting.field}
                  >
                    {#each sortFields as field}
                      <option value={field}>{field}</option>
                    {/each}
                  </select>

                  <select
                    class="rounded-md bg-gray-700 border-gray-600"
                    bind:value={stream.sorting.order}
                  >
                    {#each sortOrders as order}
                      <option value={order}>{order}</option>
                    {/each}
                  </select>
                </div>
              </div>
            </div>
          {/if}

          <!-- Sources -->
          <div class="mt-4">
            <div class="flex justify-between items-center mb-2">
              <h4 class="text-sm font-medium text-gray-300">Sources</h4>
              <button
                class="px-2 py-1 bg-blue-600 hover:bg-blue-700 rounded text-xs"
                on:click={() => addSource(streamIndex)}
              >
                Add Source
              </button>
            </div>

            <div class="space-y-2">
              {#each stream.sources as source, sourceIndex}
                <div class="bg-gray-700 p-3 rounded-lg">
                  <div class="flex justify-between items-start">
                    <div>
                      <div class="text-sm font-medium">
                        {source.type} {source.subtype ? `(${source.subtype})` : ''}
                      </div>
                      <div class="text-xs text-gray-400">
                        Priority: {source.priority}, Limit: {source.limit}
                      </div>
                    </div>

                    <div class="flex items-center space-x-2">
                      <button
                        class="p-1 hover:bg-gray-600 rounded"
                        on:click={() => editingSource = sourceIndex}
                      >
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                        </svg>
                      </button>
                      <button
                        class="p-1 hover:bg-red-600 rounded"
                        on:click={() => removeSource(streamIndex, sourceIndex)}
                      >
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                  </div>

                  {#if editingSource === sourceIndex}
                    <div class="grid grid-cols-2 gap-4 mt-4">
                      <label class="block">
                        <span class="text-xs text-gray-400">Type</span>
                        <select
                          class="mt-1 block w-full rounded-md bg-gray-600 border-gray-500 text-sm"
                          bind:value={source.type}
                        >
                          {#each sourceTypes as type}
                            <option value={type}>{type}</option>
                          {/each}
                        </select>
                      </label>

                      <label class="block">
                        <span class="text-xs text-gray-400">Subtype</span>
                        <select
                          class="mt-1 block w-full rounded-md bg-gray-600 border-gray-500 text-sm"
                          bind:value={source.subtype}
                        >
                          <option value="">None</option>
                          {#each sourceSubtypes as subtype}
                            <option value={subtype}>{subtype}</option>
                          {/each}
                        </select>
                      </label>

                      <label class="block">
                        <span class="text-xs text-gray-400">Priority</span>
                        <input
                          type="number"
                          class="mt-1 block w-full rounded-md bg-gray-600 border-gray-500 text-sm"
                          bind:value={source.priority}
                        />
                      </label>

                      <label class="block">
                        <span class="text-xs text-gray-400">Limit</span>
                        <input
                          type="number"
                          class="mt-1 block w-full rounded-md bg-gray-600 border-gray-500 text-sm"
                          bind:value={source.limit}
                        />
                      </label>

                      {#if source.subtype === 'organization'}
                        <label class="block col-span-2">
                          <span class="text-xs text-gray-400">Organization Name</span>
                          <input
                            type="text"
                            class="mt-1 block w-full rounded-md bg-gray-600 border-gray-500 text-sm"
                            bind:value={source.name}
                          />
                        </label>
                      {/if}

                      <label class="flex items-center space-x-2 col-span-2">
                        <input
                          type="checkbox"
                          class="rounded bg-gray-600 border-gray-500"
                          bind:checked={source.enabled}
                        />
                        <span class="text-sm text-gray-300">Enabled</span>
                      </label>
                    </div>
                  {/if}
                </div>
              {/each}
            </div>
          </div>
        </div>
      {/each}
    </div>
  </div>

  <!-- Organizations -->
  <div class="bg-gray-800 rounded-lg p-6">
    <div class="flex justify-between items-center mb-4">
      <h2 class="text-xl font-semibold">Organizations</h2>
      <button
        class="px-3 py-1.5 bg-green-600 hover:bg-green-700 rounded text-sm"
        on:click={addOrganization}
      >
        Add Organization
      </button>
    </div>

    <div class="space-y-2">
      {#each config.organizations as org, i}
        <div class="flex items-center space-x-2">
          <input
            type="text"
            class="flex-1 rounded-md bg-gray-700 border-gray-600"
            bind:value={config.organizations[i]}
          />
          <button
            class="p-1.5 hover:bg-red-600 rounded"
            on:click={() => removeOrganization(i)}
          >
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      {/each}
    </div>
  </div>

  <!-- API Configuration -->
  <div class="bg-gray-800 rounded-lg p-6">
    <h2 class="text-xl font-semibold mb-6">API Configuration</h2>

    <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
      <!-- Holodex -->
      <div class="space-y-4">
        <h3 class="text-lg font-medium">Holodex</h3>
        
        <label class="block">
          <span class="text-sm text-gray-300">API Key</span>
          <input
            type="password"
            class="mt-1 block w-full rounded-md bg-gray-700 border-gray-600"
            bind:value={config.holodex.apiKey}
          />
        </label>

        <div>
          <div class="flex justify-between items-center mb-2">
            <span class="text-sm text-gray-300">Favorite Channels</span>
            <button
              class="px-2 py-1 bg-blue-600 hover:bg-blue-700 rounded text-xs"
              on:click={() => addFavoriteChannel('holodex')}
            >
              Add Channel
            </button>
          </div>

          <div class="space-y-2">
            {#each config.favoriteChannels.holodex as channel, i}
              <div class="flex items-center space-x-2">
                <input
                  type="text"
                  class="flex-1 rounded-md bg-gray-700 border-gray-600"
                  bind:value={config.favoriteChannels.holodex[i]}
                />
                <button
                  class="p-1.5 hover:bg-red-600 rounded"
                  on:click={() => removeFavoriteChannel('holodex', i)}
                >
                  <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            {/each}
          </div>
        </div>
      </div>

      <!-- Twitch -->
      <div class="space-y-4">
        <h3 class="text-lg font-medium">Twitch</h3>
        
        <label class="block">
          <span class="text-sm text-gray-300">Client ID</span>
          <input
            type="password"
            class="mt-1 block w-full rounded-md bg-gray-700 border-gray-600"
            bind:value={config.twitch.clientId}
          />
        </label>

        <label class="block">
          <span class="text-sm text-gray-300">Client Secret</span>
          <input
            type="password"
            class="mt-1 block w-full rounded-md bg-gray-700 border-gray-600"
            bind:value={config.twitch.clientSecret}
          />
        </label>

        <div>
          <div class="flex justify-between items-center mb-2">
            <span class="text-sm text-gray-300">Favorite Channels</span>
            <button
              class="px-2 py-1 bg-blue-600 hover:bg-blue-700 rounded text-xs"
              on:click={() => addFavoriteChannel('twitch')}
            >
              Add Channel
            </button>
          </div>

          <div class="space-y-2">
            {#each config.favoriteChannels.twitch as channel, i}
              <div class="flex items-center space-x-2">
                <input
                  type="text"
                  class="flex-1 rounded-md bg-gray-700 border-gray-600"
                  bind:value={config.favoriteChannels.twitch[i]}
                />
                <button
                  class="p-1.5 hover:bg-red-600 rounded"
                  on:click={() => removeFavoriteChannel('twitch', i)}
                >
                  <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            {/each}
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- Save Button -->
  <div class="flex justify-end">
    <button
      class="px-6 py-2 bg-green-600 hover:bg-green-700 rounded text-white font-medium"
      on:click={save}
    >
      Save Configuration
    </button>
  </div>
</div> 