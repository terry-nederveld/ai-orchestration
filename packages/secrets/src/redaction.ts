/**
 * Log redaction: replaces known secret values in text before it reaches any
 * sink. Cheap and dumb on purpose — every logger wraps its output in this.
 */

export class SecretRedactor {
  private values = new Set<string>()

  track(value: string | undefined): void {
    if (value && value.length >= 6) this.values.add(value)
  }

  redact(text: string): string {
    let result = text
    for (const value of this.values) {
      if (result.includes(value)) {
        result = result.split(value).join('[redacted]')
      }
    }
    return result
  }
}
