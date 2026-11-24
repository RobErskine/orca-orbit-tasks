// The Orbit Tasks panel. No build step: Orca strips the types and compiles the JSX when the panel
// loads. The panel has no network, so it asks src/worker.ts for everything (src/protocol.ts).
import {
  atom,
  Badge,
  Button,
  Callout,
  Checkbox,
  Collapsible,
  EmptyState,
  Heading,
  IconButton,
  Input,
  KeyValue,
  Link,
  List,
  ListItem,
  Markdown,
  plugin,
  read,
  RelativeTime,
  Row,
  Select,
  Separator,
  set,
  Spinner,
  Stack,
  Text,
  Textarea,
  update,
  type OrcaNode,
  type PanelContext,
  type Tone
} from 'orca'
import type { ItemExtra, TaskDetail, TaskFilter, TaskItem, TaskTone } from './core/types'
import type { ConnectionStatus, Links, StartPlan, WorkspaceLink } from './protocol'

/** Rows the list draws; older pages stay reachable by narrowing the filters. */
const MAX_ROWS = 300
/** Creating a workspace runs the project's setup, which can take a while. */
const START_TIMEOUT_MS = 120_000
const LIST_TIMEOUT_MS = 60_000

type Screen = 'boot' | 'connect' | 'list' | 'detail' | 'start'

type ListState = {
  loading: boolean
  loadingMore: boolean
  loaded: boolean
  items: TaskItem[]
  extra: Record<string, ItemExtra>
  filters: TaskFilter[]
  nextCursor: string | null
  notice: string
  error: string
}

type DetailState = {
  itemId: string
  title: string
  loading: boolean
  error: string
  detail: TaskDetail | null
  extra: ItemExtra | null
}

type StartState = {
  itemId: string
  title: string
  loading: boolean
  error: string
  plan: Extract<StartPlan, { ok: true }> | null
  projectRef: string
  baseBranch: string
  workspaceName: string
  agent: string
  prompt: string
  remember: boolean
  running: boolean
  done: WorkspaceLink | null
}

const screen = atom<Screen>('boot')
const connection = atom<ConnectionStatus | null>(null)
const bootError = atom('')

const formUrl = atom('')
const formToken = atom('')
const connecting = atom(false)
const connectError = atom('')

/** The search text and filter choices come back as the person left them. */
const query = atom('query', '', { persist: 'plugin' })
const chosen = atom<Record<string, string>>('filters', {}, { persist: 'plugin' })

const emptyList: ListState = {
  loading: false,
  loadingMore: false,
  loaded: false,
  items: [],
  extra: {},
  filters: [],
  nextCursor: null,
  notice: '',
  error: ''
}
const list = atom<ListState>(emptyList)
const links = atom<Links>({})
const detail = atom<DetailState | null>(null)
const start = atom<StartState | null>(null)

// Answers of an older request must not replace those of a newer one.
let listRun = 0
let detailRun = 0

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Something went wrong.'
}

function toneOf(tone: TaskTone): Tone {
  if (tone === 'active') return 'accent'
  if (tone === 'blocked') return 'danger'
  if (tone === 'review') return 'warning'
  if (tone === 'done') return 'success'
  return 'neutral'
}

function priorityTone(priority: string): Tone {
  if (priority === 'Urgent') return 'danger'
  if (priority === 'High') return 'warning'
  return 'neutral'
}

