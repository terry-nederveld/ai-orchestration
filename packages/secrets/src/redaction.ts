/**
 * Log redaction: replaces known secret values in text before it reaches any
 * sink. Cheap and dumb on purpose — every logger wraps its output in this.
 */

export class SecretRedactor {
  private values = new Set<string>()

  track(value: string | undefined): void {
    if (!value || value.length < 6) return
    this.values.add(value)
    // Common transformations a secret survives on its way into logs or
    // events: base64, URI-encoding, and JSON string escaping.
    this.values.add(Buffer.from(value, 'utf8').toString('base64'))
    const uriEncoded = encodeURIComponent(value)
    if (uriEncoded !== value) this.values.add(uriEncoded)
    const jsonEscaped = JSON.stringify(value).slice(1, -1)
    if (jsonEscaped !== value) this.values.add(jsonEscaped)
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

  /** Deep-redact any JSON-serializable value (objects pass unharmed). */
  redactObject<T>(value: T): T {
    if (this.values.size === 0) return value
    const serialized = JSON.stringify(value)
    if (serialized === undefined) return value
    const redacted = this.redact(serialized)
    if (redacted === serialized) return value
    return JSON.parse(redacted) as T
  }
}
