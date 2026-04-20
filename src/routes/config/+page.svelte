<script lang="ts">
    import { onMount } from 'svelte';
    import type { AppConfig, StreamConfig, MpvConfig, StreamlinkConfig } from '$lib/tauri';
    import { readConfig, writeConfig, isTauri } from '$lib/tauri';

    let config: AppConfig | null = $state(null);
    let loading = $state(true);
    let saving = $state(false);
    let error = $state<string | null>(null);
    let success = $state(false);

    let editedStreams = $state<StreamConfig[]>([]);
    let editedMpv = $state<MpvConfig | null>(null);
    let editedStreamlink = $state<StreamlinkConfig | null>(null);

    onMount(async () => {
        try {
            config = await readConfig();
            if (config) {
                editedStreams = [...config.streams];
                editedMpv = { ...config.mpv };
                editedStreamlink = { ...config.streamlink };
            }
        } catch (e) {
            error = e instanceof Error ? e.message : String(e);
        } finally {
            loading = false;
        }
    });

    async function handleSave() {
        if (!config || !editedMpv || !editedStreamlink) return;

        saving = true;
        error = null;
        success = false;

        try {
            const updatedConfig: AppConfig = {
                ...config,
                streams: editedStreams,
                mpv: editedMpv,
                streamlink: editedStreamlink
            };
            await writeConfig(updatedConfig);
            config = updatedConfig;
            success = true;
            setTimeout(() => success = false, 3000);
        } catch (e) {
            error = e instanceof Error ? e.message : String(e);
        } finally {
            saving = false;
        }
    }

    function updateStreamField(index: number, field: keyof StreamConfig, value: unknown) {
        editedStreams[index] = { ...editedStreams[index], [field]: value };
    }

    function addStream() {
        const newId = editedStreams.length > 0 ? Math.max(...editedStreams.map(s => s.id)) + 1 : 0;
        editedStreams = [...editedStreams, {
            id: newId,
            screen: newId,
            enabled: true,
            width: 640,
            height: 360,
            x: newId * 640,
            y: 0,
            volume: 50,
            quality: 'best'
        }];
    }

    function removeStream(index: number) {
        editedStreams = editedStreams.filter((_, i) => i !== index);
    }
</script>

