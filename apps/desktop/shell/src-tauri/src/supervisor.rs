//! Shared state between the async supervision loop and the synchronous
//! `RunEvent::Exit` handler. The `Child` itself stays local to the
//! supervision task (so `.wait()` never needs to be awaited while holding a
//! lock); only the pid and a couple of flags are shared.
//!
//! `pid` is a plain `std::sync::Mutex`, not `tokio::sync::Mutex`, on purpose:
//! by the time `RunEvent::Exit` fires, Tauri's async runtime may already be
//! tearing down, and reaching for `tauri::async_runtime::block_on` there has
//! been observed to panic ("there is no reactor running") because the
//! runtime's reactor/timer driver is already gone even though the runtime
//! handle itself still resolves. A std mutex needs no runtime at all, and
//! it's only ever held for a plain assignment/read, never across an `.await`.

use std::sync::atomic::AtomicBool;
use std::sync::Mutex;

pub struct Supervisor {
    /// pid of the daemon process we spawned, if any is currently running.
    pub pid: Mutex<Option<u32>>,
    /// True only when we spawned the daemon ourselves (vs. attaching to one
    /// that was already running) — we only ever signal a process we own.
    pub owns_process: AtomicBool,
    /// Set on app shutdown so the supervision loop doesn't try to restart
    /// the daemon after we deliberately stop it.
    pub stopping: AtomicBool,
}

impl Supervisor {
    pub fn new() -> Self {
        Self {
            pid: Mutex::new(None),
            owns_process: AtomicBool::new(false),
            stopping: AtomicBool::new(false),
        }
    }
}
