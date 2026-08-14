/**
 * Built-in workflow actions: source-control delivery and work-item updates.
 * Registered through the same WorkflowActionRegistry extensions use — nothing
 * here is special-cased in the engine or kernel.
 */

import type { WorkflowAction } from '@overture/core'
import { asId, OrchestratorError } from '@overture/core'
import type { RunActionContext, WorkflowActionFactory } from './ports.js'

/** `source_control.commit` — stage everything and create a commit. */
function commitAction(context: RunActionContext): WorkflowAction {
  return {
    id: 'source_control.commit',
    async execute(args) {
      const { scm, workspace } = context
      if (!scm || !workspace) {
        throw new OrchestratorError('commit requires scm and workspace', 'invalid-input')
      }
      const message = typeof args.message === 'string' ? args.message : undefined
      if (!message) throw new OrchestratorError('commit requires a message', 'invalid-input')
      const status = await scm.status(workspace.path)
      if (status.clean) return { committed: false, reason: 'working tree clean' }
      const info = await scm.commit(workspace.path, { message })
      return { committed: true, sha: info.sha, message: info.message }
    },
  }
}

/** `source_control.push` — push the run branch. */
function pushAction(context: RunActionContext): WorkflowAction {
  return {
    id: 'source_control.push',
    async execute() {
      const { scm, workspace, branch } = context
      if (!scm || !workspace || !branch) {
        throw new OrchestratorError('push requires scm, workspace, and branch', 'invalid-input')
      }
      await scm.push(workspace.path, branch)
      return { pushed: true, branch }
    },
  }
}

/** `source_control.pull_request` — push the branch and open a pull request. */
function pullRequestAction(context: RunActionContext): WorkflowAction {
  return {
    id: 'source_control.pull_request',
    async execute(args) {
      const { scm, workspace, branch, workItem, run } = context
      if (!scm?.createPullRequest || !workspace || !branch) {
        throw new OrchestratorError(
          'pull_request requires an scm provider with pull-request support, a workspace, and a branch',
          'capability-mismatch',
        )
      }
      const repository = workspace.repository ?? workItem.repository
      if (!repository) {
        throw new OrchestratorError('pull_request requires a repository reference', 'invalid-input')
      }
      await scm.push(workspace.path, branch)
      const title =
        typeof args.title === 'string' && args.title.length > 0 ? args.title : workItem.title
      const body =
        typeof args.body === 'string' && args.body.length > 0
          ? args.body
          : defaultPullRequestBody(context)
      const info = await scm.createPullRequest({
        repository,
        title,
        body,
        sourceBranch: branch,
        targetBranch:
          typeof args.target_branch === 'string'
            ? args.target_branch
            : (repository.defaultBranch ?? 'main'),
        ...(args.draft === true ? { draft: true } : {}),
      })
      context.events.publish({
        id: asId(context.ids.next('evt')),
        at: context.clock.now(),
        runId: run.id,
        type: 'delivery.pull_request.created',
        url: info.url,
      })
      return { url: info.url, number: info.number ?? null, id: info.id }
    },
  }
}

/** `work.comment` — comment on the work item. */
function workCommentAction(context: RunActionContext): WorkflowAction {
  return {
    id: 'work.comment',
    async execute(args) {
      const body = typeof args.body === 'string' ? args.body : ''
      if (!body) throw new OrchestratorError('work.comment requires a body', 'invalid-input')
      await context.work.comment(context.workItem, { body })
      return { commented: true }
    },
  }
}

/** `work.transition` — move the work item to a new state. */
function workTransitionAction(context: RunActionContext): WorkflowAction {
  return {
    id: 'work.transition',
    async execute(args) {
      const state = typeof args.state === 'string' ? args.state : ''
      if (!state) throw new OrchestratorError('work.transition requires a state', 'invalid-input')
      await context.work.transition(context.workItem, { targetState: state })
      return { transitioned: true, state }
    },
  }
}

function defaultPullRequestBody(context: RunActionContext): string {
  const { workItem } = context
  const lines = [`Resolves: ${workItem.url ?? workItem.externalId}`, '', workItem.title]
  return lines.join('\n')
}

export const builtinActionFactory: WorkflowActionFactory = (context) => [
  commitAction(context),
  pushAction(context),
  pullRequestAction(context),
  workCommentAction(context),
  workTransitionAction(context),
]
