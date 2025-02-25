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

<div class="container-fluid py-4">
    <div class="d-flex justify-content-between align-items-center mb-4">
        <h1 class="h3 mb-0">Settings</h1>
        <button
            on:click={stopServer}
            class="btn btn-danger"
        >
            Stop Server
        </button>
    </div>

    {#if error}
        <div class="alert alert-danger alert-dismissible fade show mb-4">
            <strong>Error!</strong> {error}
            <button type="button" class="btn-close" on:click={() => error = null}></button>
        </div>
    {/if}

    {#if success}
        <div class="alert alert-success alert-dismissible fade show mb-4">
            <strong>Success!</strong> {success}
            <button type="button" class="btn-close" on:click={() => success = null}></button>
        </div>
    {/if}

    {#if playerSettings}
        <div class="card card-dark mb-4">
            <div class="card-header card-header-dark">
                <h5 class="mb-0">Player Settings</h5>
            </div>
            <div class="card-body">
                <div class="row g-3">
                    <div class="col-md-6 col-lg-3">
                        <label for="defaultVolume" class="form-label">Default Volume</label>
                        <input
                            type="number"
                            id="defaultVolume"
                            min="0"
                            max="100"
                            bind:value={playerSettings.defaultVolume}
                            class="form-control bg-dark text-light border-secondary"
                        />
                    </div>
                    <div class="col-md-6 col-lg-3">
                        <label for="defaultQuality" class="form-label">Default Quality</label>
                        <select
                            id="defaultQuality"
                            bind:value={playerSettings.defaultQuality}
                            class="form-select bg-dark text-light border-secondary"
                        >
                            <option value="best">Best</option>
                            <option value="high">High</option>
                            <option value="medium">Medium</option>
                            <option value="low">Low</option>
                        </select>
                    </div>
                    <div class="col-md-6 col-lg-3">
                        <label for="processPriority" class="form-label">Process Priority</label>
                        <select
                            id="processPriority"
                            bind:value={playerSettings.processPriority}
                            class="form-select bg-dark text-light border-secondary"
                        >
                            <option value="normal">Normal</option>
                            <option value="high">High</option>
                            <option value="realtime">Realtime</option>
                            <option value="above_normal">Above Normal</option>
                            <option value="below_normal">Below Normal</option>
                            <option value="low">Low</option>
                            <option value="idle">Idle</option>
                        </select>
                    </div>
                    <div class="col-md-6 col-lg-3">
                        <label for="windowMode" class="form-label">Window Mode</label>
                        <select
                            id="windowMode"
                            bind:value={playerSettings.windowMode}
                            class="form-select bg-dark text-light border-secondary"
                        >
                            <option value="windowed">Windowed</option>
                            <option value="fullscreen">Fullscreen</option>
                            <option value="borderless">Borderless</option>
                        </select>
                    </div>
                    <div class="col-md-6 col-lg-3">
                        <label for="maxStreams" class="form-label">Max Concurrent Streams</label>
                        <input
                            type="number"
                            id="maxStreams"
                            min="1"
                            max="10"
                            bind:value={playerSettings.maxStreams}
                            class="form-control bg-dark text-light border-secondary"
                        />
                    </div>
                    <div class="col-md-6 col-lg-3">
                        <div class="form-check form-switch mt-4">
                            <input
                                class="form-check-input"
                                type="checkbox"
                                id="autoStart"
                                bind:checked={playerSettings.autoStart}
                            />
                            <label class="form-check-label" for="autoStart">
                                Auto-start streams
                            </label>
                        </div>
                    </div>
                    <div class="col-md-6 col-lg-3">
                        <div class="form-check form-switch mt-4">
                            <input
                                class="form-check-input"
                                type="checkbox"
                                id="preferStreamlink"
                                bind:checked={playerSettings.preferStreamlink}
                            />
                            <label class="form-check-label" for="preferStreamlink">
                                Prefer Streamlink
                            </label>
                        </div>
                    </div>
                    <div class="col-md-6 col-lg-3">
                        <div class="form-check form-switch mt-4">
                            <input
                                class="form-check-input"
                                type="checkbox"
                                id="windowMaximized"
                                bind:checked={playerSettings.windowMaximized}
                            />
                            <label class="form-check-label" for="windowMaximized">
                                Maximize windows
                            </label>
                        </div>
                    </div>
                </div>
                <div class="d-flex justify-content-end mt-3">
                    <button
                        on:click={updatePlayerSettings}
                        class="btn btn-primary"
                    >
                        Save Player Settings
                    </button>
                </div>
            </div>
        </div>
    {/if}

    <h2 class="h4 mb-3">Screen Settings</h2>
    <div class="row g-4">
        {#each screenConfigs as config}
            <div class="col-12">
                <div class="card card-dark">
                    <div class="card-header card-header-dark d-flex justify-content-between align-items-center">
                        <h5 class="mb-0">Screen {config.screen}</h5>
                        <button
                            class="btn btn-sm {config.enabled ? 'btn-warning' : 'btn-success'}"
                            on:click={() => updateScreenConfig(config.screen, { enabled: !config.enabled })}
                        >
                            {config.enabled ? 'Disable' : 'Enable'}
                        </button>
                    </div>
                    <div class="card-body">
                        <div class="row g-3">
                            <div class="col-md-6 col-lg-3">
                                <label for="volume-{config.screen}" class="form-label">Default Volume</label>
                                <input
                                    type="number"
                                    id="volume-{config.screen}"
                                    min="0"
                                    max="100"
                                    bind:value={config.volume}
                                    on:change={() => updateScreenConfig(config.screen, { volume: config.volume })}
                                    class="form-control bg-dark text-light border-secondary"
                                />
                            </div>
                            <div class="col-md-6 col-lg-3">
                                <label for="quality-{config.screen}" class="form-label">Default Quality</label>
                                <select
                                    id="quality-{config.screen}"
                                    bind:value={config.quality}
                                    on:change={() => updateScreenConfig(config.screen, { quality: config.quality })}
                                    class="form-select bg-dark text-light border-secondary"
                                >
                                    <option value="best">Best</option>
                                    <option value="high">High</option>
                                    <option value="medium">Medium</option>
                                    <option value="low">Low</option>
                                </select>
                            </div>
                            <div class="col-md-6 col-lg-3">
                                <label class="form-label">Window Position</label>
                                <div class="input-group">
                                    <input
                                        type="number"
                                        placeholder="X"
                                        bind:value={config.windowX}
                                        on:change={() => updateScreenConfig(config.screen, { windowX: config.windowX })}
                                        class="form-control bg-dark text-light border-secondary"
                                    />
                                    <input
                                        type="number"
                                        placeholder="Y"
                                        bind:value={config.windowY}
                                        on:change={() => updateScreenConfig(config.screen, { windowY: config.windowY })}
                                        class="form-control bg-dark text-light border-secondary"
                                    />
                                </div>
                            </div>
                            <div class="col-md-6 col-lg-3">
                                <label class="form-label">Window Size</label>
                                <div class="input-group">
                                    <input
                                        type="number"
                                        placeholder="Width"
                                        bind:value={config.windowWidth}
                                        on:change={() => updateScreenConfig(config.screen, { windowWidth: config.windowWidth })}
                                        class="form-control bg-dark text-light border-secondary"
                                    />
                                    <input
                                        type="number"
                                        placeholder="Height"
                                        bind:value={config.windowHeight}
                                        on:change={() => updateScreenConfig(config.screen, { windowHeight: config.windowHeight })}
                                        class="form-control bg-dark text-light border-secondary"
                                    />
                                </div>
                            </div>
                            <div class="col-md-6 col-lg-3">
                                <div class="form-check form-switch mt-4">
                                    <input
                                        class="form-check-input"
                                        type="checkbox"
                                        id="windowMaximized-{config.screen}"
                                        bind:checked={config.windowMaximized}
                                        on:change={() => updateScreenConfig(config.screen, { windowMaximized: config.windowMaximized })}
                                    />
                                    <label class="form-check-label" for="windowMaximized-{config.screen}">
                                        Maximize window
                                    </label>
                                </div>
                            </div>
                            <div class="col-md-6 col-lg-3">
                                <div class="form-check form-switch mt-4">
                                    <input
                                        class="form-check-input"
                                        type="checkbox"
                                        id="autoStart-{config.screen}"
                                        bind:checked={config.autoStart}
                                        on:change={() => updateScreenConfig(config.screen, { autoStart: config.autoStart })}
                                    />
                                    <label class="form-check-label" for="autoStart-{config.screen}">
                                        Auto-start streams
                                    </label>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        {/each}
    </div>
</div>

<style>
    .card-dark {
        background-color: #2c2c2c;
        border-color: #444;
        color: #f8f9fa;
    }
    
    .card-header-dark {
        background-color: #222;
        border-color: #444;
        color: #f8f9fa;
    }
    
    /* Custom form switch styling for dark theme */
    :global(.form-check-input) {
        background-color: #495057;
        border-color: #6c757d;
    }
    
    :global(.form-check-input:checked) {
        background-color: #0d6efd;
        border-color: #0d6efd;
    }
</style> 