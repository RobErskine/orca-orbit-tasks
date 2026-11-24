// `orca plugin test .` runs this in Node with the same runtime and checks Orca uses. The
// `requests` of the mock host stand in for src/worker.ts.
import { assert, mockHost, mount, test, type MockRequests } from 'orca/testing'
import type { TaskFilter, TaskItem } from './core/types'
import * as panel from './panel'
import type { ConnectionStatus, ListInput, ListOutput, StartInput } from './protocol'

const connected: ConnectionStatus = {
  state: 'connected',
  baseUrl: 'https://orbit.test',
  hasToken: true,
  secretStore: 'os-keyring',
  workspace: 'Acme',
  account: 'Dev',
  tokenName: 'orca',
  expiresAt: '2027-01-01T00:00:00.000Z'
}

const disconnected: ConnectionStatus = {
  state: 'disconnected',
  baseUrl: '',
  hasToken: false,
  secretStore: 'os-keyring'
}

const filters: TaskFilter[] = [
  {
    id: 'view',
    label: 'View',
    defaultValue: 'tasks',
    options: [
      { value: 'tasks', label: 'Tasks' },
      { value: 'view:view-sprint', label: 'This sprint' }
    ]
  },
  {
    id: 'status',
    label: 'Status',
    defaultValue: 'open',
    options: [
      { value: 'open', label: 'Open' },
      { value: 'done', label: 'Done' },
      { value: 'all', label: 'All statuses' }
    ]
  },
  {
    id: 'assignee',
    label: 'Assignee',
    defaultValue: 'me',
    options: [
      { value: 'me', label: 'Me' },
      { value: 'all', label: 'Everyone' }
    ]
  }
]

const login: TaskItem = {
  id: 'task-1',
  title: 'ENG-12 · Fix login',
  status: { label: 'In progress', tone: 'active' },
  priority: 'High',
  owner: 'Dev',
  labels: ['bug'],
  updatedAt: '2026-11-20T09:30:00.000Z',
  url: 'https://orbit.test/tasks/task-1',
  start: { workspaceName: 'eng-12-fix-login', agentPrompt: 'Work on ENG-12' }
}
const cleanup: TaskItem = {
  id: 'task-3',
  title: 'ENG-14 · Old cleanup',
  status: { label: 'Done', tone: 'done' },
  startBlockedReason: 'This task is done.'
}
const extra = { identifier: 'ENG-12', projectKey: 'ENG', projectName: 'Engineering' }

function listOf(items: TaskItem[], more: Partial<Extract<ListOutput, { ok: true }>['result']> = {}): ListOutput {
  return {
    ok: true,
    result: { items, filters, ...more },
    extra: Object.fromEntries(items.map((item) => [item.id, extra])),
    links: {}
  }
}

function worker(overrides: MockRequests = {}): { requests: MockRequests; lists: ListInput[]; starts: StartInput[] } {
  const lists: ListInput[] = []
  const starts: StartInput[] = []
  const requests: MockRequests = {
    'connection.status': connected,
    'tasks.list': (input: ListInput) => {
      lists.push(input)
      return listOf([login, cleanup])
    },
    'tasks.get': ({ itemId }: { itemId: string }) => ({
      ok: true,
      detail: {
        item: itemId === 'task-1' ? login : cleanup,
        bodyMarkdown: 'Users cannot sign in with **SSO**.'
      },
      extra,
      links: []
    }),
    'start.plan': {
      ok: true,
      itemId: 'task-1',
      title: 'ENG-12 · Fix login',
      extra,
      projects: [
        { ref: 'local::p-acme', id: 'p-acme', name: 'acme', hostId: 'local', path: '/Users/dev/acme' },
        { ref: 'ssh:box::p-acme', id: 'p-acme', name: 'acme', hostId: 'ssh:box', path: '/srv/acme' }
      ],
      remembered: null,
      workspaceName: 'eng-12-fix-login',
      agent: 'claude',
      agents: ['claude', 'codex'],
      prompt: 'Work on ENG-12'
    },
    'start.run': (input: StartInput) => {
      starts.push(input)
      return { ok: true, link: { workspaceId: 'ws-new', name: input.workspaceName, createdAt: 1_800_000_000_000 } }
    },
    ...overrides
  }
  return { requests, lists, starts }
}

