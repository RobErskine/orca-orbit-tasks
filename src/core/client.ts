// The Orbit public REST API client: one authenticated GET with clear errors, one retry when
// Orbit asks to wait, and cursor pages. It never logs or returns the token.
import type { OrbitList, OrbitMe } from './types'

export const API_PATH = '/api/public/v1'
const REQUEST_TIMEOUT_MS = 20_000
/** Longest wait this client accepts from `Retry-After` before it gives up. */
const MAX_RETRY_WAIT_MS = 10_000

export type OrbitErrorKind =
  | 'invalid_url'
  | 'network'
  | 'timeout'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'server'
  | 'bad_response'
  | 'cancelled'

/** A failure with a message that is safe and useful to show to the person. */
export class OrbitError extends Error {
  readonly kind: OrbitErrorKind
  readonly status: number | undefined
  /** Orbit's problem `code`, such as `insufficient_scope`. */
  readonly code: string | undefined

  constructor(kind: OrbitErrorKind, message: string, status?: number, code?: string) {
    super(message)
    this.name = 'OrbitError'
    this.kind = kind
    this.status = status
    this.code = code
  }
}

export type FetchResponse = {
  status: number
  headers: { get(name: string): string | null }
  text(): Promise<string>
}
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; signal?: AbortSignal }
) => Promise<FetchResponse>

export type QueryParams = Record<string, string | number | undefined>

/**
 * Turns what a person types into the instance's base URL: adds `https://`, drops a trailing
 * slash, a pasted `/api/public/v1`, the query and the fragment, and keeps a base path such as
 * `https://example.com/orbit`.
 */
export function normalizeBaseUrl(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) {
    throw new OrbitError('invalid_url', 'Enter the URL of your Orbit instance.')
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    throw new OrbitError('invalid_url', `"${trimmed}" is not a valid URL.`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new OrbitError('invalid_url', 'The Orbit URL must start with https:// or http://.')
  }
  if (url.username || url.password) {
    throw new OrbitError('invalid_url', 'The Orbit URL must not contain a user name or password.')
  }
  let path = url.pathname.replace(/\/+$/, '')
  if (path.toLowerCase().endsWith(API_PATH)) {
    path = path.slice(0, -API_PATH.length).replace(/\/+$/, '')
  }
  return `${url.origin}${path}`
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host
  } catch {
    return baseUrl
  }
}

function causeText(error: unknown): string {
  const cause = (error as { cause?: { code?: string; message?: string } } | null)?.cause
  const code = cause?.code
  if (code === 'ENOTFOUND') return 'the host name was not found'
  if (code === 'ECONNREFUSED') return 'the connection was refused'
  if (code === 'ECONNRESET') return 'the connection was reset'
  if (code && /CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code)) {
    return `its TLS certificate is not trusted (${code}); self-signed certificates are not supported`
  }
  return code ?? cause?.message ?? (error instanceof Error ? error.message : 'unknown error')
}

function retryAfterMs(response: FetchResponse): number {
  const seconds = Number(response.headers.get('retry-after'))
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 1000
}

type Problem = { code?: string; detail?: string; title?: string }

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export type OrbitClientOptions = {
  baseUrl: string
  token: string
  fetch?: FetchLike
  /** Waits between a refused request and its one retry; tests pass a stub. */
  sleep?: (ms: number) => Promise<void>
}

export class OrbitClient {
  readonly baseUrl: string
  readonly #token: string
  readonly #fetch: FetchLike
  readonly #sleep: (ms: number) => Promise<void>

