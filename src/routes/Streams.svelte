<script lang="ts">
    import { onMount } from 'svelte';
    import type { Stream } from '../types/stream.js';

    let streams = $state<Stream[]>([]);
    let url = $state('');
    let quality = $state('');
    let error = $state<string | null>(null);

    const fetchStreams = async () => {
        try {
            const response = await fetch('/api/streams/active');
            if (!response.ok) throw new Error('Failed to fetch streams');
            streams = await response.json();
        } catch (err) {
            error = err instanceof Error ? err.message : 'Failed to fetch streams';
        }
    };

    const addStream = async () => {
        try {
            const response = await fetch('/api/streams', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url, quality })
            });
            if (!response.ok) throw new Error('Failed to add stream');
            await fetchStreams();
            // Clear inputs on success
            url = '';
            quality = '';
        } catch (err) {
            error = err instanceof Error ? err.message : 'Failed to add stream';
        }
    };

    const stopStream = async (screen: number) => {
        try {
            const response = await fetch(`/api/streams/${screen}`, { 
                method: 'DELETE' 
            });
            if (!response.ok) throw new Error('Failed to stop stream');
            await fetchStreams();
        } catch (err) {
            error = err instanceof Error ? err.message : 'Failed to stop stream';
        }
    };

    onMount(fetchStreams);
</script>

<div class="space-y-6">
    <h1 class="text-2xl font-bold">Stream Manager</h1>

    {#if error}
        <div class="bg-red-500 text-white p-4 rounded">
            {error}
            <button class="ml-4 underline" on:click={() => error = null}>Dismiss</button>
        </div>
    {/if}

    <div class="space-y-4">
        <div class="flex gap-4">
            <input 
                type="text" 
                bind:value={url} 
                placeholder="Stream URL"
                class="flex-1 px-4 py-2 rounded bg-gray-700"
            />
            <input 
                type="text" 
                bind:value={quality} 
                placeholder="Quality (optional)"
                class="w-48 px-4 py-2 rounded bg-gray-700"
            />
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
                <div class="space-y-2">
                    {#each streams as stream (stream.screen)}
                        <div class="flex justify-between items-center p-4 bg-gray-800 rounded">
                            <div>
                                <h3 class="font-medium">{stream.title || 'Untitled Stream'}</h3>
                                <p class="text-sm text-gray-400">{stream.url}</p>
                                <p class="text-sm text-gray-400">Quality: {stream.quality}</p>
                            </div>
                            <button 
                                on:click={() => stopStream(stream.screen)}
                                class="px-3 py-1 bg-red-600 hover:bg-red-700 rounded text-white"
                            >
                                Stop
                            </button>
                        </div>
                    {/each}
                </div>
            {/if}
        </div>
    </div>
</div>
