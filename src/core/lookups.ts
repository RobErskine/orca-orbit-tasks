// A task carries only ids (status, labels, assignees, project). This cache turns them into names
// with few requests: each lookup is fetched once, shared by concurrent callers, and kept for
// five minutes.
import { OrbitError, type OrbitClient } from './client'
import type { OrbitLabel, OrbitMember, OrbitProject, OrbitStatus, OrbitView } from './types'

const TTL_MS = 5 * 60_000
/** For the routes that take `cursor` and `limit`; projects and views answer on one page. */
const PAGED = { pageSize: 100 }

type Entry<T> = { at: number; value: Promise<T> }

export class Lookups {
  readonly #client: OrbitClient
  readonly #workspace: string
  readonly #now: () => number
  readonly #cache = new Map<string, Entry<unknown>>()

  constructor(client: OrbitClient, workspaceId: string, now: () => number = Date.now) {
    this.#client = client
    this.#workspace = `/workspaces/${encodeURIComponent(workspaceId)}`
    this.#now = now
  }

  /** The path of a workspace resource, such as `/tasks`. */
  path(resource: string): string {
    return `${this.#workspace}${resource}`
  }

  clear(): void {
    this.#cache.clear()
  }

  #cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.#cache.get(key) as Entry<T> | undefined
    if (hit && this.#now() - hit.at < TTL_MS) return hit.value
    const value = load()
    this.#cache.set(key, { at: this.#now(), value })
    // A failed lookup must not be served again.
    value.catch(() => {
      if (this.#cache.get(key)?.value === value) this.#cache.delete(key)
    })
    return value
  }

  projects(signal?: AbortSignal): Promise<OrbitProject[]> {
    return this.#cached('projects', () =>
      this.#client.all<OrbitProject>(this.path('/projects'), {}, signal)
    )
  }

  async project(projectId: string, signal?: AbortSignal): Promise<OrbitProject | undefined> {
    return (await this.projects(signal)).find((project) => project.id === projectId)
  }

  /** User id to display name. */
  members(signal?: AbortSignal): Promise<Map<string, string>> {
    return this.#cached('members', async () => {
      const members = await this.#client.all<OrbitMember>(this.path('/members'), {}, signal, PAGED)
      return new Map(members.map((member) => [member.user_id, member.display_name]))
    })
  }

  /** A project's statuses in workflow order. */
  statuses(projectId: string, signal?: AbortSignal): Promise<OrbitStatus[]> {
    return this.#cached(`statuses:${projectId}`, async () => {
      const statuses = await this.#client.all<OrbitStatus>(
        this.path(`/projects/${encodeURIComponent(projectId)}/statuses`),
        {},
        signal,
        PAGED
      )
      return statuses.sort((a, b) => a.position - b.position)
    })
  }

  /** Label id to name, for one project. */
  labels(projectId: string, signal?: AbortSignal): Promise<Map<string, string>> {
    return this.#cached(`labels:${projectId}`, async () => {
      const labels = await this.#client.all<OrbitLabel>(
        this.path(`/projects/${encodeURIComponent(projectId)}/labels`),
        {},
        signal,
        PAGED
      )
      return new Map(labels.map((label) => [label.id, label.name]))
    })
  }

  /**
   * The saved views the token's creator sees, or `null` when this Orbit or this token has none:
   * an older Orbit has no such route, and a service-account token may not read views.
   */
  views(signal?: AbortSignal): Promise<OrbitView[] | null> {
    return this.#cached('views', async () => {
      try {
        const views = await this.#client.all<OrbitView>(this.path('/views'), {}, signal)
        return views.filter((view) => typeof view.id === 'string' && typeof view.name === 'string')
      } catch (error) {
        if (error instanceof OrbitError && (error.kind === 'not_found' || error.kind === 'forbidden')) {
          return null
        }
        throw error
      }
    })
  }
}
