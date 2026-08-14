import type { Logger } from '@overture/core'

export interface LogEntry {
  readonly level: 'debug' | 'info' | 'warn' | 'error'
  readonly message: string
  readonly fields?: Record<string, unknown>
}

/** In-memory logger for assertions; `child()` shares the same entry list. */
export class RecordingLogger implements Logger {
  readonly entries: LogEntry[] = []

  private record(
    level: LogEntry['level'],
    message: string,
    fields?: Record<string, unknown>,
  ): void {
    this.entries.push(fields !== undefined ? { level, message, fields } : { level, message })
  }

  debug(message: string, fields?: Record<string, unknown>): void {
    this.record('debug', message, fields)
  }

  info(message: string, fields?: Record<string, unknown>): void {
    this.record('info', message, fields)
  }

  warn(message: string, fields?: Record<string, unknown>): void {
    this.record('warn', message, fields)
  }

  error(message: string, fields?: Record<string, unknown>): void {
    this.record('error', message, fields)
  }

  child(): Logger {
    return this
  }
}
