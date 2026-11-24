import { assert, test } from 'orca/testing'
import { BASE_URL, fakeOrbit, task, TOKEN, type FakeOrbit, type FakeOrbitData } from '../testing/fake-orbit'
import { OrbitClient, OrbitError } from './client'
import { checkDetail, checkListResult } from './contract'
import { Lookups } from './lookups'
import { DEFAULT_PROMPT_TEMPLATE } from './mapping'
import { OrbitTaskSource, type SourceSettings } from './source'

const settings: SourceSettings = {
  includeDone: false,
  promptTemplate: DEFAULT_PROMPT_TEMPLATE,
  agent: 'claude'
}

function setup(
  overrides: Partial<FakeOrbitData> = {},
  sourceSettings: SourceSettings = settings
): { orbit: FakeOrbit; source: OrbitTaskSource; lookups: Lookups } {
  const orbit = fakeOrbit(overrides)
  const client = new OrbitClient({ baseUrl: BASE_URL, token: TOKEN, fetch: orbit.fetch, sleep: async () => {} })
  const lookups = new Lookups(client, orbit.data.me.workspace.id)
  const source = new OrbitTaskSource({ client, lookups, me: orbit.data.me, settings: sourceSettings })
  return { orbit, source, lookups }
}

function taskRequests(orbit: FakeOrbit): URLSearchParams[] {
  return orbit.requests
    .filter((request) => request.startsWith('/workspaces/ws-1/tasks?'))
    .map((request) => new URLSearchParams(request.split('?')[1]))
}

test('lists my open tasks by default, newest update first', async () => {
  const { orbit, source } = setup()
  const { result, extra } = await source.list()
  assert.deepEqual(
    result.items.map((item) => item.title),
    ['ENG-12 · Fix login', 'ENG-16 · Add a retry to the client']
  )
  const [query] = taskRequests(orbit)
  assert.equal(query?.get('assignee_id'), 'user-me')
  assert.equal(query?.get('sort'), 'updated_at')
  assert.equal(query?.get('order'), 'desc')
  assert.equal(query?.get('view_id'), null)
  assert.deepEqual(extra['task-1'], { identifier: 'ENG-12', projectKey: 'ENG', projectName: 'Engineering' })
  assert.equal(result.nextCursor, undefined)
  assert.deepEqual(checkListResult(result), [])
})

test('offers the filters with their defaults', async () => {
  const { source } = setup()
  const { result } = await source.list()
  assert.deepEqual(
    result.filters?.map((filter) => [filter.id, filter.defaultValue]),
    [
      ['view', 'tasks'],
      ['project', 'all'],
      ['status', 'open'],
      ['assignee', 'me'],
      ['priority', 'all']
    ]
  )
  const project = result.filters?.find((filter) => filter.id === 'project')
  assert.deepEqual(project?.options.map((option) => option.label), [
    'All projects',
    'ENG · Engineering',
    'OPS · Operations'
  ])
  assert.deepEqual(result.filters?.find((filter) => filter.id === 'view')?.options, [
    { value: 'tasks', label: 'Tasks' },
    { value: 'view:view-sprint', label: 'This sprint' }
  ])
})

test('applies the chosen filters and the search text', async () => {
  const { orbit, source } = setup()
  const { result } = await source.list({
    query: '  api ',
    filters: { assignee: 'all', status: 'all', priority: 'urgent', project: 'project-eng' }
  })
  assert.deepEqual(result.items.map((item) => item.id), ['task-4'])
  const [query] = taskRequests(orbit)
  assert.equal(query?.get('q'), 'api')
  assert.equal(query?.get('priority'), 'urgent')
  assert.equal(query?.get('project_id'), 'project-eng')
  assert.equal(query?.get('assignee_id'), null)
  // With a project chosen, its own statuses are offered too.
  const status = result.filters?.find((filter) => filter.id === 'status')
  assert.ok(status?.options.some((option) => option.value === 'status:eng-doing' && option.label === 'In progress'))
})

test('filters one status on the server and unassigned tasks with assignee none', async () => {
  const { orbit, source } = setup()
  const { result } = await source.list({
    filters: { project: 'project-eng', status: 'status:eng-done', assignee: 'all' }
  })
  assert.deepEqual(result.items.map((item) => item.id), ['task-3'])
  assert.equal(taskRequests(orbit)[0]?.get('status_id'), 'eng-done')

  const unassigned = await source.list({ filters: { assignee: 'none' } })
  assert.deepEqual(unassigned.result.items.map((item) => item.id), ['task-2'])
  assert.equal(taskRequests(orbit)[1]?.get('assignee_id'), 'none')
})

