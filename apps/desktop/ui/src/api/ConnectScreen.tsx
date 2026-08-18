import { type FormEvent, type ReactNode, useState } from 'react'
import { Badge } from '../components/Badge'
import { Button } from '../components/Button'
import { Spinner } from '../components/Spinner'
import { relativeTime } from '../lib/format'
import styles from './ConnectScreen.module.css'
import {
  type ConnectionEntry,
  type ConnectionKind,
  type RuntimeConnection,
  useConnections,
} from './connection'

/**
 * Gate that renders the app once at least one runtime connection is
 * healthy; otherwise it shows the connection manager (or a connecting
 * screen while the configured runtimes are still being probed).
 */
export function ConnectGate({ children }: { readonly children: ReactNode }): JSX.Element {
  const { connections } = useConnections()
  if (connections.some((connection) => connection.health === 'connected')) return <>{children}</>
  return <ConnectScreen />
}

function ConnectScreen(): JSX.Element {
  const { connections } = useConnections()
  const allConnecting =
    connections.length > 0 && connections.every((connection) => connection.health === 'connecting')

  return (
    <div className={styles.wrap}>
      <div className={[styles.card, connections.length > 0 ? styles.managerCard : ''].join(' ')}>
        <div className={styles.brand}>
          <div className={styles.brandMark} />
          <div className={styles.brandName}>Overture</div>
        </div>

        {allConnecting ? (
          <>
            <div className={styles.title}>Connecting…</div>
            <p className={styles.hint}>Reaching your configured runtimes.</p>
            <Spinner />
          </>
        ) : (
          <>
            <div className={styles.title}>
              {connections.length === 0 ? 'Not connected' : 'No runtime reachable'}
            </div>
            <p className={styles.hint}>
              Overture talks to one or more runtimes over HTTP; nothing runs until at least one is
              reachable. Start the local daemon, then add it below.
              <span className={styles.command}>overture daemon</span>
              The command prints the port and token to use here.
            </p>
            <ConnectionManager />
          </>
        )}
      </div>
    </div>
  )
}

const HEALTH_DOT: Record<RuntimeConnection['health'], string> = {
  connected: styles.dotConnected ?? '',
  connecting: styles.dotConnecting ?? '',
  unreachable: styles.dotUnreachable ?? '',
}

function healthText(connection: RuntimeConnection): string {
  switch (connection.health) {
    case 'connected':
      return 'connected'
    case 'connecting':
      return 'connecting…'
    default:
      return connection.lastSeenAt
        ? `unreachable · last seen ${relativeTime(connection.lastSeenAt)}`
        : 'unreachable'
  }
}

/**
 * Lists the configured runtime connections with live health and an add
 * form. Rendered both in the pre-connection gate and on the Connections
 * page once the app is up.
 */
export function ConnectionManager(): JSX.Element {
  const { connections, addConnection, removeConnection, refresh } = useConnections()
  const [name, setName] = useState(connections.length === 0 ? 'Local' : '')
  const [kind, setKind] = useState<ConnectionKind>('local')
  const [host, setHost] = useState('127.0.0.1')
  const [port, setPort] = useState('4756')
  const [token, setToken] = useState('')
  const [formError, setFormError] = useState<string | null>(null)

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault()
    const trimmedName = name.trim()
    const trimmedHost = host.trim()
    const portNumber = Number(port.trim())
    if (!trimmedName || !trimmedHost || !token.trim()) {
      setFormError('Name, host, and token are required')
      return
    }
    if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65_535) {
      setFormError('Port must be a number between 1 and 65535')
      return
    }
    if (connections.some((connection) => connection.entry.name === trimmedName)) {
      setFormError(`A connection named '${trimmedName}' already exists`)
      return
    }
    const entry: ConnectionEntry = {
      name: trimmedName,
      host: trimmedHost,
      port: portNumber,
      token: token.trim(),
      kind,
    }
    addConnection(entry)
    setFormError(null)
    setName('')
    setToken('')
  }

  return (
    <div>
      {connections.length > 0 && (
        <div className={styles.connectionList}>
          {connections.map((connection) => (
            <div key={connection.entry.name} className={styles.connectionRow}>
              <span
                className={[styles.connectionDot, HEALTH_DOT[connection.health]].join(' ')}
                aria-hidden="true"
              />
              <div className={styles.connectionMeta}>
                <div className={styles.connectionName}>
                  {connection.entry.name}{' '}
                  <Badge tone={connection.entry.kind === 'local' ? 'neutral' : 'accent'}>
                    {connection.entry.kind}
                  </Badge>
                </div>
                <div className={styles.connectionAddress}>
                  {connection.entry.host}:{connection.entry.port}
                </div>
              </div>
              <div className={styles.connectionStatusText}>{healthText(connection)}</div>
              <Button size="sm" onClick={() => removeConnection(connection.entry.name)}>
                Remove
              </Button>
            </div>
          ))}
          <div>
            <Button size="sm" onClick={refresh}>
              Retry all
            </Button>
          </div>
        </div>
      )}

      {formError && <div className={styles.error}>{formError}</div>}

      <form className={styles.form} onSubmit={handleSubmit}>
        <div className={styles.row}>
          <label className={styles.field}>
            <span className={styles.label}>Name</span>
            <input
              className={styles.input}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={connections.length === 0 ? 'Local' : 'e.g. Office'}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.label}>Kind</span>
            <select
              className={styles.input}
              value={kind}
              onChange={(e) => setKind(e.target.value as ConnectionKind)}
            >
              <option value="local">local</option>
              <option value="remote">remote</option>
            </select>
          </label>
        </div>
        <div className={styles.row}>
          <label className={styles.field}>
            <span className={styles.label}>Host</span>
            <input
              className={styles.input}
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="127.0.0.1"
            />
          </label>
          <label className={styles.field}>
            <span className={styles.label}>Port</span>
            <input
              className={styles.input}
              value={port}
              onChange={(e) => setPort(e.target.value)}
              placeholder="4756"
              inputMode="numeric"
            />
          </label>
        </div>
        <label className={styles.field}>
          <span className={styles.label}>Token</span>
          <input
            className={styles.input}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="paste the runtime token"
            autoComplete="off"
          />
        </label>
        <Button type="submit" variant="primary" className={styles.submit}>
          Add connection
        </Button>
      </form>
    </div>
  )
}
