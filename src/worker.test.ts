// Runs src/worker.ts's activate(orca) with the orca object Orca passes, over a mock host. Orbit is
// the fake in src/testing/fake-orbit.ts, installed as the global fetch the worker uses.
import { afterEach, assert, hostError, mockHost, mountWorker, test, type MockHostOptions } from 'orca/testing'
import { BASE_URL, fakeOrbit, TOKEN, type FakeOrbit } from './testing/fake-orbit'
import * as main from './worker'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

const orcaProjects = [
  { id: 'p-acme', name: 'acme', kind: 'git', hostId: 'local', path: '/Users/dev/acme' },
  { id: 'p-notes', name: 'notes', kind: 'folder', hostId: 'local', path: '/Users/dev/notes' },
  { id: 'p-acme', name: 'acme', kind: 'git', hostId: 'ssh:box', path: '/srv/acme' },
  { id: 'p-old', name: 'old', kind: 'git', hostId: 'local', path: '/Users/dev/old', hidden: true }
]

async function mounted(options: MockHostOptions = {}, orbit: FakeOrbit = fakeOrbit()) {
  globalThis.fetch = orbit.fetch as unknown as typeof fetch
  const host = mockHost({
    settings: { baseUrl: BASE_URL },
    secrets: { token: TOKEN },
    ...options,
    results: {
      'secrets.protection': { status: 'os-keyring' },
      'project.list': { projects: orcaProjects, truncated: false },
      'workspace.create': { workspaceId: 'ws-new', terminalId: 'term-1' },
      ...options.results
    }
  })
  const worker = await mountWorker(main, { host })
  return { worker, host, orbit }
}

