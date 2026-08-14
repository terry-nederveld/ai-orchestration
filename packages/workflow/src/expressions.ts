/**
 * A tiny, safe expression language for `when` conditions and `${{ ... }}`
 * interpolation. No eval/Function: hand-rolled tokenizer + recursive-descent
 * parser producing an AST, evaluated by direct interpretation.
 *
 * Grammar (lowest to highest precedence):
 *   or         := and ( '||' and )*
 *   and        := equality ( '&&' equality )*
 *   equality   := unary ( ('==' | '!=') unary )*
 *   unary      := '!' unary | primary
 *   primary    := STRING | NUMBER | 'true' | 'false' | reference | '(' or ')'
 *   reference  := 'steps.' IDENT '.' ('succeeded'|'failed'|'skipped'|'status')
 *               | 'steps.' IDENT '.outputs.' IDENT
 *               | 'vars.' IDENT
 *
 * `steps.<id>.failed` / `.succeeded` / `.skipped` are sugar for comparing
 * `steps.<id>.status` against the matching literal; they're resolved
 * directly during evaluation rather than rewritten in the AST.
 */

import type { StepResult, StepStatus } from '@overture/core'

export class ExpressionSyntaxError extends Error {
  constructor(
    message: string,
    readonly position: number,
  ) {
    super(message)
    this.name = 'ExpressionSyntaxError'
  }
}

export class ExpressionEvaluationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExpressionEvaluationError'
  }
}

export type Literal = string | number | boolean

export type Expression =
  | { readonly kind: 'literal'; readonly value: Literal }
  | { readonly kind: 'var'; readonly name: string }
  | {
      readonly kind: 'stepField'
      readonly stepId: string
      readonly field: 'succeeded' | 'failed' | 'skipped' | 'status'
    }
  | { readonly kind: 'stepOutput'; readonly stepId: string; readonly key: string }
  | { readonly kind: 'unary'; readonly op: '!'; readonly operand: Expression }
  | {
      readonly kind: 'binary'
      readonly op: '==' | '!=' | '&&' | '||'
      readonly left: Expression
      readonly right: Expression
    }

