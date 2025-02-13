<script lang="ts">
  import type { MPVConfig, StreamlinkConfig } from '../types/config';
  import { createEventDispatcher } from 'svelte';

  export let mpvConfig: MPVConfig = {};
  export let streamlinkConfig: StreamlinkConfig = {};

  const dispatch = createEventDispatcher();

  const videoOutputs = ['gpu', 'gpu-next', 'libmpv', 'null'];
  const hwdecOptions = ['auto', 'auto-copy', 'no', 'vaapi', 'vdpau', 'cuda'];
  const gpuApiOptions = ['auto', 'opengl', 'vulkan', 'directx11'];
  const videoSyncOptions = ['audio', 'display-resample', 'display-resample-vdrop', 'display-vdrop'];
  const tscaleOptions = ['oversample', 'linear', 'catmull_rom', 'mitchell', 'gaussian', 'bicubic'];
  const audioChannelOptions = ['auto', 'stereo', '5.1', '7.1'];

  function updateMPVConfig() {
    dispatch('mpvupdate', mpvConfig);
  }

  function updateStreamlinkConfig() {
    dispatch('streamlinkupdate', streamlinkConfig);
  }
</script>

<div class="space-y-8">
  <!-- MPV Configuration -->
  <div class="bg-gray-800 rounded-lg p-6">
    <h2 class="text-xl font-semibold mb-6">MPV Configuration</h2>
    
    <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
      <!-- Core Settings -->
      <div class="space-y-4">
        <h3 class="text-lg font-medium">Core Settings</h3>
        
        <label class="block">
          <span class="text-sm text-gray-300">Video Output</span>
          <select
            class="mt-1 block w-full rounded-md bg-gray-700 border-gray-600"
            bind:value={mpvConfig.vo}
            on:change={updateMPVConfig}
          >
            <option value="">Auto</option>
            {#each videoOutputs as output}
              <option value={output}>{output}</option>
            {/each}
          </select>
        </label>

        <label class="block">
          <span class="text-sm text-gray-300">Hardware Decoding</span>
          <select
            class="mt-1 block w-full rounded-md bg-gray-700 border-gray-600"
            bind:value={mpvConfig.hwdec}
            on:change={updateMPVConfig}
          >
            <option value="">Auto</option>
            {#each hwdecOptions as option}
              <option value={option}>{option}</option>
            {/each}
          </select>
        </label>

        <label class="block">
          <span class="text-sm text-gray-300">GPU API</span>
          <select
            class="mt-1 block w-full rounded-md bg-gray-700 border-gray-600"
            bind:value={mpvConfig['gpu-api']}
            on:change={updateMPVConfig}
          >
            <option value="">Auto</option>
            {#each gpuApiOptions as api}
              <option value={api}>{api}</option>
            {/each}
          </select>
        </label>
      </div>

      <!-- Video Settings -->
      <div class="space-y-4">
        <h3 class="text-lg font-medium">Video Settings</h3>
        
        <label class="block">
          <span class="text-sm text-gray-300">Video Sync</span>
          <select
            class="mt-1 block w-full rounded-md bg-gray-700 border-gray-600"
            bind:value={mpvConfig.video_sync}
            on:change={updateMPVConfig}
          >
            <option value="">Default</option>
            {#each videoSyncOptions as sync}
              <option value={sync}>{sync}</option>
            {/each}
          </select>
        </label>

        <label class="block">
          <span class="text-sm text-gray-300">Temporal Scale</span>
          <select
            class="mt-1 block w-full rounded-md bg-gray-700 border-gray-600"
            bind:value={mpvConfig.tscale}
            on:change={updateMPVConfig}
          >
            <option value="">Default</option>
            {#each tscaleOptions as scale}
              <option value={scale}>{scale}</option>
            {/each}
          </select>
        </label>

        <label class="flex items-center space-x-2">
          <input
            type="checkbox"
            class="rounded bg-gray-700 border-gray-600"
            bind:checked={mpvConfig.interpolation}
            on:change={updateMPVConfig}
          />
          <span class="text-sm text-gray-300">Enable Interpolation</span>
        </label>
      </div>

      <!-- Audio Settings -->
      <div class="space-y-4">
        <h3 class="text-lg font-medium">Audio Settings</h3>
        
        <label class="block">
          <span class="text-sm text-gray-300">Audio Channels</span>
          <select
            class="mt-1 block w-full rounded-md bg-gray-700 border-gray-600"
            bind:value={mpvConfig.audio_channels}
            on:change={updateMPVConfig}
          >
            <option value="">Auto</option>
            {#each audioChannelOptions as channels}
              <option value={channels}>{channels}</option>
            {/each}
          </select>
        </label>
      </div>

      <!-- Performance Settings -->
      <div class="space-y-4">
        <h3 class="text-lg font-medium">Performance Settings</h3>
        
        <label class="flex items-center space-x-2">
          <input
            type="checkbox"
            class="rounded bg-gray-700 border-gray-600"
            bind:checked={mpvConfig.gpu_dumb_mode}
            on:change={updateMPVConfig}
          />
          <span class="text-sm text-gray-300">GPU Dumb Mode</span>
        </label>

        <label class="block">
          <span class="text-sm text-gray-300">Video Decoder Threads</span>
          <input
            type="number"
            class="mt-1 block w-full rounded-md bg-gray-700 border-gray-600"
            bind:value={mpvConfig.vd_lavc_threads}
            min="0"
            max="32"
            on:change={updateMPVConfig}
          />
        </label>
      </div>
    </div>
  </div>

  <!-- Streamlink Configuration -->
  <div class="bg-gray-800 rounded-lg p-6">
    <h2 class="text-xl font-semibold mb-6">Streamlink Configuration</h2>
    
    <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
      <!-- Stream Settings -->
      <div class="space-y-4">
        <h3 class="text-lg font-medium">Stream Settings</h3>
        
        <label class="block">
          <span class="text-sm text-gray-300">Retry Open</span>
          <input
            type="number"
            class="mt-1 block w-full rounded-md bg-gray-700 border-gray-600"
            bind:value={streamlinkConfig.retry_open}
            min="0"
            on:change={updateStreamlinkConfig}
          />
        </label>

        <label class="block">
          <span class="text-sm text-gray-300">Retry Streams</span>
          <input
            type="number"
            class="mt-1 block w-full rounded-md bg-gray-700 border-gray-600"
            bind:value={streamlinkConfig.retry_streams}
            min="0"
            on:change={updateStreamlinkConfig}
          />
        </label>

        <label class="block">
          <span class="text-sm text-gray-300">Stream Timeout (seconds)</span>
          <input
            type="number"
            class="mt-1 block w-full rounded-md bg-gray-700 border-gray-600"
            bind:value={streamlinkConfig.stream_timeout}
            min="0"
            on:change={updateStreamlinkConfig}
          />
        </label>
      </div>

      <!-- Buffer Settings -->
      <div class="space-y-4">
        <h3 class="text-lg font-medium">Buffer Settings</h3>
        
        <label class="block">
          <span class="text-sm text-gray-300">Ring Buffer Size</span>
          <input
            type="text"
            class="mt-1 block w-full rounded-md bg-gray-700 border-gray-600"
            bind:value={streamlinkConfig.ringbuffer_size}
            placeholder="e.g., 32M"
            on:change={updateStreamlinkConfig}
          />
        </label>

        <label class="block">
          <span class="text-sm text-gray-300">Segment Threads</span>
          <input
            type="number"
            class="mt-1 block w-full rounded-md bg-gray-700 border-gray-600"
            bind:value={streamlinkConfig.stream_segment_threads}
            min="1"
            max="10"
            on:change={updateStreamlinkConfig}
          />
        </label>

        <label class="block">
          <span class="text-sm text-gray-300">Segment Timeout (seconds)</span>
          <input
            type="number"
            class="mt-1 block w-full rounded-md bg-gray-700 border-gray-600"
            bind:value={streamlinkConfig.stream_segment_timeout}
            min="0"
            on:change={updateStreamlinkConfig}
          />
        </label>
      </div>

      <!-- Platform Settings -->
      <div class="space-y-4">
        <h3 class="text-lg font-medium">Platform Settings</h3>
        
        <label class="flex items-center space-x-2">
          <input
            type="checkbox"
            class="rounded bg-gray-700 border-gray-600"
            bind:checked={streamlinkConfig.twitch_disable_hosting}
            on:change={updateStreamlinkConfig}
          />
          <span class="text-sm text-gray-300">Disable Twitch Hosting</span>
        </label>

        <label class="flex items-center space-x-2">
          <input
            type="checkbox"
            class="rounded bg-gray-700 border-gray-600"
            bind:checked={streamlinkConfig.twitch_disable_ads}
            on:change={updateStreamlinkConfig}
          />
          <span class="text-sm text-gray-300">Disable Twitch Ads</span>
        </label>
      </div>
    </div>
  </div>
</div> 