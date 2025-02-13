<script lang="ts">
  import { page } from '$app/stores';
  import { activeStreams } from '$lib/stores';

  $: activeStreamCount = $activeStreams.length;
</script>

<header class="bg-gray-800 shadow-lg">
  <div class="container mx-auto px-4">
    <nav class="flex items-center justify-between h-16">
      <div class="flex items-center space-x-8">
        <a href="/" class="text-xl font-bold text-white hover:text-gray-300">
          LiveLink
        </a>
        
        <div class="hidden md:flex space-x-4">
          <a 
            href="/streams" 
            class="px-3 py-2 rounded-md text-sm font-medium {$page.url.pathname.startsWith('/streams') ? 'bg-gray-900 text-white' : 'text-gray-300 hover:bg-gray-700 hover:text-white'}"
          >
            Streams {activeStreamCount > 0 ? `(${activeStreamCount})` : ''}
          </a>
          
          <a 
            href="/settings" 
            class="px-3 py-2 rounded-md text-sm font-medium {$page.url.pathname === '/settings' ? 'bg-gray-900 text-white' : 'text-gray-300 hover:bg-gray-700 hover:text-white'}"
          >
            Settings
          </a>
        </div>
      </div>

      <div class="flex items-center space-x-4">
        <button 
          class="px-4 py-2 rounded bg-purple-600 hover:bg-purple-700 text-white font-medium text-sm transition-colors"
          on:click={() => window.location.href = '/api/auth/twitch'}
        >
          Connect Twitch
        </button>
      </div>
    </nav>
  </div>
</header> 