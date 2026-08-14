import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react'
import styles from './Toast.module.css'

export type ToastTone = 'info' | 'success' | 'error'

export interface ToastMessage {
  readonly id: string
  readonly tone: ToastTone
  readonly text: string
}

interface ToastContextValue {
  push(text: string, tone?: ToastTone): void
}

const ToastContext = createContext<ToastContextValue | undefined>(undefined)

const ICON: Record<ToastTone, string> = { info: 'i', success: '✓', error: '!' }
const DISMISS_MS = 6000

export function ToastProvider({ children }: { readonly children: ReactNode }): JSX.Element {
  const [toasts, setToasts] = useState<readonly ToastMessage[]>([])
  const counter = useRef(0)

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id))
  }, [])

  const push = useCallback(
    (text: string, tone: ToastTone = 'info') => {
      counter.current += 1
      const id = `toast-${counter.current}`
      setToasts((prev) => [...prev, { id, text, tone }])
      setTimeout(() => dismiss(id), DISMISS_MS)
    },
    [dismiss],
  )

  const value = useMemo<ToastContextValue>(() => ({ push }), [push])

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className={styles.viewport} aria-live="polite">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={[styles.toast, styles[toast.tone]].join(' ')}
            role="status"
          >
            <span className={styles.icon} aria-hidden="true">
              {ICON[toast.tone]}
            </span>
            <span className={styles.message}>{toast.text}</span>
            <button
              type="button"
              className={styles.close}
              onClick={() => dismiss(toast.id)}
              aria-label="Dismiss"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext)
  if (!context) throw new Error('useToast must be used within a ToastProvider')
  return context
}
