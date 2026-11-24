// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.
// The panel has no network, so every Orbit request and every Orca workspace call runs in the
// worker.
import type { ItemExtra, TaskDetail, TaskListResult } from './core/types'

/** An expected failure, with a message to show. Unexpected ones reject the request. */
export type Failure = {
  ok: false
  error: string
  /** The person must connect (again) before anything else works. */
  needsConnection?: boolean
}

export type ConnectionStatus = {
  state: 'disconnected' | 'connected' | 'error'
  /** The saved Orbit URL; empty when none is saved. */
  baseUrl: string
  hasToken: boolean
  /** `unavailable`: this computer has no key store, so Orca cannot keep the token. */
  secretStore: 'os-keyring' | 'unavailable'
  workspace?: string
  /** The token's creator, or the service account's name. */
  account?: string
  tokenName?: string
  expiresAt?: string | null
  /** Why `state` is `error`. */
  error?: string
  /** Connected, but something limits the plugin (for example a missing scope). */
  warning?: string
}

/** An Orca workspace started from a task. */
export type WorkspaceLink = {
  workspaceId: string
  name: string
  /** Milliseconds since the epoch. */
  createdAt: number
}
export type Links = Record<string, WorkspaceLink[]>

export type ListInput = {
  query: string
  filters: Record<string, string>
  cursor?: string
  /** Drop the cached projects, statuses, labels, members and views first. */
  refresh?: boolean
}
export type ListOutput =
  | { ok: true; result: TaskListResult; extra: Record<string, ItemExtra>; links: Links }
  | Failure

export type GetOutput =
  | { ok: true; detail: TaskDetail; extra: ItemExtra; links: WorkspaceLink[] }
  | Failure

/** A Git project in Orca that a workspace can be created in. `ref` names it across hosts. */
export type OrcaProject = {
  ref: string
  id: string
  name: string
  hostId: string | null
  path: string
}

export type StartPlan =
  | {
      ok: true
      itemId: string
      title: string
      extra: ItemExtra
      projects: OrcaProject[]
      /** The Orca project and base branch remembered for this Orbit project. */
      remembered: { projectRef: string; baseBranch: string } | null
      workspaceName: string
      agent: string
      agents: string[]
      prompt: string
    }
  | Failure

export type StartInput = {
  itemId: string
  /** The Orbit project key, to remember the choice under. */
  projectKey: string
  /** An `OrcaProject.ref` from the plan. */
  projectRef: string
  /** Empty: the project's default base branch. */
  baseBranch: string
  workspaceName: string
  agent: string
  prompt: string
  /** Use this Orca project and base branch for the Orbit project's tasks from now on. */
  remember: boolean
}
export type StartOutput = { ok: true; link: WorkspaceLink } | Failure

declare module 'orca' {
  interface PluginRequests {
    'connection.status': { output: ConnectionStatus }
    /** Tests the URL and token against Orbit and saves them when they work. Without `token`,
     *  the saved token is kept. */
    'connection.save': { input: { baseUrl: string; token?: string }; output: ConnectionStatus }
    /** Forgets the token. */
    'connection.clear': { output: ConnectionStatus }
    'tasks.list': { input: ListInput; output: ListOutput }
    'tasks.get': { input: { itemId: string }; output: GetOutput }
    /** What the Start form shows for a task; nothing is created. */
    'start.plan': { input: { itemId: string }; output: StartPlan }
    /** Creates the workspace and sends the prompt to the agent. */
    'start.run': { input: StartInput; output: StartOutput }
  }
  interface PluginPanelEvents {
    /** The workspaces started from tasks changed (one was started or removed). */
    'links.changed': { links: Links }
  }
}
