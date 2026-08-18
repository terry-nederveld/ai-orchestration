/**
 * Safe expression evaluation over a generic scope object for graph
 * transitions, guards, and lifecycle effects: dotted references resolved
 * against the scope, string/number/boolean literals, ==, !=, !, &&, ||,
 * and parentheses. No eval, no prototype access, deterministic.
 */

export type Scope = Readonly<Record<string, unknown>>

type Token =
  | { readonly type: 'ident'; readonly value: string }
  | { readonly type: 'string'; readonly value: string }
  | { readonly type: 'number'; readonly value: number }
  | { readonly type: 'op'; readonly value: '==' | '!=' | '&&' | '||' | '!' }
  | { readonly type: 'lparen' }
  | { readonly type: 'rparen' }
  | { readonly type: 'eof' }

export class ScopeExpressionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ScopeExpressionError'
  }
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = []
  let index = 0
  while (index < source.length) {
    const char = source[index] as string
    if (/\s/.test(char)) {
      index += 1
      continue
    }
    if (char === '(') {
      tokens.push({ type: 'lparen' })
      index += 1
      continue
    }
    if (char === ')') {
      tokens.push({ type: 'rparen' })
      index += 1
      continue
    }
    const two = source.slice(index, index + 2)
    if (two === '==' || two === '!=' || two === '&&' || two === '||') {
      tokens.push({ type: 'op', value: two })
      index += 2
      continue
    }
    if (char === '!') {
      tokens.push({ type: 'op', value: '!' })
      index += 1
      continue
    }
    if (char === "'") {
      const end = source.indexOf("'", index + 1)
      if (end === -1) throw new ScopeExpressionError(`unterminated string at ${index}`)
      tokens.push({ type: 'string', value: source.slice(index + 1, end) })
      index = end + 1
      continue
    }
    if (/[0-9]/.test(char)) {
      const match = /^[0-9]+(\.[0-9]+)?/.exec(source.slice(index))
      if (!match) throw new ScopeExpressionError(`bad number at ${index}`)
      tokens.push({ type: 'number', value: Number(match[0]) })
      index += match[0].length
      continue
    }
    if (/[A-Za-z_]/.test(char)) {
      const match = /^[A-Za-z_][A-Za-z0-9_.-]*/.exec(source.slice(index))
      if (!match) throw new ScopeExpressionError(`bad identifier at ${index}`)
      tokens.push({ type: 'ident', value: match[0] })
      index += match[0].length
      continue
    }
    throw new ScopeExpressionError(`unexpected character '${char}' at ${index}`)
  }
  tokens.push({ type: 'eof' })
  return tokens
}

type Expr =
  | { readonly type: 'literal'; readonly value: unknown }
  | { readonly type: 'ref'; readonly path: readonly string[] }
  | { readonly type: 'not'; readonly operand: Expr }
  | {
      readonly type: 'binary'
      readonly op: '==' | '!=' | '&&' | '||'
      readonly left: Expr
      readonly right: Expr
    }

class Parser {
  private position = 0
  constructor(private readonly tokens: Token[]) {}

  parse(): Expr {
    const expr = this.parseOr()
    if (this.peek().type !== 'eof') {
      throw new ScopeExpressionError('unexpected trailing tokens')
    }
    return expr
  }

  private peek(): Token {
    return this.tokens[this.position] as Token
  }

  private next(): Token {
    const token = this.peek()
    this.position += 1
    return token
  }

  private parseOr(): Expr {
    let left = this.parseAnd()
    while (this.peek().type === 'op' && (this.peek() as { value: string }).value === '||') {
      this.next()
      left = { type: 'binary', op: '||', left, right: this.parseAnd() }
    }
    return left
  }

  private parseAnd(): Expr {
    let left = this.parseEquality()
    while (this.peek().type === 'op' && (this.peek() as { value: string }).value === '&&') {
      this.next()
      left = { type: 'binary', op: '&&', left, right: this.parseEquality() }
    }
    return left
  }

  private parseEquality(): Expr {
    let left = this.parseUnary()
    while (
      this.peek().type === 'op' &&
      ((this.peek() as { value: string }).value === '==' ||
        (this.peek() as { value: string }).value === '!=')
    ) {
      const op = (this.next() as { value: '==' | '!=' }).value
      left = { type: 'binary', op, left, right: this.parseUnary() }
    }
    return left
  }

  private parseUnary(): Expr {
    const token = this.peek()
    if (token.type === 'op' && token.value === '!') {
      this.next()
      return { type: 'not', operand: this.parseUnary() }
    }
    return this.parsePrimary()
  }

  private parsePrimary(): Expr {
    const token = this.next()
    switch (token.type) {
      case 'lparen': {
        const inner = this.parseOr()
        if (this.next().type !== 'rparen') throw new ScopeExpressionError('missing )')
        return inner
      }
      case 'string':
        return { type: 'literal', value: token.value }
      case 'number':
        return { type: 'literal', value: token.value }
      case 'ident': {
        if (token.value === 'true') return { type: 'literal', value: true }
        if (token.value === 'false') return { type: 'literal', value: false }
        return { type: 'ref', path: token.value.split('.') }
      }
      default:
        throw new ScopeExpressionError(`unexpected token ${token.type}`)
    }
  }
}

const cache = new Map<string, Expr>()

export function parseScopeExpression(source: string): Expr {
  const cached = cache.get(source)
  if (cached) return cached
  const parsed = new Parser(tokenize(source)).parse()
  if (cache.size > 500) cache.clear()
  cache.set(source, parsed)
  return parsed
}

function resolveRef(path: readonly string[], scope: Scope): unknown {
  let current: unknown = scope
  for (const segment of path) {
    if (segment === '__proto__' || segment === 'constructor' || segment === 'prototype') {
      return undefined
    }
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

function evaluateNode(expr: Expr, scope: Scope): unknown {
  switch (expr.type) {
    case 'literal':
      return expr.value
    case 'ref':
      return resolveRef(expr.path, scope)
    case 'not':
      return !truthy(evaluateNode(expr.operand, scope))
    case 'binary': {
      if (expr.op === '&&') {
        return truthy(evaluateNode(expr.left, scope)) && truthy(evaluateNode(expr.right, scope))
      }
      if (expr.op === '||') {
        return truthy(evaluateNode(expr.left, scope)) || truthy(evaluateNode(expr.right, scope))
      }
      const left = evaluateNode(expr.left, scope)
      const right = evaluateNode(expr.right, scope)
      return expr.op === '==' ? left === right : left !== right
    }
  }
}

function truthy(value: unknown): boolean {
  return (
    value === true ||
    (value !== false && value !== undefined && value !== null && value !== 0 && value !== '')
  )
}

/** Evaluate an expression to a boolean against a scope. */
export function evaluateScopeExpression(source: string, scope: Scope): boolean {
  return truthy(evaluateNode(parseScopeExpression(source), scope))
}

/** Evaluate to a raw value (for effects and fan-out item lists). */
export function evaluateScopeValue(source: string, scope: Scope): unknown {
  return evaluateNode(parseScopeExpression(source), scope)
}
