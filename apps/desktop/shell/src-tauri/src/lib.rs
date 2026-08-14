//! Thin Tauri shell (ADR-0012): its only job is spawning/supervising the
//! Overture daemon sidecar and handing the webview a connection to it. All
//! product logic lives in the daemon behind its loopback HTTP API
//! (ADR-0011) — the webview talks to that API directly, never to Tauri IPC,
//! except for the one-time connection handoff done here.

mod daemon;
mod supervisor;

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use daemon::DaemonConnection;
use supervisor::Supervisor;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

type SharedSupervisor = Arc<Supervisor>;

const MAX_RESTARTS: u32 = 3;
const HEALTH_ATTEMPTS: u32 = 40; // 40 * 250ms = 10s to become healthy
const HEALTH_INTERVAL: Duration = Duration::from_millis(250);
const SHUTDOWN_GRACE: Duration = Duration::from_millis(800);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let supervisor: SharedSupervisor = Arc::new(Supervisor::new());

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // A second launch attaches to the existing window instead of
            // spawning a second daemon.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }))
        .manage(supervisor.clone())
        .setup({
            let supervisor = supervisor.clone();
            move |app| {
                let app_handle = app.handle().clone();
                let supervisor = supervisor.clone();
                tauri::async_runtime::spawn(async move {
                    bootstrap(app_handle, supervisor).await;
                });

                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    listen_for_termination_signals(app_handle).await;
                });

                Ok(())
            }
        });

    let app = builder
        .build(tauri::generate_context!())
        .expect("error building the Overture desktop shell");

    app.run(move |app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            let supervisor = app_handle.state::<SharedSupervisor>().inner().clone();
            shutdown(&supervisor);
        }
    });
}

/// A process supervisor stopping us with `SIGTERM`/`SIGINT` (or `Ctrl+C`)
/// doesn't otherwise reach Tauri's event loop, so `shutdown()` would never
/// run and a daemon we spawned would be orphaned. Translate the signal into
/// a normal app exit, which does fire `RunEvent::Exit`.
async fn listen_for_termination_signals(app: AppHandle) {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut sigterm = match signal(SignalKind::terminate()) {
            Ok(stream) => stream,
            Err(error) => {
                eprintln!("overture: failed to install a SIGTERM handler: {error}");
                return;
            }
        };
        let mut sigint = match signal(SignalKind::interrupt()) {
            Ok(stream) => stream,
            Err(error) => {
                eprintln!("overture: failed to install a SIGINT handler: {error}");
                return;
            }
        };
        tokio::select! {
            _ = sigterm.recv() => {}
            _ = sigint.recv() => {}
        }
        app.exit(0);
    }
    #[cfg(not(unix))]
    {
        if tokio::signal::ctrl_c().await.is_ok() {
            app.exit(0);
        }
    }
}

/// Attach to an already-running daemon if one answers a health check;
/// otherwise spawn and supervise our own.
async fn bootstrap(app: AppHandle, supervisor: SharedSupervisor) {
    let state_dir = daemon::default_state_dir();

    if let Some(info) = daemon::read_daemon_info(&state_dir).await {
        let connection = DaemonConnection::from(&info);
        if daemon::check_health(&connection).await {
            // We didn't start it, so we never signal it on exit.
            open_window(&app, &connection);
            emit_ready(&app, &connection);
            return;
        }
    }

    supervise(app, supervisor, state_dir).await;
}

