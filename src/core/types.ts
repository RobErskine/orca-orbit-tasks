// Two sets of types: the Orbit public API records this plugin reads, and the task source contract
// it answers with. The contract mirrors Orca's planned `contributes.taskSources` format
// (stablyai/orca#26282, src/shared/plugins/tasks/plugin-task-source.ts), so the same core can feed
// the Tasks page when that ships.

// --- Orbit public API (only the fields used; unknown fields are ignored) ---

export type OrbitNamed = { id: string; name: string }

export type OrbitMe = {
  token: {
    id: string
    name: string
    scopes: string[]
    project_ids: string[]
    expires_at: string | null
  }
  workspace: OrbitNamed
  /** `null` for a service-account token. */
  user: { id: string; email: string; display_name: string } | null
  service_account: OrbitNamed | null
}

export type OrbitProject = { id: string; name: string; key: string }

export type OrbitStatus = {
  id: string
  project_id: string
  name: string
  /** `unstarted`, `started`, `completed`, `cancelled` or `duplicate`. */
  category: string
  position: number
}

export type OrbitLabel = { id: string; project_id: string; name: string }

export type OrbitMember = { user_id: string; display_name: string }

export type OrbitTask = {
  id: string
  project_id: string
  number: number
  status_id: string
  title: string
  /** Markdown. */
  description: string
  /** `none`, `low`, `medium`, `high` or `urgent`. */
  priority: string
  assignee_ids: string[]
  label_ids: string[]
  updated_at: string
  completed_at: string | null
  parent_task_id: string | null
  /** The project key and the task number, such as `ENG-12`. */
  identifier: string
  /** The task's page in the Orbit web app. */
  url: string
  version: number
}

export type OrbitComment = {
  id: string
  author_id: string | null
  author_service_account: OrbitNamed | null
  /** Markdown. */
  body: string
  created_at: string
}

export type OrbitRelation = {
  id: string
  /** `blocks`, `related` or `duplicate`. */
  type: string
  /** `outgoing` when this task is the blocker or the duplicate. */
  direction: string
  task: { id: string; project_id: string; number: number; title: string; status_id: string }
}

export type OrbitView = { id: string; name: string }

export type OrbitList<T> = { items: T[]; next_cursor: string | null }

// --- Task source contract (stablyai/orca#26282) ---

export type TaskTone = 'open' | 'active' | 'blocked' | 'review' | 'done' | 'closed'

export type TaskStartRecipe = {
  workspaceName?: string
  agentPrompt?: string
  baseRef?: string
  projectPath?: string
  projectSource?: string
  sessionOptions?: { agent?: string; model?: string; effort?: string }
  linkMetadata?: Record<string, string>
}

export type TaskItem = {
  id: string
  title: string
  status?: { label: string; tone: TaskTone }
  priority?: string
  owner?: string
  labels?: string[]
  updatedAt?: string
  summary?: string
  url?: string
  /** Absent means the item cannot start a workspace. */
  start?: TaskStartRecipe
  startBlockedReason?: string
}

export type TaskFilterOption = { value: string; label: string; count?: number }

export type TaskFilter = {
  id: string
  label: string
  options: TaskFilterOption[]
  defaultValue?: string
}

export type TaskListParams = {
  query?: string
  filters?: Record<string, string>
  cursor?: string
}

export type TaskListResult = {
  items: TaskItem[]
  nextCursor?: string
  filters?: TaskFilter[]
  notice?: string
}

export type TaskGetParams = { itemId: string }

export type TaskDetail = { item: TaskItem; bodyMarkdown?: string }

// --- What the panel needs beside the contract ---

/** Facts about an item that the contract has no field for. */
export type ItemExtra = {
  /** `ENG-12`. */
  identifier: string
  /** The Orbit project key, `ENG`. Project mappings are stored by it. */
  projectKey: string
  projectName: string
}
