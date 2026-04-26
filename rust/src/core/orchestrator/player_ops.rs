use super::Orchestrator;

impl Orchestrator {
    pub async fn player_pause(&self, screen: u32) -> Result<(), String> {
        let player = self.player.lock().await;
        player.command(screen, 0, &["pause"]).await.map_err(|e| e.to_string())
    }

    pub async fn player_set_volume(&self, screen: u32, volume: u8) -> Result<(), String> {
        let player = self.player.lock().await;
        player.set_volume(screen, 0, volume).await.map_err(|e| e.to_string())
    }

    pub async fn player_seek(&self, screen: u32, seconds: i64) -> Result<(), String> {
        let player = self.player.lock().await;
        player.command(screen, 0, &["seek", &seconds.to_string()]).await.map_err(|e| e.to_string())
    }
}