function short(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

function timeOf(iso: string | undefined): number | null {
  const at = iso ? Date.parse(iso) : Number.NaN
  return Number.isFinite(at) ? at : null
}

/** The option a filter shows: the person's choice while Orbit still offers it, else its default. */
function valueOf(filter: TaskFilter, choices: Record<string, string>): string {
  const choice = choices[filter.id]
  if (choice !== undefined && filter.options.some((option) => option.value === choice)) return choice
  return filter.defaultValue ?? filter.options[0]?.value ?? ''
}

async function showConnect(error = ''): Promise<void> {
  const status = read(connection)
  set(formUrl, status?.baseUrl ?? '')
  set(formToken, '')
  set(connectError, error)
  set(screen, 'connect')
}

async function boot(): Promise<void> {
  set(bootError, '')
  try {
    const status = await plugin.request('connection.status')
    set(connection, status)
    if (status.state === 'connected') {
      set(screen, 'list')
      await loadList()
    } else {
      await showConnect(status.state === 'error' ? (status.error ?? '') : '')
    }
  } catch (error) {
    set(bootError, messageOf(error))
  }
}

async function connect(): Promise<void> {
  if (read(connecting)) return
  set(connecting, true)
  set(connectError, '')
  try {
    const token = read(formToken).trim()
    const status = await plugin.request('connection.save', {
      baseUrl: read(formUrl),
      ...(token ? { token } : {})
    })
    if (status.state === 'connected') {
      set(connection, status)
      set(formToken, '')
      set(list, emptyList)
      set(screen, 'list')
      await loadList({ refresh: true })
    } else {
      set(connectError, status.error ?? 'Could not connect to Orbit.')
    }
  } catch (error) {
    set(connectError, messageOf(error))
  } finally {
    set(connecting, false)
  }
}

async function forgetToken(): Promise<void> {
  try {
    set(connection, await plugin.request('connection.clear'))
    set(list, emptyList)
    await showConnect()
  } catch (error) {
    set(connectError, messageOf(error))
  }
}

async function loadList(options: { more?: boolean; refresh?: boolean } = {}): Promise<void> {
  const before = read(list)
  const cursor = options.more ? before.nextCursor : null
  if (options.more && !cursor) return
  const run = ++listRun
  set(list, { ...before, loading: !options.more, loadingMore: options.more === true, error: '' })
  const fail = (error: string): void => {
    if (run !== listRun) return
    set(list, { ...read(list), loading: false, loadingMore: false, loaded: true, error })
  }
  try {
    const answer = await plugin.request(
      'tasks.list',
      {
        query: read(query),
        filters: read(chosen),
        ...(cursor ? { cursor } : {}),
        ...(options.refresh ? { refresh: true } : {})
      },
      { timeoutMs: LIST_TIMEOUT_MS }
    )
    if (run !== listRun) return
    if (!answer.ok) {
      if (answer.needsConnection) {
        set(list, emptyList)
        await showConnect(answer.error)
        return
      }
      fail(answer.error)
      return
    }
    const known = new Set(options.more ? before.items.map((item) => item.id) : [])
    const added = answer.result.items.filter((item) => !known.has(item.id))
    set(list, {
      loading: false,
      loadingMore: false,
      loaded: true,
      items: options.more ? [...before.items, ...added] : added,
      extra: options.more ? { ...before.extra, ...answer.extra } : answer.extra,
      filters: answer.result.filters ?? [],
      nextCursor: answer.result.nextCursor ?? null,
      notice: answer.result.notice ?? '',
      error: ''
    })
    update(links, (previous) => ({ ...previous, ...answer.links }))
  } catch (error) {
    fail(messageOf(error))
  }
}

function choose(id: string, value: string): void {
  update(chosen, (previous) => {
    const next = { ...previous, [id]: value }
    // A saved view brings its own status and assignee filter; a project has its own statuses.
    if (id === 'view') {
      delete next.status
      delete next.assignee
    }
    if (id === 'project' && next.status?.startsWith('status:')) delete next.status
    return next
  })
  void loadList()
}

async function openDetail(item: TaskItem): Promise<void> {
  const run = ++detailRun
  set(detail, {
    itemId: item.id,
    title: item.title,
    loading: true,
    error: '',
    detail: null,
    extra: read(list).extra[item.id] ?? null
  })
  set(screen, 'detail')
  const finish = (patch: Partial<DetailState>): void => {
    const current = read(detail)
    if (run !== detailRun || !current) return
    set(detail, { ...current, loading: false, ...patch })
  }
  try {
    const answer = await plugin.request('tasks.get', { itemId: item.id })
    if (!answer.ok) {
      finish({ error: answer.error })
      return
    }
    finish({ detail: answer.detail, extra: answer.extra, title: answer.detail.item.title })
    update(links, (previous) => ({ ...previous, [item.id]: answer.links }))
  } catch (error) {
    finish({ error: messageOf(error) })
  }
}

async function openStart(itemId: string, title: string): Promise<void> {
  const blank: StartState = {
    itemId,
    title,
    loading: true,
    error: '',
    plan: null,
    projectRef: '',
    baseBranch: '',
    workspaceName: '',
    agent: '',
    prompt: '',
    remember: true,
    running: false,
    done: null
  }
  set(start, blank)
  set(screen, 'start')
  try {
    const plan = await plugin.request('start.plan', { itemId })
    if (read(start)?.itemId !== itemId) return
    if (!plan.ok) {
      set(start, { ...blank, loading: false, error: plan.error })
      return
    }
    const only = plan.projects.length === 1 ? plan.projects[0]!.ref : ''
    set(start, {
      ...blank,
      loading: false,
      plan,
      title: plan.title,
      projectRef: plan.remembered?.projectRef ?? only,
      baseBranch: plan.remembered?.baseBranch ?? '',
      workspaceName: plan.workspaceName,
      agent: plan.agent,
      prompt: plan.prompt
    })
  } catch (error) {
    if (read(start)?.itemId === itemId) set(start, { ...blank, loading: false, error: messageOf(error) })
  }
}

function editStart(patch: Partial<StartState>): void {
  update(start, (previous) => (previous ? { ...previous, ...patch } : previous))
}

async function runStart(): Promise<void> {
  const form = read(start)
  if (!form || !form.plan || form.running || form.done) return
  if (!form.projectRef) {
    editStart({ error: 'Choose the Orca project to create the workspace in.' })
    return
  }
  editStart({ running: true, error: '' })
  try {
    const answer = await plugin.request(
      'start.run',
      {
        itemId: form.itemId,
        projectKey: form.plan.extra.projectKey,
        projectRef: form.projectRef,
        baseBranch: form.baseBranch,
        workspaceName: form.workspaceName,
        agent: form.agent,
        prompt: form.prompt,
        remember: form.remember
      },
      { timeoutMs: START_TIMEOUT_MS }
    )
    if (answer.ok) editStart({ running: false, done: answer.link })
    else editStart({ running: false, error: answer.error })
  } catch (error) {
    const timedOut = (error as { code?: string } | null)?.code === 'timeout'
    editStart({
      running: false,
      error: timedOut
        ? 'Orca is still creating the workspace. It shows in the sidebar when it is ready.'
        : messageOf(error)
    })
  }
}

function backToList(): void {
  set(screen, 'list')
  if (!read(list).loaded) void loadList()
}

/** Runs once before the first render; what it pushes to `subscriptions` ends with the panel. */
export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(plugin.on('links.changed', (payload) => set(links, payload.links)))
  void boot()
}