export interface ExpressionContext {
  readonly steps: ReadonlyMap<string, StepResult>
  readonly vars: Readonly<Record<string, unknown>>
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type TokenType = 'string' | 'number' | 'ident' | 'op' | 'lparen' | 'rparen' | 'eof'

interface Token {
  readonly type: TokenType
  readonly value: string
  readonly pos: number
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  const n = source.length
  while (i < n) {
    const ch = source[i] as string
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++
      continue
    }
    if (ch === '(') {
      tokens.push({ type: 'lparen', value: '(', pos: i })
      i++
      continue
    }
    if (ch === ')') {
      tokens.push({ type: 'rparen', value: ')', pos: i })
      i++
      continue
    }
    if (ch === "'") {
      const start = i
      i++
      let value = ''
      while (i < n && source[i] !== "'") {
        value += source[i]
        i++
      }
      if (i >= n) {
        throw new ExpressionSyntaxError(
          `unterminated string literal starting at position ${start}`,
          start,
        )
      }
      i++ // closing quote
      tokens.push({ type: 'string', value, pos: start })
      continue
    }
    if (ch === '=' && source[i + 1] === '=') {
      tokens.push({ type: 'op', value: '==', pos: i })
      i += 2
      continue
    }
    if (ch === '!' && source[i + 1] === '=') {
      tokens.push({ type: 'op', value: '!=', pos: i })
      i += 2
      continue
    }
    if (ch === '&' && source[i + 1] === '&') {
      tokens.push({ type: 'op', value: '&&', pos: i })
      i += 2
      continue
    }
    if (ch === '|' && source[i + 1] === '|') {
      tokens.push({ type: 'op', value: '||', pos: i })
      i += 2
      continue
    }
    if (ch === '!') {
      tokens.push({ type: 'op', value: '!', pos: i })
      i++
      continue
    }
    if (/[0-9]/.test(ch)) {
      const start = i
      let value = ''
      while (i < n && /[0-9.]/.test(source[i] as string)) {
        value += source[i]
        i++
      }
      tokens.push({ type: 'number', value, pos: start })
      continue
    }
    if (/[A-Za-z_]/.test(ch)) {
      const start = i
      let value = ''
      while (i < n && /[A-Za-z0-9_.]/.test(source[i] as string)) {
        value += source[i]
        i++
      }
      tokens.push({ type: 'ident', value, pos: start })
      continue
    }
    throw new ExpressionSyntaxError(`unexpected character '${ch}' at position ${i}`, i)
  }
  tokens.push({ type: 'eof', value: '', pos: n })
  return tokens
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

const STEP_FIELDS = new Set(['succeeded', 'failed', 'skipped', 'status'])

function parseReference(path: string, pos: number): Expression {
  const parts = path.split('.')
  if (parts[0] === 'vars') {
    if (parts.length !== 2 || !parts[1]) {
      throw new ExpressionSyntaxError(`invalid reference '${path}'; expected vars.<name>`, pos)
    }
    return { kind: 'var', name: parts[1] }
  }
  if (parts[0] === 'steps') {
    if (parts.length === 3 && parts[1] && STEP_FIELDS.has(parts[2] as string)) {
      return {
        kind: 'stepField',
        stepId: parts[1],
        field: parts[2] as 'succeeded' | 'failed' | 'skipped' | 'status',
      }
    }
    if (parts.length === 4 && parts[1] && parts[2] === 'outputs' && parts[3]) {
      return { kind: 'stepOutput', stepId: parts[1], key: parts[3] }
    }
    throw new ExpressionSyntaxError(
      `invalid reference '${path}'; expected steps.<id>.(succeeded|failed|skipped|status) or steps.<id>.outputs.<key>`,
      pos,
    )
  }
  throw new ExpressionSyntaxError(
    `unknown reference '${path}'; expected a steps.* or vars.* reference`,
    pos,
  )
}

/** Parses a `when`/interpolation expression into an AST. Throws {@link ExpressionSyntaxError} on invalid syntax. */
export function parseExpression(source: string): Expression {
  const tokens = tokenize(source)
  let pos = 0
  const peek = (): Token => tokens[pos] as Token
  const advance = (): Token => tokens[pos++] as Token

  function parseOr(): Expression {
    let left = parseAnd()
    while (peek().type === 'op' && peek().value === '||') {
      advance()
      left = { kind: 'binary', op: '||', left, right: parseAnd() }
    }
    return left
  }

  function parseAnd(): Expression {
    let left = parseEquality()
    while (peek().type === 'op' && peek().value === '&&') {
      advance()
      left = { kind: 'binary', op: '&&', left, right: parseEquality() }
    }
    return left
  }

  function parseEquality(): Expression {
    let left = parseUnary()
    while (peek().type === 'op' && (peek().value === '==' || peek().value === '!=')) {
      const op = advance().value as '==' | '!='
      left = { kind: 'binary', op, left, right: parseUnary() }
    }
    return left
  }

  function parseUnary(): Expression {
    if (peek().type === 'op' && peek().value === '!') {
      advance()
      return { kind: 'unary', op: '!', operand: parseUnary() }
    }
    return parsePrimary()
  }

  function parsePrimary(): Expression {
    const token = peek()
    if (token.type === 'lparen') {
      advance()
      const expr = parseOr()
      if (peek().type !== 'rparen') {
        throw new ExpressionSyntaxError(`expected ')' at position ${peek().pos}`, peek().pos)
      }
      advance()
      return expr
    }
    if (token.type === 'string') {
      advance()
      return { kind: 'literal', value: token.value }
    }
    if (token.type === 'number') {
      advance()
      return { kind: 'literal', value: Number(token.value) }
    }
    if (token.type === 'ident') {
      advance()
      if (token.value === 'true') return { kind: 'literal', value: true }
      if (token.value === 'false') return { kind: 'literal', value: false }
      return parseReference(token.value, token.pos)
    }
    throw new ExpressionSyntaxError(
      `unexpected token '${token.value || token.type}' at position ${token.pos}`,
      token.pos,
    )
  }

  const expr = parseOr()
  if (peek().type !== 'eof') {
    throw new ExpressionSyntaxError(
      `unexpected trailing input at position ${peek().pos}`,
      peek().pos,
    )
  }
  return expr
}

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

function statusFor(stepId: string, ctx: ExpressionContext): StepStatus {
  const result = ctx.steps.get(stepId)
  if (!result) {
    throw new ExpressionEvaluationError(`unknown step reference 'steps.${stepId}'`)
  }
  return result.status
}

export function evaluateExpression(expr: Expression, ctx: ExpressionContext): unknown {
  switch (expr.kind) {
    case 'literal':
      return expr.value
    case 'var': {
      if (!(expr.name in ctx.vars)) {
        throw new ExpressionEvaluationError(`unknown variable 'vars.${expr.name}'`)
      }
      return ctx.vars[expr.name]
    }
    case 'stepField': {
      const status = statusFor(expr.stepId, ctx)
      if (expr.field === 'status') return status
      if (expr.field === 'succeeded') return status === 'succeeded'
      if (expr.field === 'failed') return status === 'failed'
      return status === 'skipped'
    }
    case 'stepOutput': {
      const result = ctx.steps.get(expr.stepId)
      if (!result) {
        throw new ExpressionEvaluationError(`unknown step reference 'steps.${expr.stepId}'`)
      }
      return result.outputs[expr.key]
    }
    case 'unary':
      return !evaluateExpression(expr.operand, ctx)
    case 'binary': {
      if (expr.op === '&&')
        return (
          Boolean(evaluateExpression(expr.left, ctx)) &&
          Boolean(evaluateExpression(expr.right, ctx))
        )
      if (expr.op === '||')
        return (
          Boolean(evaluateExpression(expr.left, ctx)) ||
          Boolean(evaluateExpression(expr.right, ctx))
        )
      const left = evaluateExpression(expr.left, ctx)
      const right = evaluateExpression(expr.right, ctx)
      return expr.op === '==' ? left === right : left !== right
    }
  }
}

const INTERPOLATION_PATTERN = /\$\{\{\s*(.*?)\s*\}\}/g

function stringifyValue(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}

/** Resolves every `${{ expr }}` occurrence in `template` against `ctx`. */
export function interpolate(template: string, ctx: ExpressionContext): string {
  return template.replace(INTERPOLATION_PATTERN, (_match, exprSource: string) => {
    const expr = parseExpression(exprSource)
    return stringifyValue(evaluateExpression(expr, ctx))
  })
}

export interface ShellInterpolationResult {
  /** `template` with every `${{ expr }}` replaced by a quoted env-var reference. */
  readonly command: string
  /** Generated var name -> raw (unescaped) resolved value, for the process's env. */
  readonly env: Readonly<Record<string, string>>
}

/**
 * Resolves `${{ expr }}` placeholders for use in a shell command string —
 * SAFELY, unlike {@link interpolate}. Substituted values are never spliced
 * into the command text (which would let shell metacharacters in the value
 * — `;`, `$()`, backticks, quotes — execute as commands); instead each
 * placeholder becomes a quoted reference to a generated environment
 * variable (`"$OVERTURE_VAR_0"`, `"$OVERTURE_VAR_1"`, ...), and the actual
 * values travel out-of-band via `env`, to be merged into the spawned
 * process's environment. Shell variable expansion of an env var never
 * re-parses the *value* as shell syntax, so this is immune to injection
 * regardless of what the value contains.
 *
 * Caveat: this only holds if the placeholder in the template is unquoted,
 * e.g. `command: echo ${{ vars.title }}`. If an author wraps it in their
 * own double quotes (`echo "${{ vars.title }}"`), the generated reference
 * ends up double-quoted-within-double-quotes (`echo ""$OVERTURE_VAR_0""`),
 * which is still injection-safe (the value's contents are never
 * re-evaluated as shell syntax) but loses word-splitting/globbing
 * protection on the value itself. Write command templates with bare
 * placeholders and let this function supply the quoting.
 */
export function interpolateForShell(
  template: string,
  ctx: ExpressionContext,
): ShellInterpolationResult {
  const env: Record<string, string> = {}
  let nextIndex = 0
  const command = template.replace(INTERPOLATION_PATTERN, (_match, exprSource: string) => {
    const expr = parseExpression(exprSource)
    const value = stringifyValue(evaluateExpression(expr, ctx))
    const varName = `OVERTURE_VAR_${nextIndex}`
    nextIndex += 1
    env[varName] = value
    return `"$${varName}"`
  })
  return { command, env }
}
