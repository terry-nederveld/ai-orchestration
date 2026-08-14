# Overture desktop app

Two packages:

- `ui/` (`@overture/ui`) — the React SPA, built with Vite. Talks only to the
  daemon's loopback HTTP API (`packages/server`), never to Tauri IPC.
- `shell/` (`@overture/desktop`) — the Tauri v2 shell. Thin by design
  (ADR-0011, ADR-0012): its Rust layer spawns and supervises the Overture
  daemon as a sidecar process, health-checks it, and hands the webview a
  connection (`window.__OVERTURE_DAEMON__ = { baseUrl, token }`). All product
  logic lives in the daemon; the shell has no fs/shell-execute permissions
  exposed to the webview (see `shell/src-tauri/capabilities/default.json`).

## Prerequisites

| Platform | Requirements |
| --- | --- |
| macOS | Xcode Command Line Tools, Rust (`rustup`), Node ≥ 22, pnpm |
| Windows | Microsoft C++ Build Tools (Visual Studio), WebView2 runtime (preinstalled on Windows 11), Rust (`rustup`, MSVC toolchain), Node ≥ 22, pnpm |
| Linux | `libwebkit2gtk-4.1-dev`, `libappindicator3-dev`, `librsvg2-dev`, `patchelf`, `build-essential`, plus `rpm`/`dpkg`/`appimagetool` on the machine building those specific bundle targets, Rust, Node ≥ 22, pnpm |

The daemon runs on the system-installed Node at runtime (v1 packaging does
not bundle a Node runtime — see "Daemon sidecar" below), so a working `node`
on `PATH` is also a runtime requirement for end users in this version.

## Build commands

From the repo root:

```sh
pnpm desktop:build     # builds @overture/ui, then @overture/desktop (release)
```

Or per-package, from `apps/desktop/shell`:

```sh
pnpm build              # tauri build (release bundle)
pnpm build:debug        # tauri build --debug (faster, unoptimized, for local verification)
pnpm dev                # tauri dev (expects `pnpm --filter @overture/ui dev` running separately
                         # at http://localhost:5173 — devUrl in tauri.conf.json; not auto-started)
```

`tauri build` always needs `apps/desktop/ui/dist` to exist first
(`pnpm --filter @overture/ui build`); `desktop:build` does this for you.

Each of the three platform bundle targets can only be produced by the
Tauri CLI running on that OS — there is no cross-compilation for the
installer/bundle formats. This machine (macOS arm64) was used to build and
verify the macOS `.app`/`.dmg` targets and to validate `tauri.conf.json`'s
schema for all three platforms; the Windows (`nsis`) and Linux
(`deb`/`rpm`/`appimage`) targets are configuration-verified only and must be
built on their respective OSes (or in CI runners for those OSes) before
release.

## Where artifacts land

Tauri writes bundles under `apps/desktop/shell/src-tauri/target/<profile>/bundle/`:

- macOS: `macos/Overture.app`, `dmg/Overture_<version>_<arch>.dmg`
- Windows: `nsis/Overture_<version>_<arch>-setup.exe`
- Linux: `deb/overture-desktop_<version>_<arch>.deb`, `rpm/overture-desktop-<version>-1.<arch>.rpm`, `appimage/overture-desktop_<version>_<arch>.AppImage`

`<profile>` is `debug` for `build:debug`, `release` for `build`.

## Code signing / notarization

Not configured in this version — local and CI builds here produce
**unsigned** bundles:

- **macOS**: `tauri.conf.json`'s `bundle.macOS.signingIdentity` is `null` and
  `hardenedRuntime` is `false`. The `.app`/`.dmg` will show Gatekeeper's
  "unidentified developer" warning; users need to right-click → Open (or
  `xattr -dr com.apple.quarantine`) the first time. Shipping outside a small
  trusted group requires an Apple Developer ID certificate
  (`APPLE_SIGNING_IDENTITY`, `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`
  env vars that `tauri build` picks up automatically) plus `notarytool`
  notarization — a follow-up, not wired up here.
- **Windows**: the NSIS installer is unsigned; Windows SmartScreen will warn
  on first run. Signing needs an Authenticode certificate
  (`tauri.conf.json`'s `bundle.windows.certificateThumbprint`/`digestAlgorithm`
  or `signCommand`) — also a follow-up.
- **Linux**: package formats don't require signing to install locally;
  distribution-specific repo signing (e.g. an APT/YUM repo GPG key) is a
  distribution-channel concern, not a build-time one, and is out of scope
  here.

Unsigned, ad-hoc local builds are the default for this repository today.

## Daemon sidecar

`shell/src-tauri/src/daemon.rs` resolves the daemon's entrypoint
(`overture daemon`, i.e. `packages/cli/dist/main.js daemon`) in this order:

1. `OVERTURE_DAEMON_ENTRY` env var (absolute path override — useful for
   testing against a different checkout or a staged bundle).
2. A bundled Tauri resource at `<resource_dir>/daemon/main.js`, for real
   distributed installs.
3. A dev/local-checkout fallback computed at compile time from this crate's
   path in the monorepo (`apps/desktop/shell/src-tauri` → repo root →
   `packages/cli/dist/main.js`). This also covers local `build`/`build:debug`
   runs against this checkout, so `cargo check`/`build:debug` verification
   doesn't require staging resources.

**Known v1 gap:** path (2) — the bundled resource — is not populated by this
build. `packages/cli/dist/main.js` requires its workspace dependencies
(`@overture/*` packages plus their own `node_modules`) to resolve at
runtime, and staging a self-contained copy of that subtree into
`src-tauri/resources/daemon` (e.g. via `pnpm --filter @overture/cli deploy
<dir>`) is a monorepo-packaging step that hasn't been wired into
`tauri.conf.json`'s `bundle.resources` yet. Until that's done, a genuinely
distributed (not-built-from-this-checkout) app needs `OVERTURE_DAEMON_ENTRY`
set, or ships from a machine where the checkout fallback still resolves.
This is a real follow-up, not a documentation-only gap — track it before
shipping installers to anyone outside this checkout.

Supervision (`shell/src-tauri/src/lib.rs`): on start, the shell checks for an
already-running daemon (an existing `daemon.json` in the state dir that
answers a health check) and attaches to it without spawning a second one or
killing it on exit. Otherwise it spawns `node <entry> daemon`, polls for
`daemon.json` + a passing `GET /api/status`, and opens the main window once
healthy with the connection baked into a `window.__OVERTURE_DAEMON__`
initialization script. If a daemon we spawned exits unexpectedly, it's
restarted up to 3 times with exponential backoff; each successful restart
also pushes the new connection into the live window (`webview.eval`) and
emits a `daemon-ready` event, since the daemon's bearer token is
regenerated on every start. On app exit, the shell SIGTERMs a daemon it
spawned (unix; no graceful-stop primitive is wired up for Windows) and waits
briefly before letting the OS reclaim it — a daemon it merely attached to is
left running. The Rust code never logs the token.
