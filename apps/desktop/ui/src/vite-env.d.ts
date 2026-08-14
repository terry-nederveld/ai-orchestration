/// <reference types="vite/client" />

/** Injected by the Tauri shell before this bundle loads, when embedded. */
interface OvertureDaemonHandle {
  readonly baseUrl: string
  readonly token: string
}

interface Window {
  // `| undefined` in addition to the `?:` marker: exactOptionalPropertyTypes
  // otherwise forbids tests from resetting this back with `= undefined`.
  __OVERTURE_DAEMON__?: OvertureDaemonHandle | undefined
}
