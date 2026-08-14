import type { ProviderStatus } from '../../api/types'
import { useApiQuery } from '../../api/useApiQuery'
import { Badge } from '../../components/Badge'
import { EmptyState } from '../../components/EmptyState'
import { Spinner } from '../../components/Spinner'
import { titleCase } from '../../lib/format'
import styles from './ProvidersPage.module.css'

const KIND_ORDER = ['model', 'agent', 'work', 'scm', 'workspace', 'secret', 'notification'] as const
const KIND_LABEL: Record<string, string> = {
  model: 'Models',
  agent: 'Agents',
  work: 'Work sources',
  scm: 'Source control',
  workspace: 'Workspaces',
  secret: 'Secrets',
  notification: 'Notifications',
}

function statusTone(status: ProviderStatus): 'success' | 'warning' | 'neutral' {
  if (status.availability.available) return 'success'
  if (status.availability.installed) return 'warning'
  return 'neutral'
}

function statusLabel(status: ProviderStatus): string {
  if (status.availability.available) return 'available'
  if (!status.availability.installed) return 'not installed'
  if (!status.availability.authenticated) return 'not authenticated'
  return 'unavailable'
}

export function ProvidersPage(): JSX.Element {
  const query = useApiQuery((client) => client.listProviders())
  const providers = query.data ?? []

  if (query.loading) return <Spinner />
  if (query.error) return <EmptyState icon="!" title="Couldn't load providers" hint={query.error} />
  if (providers.length === 0) {
    return (
      <EmptyState
        icon="◎"
        title="No providers configured"
        hint="Add model, agent, work, or SCM providers to the daemon's config file to see them here."
      />
    )
  }

  const byKind = new Map<string, ProviderStatus[]>()
  for (const p of providers) {
    const list = byKind.get(p.info.kind) ?? []
    list.push(p)
    byKind.set(p.info.kind, list)
  }

  const orderedKinds = [
    ...KIND_ORDER.filter((k) => byKind.has(k)),
    ...[...byKind.keys()].filter((k) => !(KIND_ORDER as readonly string[]).includes(k)),
  ]

  return (
    <div>
      {orderedKinds.map((kind) => (
        <div key={kind} className={styles.group}>
          <div className={styles.groupTitle}>{KIND_LABEL[kind] ?? titleCase(kind)}</div>
          <div className={styles.grid}>
            {(byKind.get(kind) ?? []).map((p) => (
              <div key={p.info.id} className={styles.card}>
                <div className={styles.cardTop}>
                  <div>
                    <div className={styles.name}>{p.info.displayName}</div>
                    <div className={styles.id}>{p.info.id}</div>
                  </div>
                  <Badge tone={statusTone(p)}>{statusLabel(p)}</Badge>
                </div>
                <div className={styles.meta}>
                  <Badge tone="neutral">{titleCase(p.info.consumption)}</Badge>
                  {p.info.authentication.map((auth) => (
                    <Badge key={auth} tone="neutral">
                      {titleCase(auth)}
                    </Badge>
                  ))}
                </div>
                {p.availability.detail && (
                  <div className={styles.detail}>{p.availability.detail}</div>
                )}
                {p.availability.models && p.availability.models.length > 0 && (
                  <div className={styles.detail}>Models: {p.availability.models.join(', ')}</div>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
