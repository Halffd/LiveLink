<script lang="ts">
  import { twitchUser } from '$lib/stores/auth';

  export let title = 'LiveLink';
</script>

<header class="w-full bg-gray-800 text-white">
  <div class="container mx-auto px-4 py-3">
    <div class="flex justify-between items-center">
      <div class="flex items-center gap-6">
        <h1 class="text-xl font-bold">{title}</h1>
        <nav class="flex gap-4">
          <a 
            href="/" 
            class="hover:text-gray-300 transition-colors"
          >
            Home
          </a>
          <a 
            href="/manager" 
            class="hover:text-gray-300 transition-colors"
          >
            Stream Manager
          </a>
        </nav>
      </div>

      <div>
        {#if !$twitchUser.isAuthenticated}
          <a 
            href="/api/auth/twitch"
            class="bg-purple-600 hover:bg-purple-700 px-4 py-2 rounded transition-colors"
          >
            Login with Twitch
          </a>
        {:else}
          <div class="flex items-center gap-4">
            <span>Welcome, {$twitchUser.username}!</span>
            <button 
              class="text-sm text-gray-300 hover:text-white"
              on:click={() => window.location.href = '/api/auth/logout'}
            >
              Logout
            </button>
          </div>
        {/if}
      </div>
    </div>
  </div>
</header>
