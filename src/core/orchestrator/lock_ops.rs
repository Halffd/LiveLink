use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::debug;

use super::Orchestrator;

/// A no-op mutex that doesn't actually lock - used when locks are disabled
struct NoOpMutex;

impl NoOpMutex {
    async fn lock(&self) -> NoOpLock {
        NoOpLock
    }
}

/// A no-op lock guard that does nothing
struct NoOpLock;

impl std::ops::Deref for NoOpLock {
    type Target = ();

    fn deref(&self) -> &Self::Target {
        &()
    }
}

impl Orchestrator {
    pub async fn get_or_create_lock(&self, screen: u32) -> Arc<Mutex<()>> {
        if !self.config.use_locks {
            debug!(screen, "Locks disabled, returning dummy lock");
            // Return a dummy lock that doesn't actually lock
            // We'll use a static mutex that we never actually wait on
            static DUMMY_LOCK: std::sync::OnceLock<Arc<Mutex<()>>> = std::sync::OnceLock::new();
            return DUMMY_LOCK.get_or_init(|| Arc::new(Mutex::new(()))).clone();
        }

        self.locks
            .get(&screen)
            .map(|r| r.value().clone())
            .unwrap_or_else(|| {
                let lock = Arc::new(Mutex::new(()));
                self.locks.insert(screen, lock.clone());
                lock
            })
    }
}