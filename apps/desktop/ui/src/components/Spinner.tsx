export interface SpinnerProps {
  readonly size?: number
  readonly label?: string
}

export function Spinner({ size = 16, label = 'Loading' }: SpinnerProps): JSX.Element {
  return (
    <span
      role="status"
      aria-label={label}
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        borderRadius: '50%',
        border: '2px solid var(--color-border-strong)',
        borderTopColor: 'var(--color-accent)',
        animation: 'spin 0.7s linear infinite',
      }}
    />
  )
}