function Badges({ item, started }: { item: TaskItem; started: boolean }): OrcaNode {
  return (
    <Row gap="xs" wrap>
      {item.status ? <Badge tone={toneOf(item.status.tone)}>{item.status.label}</Badge> : null}
      {item.priority ? <Badge tone={priorityTone(item.priority)}>{item.priority}</Badge> : null}
      {(item.labels ?? []).map((label) => (
        <Badge key={label}>{label}</Badge>
      ))}
      {started ? <Badge tone="accent">Workspace started</Badge> : null}
    </Row>
  )
}

function Meta({ item }: { item: TaskItem }): OrcaNode {
  const at = timeOf(item.updatedAt)
  if (!item.owner && at === null) return null
  return (
    <Text muted size="xs">
      {item.owner ? short(item.owner, 80) : 'Unassigned'}
      {at === null ? null : ' · updated '}
      {at === null ? null : <RelativeTime at={at} format="short" />}
    </Text>
  )
}

function ConnectScreen(): OrcaNode {
  const status = read(connection)
  const busy = read(connecting)
  const error = read(connectError)
  const connected = status?.state === 'connected'
  return (
    <Stack gap="md">
      <Heading level={2}>Connect to Orbit</Heading>
      {status?.secretStore === 'unavailable' ? (
        <Callout tone="danger" title="No key store">
          This computer has no key store, so Orca cannot keep an API token for this plugin.
        </Callout>
      ) : null}
      <Input
        label="Orbit URL"
        placeholder="https://orbit.example.com"
        value={read(formUrl)}
        maxLength={2048}
        onChange={(value) => set(formUrl, value)}
        onSubmit={() => void connect()}
      />
      <Input
        label="API token"
        type="password"
        placeholder={status?.hasToken ? 'Saved. Leave empty to keep it.' : 'orb_…'}
        value={read(formToken)}
        maxLength={512}
        onChange={(value) => set(formToken, value)}
        onSubmit={() => void connect()}
      />
      <Text muted size="xs">
        In Orbit, open Settings, then API tokens. Create a personal token with Tasks: Read, the
        projects you want here, and an expiry. Orca keeps it in your system's key store.
      </Text>
      {error ? (
        <Callout tone="danger" title="Could not connect">
          {error}
        </Callout>
      ) : null}
      <Row gap="xs" wrap>
        <Button disabled={busy} onPress={() => void connect()}>
          {busy ? 'Connecting…' : 'Connect'}
        </Button>
        {connected ? (
          <Button variant="ghost" onPress={backToList}>
            Cancel
          </Button>
        ) : null}
        {status?.hasToken ? (
          <Button variant="ghost" tone="danger" onPress={() => void forgetToken()}>
            Forget token
          </Button>
        ) : null}
      </Row>
      {connected ? (
        <KeyValue
          label="Connection"
          items={[
            { label: 'Workspace', value: status.workspace ?? '' },
            { label: 'Account', value: status.account ?? '' },
            { label: 'Token', value: status.tokenName ?? '' },
            { label: 'Expires', value: status.expiresAt ? status.expiresAt.slice(0, 10) : 'Never' }
          ]}
        />
      ) : null}
    </Stack>
  )
}

