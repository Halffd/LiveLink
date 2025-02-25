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

<div class="space-y-6 p-6">
    <div class="flex justify-between items-center">
        <h1 class="text-2xl font-bold">Stream Manager</h1>
        <div class="space-x-4">
            <button
                on:click={autoStartStreams}
                class="px-4 py-2 bg-green-600 hover:bg-green-700 rounded text-white"
            >
                Auto-Start Streams
            </button>
            <button
                on:click={stopAllStreams}
                class="px-4 py-2 bg-red-600 hover:bg-red-700 rounded text-white"
                disabled={streams.length === 0}
            >
                Stop All Streams
            </button>
        </div>
    </div>

    {#if error}
        <div class="bg-red-500 text-white p-4 rounded">
            {error}
            <button class="ml-4 underline" on:click={() => error = null}>Dismiss</button>
        </div>
    {/if}

    <div class="space-y-4">
        <div class="grid grid-cols-3 gap-4">
            <input 
                type="text" 
                bind:value={url} 
                placeholder="Stream URL"
                class="px-4 py-2 rounded bg-gray-700"
            />
            <select
                bind:value={selectedScreen}
                class="px-4 py-2 rounded bg-gray-700"
            >
                {#each screenConfigs as config}
                    <option value={config.screen}>
                        Screen {config.screen} {config.enabled ? '' : '(Disabled)'}
                    </option>
                {/each}
            </select>
            <select 
                bind:value={quality}
                class="px-4 py-2 rounded bg-gray-700"
            >
                {#each qualities as q}
                    <option value={q}>{q}</option>
                {/each}
            </select>
        </div>
        <div class="flex justify-end">
            <button 
                on:click={addStream}
                class="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded text-white"
                disabled={!url}
            >
                Add Stream
            </button>
        </div>

        <div class="space-y-4">
            <h2 class="text-xl font-semibold">Active Streams</h2>
            {#if streams.length === 0}
                <p class="text-gray-400">No active streams</p>
            {:else}
                <div class="space-y-4">
                    {#each streams as stream (stream.screen)}
                        <div class="bg-gray-800 rounded-lg overflow-hidden">
                            <div class="p-4">
                                <div class="flex justify-between items-start mb-4">
                                    <div>
                                        <h3 class="font-medium text-lg">Screen {stream.screen}</h3>
                                        <p class="text-sm text-gray-400">{stream.url}</p>
                                        <p class="text-sm text-gray-400">Quality: {stream.quality}</p>
                                    </div>
                                    <div class="space-x-2">
                                        <button 
                                            on:click={() => toggleScreen(stream.screen)}
                                            class="px-3 py-1 bg-yellow-600 hover:bg-yellow-700 rounded text-white"
                                        >
                                            {screenConfigs.find(c => c.screen === stream.screen)?.enabled ? 'Disable' : 'Enable'}
                                        </button>
                                        <button 
                                            on:click={() => stopStream(stream.screen)}
                                            class="px-3 py-1 bg-red-600 hover:bg-red-700 rounded text-white"
                                        >
                                            Stop
                                        </button>
                                    </div>
                                </div>
                                <PlayerControls {stream} />
                            </div>
                            <QueueList screen={stream.screen} queue={stream.queue || []} />
                        </div>
                    {/each}
                </div>
            {/if}
        </div>
    </div>
</div>
