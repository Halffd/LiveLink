<script lang="ts">
	import { i18n } from '$lib/i18n';
	import { ParaglideJS } from '@inlang/paraglide-sveltekit';
	import '../app.css';
	let { children } = $props();
</script>

<ParaglideJS {i18n}>
	<nav class="bg-gray-800 text-white p-4">
		<div class="container mx-auto">
			<a href="/streams" class="hover:text-gray-300">Stream Manager</a>
		</div>
	</nav>
	
	<main class="container mx-auto">
		{@render children()}
	</main>
</ParaglideJS>
