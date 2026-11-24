// The plugin's worker: every Orbit request and every Orca workspace call runs here, because the
// panel has no network. Orca starts it on the panel's first request and may stop it when idle,
// so nothing here must outlive a restart: the token is in Orca's secrets, the Orbit URL in its
// settings, and started workspaces and project choices in its storage.
import type { OrcaWorkerApi } from 'orca/worker'
import { normalizeBaseUrl, OrbitClient, OrbitError } from './core/client'
import { LIMITS } from './core/contract'
import { Lookups } from './core/lookups'
import { DEFAULT_PROMPT_TEMPLATE } from './core/mapping'
import { OrbitTaskSource, type SourceSettings } from './core/source'
import type { OrbitMe } from './core/types'
import type {
  ConnectionStatus,
  Failure,
  GetOutput,
  Links,
  ListInput,
  ListOutput,
  OrcaProject,
  StartInput,
  StartOutput,
  StartPlan,
  WorkspaceLink
} from './protocol'

const TOKEN = 'token'
const LINKS = 'links'
const TARGETS = 'targets'
/** Tasks whose started workspaces are remembered. */
const MAX_LINKED_TASKS = 300

/** The agents Orca can launch (host API 1.10); the Start form offers them. */
export const AGENTS = [
  'claude',
  'codex',
  'gemini',
  'cursor',
  'copilot',
  'opencode',
  'opencode2',
  'droid',
  'grok',
  'devin',
  'kiro',
  'pi',
  'qwen-code',
  'codebuddy',
  'qoder',
  'qoder-cn',
  'antigravity',
  'mimo-code',
  'omp',
  'prime-agent',
  'kimi',
  'muse',
  'zcode',
  'dsh',
  'jcode',
  'hermes'
]

type Session = { key: string; baseUrl: string; me: OrbitMe; client: OrbitClient; lookups: Lookups }
type Targets = Record<string, { projectRef: string; baseBranch: string }>
type Settings = SourceSettings & { baseUrl: string }

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `ssh:box::abc`: a project id is only unique on its host. */
function projectRef(project: { id: string; hostId: string | null }): string {
  return `${project.hostId ?? 'local'}::${project.id}`
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Unknown error'
}