/// Spawn the daemon, wait for it to become healthy, and restart it (bounded,
/// with backoff) if it exits unexpectedly. Runs for the lifetime of the app.
async fn supervise(app: AppHandle, supervisor: SharedSupervisor, state_dir: std::path::PathBuf) {
    let resource_dir = app.path().resource_dir().ok();
    let entry = match daemon::resolve_daemon_entry(resource_dir) {
        Ok(path) => path,
        Err(message) => {
            eprintln!("overture: {message}");
            return;
        }
    };

    let mut restarts: u32 = 0;
    loop {
        if supervisor.stopping.load(Ordering::SeqCst) {
            return;
        }

        let mut child = match daemon::spawn_daemon(&entry) {
            Ok(child) => child,
            Err(error) => {
                eprintln!("overture: failed to spawn daemon: {error}");
                return;
            }
        };
        let pid = child.id();
        *supervisor.pid.lock().unwrap() = pid;
        supervisor.owns_process.store(true, Ordering::SeqCst);

        match daemon::wait_for_daemon(&state_dir, HEALTH_ATTEMPTS, HEALTH_INTERVAL).await {
            Some(info) => {
                let connection = DaemonConnection::from(&info);
                if restarts == 0 {
                    open_window(&app, &connection);
                } else {
                    refresh_window(&app, &connection);
                }
                emit_ready(&app, &connection);
            }
            None => {
                eprintln!("overture: daemon did not become healthy within the timeout");
            }
        }

        // Blocks until the child exits (naturally, or from `shutdown()`'s
        // SIGTERM/kill). No lock is held across this await.
        let status = child.wait().await;

        *supervisor.pid.lock().unwrap() = None;
        supervisor.owns_process.store(false, Ordering::SeqCst);

        if supervisor.stopping.load(Ordering::SeqCst) {
            return;
        }

        eprintln!("overture: daemon exited unexpectedly ({status:?})");
        restarts += 1;
        if restarts > MAX_RESTARTS {
            eprintln!("overture: daemon crash-looped {MAX_RESTARTS} times in a row; giving up");
            return;
        }
        let backoff = Duration::from_secs(1u64 << (restarts - 1).min(4));
        tokio::time::sleep(backoff).await;
    }
}

/// Create the main window with the daemon connection baked into an
/// initialization script that runs before any page script, including on
/// reload — this is the primary hand-off path the UI's `ConnectionProvider`
/// reads via `window.__OVERTURE_DAEMON__`.
fn open_window(app: &AppHandle, connection: &DaemonConnection) {
    if app.get_webview_window("main").is_some() {
        refresh_window(app, connection);
        return;
    }
    let builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("Overture")
        .inner_size(1280.0, 800.0)
        .min_inner_size(960.0, 600.0)
        .initialization_script(init_script(connection));
    if let Err(error) = builder.build() {
        eprintln!("overture: failed to create the main window: {error}");
    }
}

/// Used after a daemon restart, when the window already exists and the
/// baked-in initialization script's token is now stale: push the fresh
/// connection into the live page directly.
fn refresh_window(app: &AppHandle, connection: &DaemonConnection) {
    let Some(window) = app.get_webview_window("main") else {
        open_window(app, connection);
        return;
    };
    if let Err(error) = window.eval(init_script(connection)) {
        eprintln!("overture: failed to refresh the daemon connection: {error}");
    }
}

/// Companion to the initialization script: an event carrying the same
/// payload, for late listeners (e.g. a reconnect flow added to
/// `ConnectionProvider` later) that want updates without relying on module
/// load order. The token is only ever placed in this in-memory event, never
/// written to a log.
fn emit_ready(app: &AppHandle, connection: &DaemonConnection) {
    #[derive(serde::Serialize, Clone)]
    struct DaemonReadyPayload {
        base_url: String,
        token: String,
    }
    let _ = app.emit(
        "daemon-ready",
        DaemonReadyPayload {
            base_url: connection.base_url.clone(),
            token: connection.token.clone(),
        },
    );
}

fn init_script(connection: &DaemonConnection) -> String {
    format!(
        "window.__OVERTURE_DAEMON__ = {{ baseUrl: {base_url}, token: {token} }};",
        base_url = serde_json::to_string(&connection.base_url).unwrap_or_else(|_| "null".into()),
        token = serde_json::to_string(&connection.token).unwrap_or_else(|_| "null".into()),
    )
}

/// Called synchronously from the `RunEvent::Exit` handler. Only signals a
/// daemon we spawned ourselves; a daemon we attached to (already running
/// before we started) is left alone.
///
/// Deliberately synchronous, no `tauri::async_runtime::block_on`: by the
/// time `RunEvent::Exit` fires, Tauri's managed runtime may already be
/// shutting down its reactor, which makes `block_on` of anything
/// timer/IO-based (e.g. `tokio::time::sleep`) panic even though the runtime
/// handle still resolves. `std::thread::sleep` has no such dependency.
fn shutdown(supervisor: &SharedSupervisor) {
    supervisor.stopping.store(true, Ordering::SeqCst);
    if !supervisor.owns_process.load(Ordering::SeqCst) {
        return;
    }
    let pid = *supervisor.pid.lock().unwrap();
    if let Some(pid) = pid {
        daemon::terminate(pid);
    }
    std::thread::sleep(SHUTDOWN_GRACE);
}
