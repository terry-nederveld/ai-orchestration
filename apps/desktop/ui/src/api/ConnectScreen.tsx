import { type FormEvent, type ReactNode, useState } from 'react'
import { Button } from '../components/Button'
import { Spinner } from '../components/Spinner'
import styles from './ConnectScreen.module.css'
import { useConnection } from './connection'

/** Gate that shows a connect form / loading / error state until the daemon answers. */
export function ConnectGate({ children }: { readonly children: ReactNode }): JSX.Element {
  const { status } = useConnection()
  if (status === 'connected') return <>{children}</>
  return <ConnectScreen />
}

function ConnectScreen(): JSX.Element {
  const { status, error, connect } = useConnection()
  const [port, setPort] = useState('4756')
  const [token, setToken] = useState('')

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault()
    if (!port.trim() || !token.trim()) return
    connect(`http://127.0.0.1:${port.trim()}`, token.trim())
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.card}>
        <div className={styles.brand}>
          <div className={styles.brandMark} />
          <div className={styles.brandName}>Overture</div>
        </div>

        {status === 'connecting' ? (
          <>
            <div className={styles.title}>Connecting…</div>
            <p className={styles.hint}>Reaching the local daemon.</p>
            <Spinner />
          </>
        ) : (
          <>
            <div className={styles.title}>Not connected</div>
            <p className={styles.hint}>
              Overture talks to a local daemon over HTTP; nothing runs until one is reachable. Start
              it, then connect below.
              <span className={styles.command}>overture daemon</span>
              The command prints the port and token to use here.
            </p>

            {status === 'error' && error && (
              <div className={styles.error}>Couldn't connect: {error}</div>
            )}

            <form className={styles.form} onSubmit={handleSubmit}>
              <div className={styles.row}>
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
                  placeholder="paste the daemon token"
                  autoComplete="off"
                />
              </label>
              <Button type="submit" variant="primary" className={styles.submit}>
                Connect
              </Button>
            </form>
          </>
        )}
      </div>
    </div>
  )
}
