<script lang="ts">
    import { page } from '$app/stores';
    import { isTauri, minimizeWindow, maximizeWindow, closeWindow, toggleFullscreen } from '$lib/tauri';

    const links = [
        { href: '/', label: 'Home', icon: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6' },
        { href: '/streams', label: 'Streams', icon: 'M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z' },
        { href: '/settings', label: 'Settings', icon: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z' },
        { href: '/config', label: 'Config', icon: 'M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4' },
    ];

    let usingTauri = isTauri();

    async function handleMinimize() {
        if (usingTauri) await minimizeWindow();
    }

    async function handleMaximize() {
        if (usingTauri) await maximizeWindow();
    }

    async function handleClose() {
        if (usingTauri) await closeWindow();
    }
</script>

{#if usingTauri}
    <div class="bg-gray-900 border-b border-gray-800 px-4 py-2 flex items-center justify-between" data-tauri-drag-region>
        <div class="flex items-center gap-4">
            <span class="text-indigo-400 font-bold">LiveLink</span>
        </div>
        <div class="flex items-center gap-1">
            <button onclick={handleMinimize} class="p-2 hover:bg-gray-700 rounded transition-colors" title="Minimize">
                <svg class="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 12H4" />
                </svg>
            </button>
            <button onclick={handleMaximize} class="p-2 hover:bg-gray-700 rounded transition-colors" title="Maximize">
                <svg class="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
                </svg>
            </button>
            <button onclick={handleClose} class="p-2 hover:bg-red-600 rounded transition-colors" title="Close">
                <svg class="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
            </button>
        </div>
    </div>
{/if}

<nav class="bg-gray-900 border-b border-gray-800 sticky top-0 z-50">
    <div class="container mx-auto px-4">
        <div class="flex items-center justify-between h-14">
            <div class="flex items-center gap-6">
                {#if !usingTauri}
                    <a href="/" class="text-xl font-bold text-indigo-400">LiveLink</a>
                {/if}
                <ul class="flex items-center gap-1">
                    {#each links as link}
                        <li>
                            <a
                                href={link.href}
                                class="flex items-center gap-2 px-3 py-2 rounded-lg transition-colors {$page.url.pathname === link.href ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-800'}"
                            >
                                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d={link.icon} />
                                </svg>
                                {link.label}
                            </a>
                        </li>
                    {/each}
                </ul>
            </div>
            <div class="flex items-center gap-2">
                <span class="text-xs text-gray-500">Ctrl+Shift+L: Show</span>
                <span class="text-xs text-gray-500">F11: Fullscreen</span>
            </div>
        </div>
    </div>
</nav>