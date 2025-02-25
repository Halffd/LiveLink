<script lang="ts">
    import { page } from '$app/stores';
</script>

<nav class="navbar navbar-expand-lg navbar-dark bg-dark">
    <div class="container-fluid">
        <a class="navbar-brand" href="/">LiveLink</a>
        <button class="navbar-toggler" type="button" data-bs-toggle="collapse" data-bs-target="#navbarNav">
            <span class="navbar-toggler-icon"></span>
        </button>
        <div class="collapse navbar-collapse" id="navbarNav">
            <ul class="navbar-nav">
                <li class="nav-item">
                    <a 
                        href="/" 
                        class="nav-link {$page.url.pathname === '/' ? 'active' : ''}"
                    >
                        Home
                    </a>
                </li>
                <li class="nav-item">
                    <a 
                        href="/streams" 
                        class="nav-link {$page.url.pathname === '/streams' ? 'active' : ''}"
                    >
                        Streams
                    </a>
                </li>
                <li class="nav-item">
                    <a 
                        href="/settings" 
                        class="nav-link {$page.url.pathname === '/settings' ? 'active' : ''}"
                    >
                        Settings
                    </a>
                </li>
            </ul>
        </div>
    </div>
</nav> 