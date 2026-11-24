// The task source: `list` and `get` over the Orbit API, answering in the task source contract.
import { OrbitError, type OrbitClient, type QueryParams } from './client'
import { LIMITS } from './contract'
import type { Lookups } from './lookups'
import { clip, clipBytes, extraOf, isDone, mapTask, type MapContext } from './mapping'
import type {
  ItemExtra,
  OrbitComment,
  OrbitMe,
  OrbitProject,
  OrbitRelation,
  OrbitStatus,
  OrbitTask,
  TaskDetail,
  TaskFilter,
  TaskFilterOption,
  TaskGetParams,
  TaskListParams,
  TaskListResult
} from './types'

/** Tasks asked from Orbit per request. */
const PAGE_SIZE = 50
/** `list` keeps asking for pages until it has this many items... */
const TARGET_ITEMS = 25
/** ...or has made this many requests; the person then loads more. */
const MAX_PAGES_PER_LIST = 5
const BODY_MAX_CHARS = 32_000
/** Orca draws at most 64 KiB of Markdown. */
const BODY_MAX_BYTES = 60_000
const DESCRIPTION_MAX_CHARS = 24_000
const COMMENT_MAX_CHARS = 2_000
const LATEST_COMMENTS = 5

const BUILT_IN_VIEW = 'tasks'
const ALL = 'all'
const CATEGORY_FILTERS: Record<string, (category: string | undefined) => boolean> = {
  open: (category) => !isDone(category),
  unstarted: (category) => category === 'unstarted',
  started: (category) => category === 'started',
  done: (category) => isDone(category)
}
const PRIORITIES = ['urgent', 'high', 'medium', 'low', 'none']

export type SourceSettings = {
  /** Show completed, cancelled and duplicate tasks by default. */
  includeDone: boolean
  promptTemplate: string
  agent: string
}

/** Where tasks of an Orbit project start, by Orbit project key. */
export type StartTargets = Record<string, { projectPath?: string; baseRef?: string }>

export type SourceOptions = {
  client: OrbitClient
  lookups: Lookups
  me: OrbitMe
  settings: SourceSettings
  targets?: StartTargets
}

export type ListAnswer = { result: TaskListResult; extra: Record<string, ItemExtra> }
export type GetAnswer = { detail: TaskDetail; extra: ItemExtra }

