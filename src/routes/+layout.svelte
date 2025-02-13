<script lang="ts">
	import '../app.css';
	import Header from '$components/Header.svelte';
	import { onMount } from 'svelte';
	import { initializeStores } from '$lib/stores';

	onMount(() => {
		initializeStores();
	});
</script>

<div class="min-h-screen bg-gray-900 text-white">
	<Header />
	<main class="container mx-auto px-4 py-8">
		<slot />
	</main>
</div>
