<script lang="ts">
	import Navigation from '../components/Navigation.svelte';
	import '../app.css';
	import { onMount } from 'svelte';
	import { initializeStores } from '$lib/stores';

	onMount(() => {
		initializeStores();
		
		// Initialize Bootstrap JavaScript components
		if (typeof document !== 'undefined') {
			// Import Bootstrap JS
			import('bootstrap/dist/js/bootstrap.bundle.min.js').then(() => {
				console.log('Bootstrap JS loaded');
			});
		}
	});
</script>

<div class="min-vh-100 bg-dark text-light">
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
		background-color: #111827;
		color: white;
	}
</style>
