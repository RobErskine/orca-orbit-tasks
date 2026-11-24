// A stand-in Orbit public API for the tests: sample records in the shapes of Orbit's OpenAPI
// document (PublicMe, PublicTask, PublicStatus, ...) and a `fetch` that answers the routes this
// plugin calls with Orbit's own filters, pages and problem documents. No test reaches a network.
import type { FetchLike, FetchResponse } from '../core/client'
import type {
  OrbitComment,
  OrbitLabel,
  OrbitMe,
  OrbitMember,
  OrbitProject,
  OrbitRelation,
  OrbitStatus,
  OrbitTask,
  OrbitView
} from '../core/types'

export const TOKEN = 'orb_test_token'
export const BASE_URL = 'https://orbit.test'
export const WORKSPACE = 'ws-1'
export const ME_ID = 'user-me'

export function sampleMe(): OrbitMe {
  return {
    token: {
      id: 'token-1',
      name: 'orca',
      scopes: ['tasks:read'],
      project_ids: ['project-eng', 'project-ops'],
      expires_at: '2027-01-01T00:00:00.000Z'
    },
    workspace: { id: WORKSPACE, name: 'Acme' },
    user: { id: ME_ID, email: 'dev@orbit.test', display_name: 'Dev' },
    service_account: null
  }
}

export const projects: OrbitProject[] = [
  { id: 'project-eng', name: 'Engineering', key: 'ENG' },
  { id: 'project-ops', name: 'Operations', key: 'OPS' }
]

function statusesOf(projectId: string, prefix: string): OrbitStatus[] {
  const rows: [string, string, string][] = [
    ['todo', 'Todo', 'unstarted'],
    ['doing', 'In progress', 'started'],
    ['done', 'Done', 'completed'],
    ['cancelled', 'Cancelled', 'cancelled'],
    ['duplicate', 'Duplicate', 'duplicate']
  ]
  return rows.map(([id, name, category], position) => ({
    id: `${prefix}-${id}`,
    project_id: projectId,
    name,
    category,
    position
  }))
}

export const statuses: Record<string, OrbitStatus[]> = {
  'project-eng': statusesOf('project-eng', 'eng'),
  'project-ops': statusesOf('project-ops', 'ops')
}

export const labels: Record<string, OrbitLabel[]> = {
  'project-eng': [
    { id: 'label-bug', project_id: 'project-eng', name: 'bug' },
    { id: 'label-api', project_id: 'project-eng', name: 'api' }
  ],
  'project-ops': []
}

export const members: OrbitMember[] = [
  { user_id: ME_ID, display_name: 'Dev' },
  { user_id: 'user-ana', display_name: 'Ana' }
]

export const views: OrbitView[] = [{ id: 'view-sprint', name: 'This sprint' }]

export function task(partial: Partial<OrbitTask> & { id: string; number: number }): OrbitTask {
  const projectId = partial.project_id ?? 'project-eng'
  const key = projects.find((project) => project.id === projectId)?.key ?? 'ENG'
  const prefix = key.toLowerCase()
  return {
    project_id: projectId,
    status_id: `${prefix}-todo`,
    title: `Task ${partial.number}`,
    description: '',
    priority: 'none',
    assignee_ids: [ME_ID],
    label_ids: [],
    updated_at: `2026-11-${String(10 + (partial.number % 18)).padStart(2, '0')}T09:30:00.000Z`,
    completed_at: null,
    parent_task_id: null,
    identifier: `${key}-${partial.number}`,
    url: `${BASE_URL}/tasks/${partial.id}?workspace=${WORKSPACE}`,
    version: 1,
    ...partial
  }
}