function escapeMarkdown(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/([\\`*_{}[\]<>|#])/g, '\\$1')
}

function cut(text: string, max: number, url: string | undefined): string {
  if (text.length <= max) return text
  const where = url ? ` Open the task in Orbit for the rest: ${url}` : ''
  return `${text.slice(0, max)}\n\n_The text is cut here.${where}_`
}

function isCancelled(error: unknown): boolean {
  return error instanceof OrbitError && error.kind === 'cancelled'
}

async function inBatches<T>(items: readonly T[], size: number, run: (item: T) => Promise<unknown>): Promise<void> {
  for (let index = 0; index < items.length; index += size) {
    await Promise.all(items.slice(index, index + size).map(run))
  }
}

type Selection = {
  view: string
  project: string
  status: string
  assignee: string
  priority: string
}

export class OrbitTaskSource {
  readonly #client: OrbitClient
  readonly #lookups: Lookups
  readonly #me: OrbitMe
  readonly #settings: SourceSettings
  readonly #targets: StartTargets

  constructor(options: SourceOptions) {
    this.#client = options.client
    this.#lookups = options.lookups
    this.#me = options.me
    this.#settings = options.settings
    this.#targets = options.targets ?? {}
  }

  async list(params: TaskListParams = {}, signal?: AbortSignal): Promise<ListAnswer> {
    const [projects, views] = await Promise.all([
      this.#lookups.projects(signal),
      this.#lookups.views(signal)
    ])
    const asked = params.filters ?? {}
    const viewOptions: TaskFilterOption[] = [
      { value: BUILT_IN_VIEW, label: 'Tasks' },
      ...(views ?? []).map((view) => ({
        value: `view:${view.id}`,
        label: clip(view.name || 'Untitled view', LIMITS.optionLabel)
      }))
    ].slice(0, LIMITS.filterOptions)
    const projectOptions: TaskFilterOption[] = [
      { value: ALL, label: 'All projects' },
      ...projects.map((project) => ({
        value: project.id,
        label: clip(`${project.key} · ${project.name}`, LIMITS.optionLabel)
      }))
    ].slice(0, LIMITS.filterOptions)

    const pick = (id: string, options: readonly TaskFilterOption[], fallback: string): string =>
      options.some((option) => option.value === asked[id]) ? asked[id]! : fallback

    const view = pick('view', viewOptions, BUILT_IN_VIEW)
    const savedView = view !== BUILT_IN_VIEW
    const project = pick('project', projectOptions, ALL)

    const projectStatuses = project === ALL ? [] : await this.#lookups.statuses(project, signal)
    const statusOptions: TaskFilterOption[] = [
      { value: 'open', label: 'Open' },
      { value: 'unstarted', label: 'Not started' },
      { value: 'started', label: 'Started' },
      { value: 'done', label: 'Done' },
      { value: ALL, label: 'All statuses' },
      ...projectStatuses.map((status) => ({
        value: `status:${status.id}`,
        label: clip(status.name, LIMITS.optionLabel)
      }))
    ].slice(0, LIMITS.filterOptions)
    // A saved view brings its own status and assignee filter, so the defaults stay out of its way.
    const statusDefault = savedView || this.#settings.includeDone ? ALL : 'open'
    const status = pick('status', statusOptions, statusDefault)

    const myId = this.#me.user?.id
    const assigneeOptions: TaskFilterOption[] = [
      ...(myId ? [{ value: 'me', label: 'Me' }] : []),
      { value: 'none', label: 'Unassigned' },
      { value: ALL, label: 'Everyone' }
    ]
    const assigneeDefault = savedView || !myId ? ALL : 'me'
    const assignee = pick('assignee', assigneeOptions, assigneeDefault)

    const priorityOptions: TaskFilterOption[] = [
      { value: ALL, label: 'Any priority' },
      ...PRIORITIES.map((priority) => ({
        value: priority,
        label: priority === 'none' ? 'No priority' : priority.charAt(0).toUpperCase() + priority.slice(1)
      }))
    ]
    const priority = pick('priority', priorityOptions, ALL)

    const filters: TaskFilter[] = [
      ...(views && views.length > 0
        ? [{ id: 'view', label: 'View', options: viewOptions, defaultValue: BUILT_IN_VIEW }]
        : []),
      { id: 'project', label: 'Project', options: projectOptions, defaultValue: ALL },
      { id: 'status', label: 'Status', options: statusOptions, defaultValue: statusDefault },
      { id: 'assignee', label: 'Assignee', options: assigneeOptions, defaultValue: assigneeDefault },
      { id: 'priority', label: 'Priority', options: priorityOptions, defaultValue: ALL }
    ]

    const selection: Selection = { view, project, status, assignee, priority }
    const query = this.#query(selection, params.query ?? '')
    const keep = CATEGORY_FILTERS[status]

    const items: TaskListResult['items'] = []
    const extra: Record<string, ItemExtra> = {}
    let cursor = params.cursor
    let scanned = 0
    for (let pageNumber = 0; pageNumber < MAX_PAGES_PER_LIST; pageNumber += 1) {
      const page = await this.#client.page<OrbitTask>(
        this.#lookups.path('/tasks'),
        { ...query, limit: PAGE_SIZE, cursor },
        signal
      )
      scanned += page.items.length
      const contexts = await this.#contexts(page.items, projects, signal)
      for (const task of page.items) {
        const context = contexts.get(task.project_id)
        if (!context) continue
        const category = context.statuses.find((candidate) => candidate.id === task.status_id)?.category
        if (keep && !keep(category)) continue
        items.push(mapTask(task, context))
        extra[task.id] = extraOf(task, context.project)
      }
      cursor = page.next_cursor ?? undefined
      if (!cursor || items.length >= TARGET_ITEMS) break
    }

    const result: TaskListResult = { items: items.slice(0, LIMITS.items), filters }
    // The contract caps a cursor; a longer one cannot be passed back, so the list ends there.
    if (cursor && cursor.length <= LIMITS.cursor) result.nextCursor = cursor
    if (cursor && items.length === 0) {
      result.notice = `None of the last ${scanned} tasks match the filters. Load more to keep looking.`
    }
    return { result, extra }
  }

  async get(params: TaskGetParams, signal?: AbortSignal): Promise<GetAnswer> {
    const taskPath = this.#lookups.path(`/tasks/${encodeURIComponent(params.itemId)}`)
    const [task, projects] = await Promise.all([
      this.#client.get<OrbitTask>(taskPath, {}, signal),
      this.#lookups.projects(signal)
    ])
    const contexts = await this.#contexts([task], projects, signal)
    const context = contexts.get(task.project_id)
    if (!context) {
      throw new OrbitError('not_found', 'The task is in a project the API token does not include.')
    }
    const item = mapTask(task, context)

    // The extra sections are optional: one that fails is left out, the task still shows.
    const optional = async <T>(load: Promise<T>): Promise<T | undefined> => {
      try {
        return await load
      } catch (error) {
        if (isCancelled(error)) throw error
        return undefined
      }
    }
    const [subIssues, relations, comments] = await Promise.all([
      optional(
        this.#client.page<OrbitTask>(
          this.#lookups.path('/tasks'),
          { parent_task_id: task.id, limit: PAGE_SIZE },
          signal
        )
      ),
      optional(this.#client.page<OrbitRelation>(`${taskPath}/relations`, {}, signal)),
      optional(
        this.#client.all<OrbitComment>(`${taskPath}/comments`, {}, signal, { pageSize: 100, maxPages: 3 })
      )
    ])

    const sections: string[] = []
    const description = (task.description ?? '').trim()
    sections.push(description ? cut(description, DESCRIPTION_MAX_CHARS, item.url) : '_No description._')

    if (subIssues && subIssues.items.length > 0) {
      const subContexts = await optional(this.#contexts(subIssues.items, projects, signal))
      const lines = subIssues.items.map((sub) => {
        const subContext = subContexts?.get(sub.project_id)
        const name = subContext?.statuses.find((candidate) => candidate.id === sub.status_id)?.name
        const identifier = extraOf(sub, subContext?.project).identifier
        return `- ${escapeMarkdown(identifier)} · ${escapeMarkdown(sub.title)}${name ? ` (${escapeMarkdown(name)})` : ''}`
      })
      if (subIssues.next_cursor) lines.push('- …and more')
      sections.push(`## Sub-issues\n\n${lines.join('\n')}`)
    }

    if (relations && relations.items.length > 0) {
      const lines = relations.items.map((relation) => {
        const other = relation.task
        const key = projects.find((candidate) => candidate.id === other.project_id)?.key
        const identifier = key ? `${key}-${other.number}` : `#${other.number}`
        return `- ${relationLabel(relation)} ${escapeMarkdown(identifier)} · ${escapeMarkdown(other.title ?? '')}`
      })
      sections.push(`## Relations\n\n${lines.join('\n')}`)
    }

    if (comments && comments.length > 0) {
      const latest = comments.slice(-LATEST_COMMENTS)
      const blocks = latest.map((comment) => {
        const author =
          comment.author_service_account?.name ??
          (comment.author_id ? context.members.get(comment.author_id) : undefined) ??
          'Someone'
        const when = (comment.created_at ?? '').slice(0, 16).replace('T', ' ')
        const body = cut((comment.body ?? '').trim(), COMMENT_MAX_CHARS, undefined)
        return `**${escapeMarkdown(author)}**${when ? ` · ${when} UTC` : ''}\n\n${body}`
      })
      const heading =
        comments.length > latest.length ? `## Latest comments (${latest.length} of ${comments.length})` : '## Comments'
      sections.push(`${heading}\n\n${blocks.join('\n\n---\n\n')}`)
    }

    const bodyMarkdown = clipBytes(
      cut(sections.join('\n\n'), BODY_MAX_CHARS, item.url),
      BODY_MAX_BYTES
    )
    return { detail: { item, bodyMarkdown }, extra: extraOf(task, context.project) }
  }

  #query(selection: Selection, text: string): QueryParams {
    const query: QueryParams = {}
    // Orbit takes up to 500 characters of search text.
    const q = text.trim().slice(0, 500)
    if (q) query.q = q
    if (selection.view === BUILT_IN_VIEW) {
      query.sort = 'updated_at'
      query.order = 'desc'
    } else {
      // Without `sort` and `order`, Orbit gives the view's own order.
      query.view_id = selection.view.slice('view:'.length)
    }
    if (selection.project !== ALL) query.project_id = selection.project
    if (selection.status.startsWith('status:')) query.status_id = selection.status.slice('status:'.length)
    if (selection.assignee === 'me') query.assignee_id = this.#me.user?.id
    if (selection.assignee === 'none') query.assignee_id = 'none'
    if (selection.priority !== ALL) query.priority = selection.priority
    return query
  }

  /** What `mapTask` needs for each project that `tasks` are in. */
  async #contexts(
    tasks: readonly OrbitTask[],
    projects: readonly OrbitProject[],
    signal?: AbortSignal
  ): Promise<Map<string, MapContext>> {
    const projectIds = [...new Set(tasks.map((task) => task.project_id))]
    const withLabels = new Set(
      tasks.filter((task) => (task.label_ids ?? []).length > 0).map((task) => task.project_id)
    )
    const anyAssignee = tasks.some((task) => (task.assignee_ids ?? []).length > 0)
    const members = anyAssignee ? await this.#lookups.members(signal) : new Map<string, string>()
    const contexts = new Map<string, MapContext>()
    await inBatches(projectIds, 4, async (projectId) => {
      const [statuses, labels] = await Promise.all([
        this.#lookups.statuses(projectId, signal) as Promise<readonly OrbitStatus[]>,
        withLabels.has(projectId) ? this.#lookups.labels(projectId, signal) : new Map<string, string>()
      ])
      const project = projects.find((candidate) => candidate.id === projectId)
      contexts.set(projectId, {
        project,
        statuses,
        labels,
        members,
        promptTemplate: this.#settings.promptTemplate,
        agent: this.#settings.agent,
        target: project ? this.#targets[project.key] : undefined
      })
    })
    return contexts
  }
}

function relationLabel(relation: OrbitRelation): string {
  const outgoing = relation.direction === 'outgoing'
  if (relation.type === 'blocks') return outgoing ? 'Blocks' : 'Blocked by'
  if (relation.type === 'duplicate') return outgoing ? 'Duplicate of' : 'Duplicated by'
  return 'Related to'
}
