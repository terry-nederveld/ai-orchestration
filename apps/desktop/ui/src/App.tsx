import { NavLink, Route, Routes } from 'react-router-dom'
import styles from './App.module.css'
import { ConnectGate } from './api/ConnectScreen'
import { useConnection } from './api/connection'
import { useEventStream } from './api/events'
import { useStatus } from './api/useStatus'
import { ApprovalsPage } from './features/approvals/ApprovalsPage'
import { Dashboard } from './features/dashboard/Dashboard'
import { ProvidersPage } from './features/providers/ProvidersPage'
import { RunDetail } from './features/runs/RunDetail'
import { RunsList } from './features/runs/RunsList'
import { WorkPage } from './features/work/WorkPage'
import { WorkflowDetail } from './features/workflows/WorkflowDetail'
import { WorkflowsPage } from './features/workflows/WorkflowsPage'

const NAV_ITEMS = [
  { to: '/', label: 'Dashboard', icon: '◈', end: true },
  { to: '/runs', label: 'Runs', icon: '▶', end: false },
  { to: '/work', label: 'Work', icon: '☰', end: false },
  { to: '/workflows', label: 'Workflows', icon: '⌁', end: false },
  { to: '/providers', label: 'Providers', icon: '◎', end: false },
  { to: '/approvals', label: 'Approvals', icon: '✓', end: false },
]

export function App(): JSX.Element {
  return (
    <ConnectGate>
      <Shell />
    </ConnectGate>
  )
}

function Shell(): JSX.Element {
  const { connected } = useEventStream()
  const { status } = useStatus()
  const { disconnect } = useConnection()

  return (
    <div className={styles.shell}>
      <aside className={styles.sidebar}>
        <div className={styles.brand}>
          <div className={styles.brandMark} />
          Overture
        </div>
        <nav className={styles.nav}>
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                [styles.navLink, isActive ? styles.navLinkActive : ''].filter(Boolean).join(' ')
              }
            >
              <span className={styles.navIcon} aria-hidden="true">
                {item.icon}
              </span>
              {item.label}
            </NavLink>
          ))}
        </nav>
      </aside>

      <div className={styles.main}>
        <header className={styles.header}>
          <div className={styles.headerTitle}>
            {status ? `${status.activeRuns} active run${status.activeRuns === 1 ? '' : 's'}` : ''}
          </div>
          <div className={styles.headerRight}>
            <button
              type="button"
              onClick={disconnect}
              title="Disconnect"
              className={styles.connectionPill}
              style={{ background: 'none', border: 'none', cursor: 'pointer' }}
            >
              <span
                className={[styles.connectionDot, connected ? styles.live : styles.down].join(' ')}
              />
              {connected ? 'Live' : 'Reconnecting…'}
            </button>
            {status && <span className={styles.version}>v{status.version}</span>}
          </div>
        </header>

        <main className={styles.content}>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/runs" element={<RunsList />} />
            <Route path="/runs/:runId" element={<RunDetail />} />
            <Route path="/work" element={<WorkPage />} />
            <Route path="/workflows" element={<WorkflowsPage />} />
            <Route path="/workflows/:name" element={<WorkflowDetail />} />
            <Route path="/providers" element={<ProvidersPage />} />
            <Route path="/approvals" element={<ApprovalsPage />} />
          </Routes>
        </main>
      </div>
    </div>
  )
}