test('falls back to the default for a choice Orbit no longer offers', async () => {
  const { orbit, source } = setup()
  const { result } = await source.list({
    filters: { project: 'project-deleted', status: 'status:eng-doing', assignee: 'someone', view: 'view:gone' }
  })
  const [query] = taskRequests(orbit)
  assert.equal(query?.get('project_id'), null)
  assert.equal(query?.get('status_id'), null)
  assert.equal(query?.get('view_id'), null)
  assert.equal(query?.get('assignee_id'), 'user-me')
  assert.equal(result.items.length, 2)
})

test('shows a saved view as Orbit filters and orders it', async () => {
  const { orbit, source } = setup()
  const { result } = await source.list({ filters: { view: 'view:view-sprint' } })
  // The view decides: no "me", no "open" and no sort are added.
  assert.deepEqual(result.items.map((item) => item.id), ['task-3', 'task-4'])
  const [query] = taskRequests(orbit)
  assert.equal(query?.get('view_id'), 'view-sprint')
  assert.equal(query?.get('sort'), null)
  assert.equal(query?.get('assignee_id'), null)
  assert.equal(result.filters?.find((filter) => filter.id === 'status')?.defaultValue, 'all')
  assert.equal(result.filters?.find((filter) => filter.id === 'assignee')?.defaultValue, 'all')
  assert.deepEqual(checkListResult(result), [])
})

test('hides the View filter when Orbit has no saved views route', async () => {
  const { source } = setup({ views: null })
  const { result } = await source.list()
  assert.ok(!result.filters?.some((filter) => filter.id === 'view'))
  assert.equal(result.items.length, 2)
})

test('has no "Me" for a service-account token', async () => {
  const me = { ...fakeOrbit().data.me, user: null, service_account: { id: 'sa-1', name: 'CI' } }
  const { orbit, source } = setup({ me })
  const { result } = await source.list()
  const assignee = result.filters?.find((filter) => filter.id === 'assignee')
  assert.deepEqual(assignee?.options.map((option) => option.value), ['none', 'all'])
  assert.equal(assignee?.defaultValue, 'all')
  assert.equal(taskRequests(orbit)[0]?.get('assignee_id'), null)
  assert.deepEqual(result.items.map((item) => item.id), ['task-1', 'task-2', 'task-4', 'task-5'])
})

test('includes done tasks when the setting says so', async () => {
  const { source } = setup({}, { ...settings, includeDone: true })
  const { result } = await source.list()
  assert.deepEqual(result.items.map((item) => item.id), ['task-1', 'task-3', 'task-5'])
  assert.equal(result.filters?.find((filter) => filter.id === 'status')?.defaultValue, 'all')
})

test('keeps asking for pages until it has enough open tasks', async () => {
  // 120 done tasks first, then 40 open ones: the first two pages hold nothing to show.
  const done = Array.from({ length: 120 }, (_value, index) =>
    task({ id: `done-${index}`, number: 100 + index, status_id: 'eng-done', updated_at: '2026-11-20T00:00:00.000Z' })
  )
  const open = Array.from({ length: 40 }, (_value, index) =>
    task({ id: `open-${index}`, number: 300 + index, updated_at: '2026-11-01T00:00:00.000Z' })
  )
  const { orbit, source } = setup({ tasks: [...done, ...open] })
  const first = await source.list()
  assert.equal(taskRequests(orbit).length, 3)
  assert.equal(first.result.items.length, 30)
  assert.equal(first.result.nextCursor, '150')
  assert.equal(first.result.notice, undefined)
  assert.deepEqual(checkListResult(first.result), [])

  const second = await source.list({ cursor: first.result.nextCursor })
  assert.equal(second.result.items.length, 10)
  assert.equal(second.result.nextCursor, undefined)
  assert.equal(taskRequests(orbit)[3]?.get('cursor'), '150')
})

test('stops after five requests and says how to go on', async () => {
  const done = Array.from({ length: 400 }, (_value, index) =>
    task({ id: `done-${index}`, number: 100 + index, status_id: 'eng-done' })
  )
  const { orbit, source } = setup({ tasks: done })
  const { result } = await source.list()
  assert.equal(taskRequests(orbit).length, 5)
  assert.deepEqual(result.items, [])
  assert.equal(result.nextCursor, '250')
  assert.equal(result.notice, 'None of the last 250 tasks match the filters. Load more to keep looking.')
  assert.deepEqual(checkListResult(result), [])
})

