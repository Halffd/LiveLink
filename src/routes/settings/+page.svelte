<script lang="ts">
  import { playerSettings, screenConfigs } from '$lib/stores';
  import PlayerConfig from '$components/PlayerConfig.svelte';
  import LayerConfig from '$components/LayerConfig.svelte';
  import { onMount } from 'svelte';
  import type { MPVConfig, StreamlinkConfig, LayerConfig as LayerConfigType } from '../types/config';

  let loading = true;
  let error: string | null = null;
  let success: string | null = null;

  const priorities = [
    { value: 'realtime', label: 'Realtime' },
    { value: 'high', label: 'High' },
    { value: 'above_normal', label: 'Above Normal' },
    { value: 'normal', label: 'Normal' },
    { value: 'below_normal', label: 'Below Normal' },
    { value: 'low', label: 'Low' },
    { value: 'idle', label: 'Idle' }
  ];

  const qualities = [
    'best',
    '1080p',
    '720p',
    '480p',
    'worst'
  ];

  async function updatePlayerPriority(priority: string) {
    try {
      const response = await fetch('/api/player/priority', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ priority })
      });

      if (!response.ok) throw new Error('Failed to update priority');

      success = 'Priority updated successfully';
      setTimeout(() => success = null, 3000);

    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to update priority';
      setTimeout(() => error = null, 3000);
    }
  }

  async function updateScreenConfig(screen: number, config: any) {
    try {
      const response = await fetch(`/api/screens/${screen}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config)
      });

      if (!response.ok) throw new Error('Failed to update screen configuration');

      success = 'Screen configuration updated successfully';
      setTimeout(() => success = null, 3000);

    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to update screen configuration';
      setTimeout(() => error = null, 3000);
    }
  }

  async function updatePlayerSettings(settings: any) {
    try {
      const response = await fetch('/api/player/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings)
      });

      if (!response.ok) throw new Error('Failed to update player settings');

      success = 'Settings updated successfully';
      setTimeout(() => success = null, 3000);

    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to update settings';
      setTimeout(() => error = null, 3000);
    }
  }

  async function updateMPVConfig(event: CustomEvent<MPVConfig>) {
    try {
      const response = await fetch('/api/player/mpv', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event.detail)
      });

      if (!response.ok) throw new Error('Failed to update MPV configuration');

      success = 'MPV configuration updated successfully';
      setTimeout(() => success = null, 3000);

    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to update MPV configuration';
      setTimeout(() => error = null, 3000);
    }
  }

  async function updateStreamlinkConfig(event: CustomEvent<StreamlinkConfig>) {
    try {
      const response = await fetch('/api/player/streamlink', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event.detail)
      });

      if (!response.ok) throw new Error('Failed to update Streamlink configuration');

      success = 'Streamlink configuration updated successfully';
      setTimeout(() => success = null, 3000);

    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to update Streamlink configuration';
      setTimeout(() => error = null, 3000);
    }
  }

  async function updateLayerConfig(screen: number, event: CustomEvent<LayerConfigType>) {
    try {
      const response = await fetch(`/api/screens/${screen}/layer`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event.detail)
      });

      if (!response.ok) throw new Error('Failed to update layer configuration');

      success = 'Layer configuration updated successfully';
      setTimeout(() => success = null, 3000);

    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to update layer configuration';
      setTimeout(() => error = null, 3000);
    }
  }

  onMount(async () => {
    try {
      const response = await fetch('/api/player/settings');
      const settings = await response.json();
      playerSettings.set(settings);
      loading = false;
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to load settings';
      loading = false;
    }
  });
</script>

<div class="container mx-auto px-4 py-8">
  <h1 class="text-3xl font-bold mb-8">Settings</h1>

  {#if error}
    <div class="bg-red-500 text-white p-4 rounded mb-4">
      {error}
    </div>
  {/if}

  {#if success}
    <div class="bg-green-500 text-white p-4 rounded mb-4">
      {success}
    </div>
  {/if}

  {#if loading}
    <div class="flex justify-center items-center h-64">
      <div class="animate-spin rounded-full h-32 w-32 border-b-2 border-white"></div>
    </div>
  {:else}
    <div class="space-y-8">
      <!-- Basic Player Settings -->
      <div class="bg-gray-800 rounded-lg p-6">
        <h2 class="text-xl font-semibold mb-6">Basic Settings</h2>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div class="space-y-4">
            <label class="block">
              <span class="text-sm text-gray-300">Default Quality</span>
              <select
                class="mt-1 block w-full rounded-md bg-gray-700 border-gray-600"
                bind:value={$playerSettings.defaultQuality}
                on:change={() => updatePlayerSettings($playerSettings)}
              >
                {#each qualities as quality}
                  <option value={quality}>{quality}</option>
                {/each}
              </select>
            </label>

            <label class="block">
              <span class="text-sm text-gray-300">Default Volume</span>
              <input
                type="range"
                class="mt-1 block w-full"
                min="0"
                max="100"
                bind:value={$playerSettings.defaultVolume}
                on:change={() => updatePlayerSettings($playerSettings)}
              />
            </label>

            <label class="flex items-center space-x-2">
              <input
                type="checkbox"
                class="rounded bg-gray-700 border-gray-600"
                bind:checked={$playerSettings.preferStreamlink}
                on:change={() => updatePlayerSettings($playerSettings)}
              />
              <span class="text-sm text-gray-300">Prefer Streamlink for Twitch</span>
            </label>

            <label class="flex items-center space-x-2">
              <input
                type="checkbox"
                class="rounded bg-gray-700 border-gray-600"
                bind:checked={$playerSettings.windowMaximized}
                on:change={() => updatePlayerSettings($playerSettings)}
              />
              <span class="text-sm text-gray-300">Start Maximized</span>
            </label>

            <label class="flex items-center space-x-2">
              <input
                type="checkbox"
                class="rounded bg-gray-700 border-gray-600"
                bind:checked={$playerSettings.autoStart}
                on:change={() => updatePlayerSettings($playerSettings)}
              />
              <span class="text-sm text-gray-300">Auto-start Streams</span>
            </label>
          </div>

          <div class="space-y-4">
            <label class="block">
              <span class="text-sm text-gray-300">Maximum Streams</span>
              <input
                type="number"
                class="mt-1 block w-full rounded-md bg-gray-700 border-gray-600"
                min="1"
                max="16"
                bind:value={$playerSettings.maxStreams}
                on:change={() => updatePlayerSettings($playerSettings)}
              />
            </label>
          </div>
        </div>
      </div>

      <!-- MPV and Streamlink Configuration -->
      <PlayerConfig
        mpvConfig={$playerSettings.mpv || {}}
        streamlinkConfig={$playerSettings.streamlink || {}}
        on:mpvupdate={updateMPVConfig}
        on:streamlinkupdate={updateStreamlinkConfig}
      />

      <!-- Screen Configurations -->
      <div class="space-y-6">
        <h2 class="text-xl font-semibold">Screen Configurations</h2>

        {#each Array.from($screenConfigs) as [screen, config]}
          <div class="bg-gray-800 rounded-lg p-6">
            <h3 class="text-lg font-semibold mb-4">Screen {screen}</h3>

            <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
              <!-- Screen Settings -->
              <div class="space-y-4">
                <label class="flex items-center space-x-2">
                  <input
                    type="checkbox"
                    class="rounded bg-gray-700 border-gray-600"
                    bind:checked={config.enabled}
                    on:change={() => updatePlayerSettings($playerSettings)}
                  />
                  <span class="text-sm text-gray-300">Enabled</span>
                </label>

                <label class="block">
                  <span class="text-sm text-gray-300">Width</span>
                  <input
                    type="number"
                    class="mt-1 block w-full rounded-md bg-gray-700 border-gray-600"
                    bind:value={config.width}
                    on:change={() => updatePlayerSettings($playerSettings)}
                  />
                </label>

                <label class="block">
                  <span class="text-sm text-gray-300">Height</span>
                  <input
                    type="number"
                    class="mt-1 block w-full rounded-md bg-gray-700 border-gray-600"
                    bind:value={config.height}
                    on:change={() => updatePlayerSettings($playerSettings)}
                  />
                </label>

                <label class="block">
                  <span class="text-sm text-gray-300">X Position</span>
                  <input
                    type="number"
                    class="mt-1 block w-full rounded-md bg-gray-700 border-gray-600"
                    bind:value={config.x}
                    on:change={() => updatePlayerSettings($playerSettings)}
                  />
                </label>

                <label class="block">
                  <span class="text-sm text-gray-300">Y Position</span>
                  <input
                    type="number"
                    class="mt-1 block w-full rounded-md bg-gray-700 border-gray-600"
                    bind:value={config.y}
                    on:change={() => updatePlayerSettings($playerSettings)}
                  />
                </label>
              </div>

              <!-- Layer Configuration -->
              {#if config.enabled}
                <LayerConfig
                  layer={config.layer || {
                    zIndex: 0,
                    opacity: 1,
                    visible: true,
                    blendMode: 'normal'
                  }}
                  on:update={(event) => updateLayerConfig(screen, event)}
                />
              {/if}
            </div>
          </div>
        {/each}
      </div>
    </div>
  {/if}
</div> 