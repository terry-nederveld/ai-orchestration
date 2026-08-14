/**
 * Incremental JSONL line splitter. `codex exec --json` writes one JSON
 * object per line to stdout, but stream chunks (from a child process pipe)
 * never align with line boundaries, so a line can arrive split across
 * multiple `data` events. Buffers the trailing partial line between calls.
 */
export class JsonlSplitter {
  private buffer = ''

  /** Feeds a raw chunk and returns every complete, parseable JSON line it completed. Malformed lines are dropped, not thrown. */
  push(chunk: string): unknown[] {
    this.buffer += chunk
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() ?? ''
    return lines.map(parseLine).filter((v): v is unknown => v !== undefined)
  }

  /** Parses whatever remains in the buffer (e.g. a final line with no trailing newline) once the stream ends. */
  flush(): unknown[] {
    const remaining = this.buffer
    this.buffer = ''
    const parsed = parseLine(remaining)
    return parsed === undefined ? [] : [parsed]
  }
}

function parseLine(line: string): unknown {
  const trimmed = line.trim()
  if (!trimmed) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}