function ListScreen(): OrcaNode {
  const status = read(connection)
  const state = read(list)
  const choices = read(chosen)
  const started = read(links)
  const rows = state.items.slice(0, MAX_ROWS)
  const active = state.filters
    .filter((filter) => filter.id !== 'priority' || valueOf(filter, choices) !== 'all')
    .map((filter) => filter.options.find((option) => option.value === valueOf(filter, choices))?.label)
    .filter(Boolean)
    .join(' · ')
  return (
    <Stack gap="md">
      <Row justify="between" align="center">
        <Heading level={2}>{short(status?.workspace || 'Orbit', 60)}</Heading>
        <Row gap="xs">
          <IconButton
            icon="refresh"
            label="Refresh"
            variant="ghost"
            disabled={state.loading}
            onPress={() => void loadList({ refresh: true })}
          />
          <IconButton
            icon="settings"
            label="Connection"
            variant="ghost"
            onPress={() => void showConnect()}
          />
        </Row>
      </Row>
      {status?.warning ? <Callout tone="warning">{status.warning}</Callout> : null}
      <Input
        label="Search tasks"
        labelHidden
        type="search"
        placeholder="Search tasks, then press Enter"
        value={read(query)}
        maxLength={512}
        onChange={(value) => set(query, value)}
        onSubmit={() => void loadList()}
      />
      {state.filters.length > 0 ? (
        <Collapsible title="Filters" description={short(active, 200)}>
          <Stack gap="sm">
            {state.filters.map((filter) => (
              <Select
                key={filter.id}
                label={filter.label}
                value={valueOf(filter, choices)}
                options={filter.options.map((option) => ({ value: option.value, label: option.label }))}
                onChange={(value) => choose(filter.id, value)}
              />
            ))}
          </Stack>
        </Collapsible>
      ) : null}
      {state.error ? (
        <Callout tone="danger" title="Could not load tasks">
          {state.error}
        </Callout>
      ) : null}
      {state.notice ? <Callout tone="neutral">{state.notice}</Callout> : null}
      {state.loading ? <Spinner label="Loading tasks" /> : null}
      {!state.loading && state.loaded && !state.error && rows.length === 0 && !state.notice ? (
        <EmptyState
          icon="check"
          title="No tasks"
          description="No task matches the search and filters."
        />
      ) : null}
      {rows.length > 0 ? (
        <List label="Tasks">
          {rows.map((item) => (
            <ListItem key={item.id} title={short(item.title, 160)} onPress={() => void openDetail(item)}>
              <Stack gap="xs">
                <Badges item={item} started={(started[item.id] ?? []).length > 0} />
                <Meta item={item} />
              </Stack>
            </ListItem>
          ))}
        </List>
      ) : null}
      {state.items.length > MAX_ROWS ? (
        <Text muted size="xs">
          Showing the first {MAX_ROWS} tasks. Search or filter to find the others.
        </Text>
      ) : null}
      {state.nextCursor && state.items.length <= MAX_ROWS ? (
        <Button variant="outline" disabled={state.loadingMore} onPress={() => void loadList({ more: true })}>
          {state.loadingMore ? 'Loading…' : 'Load more'}
        </Button>
      ) : null}
    </Stack>
  )
}

function DetailScreen(): OrcaNode {
  const state = read(detail)
  if (!state) return null
  const item = state.detail?.item
  const started = read(links)[state.itemId] ?? []
  return (
    <Stack gap="md">
      <Row>
        <Button variant="ghost" size="sm" onPress={backToList}>
          Back to tasks
        </Button>
      </Row>
      <Heading level={2}>{short(state.title, 300)}</Heading>
      {state.loading ? <Spinner label="Loading task" /> : null}
      {state.error ? (
        <Callout tone="danger" title="Could not load the task">
          {state.error}
        </Callout>
      ) : null}
      {item ? (
        <Stack gap="md">
          <Badges item={item} started={false} />
          <Meta item={item} />
          <Row gap="sm" wrap align="center">
            <Button
              icon="play"
              disabled={!item.start}
              onPress={() => void openStart(item.id, item.title)}
            >
              Start workspace
            </Button>
            {item.url ? <Link href={item.url}>Open in Orbit</Link> : null}
          </Row>
          {item.startBlockedReason ? (
            <Text muted size="xs">
              {item.startBlockedReason}
            </Text>
          ) : null}
          {started.length > 0 ? (
            <Callout tone="accent" title="Workspaces started from this task">
              <Stack gap="xs">
                {started.map((link) => (
                  <Text key={link.workspaceId} size="sm">
                    {short(link.name, 120)} · <RelativeTime at={link.createdAt} format="long" />
                  </Text>
                ))}
              </Stack>
            </Callout>
          ) : null}
          <Separator />
          <Markdown content={state.detail?.bodyMarkdown || '_No description._'} />
        </Stack>
      ) : null}
    </Stack>
  )
}