export function sampleTasks(): OrbitTask[] {
  return [
    task({
      id: 'task-1',
      number: 12,
      title: 'Fix login',
      description: 'Users cannot sign in with **SSO**.\n\nSteps:\n1. Open the app',
      priority: 'high',
      status_id: 'eng-doing',
      label_ids: ['label-bug', 'label-api'],
      updated_at: '2026-11-20T09:30:00.000Z'
    }),
    task({
      id: 'task-2',
      number: 13,
      title: 'Write the runbook',
      project_id: 'project-ops',
      assignee_ids: [],
      updated_at: '2026-11-19T09:30:00.000Z'
    }),
    task({
      id: 'task-3',
      number: 14,
      title: 'Old cleanup',
      status_id: 'eng-done',
      completed_at: '2026-11-01T00:00:00.000Z',
      updated_at: '2026-11-18T09:30:00.000Z'
    }),
    task({
      id: 'task-4',
      number: 15,
      title: 'Review the API limits',
      assignee_ids: ['user-ana'],
      priority: 'urgent',
      updated_at: '2026-11-17T09:30:00.000Z'
    }),
    task({
      id: 'task-5',
      number: 16,
      title: 'Add a retry to the client',
      parent_task_id: 'task-1',
      updated_at: '2026-11-16T09:30:00.000Z'
    })
  ]
}

export type FakeOrbitData = {
  me: OrbitMe
  tasks: OrbitTask[]
  views: OrbitView[] | null
  comments: Record<string, OrbitComment[]>
  relations: Record<string, OrbitRelation[]>
  /** Task ids a saved view shows, by view id. */
  viewTasks: Record<string, string[]>
}

export type FakeOrbit = {
  fetch: FetchLike
  /** Every request as `path?query`, without the API prefix. */
  requests: string[]
  data: FakeOrbitData
  /** Answers queued here are sent first, for the next requests, whatever they ask. */
  next: { status: number; body?: unknown; headers?: Record<string, string>; raw?: string }[]
}

function response(status: number, body: unknown, headers: Record<string, string> = {}, raw?: string): FetchResponse {
  const lower = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]))
  return {
    status,
    headers: { get: (name) => lower[name.toLowerCase()] ?? null },
    text: async () => raw ?? JSON.stringify(body)
  }
}

const PAGE_PARAMS = ['cursor', 'limit']
const TASK_PARAMS = [
  'project_id',
  'status_id',
  'assignee_id',
  'sort',
  'order',
  'label_id',
  'priority',
  'milestone_id',
  'cycle_id',
  'due_before',
  'due_after',
  'has_due_date',
  'parent_task_id',
  'q',
  'view_id',
  ...PAGE_PARAMS
]

/** The query parameters Orbit's OpenAPI document declares for a workspace route. */
function allowedParams(route: string): string[] {
  if (route === '/tasks') return TASK_PARAMS
  if (route === '/members' || /\/(statuses|labels|comments)$/.test(route)) return PAGE_PARAMS
  return []
}

export function problem(status: number, code: string, detail = 'Problem detail.'): unknown {
  return { type: `https://docs.orbit.dev/problems/${code}`, title: code, status, code, detail }
}

