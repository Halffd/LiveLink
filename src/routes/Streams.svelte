<script lang="ts">
    import { onMount } from 'svelte';
    import type { Stream, StreamConfig } from '../types/stream.js';
    import { api } from '$lib/api';
    import PlayerControls from '../components/PlayerControls.svelte';
    import QueueList from '../components/QueueList.svelte';

    let streams = $state<Stream[]>([]);
    let screenConfigs = $state<StreamConfig[]>([]);
    let url = $state('');
    let quality = $state('best');
    let selectedScreen = $state(1);
    let error = $state<string | null>(null);

    const qualities = ['best', 'high', 'medium', 'low'];

    const fetchStreams = async () => {
        try {
            const [activeStreams, configs] = await Promise.all([
                api.getActiveStreams(),
                api.getScreenConfigs()
            ]);
            streams = activeStreams;
            screenConfigs = configs;
        } catch (err) {
            error = err instanceof Error ? err.message : 'Failed to fetch streams';
            setTimeout(() => error = null, 3000);
        }
    };

    const addStream = async () => {
        try {
            await api.startStream(url, selectedScreen, quality);
            await fetchStreams();
            url = '';
            quality = 'best';
        } catch (err) {
            error = err instanceof Error ? err.message : 'Failed to add stream';
            setTimeout(() => error = null, 3000);
        }
    };

    const stopStream = async (screen: number) => {
        try {
            await api.stopStream(screen);
            await fetchStreams();
        } catch (err) {
            error = err instanceof Error ? err.message : 'Failed to stop stream';
            setTimeout(() => error = null, 3000);
        }
    };

    const toggleScreen = async (screen: number) => {
        try {
            const config = screenConfigs.find(c => c.screen === screen);
            if (config) {
                await api.updateScreenConfig(screen, { enabled: !config.enabled });
                await fetchStreams();
            }
        } catch (err) {
            error = err instanceof Error ? err.message : 'Failed to toggle screen';
            setTimeout(() => error = null, 3000);
        }
    };

    const stopAllStreams = async () => {
        try {
            for (const stream of streams) {
                await api.stopStream(stream.screen);
            }
            await fetchStreams();
        } catch (err) {
            error = err instanceof Error ? err.message : 'Failed to stop all streams';
            setTimeout(() => error = null, 3000);
        }
    };

    const autoStartStreams = async () => {
        try {
            await fetch('/api/streams/autostart', { method: 'POST' });
            await fetchStreams();
        } catch (err) {
            error = err instanceof Error ? err.message : 'Failed to auto-start streams';
            setTimeout(() => error = null, 3000);
        }
    };

    onMount(fetchStreams);
</script>

<div class="container-fluid py-4">
    <div class="d-flex justify-content-between align-items-center mb-4">
        <h1 class="h3 mb-0">Stream Manager</h1>
        <div class="d-flex gap-2">
            <button
                on:click={autoStartStreams}
                class="btn btn-success"
            >
                Auto-Start Streams
            </button>
            <button
                on:click={stopAllStreams}
                class="btn btn-danger"
                disabled={streams.length === 0}
            >
                Stop All Streams
            </button>
        </div>
    </div>

    {#if error}
        <div class="alert alert-danger alert-dismissible fade show mb-4">
            <strong>Error!</strong> {error}
            <button type="button" class="btn-close" on:click={() => error = null}></button>
        </div>
    {/if}

    <div class="card card-dark mb-4">
        <div class="card-header card-header-dark">
            <h5 class="mb-0">Add Stream</h5>
        </div>
        <div class="card-body">
            <div class="row g-3">
                <div class="col-md-6">
                    <label for="streamUrl" class="form-label">Stream URL</label>
                    <input 
                        type="text" 
                        id="streamUrl"
                        class="form-control bg-dark text-light border-secondary" 
                        bind:value={url} 
                        placeholder="Enter stream URL"
                    />
                </div>
                <div class="col-md-3">
                    <label for="screenSelect" class="form-label">Screen</label>
                    <select
                        id="screenSelect"
                        bind:value={selectedScreen}
                        class="form-select bg-dark text-light border-secondary"
                    >
                        {#each screenConfigs as config}
                            <option value={config.screen}>
                                Screen {config.screen} {config.enabled ? '' : '(Disabled)'}
                            </option>
                        {/each}
                    </select>
                </div>
                <div class="col-md-3">
                    <label for="qualitySelect" class="form-label">Quality</label>
                    <select 
                        id="qualitySelect"
                        bind:value={quality}
                        class="form-select bg-dark text-light border-secondary"
                    >
                        {#each qualities as q}
                            <option value={q}>{q}</option>
                        {/each}
                    </select>
                </div>
            </div>
            <div class="d-flex justify-content-end mt-3">
                <button 
                    on:click={addStream}
                    class="btn btn-primary"
                    disabled={!url}
                >
                    Add Stream
                </button>
            </div>
        </div>
    </div>

    <h2 class="h4 mb-3">Active Streams</h2>
    {#if streams.length === 0}
        <div class="alert alert-secondary">No active streams</div>
    {:else}
        <div class="row g-4">
            {#each streams as stream (stream.screen)}
                <div class="col-12">
                    <div class="card card-dark">
                        <div class="card-header card-header-dark d-flex justify-content-between align-items-center">
                            <h5 class="mb-0">Screen {stream.screen}</h5>
                            <div class="d-flex gap-2">
                                <button 
                                    on:click={() => toggleScreen(stream.screen)}
                                    class="btn btn-sm {screenConfigs.find(c => c.screen === stream.screen)?.enabled ? 'btn-warning' : 'btn-success'}"
                                >
                                    {screenConfigs.find(c => c.screen === stream.screen)?.enabled ? 'Disable' : 'Enable'}
                                </button>
                                <button 
                                    on:click={() => stopStream(stream.screen)}
                                    class="btn btn-sm btn-danger"
                                >
                                    Stop
                                </button>
                            </div>
                        </div>
                        <div class="card-body">
                            <div class="mb-3">
                                <p class="mb-1"><strong>URL:</strong> <span class="text-muted">{stream.url}</span></p>
                                <p class="mb-0"><strong>Quality:</strong> <span class="text-muted">{stream.quality}</span></p>
                            </div>
                            <PlayerControls {stream} />
                            <QueueList screen={stream.screen} queue={stream.queue || []} />
                        </div>
                    </div>
                </div>
            {/each}
        </div>
    {/if}
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
</style>