  constructor(options: OrbitClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl)
    this.#token = options.token.trim()
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init))
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  me(signal?: AbortSignal): Promise<OrbitMe> {
    return this.get<OrbitMe>('/me', {}, signal)
  }

  /** `GET <base>/api/public/v1<path>`. Unset params are left out. */
  async get<T>(path: string, params: QueryParams = {}, signal?: AbortSignal): Promise<T> {
    const url = new URL(`${this.baseUrl}${API_PATH}${path}`)
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '') url.searchParams.set(key, String(value))
    }
    let response = await this.#send(url.toString(), signal)
    // Orbit sends 429 with Retry-After in seconds, and 503 while a resource is busy.
    if (response.status === 429 || response.status === 503) {
      const wait = retryAfterMs(response)
      if (wait <= MAX_RETRY_WAIT_MS) {
        await this.#sleep(wait)
        if (signal?.aborted) throw new OrbitError('cancelled', 'The request was cancelled.')
        response = await this.#send(url.toString(), signal)
      }
    }
    const text = await response.text()
    const body = parseJson(text)
    if (response.status >= 200 && response.status < 300) {
      if (body === undefined || body === null || typeof body !== 'object') {
        throw new OrbitError(
          'bad_response',
          `${hostOf(this.baseUrl)} did not answer like an Orbit API. Check the Orbit URL.`,
          response.status
        )
      }
      return body as T
    }
    throw this.#failure(response, (body ?? {}) as Problem)
  }

  /** One page of a cursor list. */
  page<T>(path: string, params: QueryParams = {}, signal?: AbortSignal): Promise<OrbitList<T>> {
    return this.get<OrbitList<T>>(path, params, signal).then((list) => ({
      items: Array.isArray(list.items) ? list.items : [],
      next_cursor: typeof list.next_cursor === 'string' && list.next_cursor ? list.next_cursor : null
    }))
  }

  /** Every item of a cursor list, up to `maxPages` pages of 100. */
  async all<T>(
    path: string,
    params: QueryParams = {},
    signal?: AbortSignal,
    maxPages = 10
  ): Promise<T[]> {
    const items: T[] = []
    let cursor: string | undefined
    for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
      const page = await this.page<T>(path, { ...params, limit: 100, cursor }, signal)
      items.push(...page.items)
      if (!page.next_cursor) break
      cursor = page.next_cursor
    }
    return items
  }

  async #send(url: string, signal?: AbortSignal): Promise<FetchResponse> {
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, REQUEST_TIMEOUT_MS)
    const onAbort = (): void => controller.abort()
    if (signal?.aborted) controller.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      return await this.#fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: `Bearer ${this.#token}` },
        signal: controller.signal
      })
    } catch (error) {
      if (timedOut) {
        throw new OrbitError(
          'timeout',
          `${hostOf(this.baseUrl)} did not answer within ${REQUEST_TIMEOUT_MS / 1000} seconds.`
        )
      }
      if (signal?.aborted) throw new OrbitError('cancelled', 'The request was cancelled.')
      throw new OrbitError(
        'network',
        `Could not reach Orbit at ${hostOf(this.baseUrl)}: ${causeText(error)}.`
      )
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  #failure(response: FetchResponse, problem: Problem): OrbitError {
    const { status } = response
    const code = typeof problem.code === 'string' ? problem.code : undefined
    const detail = typeof problem.detail === 'string' ? problem.detail : undefined
    if (status === 401) {
      return new OrbitError(
        'unauthorized',
        'Orbit refused the API token. It may be wrong, expired or revoked.',
        status,
        code
      )
    }
    // No problem `code`: something other than Orbit answered (a proxy, another site).
    if (code === undefined && status < 500 && status !== 429) {
      return new OrbitError(
        'bad_response',
        `${hostOf(this.baseUrl)} did not answer like an Orbit API (HTTP ${status}). Check the Orbit URL.`,
        status
      )
    }
    if (status === 403) {
      const message =
        code === 'insufficient_scope'
          ? 'The API token has no permission to read tasks. Create one with Tasks: Read.'
          : (detail ?? 'Orbit refused this request for the API token.')
      return new OrbitError('forbidden', message, status, code)
    }
    if (status === 404) {
      const message =
        code === 'route_not_found'
          ? `${hostOf(this.baseUrl)} has no such API route. The Orbit instance may be older than this plugin expects.`
          : 'Orbit did not find it. It may be deleted, or in a project the API token does not include.'
      return new OrbitError('not_found', message, status, code)
    }
    if (status === 429) {
      const seconds = Math.ceil(retryAfterMs(response) / 1000)
      return new OrbitError(
        'rate_limited',
        `Orbit is limiting requests. Try again in ${seconds} second${seconds === 1 ? '' : 's'}.`,
        status,
        code
      )
    }
    if (status >= 500) {
      return new OrbitError(
        'server',
        detail ?? `Orbit could not complete the request (HTTP ${status}). Try again later.`,
        status,
        code
      )
    }
    return new OrbitError(
      'bad_response',
      detail ?? `Orbit refused the request (${code ?? `HTTP ${status}`}).`,
      status,
      code
    )
  }
}