export function fakeOrbit(overrides: Partial<FakeOrbitData> = {}): FakeOrbit {
  const data: FakeOrbitData = {
    me: sampleMe(),
    tasks: sampleTasks(),
    views,
    comments: {
      'task-1': [
        {
          id: 'comment-1',
          author_id: 'user-ana',
          author_service_account: null,
          body: 'I can reproduce this.',
          created_at: '2026-11-19T10:00:00.000Z'
        }
      ]
    },
    relations: {
      'task-1': [
        {
          id: 'relation-1',
          type: 'blocks',
          direction: 'outgoing',
          task: { id: 'task-4', project_id: 'project-eng', number: 15, title: 'Review the API limits', status_id: 'eng-todo' }
        }
      ]
    },
    viewTasks: { 'view-sprint': ['task-3', 'task-4'] },
    ...overrides
  }
  const requests: string[] = []
  const next: FakeOrbit['next'] = []

  const page = <T>(items: T[], query: URLSearchParams): unknown => {
    const limit = Number(query.get('limit') ?? 50)
    const offset = Number(query.get('cursor') ?? 0)
    const end = offset + limit
    return { items: items.slice(offset, end), next_cursor: end < items.length ? String(end) : null }
  }

  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input)
    const prefix = '/api/public/v1'
    const path = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : url.pathname
    requests.push(`${path}${url.search}`)
    const queued = next.shift()
    if (queued) return response(queued.status, queued.body, queued.headers, queued.raw)
    if (init.headers.Authorization !== `Bearer ${TOKEN}`) {
      return response(401, problem(401, 'unauthorized'))
    }
    if (path === '/me') return response(200, data.me)
    const base = `/workspaces/${WORKSPACE}`
    if (!path.startsWith(base)) return response(404, problem(404, 'not_found'))
    const rest = path.slice(base.length)
    const query = url.searchParams
    // As Orbit does: a query parameter the route does not declare is refused.
    const declared = allowedParams(rest)
    const asked: string[] = []
    query.forEach((_value, key) => asked.push(key))
    const unknown = asked.find((key) => !declared.includes(key))
    if (unknown) return response(400, problem(400, 'invalid_request', `unknown field \`${unknown}\``))
    if (rest === '/projects') return response(200, page(projects, query))
    if (rest === '/members') return response(200, page(members, query))
    if (rest === '/views') {
      if (data.views === null) return response(404, problem(404, 'route_not_found'))
      return response(200, page(data.views, query))
    }
    const lookup = /^\/projects\/([^/]+)\/(statuses|labels)$/.exec(rest)
    if (lookup) {
      const rows = (lookup[2] === 'statuses' ? statuses : labels)[lookup[1]!]
      return rows ? response(200, page(rows as unknown[], query)) : response(404, problem(404, 'not_found'))
    }
    if (rest === '/tasks') {
      let rows = data.tasks.slice()
      const viewId = query.get('view_id')
      if (viewId) {
        const ids = data.viewTasks[viewId]
        if (!ids) return response(404, problem(404, 'not_found'))
        rows = ids.map((id) => rows.find((row) => row.id === id)).filter((row): row is OrbitTask => Boolean(row))
      }
      const parent = query.get('parent_task_id')
      if (parent) rows = rows.filter((row) => row.parent_task_id === parent)
      const projectId = query.get('project_id')
      if (projectId) rows = rows.filter((row) => row.project_id === projectId)
      const statusId = query.get('status_id')
      if (statusId) rows = rows.filter((row) => row.status_id === statusId)
      const assignee = query.get('assignee_id')
      if (assignee === 'none') rows = rows.filter((row) => row.assignee_ids.length === 0)
      else if (assignee) rows = rows.filter((row) => row.assignee_ids.includes(assignee))
      const priority = query.get('priority')
      if (priority) rows = rows.filter((row) => row.priority === priority)
      const q = query.get('q')?.toLowerCase()
      if (q) {
        rows = rows.filter(
          (row) =>
            row.title.toLowerCase().includes(q) ||
            row.description.toLowerCase().includes(q) ||
            row.identifier.toLowerCase() === q
        )
      }
      if (query.get('sort') === 'updated_at') {
        rows.sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      }
      return response(200, page(rows, query))
    }
    const single = /^\/tasks\/([^/]+)(\/comments|\/relations)?$/.exec(rest)
    if (single) {
      const wanted = decodeURIComponent(single[1]!)
      const found = data.tasks.find(
        (row) => row.id === wanted || row.identifier.toLowerCase() === wanted.toLowerCase()
      )
      if (!found) return response(404, problem(404, 'not_found'))
      if (single[2] === '/comments') return response(200, page(data.comments[found.id] ?? [], query))
      if (single[2] === '/relations') {
        return response(200, { items: data.relations[found.id] ?? [], next_cursor: null })
      }
      return response(200, found)
    }
    return response(404, problem(404, 'route_not_found'))
  }

  return { fetch, requests, data, next }
}
