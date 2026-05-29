use std::sync::Arc;
use tokio::sync::Mutex;

use super::Orchestrator;

impl Orchestrator {
    pub async fn get_or_create_lock(&self, screen: u32) -> Arc<Mutex<()>> {
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