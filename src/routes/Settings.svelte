<script lang="ts">
    import { onMount } from 'svelte';
    import { api } from '$lib/api';
    import type { PlayerSettings, StreamConfig } from '../types/stream.js';

    let playerSettings = $state<PlayerSettings | null>(null);
    let screenConfigs = $state<StreamConfig[]>([]);
    let error = $state<string | null>(null);
    let success = $state<string | null>(null);

    const fetchSettings = async () => {
        try {
            const [settings, configs] = await Promise.all([
                api.getPlayerSettings(),
                api.getScreenConfigs()
            ]);
            playerSettings = settings;
            screenConfigs = configs;
        } catch (err) {
            error = err instanceof Error ? err.message : 'Failed to fetch settings';
            setTimeout(() => error = null, 3000);
        }
    };

    const updatePlayerSettings = async () => {
        if (!playerSettings) return;
        try {
            await api.updatePlayerSettings(playerSettings);
            success = 'Player settings updated successfully';
            setTimeout(() => success = null, 3000);
        } catch (err) {
            error = err instanceof Error ? err.message : 'Failed to update player settings';
            setTimeout(() => error = null, 3000);
        }
    };

    const updateScreenConfig = async (screen: number, config: Partial<StreamConfig>) => {
        try {
            await api.updateScreenConfig(screen, config);
            await fetchSettings();
            success = `Screen ${screen} settings updated successfully`;
            setTimeout(() => success = null, 3000);
        } catch (err) {
            error = err instanceof Error ? err.message : 'Failed to update screen settings';
            setTimeout(() => error = null, 3000);
        }
    };

    const stopServer = async () => {
        if (!confirm('Are you sure you want to stop the server?')) return;
        try {
            await api.stopServer();
            success = 'Server stopping...';
        } catch (err) {
            error = err instanceof Error ? err.message : 'Failed to stop server';
            setTimeout(() => error = null, 3000);
        }
    };

    onMount(fetchSettings);
</script>

<div class="space-y-6 p-6">
    <div class="flex justify-between items-center">
        <h1 class="text-2xl font-bold">Settings</h1>
        <button
            on:click={stopServer}
            class="px-4 py-2 bg-red-600 hover:bg-red-700 rounded text-white"
        >
            Stop Server
        </button>
    </div>

    {#if error}
        <div class="bg-red-500 text-white p-4 rounded">
            {error}
            <button class="ml-4 underline" on:click={() => error = null}>Dismiss</button>
        </div>
    {/if}

    {#if success}
        <div class="bg-green-500 text-white p-4 rounded">
            {success}
            <button class="ml-4 underline" on:click={() => success = null}>Dismiss</button>
        </div>
    {/if}

    {#if playerSettings}
        <div class="space-y-4">
            <h2 class="text-xl font-semibold">Player Settings</h2>
            <div class="grid grid-cols-2 gap-4 bg-gray-800 p-4 rounded-lg">
                <div class="space-y-2">
                    <label class="block text-sm font-medium">Default Volume</label>
                    <input
                        type="number"
                        min="0"
                        max="100"
                        bind:value={playerSettings.defaultVolume}
                        class="w-full px-4 py-2 rounded bg-gray-700"
                    />
                </div>
                <div class="space-y-2">
                    <label class="block text-sm font-medium">Default Quality</label>
                    <select
                        bind:value={playerSettings.defaultQuality}
                        class="w-full px-4 py-2 rounded bg-gray-700"
                    >
                        <option value="best">Best</option>
                        <option value="high">High</option>
                        <option value="medium">Medium</option>
                        <option value="low">Low</option>
                    </select>
                </div>
                <div class="space-y-2">
                    <label class="block text-sm font-medium">Process Priority</label>
                    <select
                        bind:value={playerSettings.processPriority}
                        class="w-full px-4 py-2 rounded bg-gray-700"
                    >
                        <option value="normal">Normal</option>
                        <option value="high">High</option>
                        <option value="realtime">Realtime</option>
                    </select>
                </div>
                <div class="space-y-2">
                    <label class="block text-sm font-medium">Window Mode</label>
                    <select
                        bind:value={playerSettings.windowMode}
                        class="w-full px-4 py-2 rounded bg-gray-700"
                    >
                        <option value="windowed">Windowed</option>
                        <option value="fullscreen">Fullscreen</option>
                        <option value="borderless">Borderless</option>
                    </select>
                </div>
            </div>
            <div class="flex justify-end">
                <button
                    on:click={updatePlayerSettings}
                    class="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded text-white"
                >
                    Save Player Settings
                </button>
            </div>
        </div>
    {/if}

    <div class="space-y-4">
        <h2 class="text-xl font-semibold">Screen Settings</h2>
        <div class="grid gap-4">
            {#each screenConfigs as config}
                <div class="bg-gray-800 p-4 rounded-lg">
                    <h3 class="text-lg font-medium mb-4">Screen {config.screen}</h3>
                    <div class="grid grid-cols-2 gap-4">
                        <div class="space-y-2">
                            <label class="block text-sm font-medium">Status</label>
                            <div class="flex items-center space-x-2">
                                <button
                                    class="px-3 py-1 {config.enabled ? 'bg-green-600 hover:bg-green-700' : 'bg-red-600 hover:bg-red-700'} rounded text-white"
                                    on:click={() => updateScreenConfig(config.screen, { enabled: !config.enabled })}
                                >
                                    {config.enabled ? 'Enabled' : 'Disabled'}
                                </button>
                            </div>
                        </div>
                        <div class="space-y-2">
                            <label class="block text-sm font-medium">Default Volume</label>
                            <input
                                type="number"
                                min="0"
                                max="100"
                                bind:value={config.volume}
                                on:change={() => updateScreenConfig(config.screen, { volume: config.volume })}
                                class="w-full px-4 py-2 rounded bg-gray-700"
                            />
                        </div>
                        <div class="space-y-2">
                            <label class="block text-sm font-medium">Window Position</label>
                            <div class="grid grid-cols-2 gap-2">
                                <input
                                    type="number"
                                    placeholder="X"
                                    bind:value={config.windowX}
                                    on:change={() => updateScreenConfig(config.screen, { windowX: config.windowX })}
                                    class="w-full px-4 py-2 rounded bg-gray-700"
                                />
                                <input
                                    type="number"
                                    placeholder="Y"
                                    bind:value={config.windowY}
                                    on:change={() => updateScreenConfig(config.screen, { windowY: config.windowY })}
                                    class="w-full px-4 py-2 rounded bg-gray-700"
                                />
                            </div>
                        </div>
                        <div class="space-y-2">
                            <label class="block text-sm font-medium">Window Size</label>
                            <div class="grid grid-cols-2 gap-2">
                                <input
                                    type="number"
                                    placeholder="Width"
                                    bind:value={config.windowWidth}
                                    on:change={() => updateScreenConfig(config.screen, { windowWidth: config.windowWidth })}
                                    class="w-full px-4 py-2 rounded bg-gray-700"
                                />
                                <input
                                    type="number"
                                    placeholder="Height"
                                    bind:value={config.windowHeight}
                                    on:change={() => updateScreenConfig(config.screen, { windowHeight: config.windowHeight })}
                                    class="w-full px-4 py-2 rounded bg-gray-700"
                                />
                            </div>
                        </div>
                    </div>
                </div>
            {/each}
        </div>
    </div>
</div> 