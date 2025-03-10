<script lang="ts">
  import { api } from '$lib/api';
  import type { Stream } from '../types/stream.js';
  import { onMount, onDestroy } from 'svelte';

  let { stream } = $props<{
    stream: Stream;
  }>();

  let volume = $state(stream.volume || 50);
  let seeking = $state(false);
  let error = $state<string | null>(null);
  let isPaused = $state(stream.playerStatus === 'paused');

  let updateInterval: ReturnType<typeof setInterval>;

  const handleVolumeChange = async (event: Event) => {
    const target = event.target as HTMLInputElement;
    const newVolume = parseInt(target.value);
    try {
      await api.setVolume(stream.screen, newVolume);
      volume = newVolume;
    } catch (err) {
      console.error('Error setting volume:', err);
      error = err instanceof Error ? err.message : 'Failed to set volume';
      setTimeout(() => error = null, 3000);
    }
  };

  const togglePause = async () => {
    try {
      await api.togglePause(stream.screen);
      isPaused = !isPaused;
    } catch (err) {
      console.error('Error toggling pause:', err);
      error = err instanceof Error ? err.message : 'Failed to toggle pause';
      setTimeout(() => error = null, 3000);
    }
  };

  const updateStreamStatus = async () => {
    try {
      const status = await api.getStreamStatus(stream.screen);
      isPaused = status.playerStatus === 'paused';
      volume = status.volume || volume;
    } catch (err) {
      console.error('Error updating stream status:', err);
    }
  };

  async function handleSeek(seconds: number) {
    if (seeking) return;
    seeking = true;
    try {
      await api.seek(stream.screen, seconds);
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to seek';
      setTimeout(() => error = null, 3000);
    } finally {
      seeking = false;
    }
  }

  async function restartStream() {
    try {
      await api.restartStream(stream.screen);
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to restart stream';
      setTimeout(() => error = null, 3000);
    }
  }

  onMount(() => {
    updateStreamStatus();
    updateInterval = setInterval(updateStreamStatus, 2000);
  });

  onDestroy(() => {
    if (updateInterval) {
      clearInterval(updateInterval);
    }
  });
</script>

<div class="card card-dark mb-4">
  <div class="card-header card-header-dark">
    <h5 class="mb-0">Player Controls</h5>
  </div>
  
  <div class="card-body">
    {#if error}
      <div class="alert alert-danger alert-dismissible fade show mb-3">
        <strong>Error!</strong> {error}
        <button type="button" class="btn-close" on:click={() => error = null}></button>
      </div>
    {/if}

    <div class="d-flex align-items-center gap-3">
      <button
        class="btn btn-outline-light"
        on:click={togglePause}
        title={isPaused ? 'Play' : 'Pause'}
        aria-label={isPaused ? 'Play' : 'Pause'}
      >
        <i class="bi {isPaused ? 'bi-play-fill' : 'bi-pause-fill'}"></i>
      </button>

      <div class="d-flex gap-2">
        <button
          class="btn btn-outline-light"
          on:click={() => handleSeek(-10)}
          title="Rewind 10s"
          disabled={seeking}
        >
          <i class="bi bi-rewind-fill"></i>
        </button>

        <button
          class="btn btn-outline-light"
          on:click={() => handleSeek(10)}
          title="Forward 10s"
          disabled={seeking}
        >
          <i class="bi bi-fast-forward-fill"></i>
        </button>
      </div>

      <div class="d-flex align-items-center flex-grow-1 gap-2">
        <i class="bi bi-volume-up"></i>
        <input
          type="range"
          class="form-range"
          min="0"
          max="100"
          bind:value={volume}
          on:change={handleVolumeChange}
        />
      </div>

      <button
        class="btn btn-outline-light"
        on:click={restartStream}
        title="Restart Stream"
      >
        <i class="bi bi-arrow-repeat"></i>
      </button>
    </div>
    
    <div class="mt-3">
      <div class="d-flex justify-content-between text-muted small">
        <div>Status: <span class="badge {stream.playerStatus === 'playing' ? 'bg-success' : stream.playerStatus === 'paused' ? 'bg-warning text-dark' : stream.playerStatus === 'error' ? 'bg-danger' : 'bg-secondary'}">{stream.playerStatus || 'unknown'}</span></div>
        <div>Volume: {volume}%</div>
      </div>
    </div>
  </div>
</div>

<style>
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
  
  /* Bootstrap Icons fallback */
  .bi-play-fill::before {
    content: "▶";
  }
  
  .bi-rewind-fill::before {
    content: "◀◀";
  }
  
  .bi-fast-forward-fill::before {
    content: "▶▶";
  }
  
  .bi-volume-up::before {
    content: "🔊";
  }
  
  .bi-arrow-repeat::before {
    content: "↻";
  }
</style> 