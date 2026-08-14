import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { App } from './App'
import { ConnectionProvider } from './api/connection'
import './global.css'
import { ToastProvider } from './components/Toast'

const container = document.getElementById('root')
if (!container) throw new Error('missing #root element')

// MemoryRouter, not Browser/HashRouter: this bundle is embedded in a Tauri
// webview with no address bar, and the URL hash is reserved for the
// daemon-connection handshake (`#port=..&token=..`), so it can't also drive
// route state.
createRoot(container).render(
  <StrictMode>
    <MemoryRouter>
      <ConnectionProvider>
        <ToastProvider>
          <App />
        </ToastProvider>
      </ConnectionProvider>
    </MemoryRouter>
  </StrictMode>,
)
