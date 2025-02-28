<script lang="ts">
    import { page } from '$app/stores';
    import { goto } from '$app/navigation';
    
    let activeTab = $state('overview'); // or whatever default tab you want
    
    // Persist the active tab when navigating
    $: {
        if ($page.url.searchParams.get('tab')) {
            activeTab = $page.url.searchParams.get('tab')!;
        }
    }
    
    function switchTab(tab: string) {
        activeTab = tab;
        // Update URL without full page reload
        goto(`?tab=${tab}`, { replaceState: true });
    }
</script>

<div class="tabs">
    <button 
        class="tab {activeTab === 'overview' ? 'active' : ''}"
        on:click={() => switchTab('overview')}
    >
        Overview
    </button>
    <button 
        class="tab {activeTab === 'endpoints' ? 'active' : ''}"
        on:click={() => switchTab('endpoints')}
    >
        Endpoints
    </button>
    <!-- Add more tabs as needed -->
</div>

<div class="tab-content">
    {#if activeTab === 'overview'}
        <div class="tab-pane">
            <!-- Overview content -->
        </div>
    {:else if activeTab === 'endpoints'}
        <div class="tab-pane">
            <!-- Endpoints content -->
        </div>
    {/if}
</div>

<style>
    .tabs {
        display: flex;
        gap: 1rem;
        border-bottom: 1px solid #444;
        padding: 1rem;
    }
    
    .tab {
        padding: 0.5rem 1rem;
        border: none;
        background: none;
        color: #fff;
        cursor: pointer;
        border-bottom: 2px solid transparent;
    }
    
    .tab.active {
        border-bottom-color: #fff;
    }
    
    .tab-content {
        padding: 1rem;
    }
    
    .tab-pane {
        animation: fadeIn 0.2s ease-in-out;
    }
    
    @keyframes fadeIn {
        from { opacity: 0; }
        to { opacity: 1; }
    }
</style> 