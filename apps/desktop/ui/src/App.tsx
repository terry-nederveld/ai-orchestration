import { NavLink, Route, Routes } from 'react-router'
import styles from './App.module.css'
import { ConnectionsPage } from './api/ConnectionsPage'
import { ConnectGate } from './api/ConnectScreen'
import { useConnections } from './api/connection'
import { useNeedsYouCount } from './api/useNeedsYou'
import { useStatus } from './api/useStatus'
import { ActivityPage } from './features/activity/ActivityPage'
import { ApprovalsPage } from './features/approvals/ApprovalsPage'
import { Dashboard } from './features/dashboard/Dashboard'
import { DesignerDetail } from './features/designer/DesignerDetail'
import { DesignerPage } from './features/designer/DesignerPage'
import { ProvidersPage } from './features/providers/ProvidersPage'
import { RunDetail } from './features/runs/RunDetail'
import { RunsList } from './features/runs/RunsList'
import { WorkPage } from './features/work/WorkPage'
import { WorkflowDetail } from './features/workflows/WorkflowDetail'
import { WorkflowsPage } from './features/workflows/WorkflowsPage'

const NAV_ITEMS = [
  { to: '/', label: 'Activity', icon: '✦', end: true, needsYouBadge: true },
  { to: '/overview', label: 'Dashboard', icon: '◈', end: false },
  { to: '/runs', label: 'Runs', icon: '▶', end: false },
  { to: '/work', label: 'Work', icon: '☰', end: false },
  { to: '/workflows', label: 'Workflows', icon: '⌁', end: false },
  { to: '/providers', label: 'Providers', icon: '◎', end: false },
  { to: '/approvals', label: 'Needs you', icon: '✋', end: false },
  { to: '/designer', label: 'Designer', icon: '✎', end: false },
]

export function App(): JSX.Element {
  return (
    <ConnectGate>
      <Shell />
    </ConnectGate>
  )
}

function Shell(): JSX.Element {
  const { status } = useStatus()
  const { connections } = useConnections()
  const needsYou = useNeedsYouCount()
  const connectedCount = connections.filter(
    (connection) => connection.health === 'connected',
  ).length

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
              {'needsYouBadge' in item && item.needsYouBadge && needsYou > 0 && (
                <span className={styles.navBadge}>{needsYou}</span>
              )}
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
            <NavLink
              to="/connections"
              title="Manage connections"
              className={styles.connectionPill ?? ''}
            >
              <span
                className={[
                  styles.connectionDot,
                  connectedCount > 0 ? styles.live : styles.down,
                ].join(' ')}
              />
              {connectedCount}/{connections.length} runtime
              {connections.length === 1 ? '' : 's'}
            </NavLink>
            {status && <span className={styles.version}>v{status.version}</span>}
          </div>
        </header>

        <main className={styles.content}>
          <Routes>
            <Route path="/" element={<ActivityPage />} />
            <Route path="/overview" element={<Dashboard />} />
            <Route path="/connections" element={<ConnectionsPage />} />
            <Route path="/runs" element={<RunsList />} />
            <Route path="/runs/:runId" element={<RunDetail />} />
            <Route path="/work" element={<WorkPage />} />
            <Route path="/workflows" element={<WorkflowsPage />} />
            <Route path="/workflows/:name" element={<WorkflowDetail />} />
            <Route path="/providers" element={<ProvidersPage />} />
            <Route path="/approvals" element={<ApprovalsPage />} />
            <Route path="/designer" element={<DesignerPage />} />
            <Route path="/designer/:name" element={<DesignerDetail />} />
          </Routes>
        </main>
      </div>
    </div>
  )
}
