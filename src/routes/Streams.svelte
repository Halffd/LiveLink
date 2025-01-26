<script lang="ts">
    import { onMount } from 'svelte';
    let streams = [];
    let url = '';
    let quality = '';

    const fetchStreams = async () => {
        const response = await fetch('/api/streams');
        streams = await response.json();
    };

    const addStream = async () => {
        await fetch('/api/streams', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, quality })
        });
        fetchStreams();
    };

    const stopStream = async (url) => {
        await fetch(`/api/streams/${url}`, { method: 'DELETE' });
        fetchStreams();
    };

    onMount(fetchStreams);
</script>

<h1>Stream Manager</h1>
<input type="text" bind:value={url} placeholder="Stream URL" />
<input type="text" bind:value={quality} placeholder="Quality" />
<button on:click={addStream}>Add Stream</button>

<h2>Current Streams</h2>
<ul>
    {#each Object.keys(streams) as streamUrl}
        <li>
            {streamUrl} <button on:click={() => stopStream(streamUrl)}>Stop</button>
        </li>
    {/each}
</ul>