test('asks to connect, then lists the tasks', async () => {
  const saved: unknown[] = []
  const { requests, lists } = worker({
    'connection.status': disconnected,
    'connection.save': (input: { baseUrl: string; token?: string }) => {
      saved.push(input)
      return input.token === 'orb_good'
        ? connected
        : { ...disconnected, state: 'error', error: 'Orbit refused the API token. It may be wrong, expired or revoked.' }
    }
  })
  const view = await mount(panel, { host: mockHost({ requests }) })
  assert.ok(view.find({ type: 'Heading', text: 'Connect to Orbit' }))
  assert.equal(lists.length, 0)

  await view.type({ label: 'Orbit URL' }, 'orbit.test')
  await view.type({ label: 'API token' }, 'orb_bad')
  await view.press({ role: 'button', text: 'Connect' })
  assert.ok(view.find({ text: /Orbit refused the API token/ }))

  await view.type({ label: 'API token' }, 'orb_good', { replace: true, submit: true })
  assert.deepEqual(saved, [
    { baseUrl: 'orbit.test', token: 'orb_bad' },
    { baseUrl: 'orbit.test', token: 'orb_good' }
  ])
  assert.ok(view.find({ type: 'Heading', text: 'Acme' }))
  assert.ok(view.find({ label: 'ENG-12 · Fix login' }))
  assert.deepEqual(lists, [{ query: '', filters: {}, refresh: true }])
  // The token is never kept by the panel.
  assert.ok(!JSON.stringify(view.persisted).includes('orb_'))
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('searches, filters and loads more', async () => {
  const state = worker()
  let page = 0
  state.requests['tasks.list'] = (input: ListInput) => {
    state.lists.push(input)
    page += 1
    if (input.cursor) return listOf([cleanup])
    return listOf([login], { nextCursor: `cursor-${page}` })
  }
  const view = await mount(panel, { host: mockHost({ requests: state.requests }) })
  assert.ok(view.find({ label: 'ENG-12 · Fix login' }))
  assert.ok(view.find({ type: 'Badge', text: 'In progress' }))

  await view.type({ label: 'Search tasks' }, 'login', { submit: true })
  assert.deepEqual(state.lists.at(-1), { query: 'login', filters: {} })

  await view.toggle({ type: 'Collapsible' })
  assert.equal(view.valueOf({ label: 'Status' }), 'open')
  await view.select({ label: 'Status' }, 'all')
  assert.deepEqual(state.lists.at(-1), { query: 'login', filters: { status: 'all' } })

  // A saved view brings its own status and assignee, so those choices are dropped.
  await view.select({ label: 'View' }, 'view:view-sprint')
  assert.deepEqual(state.lists.at(-1), { query: 'login', filters: { view: 'view:view-sprint' } })

  await view.press({ role: 'button', text: 'Load more' })
  assert.deepEqual(state.lists.at(-1), { query: 'login', filters: { view: 'view:view-sprint' }, cursor: 'cursor-4' })
  assert.ok(view.find({ label: 'ENG-12 · Fix login' }))
  assert.ok(view.find({ label: 'ENG-14 · Old cleanup' }))
  assert.equal(view.find({ role: 'button', text: 'Load more' }), null)

  await view.press({ label: 'Refresh' })
  assert.deepEqual(state.lists.at(-1), { query: 'login', filters: { view: 'view:view-sprint' }, refresh: true })
  assert.deepEqual(view.persisted.plugin, { query: 'login', filters: { view: 'view:view-sprint' } })
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('opens a task and starts a workspace only from the Start form', async () => {
  const { requests, starts } = worker()
  const view = await mount(panel, { host: mockHost({ requests }) })
  await view.press({ label: 'ENG-12 · Fix login' })
  assert.ok(view.find({ type: 'Markdown' }))
  assert.equal(view.find({ type: 'Link', text: 'Open in Orbit' })?.props.href, 'https://orbit.test/tasks/task-1')
  assert.equal(starts.length, 0)

  await view.press({ role: 'button', text: 'Start workspace' })
  assert.ok(view.find({ text: /sends this prompt to the agent/ }))
  assert.equal(view.valueOf({ label: 'Workspace name' }), 'eng-12-fix-login')
  assert.equal(view.valueOf({ label: 'Prompt' }), 'Work on ENG-12')
  assert.equal(starts.length, 0)

  // Two Orca projects and none remembered: one must be chosen.
  await view.press({ role: 'button', text: 'Start' })
  assert.ok(view.find({ text: /Choose the Orca project to create the workspace in\./ }))
  assert.equal(starts.length, 0)

  await view.select({ label: 'Orca project' }, 'ssh:box::p-acme')
  await view.type({ label: 'Base branch' }, 'develop')
  await view.type({ label: 'Prompt' }, ' carefully')
  await view.press({ role: 'button', text: 'Start' })
  assert.deepEqual(starts, [
    {
      itemId: 'task-1',
      projectKey: 'ENG',
      projectRef: 'ssh:box::p-acme',
      baseBranch: 'develop',
      workspaceName: 'eng-12-fix-login',
      agent: 'claude',
      prompt: 'Work on ENG-12 carefully',
      remember: true
    }
  ])
  assert.ok(view.find({ text: /Orca created eng-12-fix-login and sent the prompt/ }))
  // The form is gone: a second press cannot start a second workspace.
  assert.equal(view.find({ role: 'button', text: 'Start' }), null)

  await view.post('links.changed', {
    links: { 'task-1': [{ workspaceId: 'ws-new', name: 'eng-12-fix-login', createdAt: 1_800_000_000_000 }] }
  })
  await view.press({ role: 'button', text: 'Back to tasks' })
  assert.ok(view.find({ type: 'Badge', text: 'Workspace started' }))
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('does not offer Start for a done task, and shows why a start failed', async () => {
  const { requests } = worker({
    'start.run': { ok: false, error: 'Orca did not create the workspace: the branch already exists' },
    'start.plan': {
      ok: true,
      itemId: 'task-1',
      title: 'ENG-12 · Fix login',
      extra,
      projects: [{ ref: 'local::p-acme', id: 'p-acme', name: 'acme', hostId: 'local', path: '/a' }],
      remembered: null,
      workspaceName: 'eng-12-fix-login',
      agent: 'claude',
      agents: ['claude'],
      prompt: 'Work on ENG-12'
    }
  })
  const view = await mount(panel, { host: mockHost({ requests }) })
  await view.press({ label: 'ENG-14 · Old cleanup' })
  assert.equal(view.find({ role: 'button', text: 'Start workspace' })?.disabled, true)
  assert.ok(view.find({ text: 'This task is done.' }))

  await view.press({ role: 'button', text: 'Back to tasks' })
  await view.press({ label: 'ENG-12 · Fix login' })
  await view.press({ role: 'button', text: 'Start workspace' })
  // The only Orca project is preselected.
  assert.equal(view.valueOf({ label: 'Orca project' }), 'local::p-acme')
  await view.press({ role: 'button', text: 'Start' })
  assert.ok(view.find({ text: /Orca did not create the workspace: the branch already exists/ }))
  assert.ok(view.find({ role: 'button', text: 'Start' }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('shows list problems and goes back to Connect when the token stops working', async () => {
  const state = worker()
  let answer: ListOutput = { ok: false, error: 'The database is unavailable.' }
  state.requests['tasks.list'] = () => answer
  const view = await mount(panel, { host: mockHost({ requests: state.requests }) })
  assert.ok(view.find({ text: /The database is unavailable\./ }))

  answer = listOf([], { notice: 'None of the last 250 tasks match the filters. Load more to keep looking.', nextCursor: '250' })
  await view.press({ label: 'Refresh' })
  assert.ok(view.find({ text: /None of the last 250 tasks/ }))
  assert.ok(view.find({ role: 'button', text: 'Load more' }))

  answer = listOf([])
  await view.press({ label: 'Refresh' })
  assert.ok(view.find({ type: 'EmptyState' }))

  answer = { ok: false, error: 'Orbit refused the API token. It may be wrong, expired or revoked.', needsConnection: true }
  await view.press({ label: 'Refresh' })
  assert.ok(view.find({ type: 'Heading', text: 'Connect to Orbit' }))
  assert.ok(view.find({ text: /Orbit refused the API token/ }))
  assert.equal(view.valueOf({ label: 'Orbit URL' }), 'https://orbit.test')
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('draws the longest prompt and task body the worker can send', async () => {
  const prompt = `${'p'.repeat(11_999)}é`
  const { requests } = worker({
    'tasks.get': {
      ok: true,
      detail: { item: login, bodyMarkdown: 'é'.repeat(30_000) },
      extra,
      links: []
    },
    'start.plan': {
      ok: true,
      itemId: 'task-1',
      title: `ENG-12 · ${'t'.repeat(500)}`,
      extra,
      projects: [{ ref: 'local::p-acme', id: 'p-acme', name: 'acme', hostId: 'local', path: '/a' }],
      remembered: null,
      workspaceName: 'eng-12-fix-login',
      agent: 'claude',
      agents: ['claude'],
      prompt
    }
  })
  const view = await mount(panel, { host: mockHost({ requests }) })
  await view.press({ label: 'ENG-12 · Fix login' })
  assert.ok(view.find({ type: 'Markdown' }))
  await view.press({ role: 'button', text: 'Start workspace' })
  assert.equal(view.valueOf({ label: 'Prompt' }), prompt)
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  await view.unmount()
})
