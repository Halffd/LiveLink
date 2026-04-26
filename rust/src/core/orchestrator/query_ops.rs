use crate::queue::queue::StreamSource;
use crate::services::holodex::QueryOptions;
use tracing::{debug, info};

use super::Orchestrator;

impl Orchestrator {
    pub async fn query_streams(&self, options: QueryOptions) -> Result<Vec<StreamSource>, String> {
        debug!(?options, "Querying streams");

        let mut all_sources = Vec::new();

        if self.holodex_service.is_enabled() {
            match self.holodex_service.query(&options).await {
                Ok(sources) => {
                    info!(count = sources.len(), source = "holodex", "Queried streams from Holodex");
                    all_sources.extend(sources);
                }
                Err(e) => {
                    tracing::warn!(error = %e, "Holodex query failed");
                }
            }
        }

        if all_sources.is_empty() {
            return Err("No streams found for the given query".to_string());
        }

        Ok(all_sources)
    }
}