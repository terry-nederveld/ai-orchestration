/**
 * Validation error surfaced by the parser: every problem found in a workflow
 * document, not just the first, each addressed by a YAML-ish path so an
 * editor or CLI can point straight at the offending field.
 */

export interface WorkflowValidationIssue {
  readonly path: string
  readonly message: string
}

export class WorkflowValidationError extends Error {
  readonly issues: readonly WorkflowValidationIssue[]

  constructor(issues: readonly WorkflowValidationIssue[]) {
    super(WorkflowValidationError.formatMessage(issues))
    this.name = 'WorkflowValidationError'
    this.issues = issues
  }

  private static formatMessage(issues: readonly WorkflowValidationIssue[]): string {
    const lines = issues.map((issue) => `  - ${issue.path}: ${issue.message}`)
    return `workflow validation failed with ${issues.length} issue(s):\n${lines.join('\n')}`
  }
}