test('asks for each lookup once', async () => {
  const { orbit, source } = setup()
  await source.list()
  await source.list({ filters: { assignee: 'all' } })
  const count = (path: string): number => orbit.requests.filter((request) => request.startsWith(path)).length
  assert.equal(orbit.requests.filter((request) => request === '/workspaces/ws-1/projects').length, 1)
  assert.equal(count('/workspaces/ws-1/views'), 1)
  assert.equal(count('/workspaces/ws-1/members'), 1)
  assert.equal(count('/workspaces/ws-1/projects/project-eng/statuses'), 1)
  assert.equal(count('/workspaces/ws-1/projects/project-eng/labels'), 1)
  // Operations tasks have no labels, so its labels are never asked for.
  assert.equal(count('/workspaces/ws-1/projects/project-ops/labels'), 0)
})

test('gets a task with its sub-issues, relations and comments', async () => {
  const { source } = setup()
  const { detail, extra } = await source.get({ itemId: 'task-1' })
  assert.equal(detail.item.title, 'ENG-12 · Fix login')
  assert.equal(extra.projectKey, 'ENG')
  assert.equal(
    detail.bodyMarkdown,
    [
      'Users cannot sign in with **SSO**.\n\nSteps:\n1. Open the app',
      '## Sub-issues\n\n- ENG-16 · Add a retry to the client (Todo)',
      '## Relations\n\n- Blocks ENG-15 · Review the API limits',
      '## Comments\n\n**Ana** · 2026-11-19 10:00 UTC\n\nI can reproduce this.'
    ].join('\n\n')
  )
  assert.deepEqual(checkDetail(detail), [])
})

test('gets a done task without a start recipe, and a bare one without extra sections', async () => {
  const { source } = setup()
  const done = await source.get({ itemId: 'task-3' })
  assert.equal(done.detail.item.start, undefined)
  assert.equal(done.detail.item.startBlockedReason, 'This task is done.')
  assert.equal(done.detail.bodyMarkdown, '_No description._')
  assert.deepEqual(checkDetail(done.detail), [])
})

test('shows only the latest comments and keeps the body within what Orca draws', async () => {
  const comments = Array.from({ length: 12 }, (_value, index) => ({
    id: `comment-${index}`,
    author_id: null,
    author_service_account: { id: 'sa-1', name: 'CI *bot*' },
    body: `Comment ${index} ${'z'.repeat(3000)}`,
    created_at: '2026-11-19T10:00:00.000Z'
  }))
  const tasks = [task({ id: 'task-1', number: 12, description: 'é'.repeat(40_000) })]
  const { source } = setup({ tasks, comments: { 'task-1': comments }, relations: {} })
  const { detail } = await source.get({ itemId: 'task-1' })
  const body = detail.bodyMarkdown ?? ''
  assert.ok(new TextEncoder().encode(body).length <= 60_000)
  assert.match(body, /_The text is cut here\. Open the task in Orbit for the rest: https:\/\/orbit\.test/)
  assert.deepEqual(checkDetail(detail), [])

  const short = setup({ tasks: [task({ id: 'task-1', number: 12 })], comments: { 'task-1': comments }, relations: {} })
  const shortBody = (await short.source.get({ itemId: 'task-1' })).detail.bodyMarkdown ?? ''
  assert.match(shortBody, /## Latest comments \(5 of 12\)/)
  assert.match(shortBody, /\*\*CI \\\*bot\\\*\*\*/)
  assert.ok(!shortBody.includes('Comment 6 ') && shortBody.includes('Comment 7 '))
})

test('still shows the task when an extra section fails', async () => {
  const { orbit } = setup()
  const fetch = orbit.fetch
  const client = new OrbitClient({
    baseUrl: BASE_URL,
    token: TOKEN,
    sleep: async () => {},
    fetch: async (url, init) =>
      url.includes('/comments')
        ? { status: 500, headers: { get: () => null }, text: async () => '{"code":"internal_error"}' }
        : fetch(url, init)
  })
  const failing = new OrbitTaskSource({
    client,
    lookups: new Lookups(client, 'ws-1'),
    me: orbit.data.me,
    settings
  })
  const { detail } = await failing.get({ itemId: 'task-1' })
  assert.match(detail.bodyMarkdown ?? '', /## Relations/)
  assert.ok(!(detail.bodyMarkdown ?? '').includes('## Comments'))
})

test('fails clearly for a task the token cannot see', async () => {
  const { source } = setup()
  await assert.rejects(
    source.get({ itemId: 'task-unknown' }),
    (error) => error instanceof OrbitError && error.kind === 'not_found'
  )
})
