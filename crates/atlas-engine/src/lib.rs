pub mod analyze;
pub mod bridge;
pub mod control;
pub mod exec;
pub mod facts;
pub mod flow;
pub mod incremental;
pub mod inter;
pub mod job;
pub mod patch;
pub mod query;
pub mod scan;
pub mod solve;
pub mod store;

use sha2::{Digest, Sha256};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum Error {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("storage: {0}")]
    Sql(#[from] rusqlite::Error),
    #[error("protocol: {0}")]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    Invalid(String),
}
pub type Result<T> = std::result::Result<T, Error>;
pub fn invalid(reason: &str) -> Error {
    Error::Invalid(reason.into())
}
pub fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
