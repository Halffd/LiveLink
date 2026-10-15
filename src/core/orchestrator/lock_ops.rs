use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::debug;

use super::Orchestrator;

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