<div class="min-h-screen bg-gray-950 text-gray-100 p-6">
    <div class="max-w-4xl mx-auto">
        <header class="mb-8">
            <h1 class="text-3xl font-bold text-indigo-400">Settings</h1>
            <p class="text-gray-400 mt-1">Configure LiveLink streaming behavior</p>
        </header>

        {#if loading}
            <div class="flex items-center justify-center py-12">
                <div class="animate-spin w-8 h-8 border-4 border-indigo-500 border-t-transparent rounded-full"></div>
            </div>
        {:else if error && !config}
            <div class="bg-red-900/30 border border-red-700 rounded-lg p-4 text-red-300">
                <strong>Error loading config:</strong> {error}
            </div>
        {:else if config}
            {#if error}
                <div class="bg-red-900/30 border border-red-700 rounded-lg p-4 text-red-300 mb-6">
                    {error}
                </div>
            {/if}

            {#if success}
                <div class="bg-green-900/30 border border-green-700 rounded-lg p-4 text-green-300 mb-6">
                    Configuration saved successfully!
                </div>
            {/if}

            <div class="space-y-6">
                <section class="bg-gray-900 rounded-xl p-6 border border-gray-800">
                    <h2 class="text-xl font-semibold text-indigo-300 mb-4 flex items-center gap-2">
                        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                        </svg>
                        Stream Screens
                    </h2>

                    <div class="space-y-4">
                        {#each editedStreams as stream, i}
                            <div class="bg-gray-800 rounded-lg p-4 border border-gray-700">
                                <div class="flex justify-between items-start mb-4">
                                    <span class="text-sm font-medium text-gray-300">Screen {stream.screen}</span>
                                    <button
                                        onclick={() => removeStream(i)}
                                        class="text-red-400 hover:text-red-300 text-sm"
                                    >
                                        Remove
                                    </button>
                                </div>

                                <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
                                    <label class="flex flex-col gap-1">
                                        <span class="text-xs text-gray-400">Width</span>
                                        <input
                                            type="number"
                                            value={stream.width}
                                            onchange={(e) => updateStreamField(i, 'width', parseInt(e.currentTarget.value))}
                                            class="bg-gray-700 border border-gray-600 rounded px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
                                        />
                                    </label>

                                    <label class="flex flex-col gap-1">
                                        <span class="text-xs text-gray-400">Height</span>
                                        <input
                                            type="number"
                                            value={stream.height}
                                            onchange={(e) => updateStreamField(i, 'height', parseInt(e.currentTarget.value))}
                                            class="bg-gray-700 border border-gray-600 rounded px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
                                        />
                                    </label>

                                    <label class="flex flex-col gap-1">
                                        <span class="text-xs text-gray-400">X Position</span>
                                        <input
                                            type="number"
                                            value={stream.x}
                                            onchange={(e) => updateStreamField(i, 'x', parseInt(e.currentTarget.value))}
                                            class="bg-gray-700 border border-gray-600 rounded px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
                                        />
                                    </label>

                                    <label class="flex flex-col gap-1">
                                        <span class="text-xs text-gray-400">Y Position</span>
                                        <input
                                            type="number"
                                            value={stream.y}
                                            onchange={(e) => updateStreamField(i, 'y', parseInt(e.currentTarget.value)}
                                            class="bg-gray-700 border border-gray-600 rounded px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
                                        />
                                    </label>

                                    <label class="flex flex-col gap-1">
                                        <span class="text-xs text-gray-400">Volume</span>
                                        <input
                                            type="number"
                                            min="0"
                                            max="100"
                                            value={stream.volume}
                                            onchange={(e) => updateStreamField(i, 'volume', parseInt(e.currentTarget.value))}
                                            class="bg-gray-700 border border-gray-600 rounded px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
                                        />
                                    </label>

                                    <label class="flex flex-col gap-1">
                                        <span class="text-xs text-gray-400">Quality</span>
                                        <select
                                            value={stream.quality}
                                            onchange={(e) => updateStreamField(i, 'quality', e.currentTarget.value)}
                                            class="bg-gray-700 border border-gray-600 rounded px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
                                        >
                                            <option value="best">Best</option>
                                            <option value="1080p">1080p</option>
                                            <option value="720p">720p</option>
                                            <option value="480p">480p</option>
                                            <option value="360p">360p</option>
                                        </select>
                                    </label>

                                    <label class="flex items-center gap-2 pt-5">
                                        <input
                                            type="checkbox"
                                            checked={stream.enabled}
                                            onchange={(e) => updateStreamField(i, 'enabled', e.currentTarget.checked)}
                                            class="w-4 h-4 rounded bg-gray-700 border-gray-600 text-indigo-500 focus:ring-indigo-500"
                                        />
                                        <span class="text-sm text-gray-300">Enabled</span>
                                    </label>
                                </div>
                            </div>
                        {/each}

                        <button
                            onclick={addStream}
                            class="w-full py-3 border-2 border-dashed border-gray-700 rounded-lg text-gray-400 hover:border-indigo-500 hover:text-indigo-400 transition-colors"
                        >
                            + Add Screen
                        </button>
                    </div>
                </section>

                <section class="bg-gray-900 rounded-xl p-6 border border-gray-800">
                    <h2 class="text-xl font-semibold text-indigo-300 mb-4 flex items-center gap-2">
                        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                        MPV Player
                    </h2>

                    {#if editedMpv}
                        <div class="grid grid-cols-2 gap-4">
                            <label class="flex flex-col gap-1">
                                <span class="text-xs text-gray-400">Process Priority</span>
                                <select
                                    value={editedMpv.priority}
                                    onchange={(e) => editedMpv && (editedMpv.priority = e.currentTarget.value)}
                                    class="bg-gray-700 border border-gray-600 rounded px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
                                >
                                    <option value="high">High</option>
                                    <option value="normal">Normal</option>
                                    <option value="low">Low</option>
                                </select>
                            </label>

                            <label class="flex flex-col gap-1">
                                <span class="text-xs text-gray-400">GPU Context</span>
                                <select
                                    value={editedMpv['gpu-context']}
                                    onchange={(e) => editedMpv && (editedMpv['gpu-context'] = e.currentTarget.value)}
                                    class="bg-gray-700 border border-gray-600 rounded px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
                                >
                                    <option value="auto">Auto</option>
                                    <option value="wayland">Wayland</option>
                                    <option value="x11">X11</option>
                                    <option value="x11egl">X11 EGL</option>
                                    <option value="none">None</option>
                                </select>
                            </label>
                        </div>
                    {/if}
                </section>

                <section class="bg-gray-900 rounded-xl p-6 border border-gray-800">
                    <h2 class="text-xl font-semibold text-indigo-300 mb-4 flex items-center gap-2">
                        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                        </svg>
                        Streamlink
                    </h2>

                    {#if editedStreamlink}
                        <div class="grid grid-cols-2 gap-4">
                            <label class="flex flex-col gap-1">
                                <span class="text-xs text-gray-400">Path</span>
                                <input
                                    type="text"
                                    value={editedStreamlink.path}
                                    onchange={(e) => editedStreamlink && (editedStreamlink.path = e.currentTarget.value)}
                                    class="bg-gray-700 border border-gray-600 rounded px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
                                />
                            </label>
                        </div>
                    {/if}
                </section>

                <div class="flex justify-end gap-4">
                    <button
                        onclick={handleSave}
                        disabled={saving}
                        class="px-6 py-3 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-800 rounded-lg font-medium transition-colors flex items-center gap-2"
                    >
                        {#if saving}
                            <div class="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                            Saving...
                        {:else}
                            Save Configuration
                        {/if}
                    </button>
                </div>
            </div>
        {/if}
    </div>
</div>
