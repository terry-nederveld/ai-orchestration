//! Sidecar lifecycle: resolving the daemon entrypoint, spawning it via the
//! system Node, and health-checking it through the same loopback API the CLI
//! and UI use. Mirrors `packages/server/src/state-dir.ts` for the state
//! directory layout and `packages/cli/src/daemon.ts` for the entrypoint.
//!
//! Nothing here ever logs the bearer token.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Deserialize;
use tokio::process::{Child, Command};
use tokio::time::sleep;

#[derive(Debug, Clone, Deserialize)]
pub struct DaemonInfo {
    pub host: String,
    pub port: u16,
    pub token: String,
    #[allow(dead_code)]
    pub pid: u32,
}

/// Connection details handed to the webview. Never printed or logged.
#[derive(Debug, Clone)]
pub struct DaemonConnection {
    pub base_url: String,
    pub token: String,
}

impl From<&DaemonInfo> for DaemonConnection {
    fn from(info: &DaemonInfo) -> Self {
        DaemonConnection {
            base_url: format!("http://{}:{}", info.host, info.port),
            token: info.token.clone(),
        }
    }
}

/// Mirrors `defaultStateDir()` in `packages/server/src/state-dir.ts`:
/// `$XDG_STATE_HOME/overture`, falling back to `~/.local/state/overture`.
pub fn default_state_dir() -> PathBuf {
    if let Ok(xdg) = std::env::var("XDG_STATE_HOME") {
        if !xdg.is_empty() {
            return PathBuf::from(xdg).join("overture");
        }
    }
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".local").join("state").join("overture")
}

fn info_file(state_dir: &Path) -> PathBuf {
    state_dir.join("daemon.json")
}

pub async fn read_daemon_info(state_dir: &Path) -> Option<DaemonInfo> {
    let raw = tokio::fs::read_to_string(info_file(state_dir)).await.ok()?;
    serde_json::from_str(&raw).ok()
}

/// `GET /api/status` with the bearer token; healthy only on a 2xx response.
pub async fn check_health(connection: &DaemonConnection) -> bool {
    let client = match reqwest::Client::builder().timeout(Duration::from_secs(2)).build() {
        Ok(client) => client,
        Err(_) => return false,
    };
    client
        .get(format!("{}/api/status", connection.base_url))
        .bearer_auth(&connection.token)
        .send()
        .await
        .map(|response| response.status().is_success())
        .unwrap_or(false)
}

/// Poll the state dir for `daemon.json` plus a passing health check.
pub async fn wait_for_daemon(
    state_dir: &Path,
    attempts: u32,
    interval: Duration,
) -> Option<DaemonInfo> {
    for _ in 0..attempts {
        if let Some(info) = read_daemon_info(state_dir).await {
            let connection = DaemonConnection::from(&info);
            if check_health(&connection).await {
                return Some(info);
            }
        }
        sleep(interval).await;
    }
    None
}

/// Resolve the daemon's entrypoint script (`overture daemon`'s `main.js`).
///
/// Priority: an explicit `OVERTURE_DAEMON_ENTRY` override, a bundled Tauri
/// resource (`<resource_dir>/daemon/main.js`, staged at package time), then a
/// dev-mode fallback computed at compile time from this crate's location in
/// the monorepo checkout (`apps/desktop/shell/src-tauri` -> repo root ->
/// `packages/cli/dist/main.js`). The compile-time fallback also covers local
/// `tauri build --debug` runs against this checkout.
pub fn resolve_daemon_entry(resource_dir: Option<PathBuf>) -> Result<PathBuf, String> {
    if let Ok(raw) = std::env::var("OVERTURE_DAEMON_ENTRY") {
        let path = PathBuf::from(raw);
        return if path.exists() {
            Ok(path)
        } else {
            Err(format!(
                "OVERTURE_DAEMON_ENTRY is set but does not exist: {}",
                path.display()
            ))
        };
    }

    if let Some(resource_dir) = resource_dir {
        let bundled = resource_dir.join("daemon").join("main.js");
        if bundled.exists() {
            return Ok(bundled);
        }
    }

    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let dev_entry = manifest_dir
        .join("..") // shell
        .join("..") // desktop
        .join("..") // apps
        .join("..") // repo root
        .join("packages")
        .join("cli")
        .join("dist")
        .join("main.js");
    if dev_entry.exists() {
        return Ok(dev_entry);
    }

    Err(format!(
        "could not resolve the daemon entrypoint: set OVERTURE_DAEMON_ENTRY, stage a bundled \
         resource at daemon/main.js, or build packages/cli (expected {})",
        dev_entry.display()
    ))
}

/// Spawn the daemon via the system Node (`node <entry> daemon`). v1
/// packaging relies on Node already being installed rather than bundling a
/// Node runtime (see ADR-0012's "Implementation Notes" for the future
/// `externalBin` path).
pub fn spawn_daemon(entry: &Path) -> std::io::Result<Child> {
    let node = std::env::var("OVERTURE_NODE_BIN").unwrap_or_else(|_| "node".to_string());
    Command::new(node)
        .arg(entry)
        .arg("daemon")
        .kill_on_drop(true)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::inherit())
        .stderr(std::process::Stdio::inherit())
        .spawn()
}

/// Best-effort graceful stop. SIGTERM on unix (the daemon installs a handler
/// that cancels active runs and clears `daemon.json` before exiting); no
/// portable equivalent on Windows without an extra dependency, so the caller
/// just gives the process a short grace window before the OS reclaims it at
/// app exit.
#[cfg(unix)]
pub fn terminate(pid: u32) {
    unsafe {
        libc::kill(pid as libc::pid_t, libc::SIGTERM);
    }
}

#[cfg(not(unix))]
pub fn terminate(_pid: u32) {}
