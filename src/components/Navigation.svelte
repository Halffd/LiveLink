<script lang="ts">
    import { page } from '$app/stores';
</script>

<nav class="bg-gray-900 text-white p-4">
    <div class="container mx-auto flex items-center justify-between">
        <div class="text-xl font-bold">LiveLink</div>
        <div class="space-x-4">
            <a
                href="/"
                class="px-3 py-2 rounded hover:bg-gray-800 {$page.url.pathname === '/' ? 'bg-gray-800' : ''}"
            >
                Streams
            </a>
            <a
                href="/settings"
                class="px-3 py-2 rounded hover:bg-gray-800 {$page.url.pathname === '/settings' ? 'bg-gray-800' : ''}"
            >
                Settings
            </a>
        </div>
    </div>
</nav> 