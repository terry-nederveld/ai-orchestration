/**
 * Wires the shared WorkProvider contract suite against a fake-fetch-backed
 * GitHubIssuesWorkProvider so it's held to the same behavioral guarantees as
 * every other provider (fakes included) — claim idempotency, release
 * unblocking a competing claimant, transition mutating observable state, etc.
 *
 * describeWorkProviderContract() runs `factory()` then `seed(provider)` once
 * per `it`, sequentially (this suite doesn't use test.concurrent), so a
 * module-level `currentBackend` set inside factory() and read inside seed()
 * is enough to give each test its own isolated fake GitHub repo without
 * needing a "create issue" method on the WorkProvider contract itself.
 *
 * The GitHubProjectsWorkProvider isn't wired here: its claim/comment surface
 * is GraphQL mutations rather than a REST resource, so a comparable stateful
 * fake would need to model GraphQL field/option resolution and comment
 * mutations too. It's covered directly by projects-provider.test.ts instead.
 */

import { describeWorkProviderContract } from '@overture/testkit'
import { GitHubIssuesWorkProvider } from './issues-provider.js'
import { FakeGitHubBackend } from './test-helpers.js'

let currentBackend: FakeGitHubBackend | undefined

function factory(): GitHubIssuesWorkProvider {
  const backend = new FakeGitHubBackend('contract-org/repo')
  currentBackend = backend
  return new GitHubIssuesWorkProvider({
    token: async () => 'ghp_contract_test',
    repo: 'contract-org/repo',
    fetchImpl: backend.fetchImpl,
  })
}

function seed() {
  const backend = currentBackend
  if (!backend) throw new Error('seed() called before factory()')
  backend.addIssue({ title: 'Bug 1', state: 'open', labels: ['bug'] })
  backend.addIssue({ title: 'Feature 1', state: 'open', labels: ['feature'] })
  backend.addIssue({ title: 'Fixed already', state: 'closed', labels: ['bug'] })

  // seed() must return WorkItems matching what discover() would produce; the
  // simplest way to stay in lockstep with the real mapping is to ask the
  // provider itself rather than re-deriving the shape here.
  const provider = new GitHubIssuesWorkProvider({
    token: async () => 'ghp_contract_test',
    repo: 'contract-org/repo',
    fetchImpl: backend.fetchImpl,
  })
  return provider.discover({ states: ['open', 'closed'] })
}

describeWorkProviderContract('GitHubIssuesWorkProvider', factory, seed)