export default function activate(orca: OrcaWorkerApi): void {
  let session: Promise<Session> | null = null
  let sessionKey = ''
  const starting = new Set<string>()

  async function readSettings(): Promise<Settings> {
    const all = await orca.settings.get()
    return {
      baseUrl: text(all.baseUrl).trim(),
      includeDone: all.includeDone === true,
      agent: text(all.defaultAgent, 'claude') || 'claude',
      promptTemplate: text(all.promptTemplate).trim() ? text(all.promptTemplate) : DEFAULT_PROMPT_TEMPLATE
    }
  }

  async function readToken(): Promise<string> {
    try {
      return ((await orca.secrets.get(TOKEN)) ?? '').trim()
    } catch {
      return ''
    }
  }

  async function secretStore(): Promise<ConnectionStatus['secretStore']> {
    try {
      return (await orca.host.call('secrets.protection')).status
    } catch {
      return 'unavailable'
    }
  }

  /** The connected session for the saved URL and token, opened once and reused until they change. */
  async function open(settings: Settings): Promise<Session | Failure> {
    const token = await readToken()
    if (!settings.baseUrl || !token) {
      return { ok: false, error: 'Connect to Orbit first.', needsConnection: true }
    }
    const key = `${settings.baseUrl}\n${token}`
    if (!session || sessionKey !== key) {
      sessionKey = key
      const opening = (async (): Promise<Session> => {
        const client = new OrbitClient({ baseUrl: settings.baseUrl, token })
        const me = await client.me()
        return { key, baseUrl: client.baseUrl, me, client, lookups: new Lookups(client, me.workspace.id) }
      })()
      session = opening
      opening.catch(() => {
        if (session === opening) session = null
      })
    }
    try {
      return await session
    } catch (error) {
      return failure(error)
    }
  }

  /** Expected failures become a message for the panel; anything else rejects the request. */
  function failure(error: unknown): Failure {
    if (error instanceof OrbitError) {
      return {
        ok: false,
        error: error.message,
        ...(error.kind === 'unauthorized' || error.kind === 'invalid_url' ? { needsConnection: true } : {})
      }
    }
    orca.log(`unexpected error: ${messageOf(error)}`)
    throw error
  }

  function statusOf(
    settings: Settings,
    hasToken: boolean,
    store: ConnectionStatus['secretStore'],
    opened: Session | Failure | null
  ): ConnectionStatus {
    const base = { baseUrl: settings.baseUrl, hasToken, secretStore: store }
    if (!opened || !settings.baseUrl || !hasToken) return { state: 'disconnected', ...base }
    if ('ok' in opened) return { state: 'error', ...base, error: opened.error }
    const { me } = opened
    const scopes = Array.isArray(me.token.scopes) ? me.token.scopes : []
    const canRead = scopes.includes('tasks:read') || scopes.includes('tasks:write')
    return {
      state: 'connected',
      ...base,
      baseUrl: opened.baseUrl,
      workspace: me.workspace.name,
      account: me.user?.display_name ?? me.service_account?.name ?? '',
      tokenName: me.token.name,
      expiresAt: me.token.expires_at ?? null,
      ...(canRead
        ? {}
        : { warning: 'This token cannot read tasks. Create one with Tasks: Read in Orbit.' })
    }
  }

  async function readLinks(): Promise<Links> {
    const stored = await orca.storage.get(LINKS)
    if (!isRecord(stored)) return {}
    const links: Links = {}
    for (const [taskId, value] of Object.entries(stored)) {
      if (!Array.isArray(value)) continue
      const entries = value.filter(
        (entry): entry is WorkspaceLink =>
          isRecord(entry) &&
          typeof entry.workspaceId === 'string' &&
          typeof entry.name === 'string' &&
          typeof entry.createdAt === 'number'
      )
      if (entries.length > 0) links[taskId] = entries
    }
    return links
  }

  async function writeLinks(links: Links): Promise<void> {
    const newest = (entries: WorkspaceLink[]): number => Math.max(...entries.map((entry) => entry.createdAt))
    const kept = Object.entries(links)
      .sort((a, b) => newest(b[1]) - newest(a[1]))
      .slice(0, MAX_LINKED_TASKS)
    const next = Object.fromEntries(kept)
    await orca.storage.set(LINKS, next)
    orca.panels.post('links.changed', { links: next })
  }

  async function readTargets(): Promise<Targets> {
    const stored = await orca.storage.get(TARGETS)
    if (!isRecord(stored)) return {}
    const targets: Targets = {}
    for (const [key, value] of Object.entries(stored)) {
      if (isRecord(value) && typeof value.projectRef === 'string') {
        targets[key] = { projectRef: value.projectRef, baseBranch: text(value.baseBranch) }
      }
    }
    return targets
  }

  async function gitProjects(): Promise<OrcaProject[]> {
    const { projects } = await orca.host.call('project.list')
    return projects
      .filter((project) => project.kind === 'git' && project.hidden !== true)
      .map((project) => ({
        ref: projectRef(project),
        id: project.id,
        name: project.name,
        hostId: project.hostId,
        path: project.path
      }))
  }

  function sourceFor(opened: Session, settings: Settings): OrbitTaskSource {
    return new OrbitTaskSource({
      client: opened.client,
      lookups: opened.lookups,
      me: opened.me,
      settings
    })
  }

  orca.panels.handle('connection.status', async () => {
    const [settings, store] = await Promise.all([readSettings(), secretStore()])
    const hasToken = (await readToken()) !== ''
    const opened = settings.baseUrl && hasToken ? await open(settings) : null
    return statusOf(settings, hasToken, store, opened)
  })

  orca.panels.handle('connection.save', async (input, { signal }) => {
    const [settings, store] = await Promise.all([readSettings(), secretStore()])
    const saved = await readToken()
    const typed = text(input?.token).trim()
    const token = typed || saved
    const draft = { ...settings, baseUrl: text(input?.baseUrl).trim() }
    const refuse = (error: string): ConnectionStatus => ({
      state: 'error',
      baseUrl: draft.baseUrl,
      hasToken: saved !== '',
      secretStore: store,
      error
    })
    if (!token) return refuse('Enter an API token.')
    if (typed && store === 'unavailable') {
      return refuse('Orca cannot keep the token: this computer has no key store for secrets.')
    }
    let client: OrbitClient
    let me: OrbitMe
    try {
      client = new OrbitClient({ baseUrl: draft.baseUrl, token })
      me = await client.me(signal)
    } catch (error) {
      if (error instanceof OrbitError) return refuse(error.message)
      throw error
    }
    // Saved only now: a URL or token that does not work never replaces one that does.
    await orca.settings.set('baseUrl', client.baseUrl)
    if (typed) await orca.secrets.set(TOKEN, typed)
    const opened: Session = {
      key: `${client.baseUrl}\n${token}`,
      baseUrl: client.baseUrl,
      me,
      client,
      lookups: new Lookups(client, me.workspace.id)
    }
    sessionKey = opened.key
    session = Promise.resolve(opened)
    return statusOf({ ...settings, baseUrl: client.baseUrl }, true, store, opened)
  })

  orca.panels.handle('connection.clear', async () => {
    await orca.secrets.delete(TOKEN)
    session = null
    sessionKey = ''
    const [settings, store] = await Promise.all([readSettings(), secretStore()])
    return statusOf(settings, false, store, null)
  })

  orca.panels.handle('tasks.list', async (input: ListInput, { signal }): Promise<ListOutput> => {
    const settings = await readSettings()
    const opened = await open(settings)
    if ('ok' in opened) return opened
    if (input?.refresh) opened.lookups.clear()
    try {
      const answer = await sourceFor(opened, settings).list(
        {
          query: text(input?.query).slice(0, 512),
          filters: isRecord(input?.filters) ? (input.filters as Record<string, string>) : {},
          ...(input?.cursor ? { cursor: input.cursor } : {})
        },
        signal
      )
      const all = await readLinks()
      const links: Links = {}
      for (const item of answer.result.items) {
        if (all[item.id]) links[item.id] = all[item.id]!
      }
      return { ok: true, ...answer, links }
    } catch (error) {
      return failure(error)
    }
  })

  orca.panels.handle('tasks.get', async (input, { signal }): Promise<GetOutput> => {
    const settings = await readSettings()
    const opened = await open(settings)
    if ('ok' in opened) return opened
    try {
      const answer = await sourceFor(opened, settings).get({ itemId: text(input?.itemId) }, signal)
      const links = (await readLinks())[answer.detail.item.id] ?? []
      return { ok: true, ...answer, links }
    } catch (error) {
      return failure(error)
    }
  })

  orca.panels.handle('start.plan', async (input, { signal }): Promise<StartPlan> => {
    const settings = await readSettings()
    const opened = await open(settings)
    if ('ok' in opened) return opened
    try {
      const { detail, extra } = await sourceFor(opened, settings).get(
        { itemId: text(input?.itemId) },
        signal
      )
      const recipe = detail.item.start
      if (!recipe) {
        return { ok: false, error: detail.item.startBlockedReason ?? 'This task cannot be started.' }
      }
      const projects = await gitProjects()
      if (projects.length === 0) {
        return {
          ok: false,
          error: 'Orca has no Git project to create a workspace in. Add the repository to Orca first.'
        }
      }
      const target = (await readTargets())[extra.projectKey]
      const remembered =
        target && projects.some((project) => project.ref === target.projectRef) ? target : null
      return {
        ok: true,
        itemId: detail.item.id,
        title: detail.item.title,
        extra,
        projects,
        remembered,
        workspaceName: recipe.workspaceName ?? '',
        agent: AGENTS.includes(settings.agent) ? settings.agent : 'claude',
        agents: AGENTS,
        prompt: recipe.agentPrompt ?? ''
      }
    } catch (error) {
      return failure(error)
    }
  })

  orca.panels.handle('start.run', async (input: StartInput): Promise<StartOutput> => {
    const itemId = text(input?.itemId)
    const name = text(input?.workspaceName).trim()
    const prompt = text(input?.prompt).trim()
    const agent = text(input?.agent).trim()
    const baseBranch = text(input?.baseBranch).trim()
    if (!itemId) return { ok: false, error: 'No task was chosen.' }
    if (!name) return { ok: false, error: 'Enter a workspace name.' }
    if (name.length > LIMITS.workspaceName) return { ok: false, error: 'The workspace name is too long.' }
    if (!agent) return { ok: false, error: 'Choose an agent.' }
    if (!prompt) return { ok: false, error: 'The prompt is empty.' }
    if (prompt.length > LIMITS.agentPrompt) {
      return { ok: false, error: `The prompt is longer than ${LIMITS.agentPrompt} characters.` }
    }
    if (starting.has(itemId)) {
      return { ok: false, error: 'A workspace for this task is already being created.' }
    }
    starting.add(itemId)
    try {
      const project = (await gitProjects()).find((candidate) => candidate.ref === input.projectRef)
      if (!project) return { ok: false, error: 'Choose the Orca project to create the workspace in.' }
      let created: { workspaceId: string }
      try {
        // No signal: once Orca has begun, the create must finish and be recorded even when the
        // panel stopped waiting.
        created = await orca.host.call('workspace.create', {
          projectId: project.id,
          ...(project.hostId ? { hostId: project.hostId } : {}),
          name,
          ...(baseBranch ? { baseBranch } : {}),
          agent,
          prompt,
          open: true
        })
      } catch (error) {
        return { ok: false, error: `Orca did not create the workspace: ${messageOf(error)}` }
      }
      const link: WorkspaceLink = { workspaceId: created.workspaceId, name, createdAt: Date.now() }
      const links = await readLinks()
      links[itemId] = [link, ...(links[itemId] ?? [])].slice(0, 10)
      await writeLinks(links)
      const projectKey = text(input.projectKey)
      if (input.remember === true && projectKey) {
        const targets = await readTargets()
        targets[projectKey] = { projectRef: project.ref, baseBranch }
        await orca.storage.set(TARGETS, targets)
      }
      return { ok: true, link }
    } finally {
      starting.delete(itemId)
    }
  })

  // A removed workspace no longer shows under its task.
  orca.events.on('workspace.removed', async (payload) => {
    const gone = new Set([payload.workspaceId, payload.workspaceListId].filter(Boolean))
    const links = await readLinks()
    let changed = false
    for (const [taskId, entries] of Object.entries(links)) {
      const kept = entries.filter((entry) => !gone.has(entry.workspaceId))
      if (kept.length === entries.length) continue
      changed = true
      if (kept.length > 0) links[taskId] = kept
      else delete links[taskId]
    }
    if (changed) await writeLinks(links)
  })
}
