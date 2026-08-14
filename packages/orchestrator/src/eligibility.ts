/**
 * Trigger and eligibility evaluation: does a discovered work item qualify for
 * a workflow? Pure functions over the canonical WorkItem.
 */

import type { WorkflowDefinition, WorkItem } from '@overture/core'

export interface EligibilityResult {
  readonly eligible: boolean
  readonly reason?: string
}

export function evaluateEligibility(
  item: WorkItem,
  definition: WorkflowDefinition,
): EligibilityResult {
  const trigger = definition.trigger
  if (trigger?.states && trigger.states.length > 0 && !trigger.states.includes(item.state)) {
    return { eligible: false, reason: `state '${item.state}' not in trigger states` }
  }
  if (
    trigger?.labels &&
    trigger.labels.length > 0 &&
    !trigger.labels.some((label) => item.labels.includes(label))
  ) {
    return { eligible: false, reason: 'no trigger label present' }
  }

  const eligibility = definition.eligibility
  if (eligibility) {
    for (const required of eligibility.labelsInclude ?? []) {
      if (!item.labels.includes(required)) {
        return { eligible: false, reason: `missing required label '${required}'` }
      }
    }
    for (const excluded of eligibility.labelsExclude ?? []) {
      if (item.labels.includes(excluded)) {
        return { eligible: false, reason: `has excluded label '${excluded}'` }
      }
    }
    if (
      eligibility.types &&
      eligibility.types.length > 0 &&
      (!item.type || !eligibility.types.includes(item.type))
    ) {
      return { eligible: false, reason: `type '${item.type ?? 'none'}' not eligible` }
    }
    if (eligibility.assignee === 'unassigned' && item.assignees.length > 0) {
      return { eligible: false, reason: 'item is already assigned' }
    }
  }
  return { eligible: true }
}

/** First workflow whose trigger + eligibility accept the item. */
export function selectWorkflow(
  item: WorkItem,
  definitions: readonly WorkflowDefinition[],
): WorkflowDefinition | undefined {
  return definitions.find((definition) => evaluateEligibility(item, definition).eligible)
}
