//! One index operation's cooperative cancellation and publication boundary.
use crate::{Result, invalid};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::time::Instant;

#[derive(Debug, Default)]
struct Shared {
    cancelled: AtomicBool,
    completed: AtomicBool,
    publication: Mutex<()>,
}

/// Clones share cancellation; a separate `new` call creates an independent job.
/// Cancellation and the final commit serialize on the same gate. A cancellation
/// accepted before commit prevents publication; a committed version is immutable.
#[derive(Clone, Debug)]
pub struct ExecutionControl {
    shared: Arc<Shared>,
    deadline: Option<Instant>,
    deadline_error: &'static str,
}

impl ExecutionControl {
    pub fn new(deadline: Option<Instant>) -> Self {
        Self {
            shared: Arc::default(),
            deadline,
            deadline_error: "analysis_deadline_exceeded_no_analysis_published",
        }
    }

    pub fn deadline(&self) -> Option<Instant> {
        self.deadline
    }

    /// A stage can shorten, but cannot extend, its parent's deadline. Both
    /// views still share cancellation and the terminal publication gate.
    pub fn with_stage_deadline(&self, deadline: Instant, reason: &'static str) -> Self {
        if self.deadline.is_some_and(|existing| existing <= deadline) {
            return self.clone();
        }
        Self {
            shared: self.shared.clone(),
            deadline: Some(deadline),
            deadline_error: reason,
        }
    }

    /// Returns false when publication already completed, so a late signal
    /// cannot relabel a committed result as cancelled.
    pub fn cancel(&self) -> bool {
        let _guard = self
            .shared
            .publication
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if self.shared.completed.load(Ordering::Acquire) {
            return false;
        }
        self.shared.cancelled.store(true, Ordering::Release);
        true
    }

    pub fn is_cancelled(&self) -> bool {
        self.shared.cancelled.load(Ordering::Acquire)
    }

    pub fn checkpoint(&self) -> Result<()> {
        if self.is_cancelled() {
            return Err(invalid("index_cancelled_no_analysis_published"));
        }
        if self
            .deadline
            .is_some_and(|deadline| Instant::now() >= deadline)
        {
            return Err(invalid(self.deadline_error));
        }
        Ok(())
    }

    /// Keep this gate only for the final commit, never for derivation or SQL
    /// lock acquisition. Cancellation must remain responsive while those wait.
    pub(crate) fn publish<T>(&self, commit: impl FnOnce() -> Result<T>) -> Result<T> {
        let _guard = self
            .shared
            .publication
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        self.checkpoint()?;
        commit()
    }

    pub(crate) fn finish_publication<T>(&self, commit: impl FnOnce() -> Result<T>) -> Result<T> {
        self.publish(|| {
            let value = commit()?;
            self.shared.completed.store(true, Ordering::Release);
            Ok(value)
        })
    }
}
