<script lang="ts">
  import type { LayerConfig } from '../types/config';
  import { createEventDispatcher } from 'svelte';

  let { layer } = $props<{ layer: LayerConfig }>();
  
  const dispatch = createEventDispatcher();

  const blendModes = ['normal', 'multiply', 'screen', 'overlay'];

  function updateLayer() {
    dispatch('update', layer);
  }
</script>

<div class="bg-gray-800 rounded-lg p-6">
  <h2 class="text-xl font-semibold mb-6">Layer Configuration</h2>
  
  <div class="space-y-4">
    <label class="block">
      <span class="text-sm text-gray-300">Z-Index</span>
      <input
        type="number"
        class="mt-1 block w-full rounded-md bg-gray-700 border-gray-600"
        bind:value={layer.zIndex}
        min="0"
        onchange={updateLayer}
      />
    </label>

    <label class="block">
      <span class="text-sm text-gray-300">Opacity</span>
      <div class="flex items-center space-x-4">
        <input
          type="range"
          class="flex-1"
          bind:value={layer.opacity}
          min="0"
          max="1"
          step="0.1"
          onchange={updateLayer}
        />
        <span class="text-sm text-gray-300 w-12 text-right">
          {Math.round(layer.opacity * 100)}%
        </span>
      </div>
    </label>

    <label class="flex items-center space-x-2">
      <input
        type="checkbox"
        class="rounded bg-gray-700 border-gray-600"
        bind:checked={layer.visible}
        onchange={updateLayer}
      />
      <span class="text-sm text-gray-300">Visible</span>
    </label>

    <label class="block">
      <span class="text-sm text-gray-300">Blend Mode</span>
      <select
        class="mt-1 block w-full rounded-md bg-gray-700 border-gray-600"
        bind:value={layer.blendMode}
        onchange={updateLayer}
      >
        {#each blendModes as mode}
          <option value={mode}>{mode}</option>
        {/each}
      </select>
    </label>
  </div>
</div> 