test('is disconnected until a URL and a token are saved', async () => {
  const { worker, orbit } = await mounted({ settings: {}, secrets: {} })
  assert.deepEqual(await worker.request('connection.status'), {
    state: 'disconnected',
    baseUrl: '',
    hasToken: false,
    secretStore: 'os-keyring'
  })
  const list = await worker.request('tasks.list', { query: '', filters: {} })
  assert.deepEqual(list, { ok: false, error: 'Connect to Orbit first.', needsConnection: true })
  assert.deepEqual(orbit.requests, [])
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('saves a URL and token only when Orbit accepts them', async () => {
  const { worker, host } = await mounted({ settings: {}, secrets: {} })
  const refused = await worker.request('connection.save', { baseUrl: 'orbit.test', token: 'orb_wrong' })
  assert.equal(refused.state, 'error')
  assert.match(refused.error ?? '', /refused the API token/)
  assert.deepEqual(host.data().secrets, {})
  assert.equal(host.data().settings.baseUrl, undefined)

  assert.equal((await worker.request('connection.save', { baseUrl: '' , token: TOKEN })).error, 'Enter the URL of your Orbit instance.')
  assert.equal((await worker.request('connection.save', { baseUrl: 'orbit.test' })).error, 'Enter an API token.')

  const status = await worker.request('connection.save', { baseUrl: 'orbit.test/api/public/v1/', token: ` ${TOKEN} ` })
  assert.deepEqual(status, {
    state: 'connected',
    baseUrl: BASE_URL,
    hasToken: true,
    secretStore: 'os-keyring',
    workspace: 'Acme',
    account: 'Dev',
    tokenName: 'orca',
    expiresAt: '2027-01-01T00:00:00.000Z'
  })
  assert.deepEqual(host.data().secrets, { token: TOKEN })
  assert.equal(host.data().settings.baseUrl, BASE_URL)
  assert.ok(!worker.logs.join('\n').includes(TOKEN))

  // A new URL with the saved token: no token is typed again.
  const again = await worker.request('connection.save', { baseUrl: BASE_URL })
  assert.equal(again.state, 'connected')

  const cleared = await worker.request('connection.clear')
  assert.equal(cleared.state, 'disconnected')
  assert.equal(cleared.hasToken, false)
  assert.deepEqual(host.data().secrets, {})
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('refuses a token when the computer has no key store', async () => {
  const { worker, host } = await mounted({
    settings: {},
    secrets: {},
    results: { 'secrets.protection': { status: 'unavailable' } }
  })
  const status = await worker.request('connection.save', { baseUrl: BASE_URL, token: TOKEN })
  assert.equal(status.state, 'error')
  assert.match(status.error ?? '', /no key store/)
  assert.deepEqual(host.data().secrets, {})
  await worker.deactivate()
})

test('warns when the token cannot read tasks', async () => {
  const orbit = fakeOrbit()
  orbit.data.me.token.scopes = ['docs:read']
  const { worker } = await mounted({}, orbit)
  const status = await worker.request('connection.status')
  assert.equal(status.state, 'connected')
  assert.match(status.warning ?? '', /cannot read tasks/)
  await worker.deactivate()
})

test('reports a token Orbit no longer accepts as a connection problem', async () => {
  const { worker } = await mounted({ secrets: { token: 'orb_revoked' } })
  const status = await worker.request('connection.status')
  assert.equal(status.state, 'error')
  const list = await worker.request('tasks.list', { query: '', filters: {} })
  assert.equal(list.ok, false)
  assert.equal(!list.ok && list.needsConnection, true)
  await worker.deactivate()
})

test('lists and gets tasks with the settings applied', async () => {
  const { worker, orbit } = await mounted({
    settings: { baseUrl: BASE_URL, includeDone: true, promptTemplate: 'Do {{key}}', defaultAgent: 'codex' }
  })
  const list = await worker.request('tasks.list', { query: '', filters: {} })
  assert.ok(list.ok)
  assert.deepEqual(list.result.items.map((item) => item.id), ['task-1', 'task-3', 'task-5'])
  assert.equal(list.result.items[0]?.start?.agentPrompt, 'Do ENG-12')
  assert.deepEqual(list.result.items[0]?.start?.sessionOptions, { agent: 'codex' })
  assert.deepEqual(list.links, {})
  assert.equal(orbit.requests.filter((request) => request === '/me').length, 1)

  const got = await worker.request('tasks.get', { itemId: 'task-1' })
  assert.ok(got.ok)
  assert.match(got.detail.bodyMarkdown ?? '', /## Sub-issues/)
  assert.deepEqual(got.links, [])

  // The session is reused: /me was asked once for all three requests.
  await worker.request('tasks.list', { query: 'login', filters: {}, refresh: true })
  assert.equal(orbit.requests.filter((request) => request === '/me').length, 1)
  assert.equal(orbit.requests.filter((request) => request.startsWith('/workspaces/ws-1/projects?')).length, 2)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('turns an Orbit failure into a message and keeps the connection', async () => {
  const { worker, orbit } = await mounted()
  await worker.request('connection.status')
  orbit.next.push({ status: 500, body: { code: 'internal_error', detail: 'The database is unavailable.' } })
  const list = await worker.request('tasks.list', { query: '', filters: {} })
  assert.deepEqual(list, { ok: false, error: 'The database is unavailable.' })
  await worker.deactivate()
})

test('plans a start without creating anything', async () => {
  const { worker, host } = await mounted()
  const plan = await worker.request('start.plan', { itemId: 'task-1' })
  assert.ok(plan.ok)
  assert.equal(plan.title, 'ENG-12 · Fix login')
  assert.equal(plan.workspaceName, 'eng-12-fix-login')
  assert.equal(plan.agent, 'claude')
  assert.match(plan.prompt, /Work on Orbit task ENG-12: Fix login/)
  assert.equal(plan.remembered, null)
  // Git projects that are not hidden, on every host.
  assert.deepEqual(plan.projects, [
    { ref: 'local::p-acme', id: 'p-acme', name: 'acme', hostId: 'local', path: '/Users/dev/acme' },
    { ref: 'ssh:box::p-acme', id: 'p-acme', name: 'acme', hostId: 'ssh:box', path: '/srv/acme' }
  ])
  assert.deepEqual(host.callsOf('workspace.create'), [])

  const done = await worker.request('start.plan', { itemId: 'task-3' })
  assert.deepEqual(done, { ok: false, error: 'This task is done.' })
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('creates the workspace, records it and remembers the project', async () => {
  const { worker, host } = await mounted()
  const input = {
    itemId: 'task-1',
    projectKey: 'ENG',
    projectRef: 'ssh:box::p-acme',
    baseBranch: ' develop ',
    workspaceName: ' eng-12-fix-login ',
    agent: 'claude',
    prompt: 'Work on ENG-12',
    remember: true
  }
  const started = await worker.request('start.run', input)
  assert.ok(started.ok)
  assert.equal(started.link.workspaceId, 'ws-new')
  assert.equal(started.link.name, 'eng-12-fix-login')
  assert.deepEqual(host.callsOf('workspace.create'), [
    {
      projectId: 'p-acme',
      hostId: 'ssh:box',
      name: 'eng-12-fix-login',
      baseBranch: 'develop',
      agent: 'claude',
      prompt: 'Work on ENG-12',
      open: true
    }
  ])
  assert.deepEqual(host.data().storage.targets, { ENG: { projectRef: 'ssh:box::p-acme', baseBranch: 'develop' } })
  assert.equal(worker.posts.length, 1)
  assert.equal(worker.posts[0]?.event, 'links.changed')

  // The task now shows its workspace, and the next plan preselects the project.
  const list = await worker.request('tasks.list', { query: '', filters: {} })
  assert.ok(list.ok)
  assert.deepEqual(Object.keys(list.links), ['task-1'])
  const plan = await worker.request('start.plan', { itemId: 'task-5' })
  assert.ok(plan.ok)
  assert.deepEqual(plan.remembered, { projectRef: 'ssh:box::p-acme', baseBranch: 'develop' })

  // Without a base branch or `remember`, neither is sent or stored.
  await worker.request('start.run', { ...input, itemId: 'task-5', projectKey: 'OPS', projectRef: 'local::p-acme', baseBranch: '', remember: false })
  assert.deepEqual(host.callsOf('workspace.create')[1], {
    projectId: 'p-acme',
    hostId: 'local',
    name: 'eng-12-fix-login',
    agent: 'claude',
    prompt: 'Work on ENG-12',
    open: true
  })
  assert.deepEqual(Object.keys(host.data().storage.targets as object), ['ENG'])
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('refuses a start that is incomplete, and reports what Orca refuses', async () => {
  const { worker, host } = await mounted({
    results: {
      'workspace.create': () => {
        throw hostError('action_failed', 'a branch named eng-12-fix-login already exists')
      }
    }
  })
  const input = {
    itemId: 'task-1',
    projectKey: 'ENG',
    projectRef: 'local::p-acme',
    baseBranch: '',
    workspaceName: 'eng-12-fix-login',
    agent: 'claude',
    prompt: 'Work on ENG-12',
    remember: true
  }
  const errorOf = async (patch: Partial<typeof input>): Promise<string> => {
    const answer = await worker.request('start.run', { ...input, ...patch })
    return answer.ok ? '' : answer.error
  }
  assert.equal(await errorOf({ workspaceName: '  ' }), 'Enter a workspace name.')
  assert.equal(await errorOf({ prompt: '' }), 'The prompt is empty.')
  assert.equal(await errorOf({ prompt: 'p'.repeat(16385) }), 'The prompt is longer than 16384 characters.')
  assert.equal(await errorOf({ agent: '' }), 'Choose an agent.')
  assert.equal(await errorOf({ projectRef: 'local::p-notes' }), 'Choose the Orca project to create the workspace in.')
  assert.deepEqual(host.callsOf('workspace.create'), [])

  assert.equal(
    await errorOf({}),
    'Orca did not create the workspace: a branch named eng-12-fix-login already exists'
  )
  // Nothing is recorded for a workspace that was not created.
  assert.equal(host.data().storage.links, undefined)
  assert.equal(host.data().storage.targets, undefined)
  await worker.deactivate()
})

test('forgets a workspace when Orca removes it', async () => {
  const { worker, host } = await mounted({
    storage: {
      links: {
        'task-1': [
          { workspaceId: 'ws-a', name: 'a', createdAt: 1 },
          { workspaceId: 'ws-b', name: 'b', createdAt: 2 }
        ],
        'task-2': [{ workspaceId: 'ws-c', name: 'c', createdAt: 3 }]
      }
    }
  })
  await worker.emit('workspace.removed', { workspaceId: 'internal-c', workspaceListId: 'ws-c', kind: 'worktree', path: '/x' })
  await worker.emit('workspace.removed', { workspaceId: 'ws-a', kind: 'worktree', path: '/y' })
  await worker.emit('workspace.removed', { workspaceId: 'ws-unknown', kind: 'worktree', path: '/z' })
  assert.deepEqual(host.data().storage.links, { 'task-1': [{ workspaceId: 'ws-b', name: 'b', createdAt: 2 }] })
  assert.equal(worker.posts.length, 2)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('declares the same defaults as the manifest', async () => {
  const { readFileSync } = await import('node:fs')
  const manifest = JSON.parse(readFileSync(new URL('../orca-plugin.json', import.meta.url), 'utf8')) as {
    contributes: { settings: { key: string; default?: unknown; enum?: string[] }[] }
  }
  const setting = (key: string) => manifest.contributes.settings.find((entry) => entry.key === key)
  const { DEFAULT_PROMPT_TEMPLATE } = await import('./core/mapping')
  assert.equal(setting('promptTemplate')?.default, DEFAULT_PROMPT_TEMPLATE)
  assert.deepEqual(setting('defaultAgent')?.enum, main.AGENTS)
})
