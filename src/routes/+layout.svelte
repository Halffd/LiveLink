<script lang="ts">
    import Navigation from '../components/Navigation.svelte';
    import '../app.css';
    import { onMount } from 'svelte';
    import { initializeStores } from '$lib/stores';

    onMount(() => {
        initializeStores();
    });
</script>

<div class="min-h-screen bg-gray-950 text-gray-100">
    <Navigation />
    <main class="container-fluid py-4">
        <slot />
    </main>
</div>

<style>
    :global(body) {
        margin: 0;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen,
            Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif;
        background-color: #020617;
        color: #f3f4f6;
    }
    :global(*) {
        box-sizing: border-box;
    }
</style>