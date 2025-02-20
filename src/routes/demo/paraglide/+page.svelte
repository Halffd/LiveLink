<script lang="ts">
	import { locale, t } from '$lib/i18n';
</script>

<div class="container mx-auto px-4 py-8">
	<h1 class="text-2xl font-bold mb-4">{$t.welcome}</h1>
	
	<div class="space-y-4">
		<div class="flex space-x-4">
			<button 
				class="px-4 py-2 bg-blue-500 text-white rounded"
				onclick={() => locale.set('en')}
			>
				English
			</button>
			<button 
				class="px-4 py-2 bg-blue-500 text-white rounded"
				onclick={() => locale.set('ja')}
			>
				日本語
			</button>
		</div>

		<div class="space-y-2">
			<p>{$t.streams}</p>
			<p>{$t.settings}</p>
			<p>{$t.queue}</p>
			<p>{$t.connectTwitch}</p>
		</div>
	</div>
</div>