function StartScreen(): OrcaNode {
  const form = read(start)
  if (!form) return null
  const plan = form.plan
  return (
    <Stack gap="md">
      <Row>
        <Button variant="ghost" size="sm" onPress={() => set(screen, read(detail) ? 'detail' : 'list')}>
          Back
        </Button>
      </Row>
      <Heading level={2}>Start workspace</Heading>
      <Text muted>{short(form.title, 300)}</Text>
      {form.loading ? <Spinner label="Preparing" /> : null}
      {form.done ? (
        <Stack gap="md">
          <Callout tone="success" title="Workspace started">
            Orca created {short(form.done.name, 120)} and sent the prompt to the agent.
          </Callout>
          <Row>
            <Button variant="outline" onPress={backToList}>
              Back to tasks
            </Button>
          </Row>
        </Stack>
      ) : null}
      {plan && !form.done ? (
        <Stack gap="md">
          <Callout tone="warning" title="Start runs at once">
            Orca creates the workspace and sends this prompt to the agent, which begins to work.
            Read the prompt first: the task description is part of it.
          </Callout>
          <Select
            label="Orca project"
            placeholder="Choose a project"
            value={form.projectRef}
            options={plan.projects.map((project) => ({
              value: project.ref,
              label: short(
                project.hostId && project.hostId !== 'local'
                  ? `${project.name} (${project.hostId})`
                  : project.name,
                120
              )
            }))}
            onChange={(value) => editStart({ projectRef: value })}
          />
          <Input
            label="Base branch"
            placeholder="The project's default branch"
            value={form.baseBranch}
            maxLength={512}
            onChange={(value) => editStart({ baseBranch: value })}
          />
          <Input
            label="Workspace name"
            value={form.workspaceName}
            maxLength={128}
            onChange={(value) => editStart({ workspaceName: value })}
          />
          <Select
            label="Agent"
            value={form.agent}
            options={plan.agents.map((agent) => ({ value: agent, label: agent }))}
            onChange={(value) => editStart({ agent: value })}
          />
          <Textarea
            label="Prompt"
            rows={14}
            value={form.prompt}
            maxLength={16384}
            onChange={(value) => editStart({ prompt: value })}
          />
          <Checkbox
            label={`Use this project and branch for ${plan.extra.projectKey} tasks`}
            checked={form.remember}
            onChange={(checked) => editStart({ remember: checked })}
          />
          {form.error ? (
            <Callout tone="danger" title="Not started">
              {form.error}
            </Callout>
          ) : null}
          <Row gap="xs">
            <Button icon="play" disabled={form.running} onPress={() => void runStart()}>
              {form.running ? 'Starting…' : 'Start'}
            </Button>
            <Button variant="ghost" disabled={form.running} onPress={() => set(screen, read(detail) ? 'detail' : 'list')}>
              Cancel
            </Button>
          </Row>
        </Stack>
      ) : null}
      {!plan && !form.loading && form.error ? (
        <Callout tone="danger" title="Cannot start">
          {form.error}
        </Callout>
      ) : null}
    </Stack>
  )
}

export default function Panel(): OrcaNode {
  const current = read(screen)
  if (current === 'connect') return <ConnectScreen />
  if (current === 'list') return <ListScreen />
  if (current === 'detail') return <DetailScreen />
  if (current === 'start') return <StartScreen />
  const error = read(bootError)
  if (error) {
    return (
      <Stack gap="md">
        <Callout tone="danger" title="Orbit Tasks could not start">
          {error}
        </Callout>
        <Row>
          <Button variant="outline" onPress={() => void boot()}>
            Try again
          </Button>
        </Row>
      </Stack>
    )
  }
  return <Spinner label="Loading Orbit Tasks" />
}
