<script lang="ts">
	import Navigation from '../components/Navigation.svelte';
	import '../app.css';
	import { onMount } from 'svelte';
	import { initializeStores } from '$lib/stores';

	onMount(() => {
		initializeStores();
	});
</script>

<div class="min-h-screen bg-gray-900 text-white">
	<Navigation />
	<main class="container mx-auto px-4 py-8">
		<slot />
	</main>
</div>

<style>
	:global(body) {
		margin: 0;
		font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen,
			Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif;
		background-color: #111827;
		color: white;
	}
</style>
