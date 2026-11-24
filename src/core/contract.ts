// The limits of Orca's planned task source format, and a checker that refuses what Orca would
// refuse. It mirrors the Zod schemas of stablyai/orca#26282 at commit 05be3b1b5f4e
// (src/shared/plugins/tasks/plugin-task-source.ts): strict objects, the same lengths and counts.
// The tests run every list and detail answer through it.
import type { TaskTone } from './types'

export const TONES: readonly TaskTone[] = ['open', 'active', 'blocked', 'review', 'done', 'closed']

export const LIMITS = {
  items: 500,
  filters: 8,
  filterOptions: 100,
  id: 512,
  title: 512,
  statusLabel: 64,
  priority: 32,
  owner: 256,
  labels: 16,
  label: 64,
  updatedAt: 64,
  summary: 1024,
  url: 2048,
  blockedReason: 256,
  workspaceName: 128,
  agentPrompt: 16 * 1024,
  baseRef: 512,
  projectPath: 4096,
  projectSource: 512,
  linkMetadataEntries: 8,
  linkMetadataValue: 4096,
  filterLabel: 64,
  optionValue: 256,
  optionLabel: 128,
  cursor: 1024,
  notice: 512,
  body: 512 * 1024
} as const

const FILTER_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const METADATA_KEY = /^[A-Za-z][A-Za-z0-9_-]*$/

type Problems = string[]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function keys(value: Record<string, unknown>, allowed: readonly string[], at: string, out: Problems): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) out.push(`${at}.${key}: unknown key`)
  }
}

/** A string of `min` to `max` characters; `undefined` passes when `optional`. */
function text(
  value: unknown,
  at: string,
  out: Problems,
  options: { min?: number; max: number; optional?: boolean }
): void {
  if (value === undefined) {
    if (!options.optional) out.push(`${at}: required`)
    return
  }
  if (typeof value !== 'string') {
    out.push(`${at}: must be a string`)
    return
  }
  if (value.length < (options.min ?? 1)) out.push(`${at}: too short`)
  if (value.length > options.max) out.push(`${at}: longer than ${options.max}`)
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

function checkStart(value: unknown, at: string, out: Problems): void {
  if (!isRecord(value)) {
    out.push(`${at}: must be an object`)
    return
  }
  keys(
    value,
    [
      'workspaceName',
      'agentPrompt',
      'baseRef',
      'projectPath',
      'projectSource',
      'sessionOptions',
      'linkMetadata'
    ],
    at,
    out
  )
  text(value.workspaceName, `${at}.workspaceName`, out, { max: LIMITS.workspaceName, optional: true })
  text(value.agentPrompt, `${at}.agentPrompt`, out, { max: LIMITS.agentPrompt, optional: true })
  text(value.baseRef, `${at}.baseRef`, out, { max: LIMITS.baseRef, optional: true })
  text(value.projectPath, `${at}.projectPath`, out, { max: LIMITS.projectPath, optional: true })
  text(value.projectSource, `${at}.projectSource`, out, { max: LIMITS.projectSource, optional: true })
  if (value.sessionOptions !== undefined) {
    if (!isRecord(value.sessionOptions)) {
      out.push(`${at}.sessionOptions: must be an object`)
    } else {
      keys(value.sessionOptions, ['agent', 'model', 'effort'], `${at}.sessionOptions`, out)
      text(value.sessionOptions.agent, `${at}.sessionOptions.agent`, out, { max: 64, optional: true })
      text(value.sessionOptions.model, `${at}.sessionOptions.model`, out, { max: 128, optional: true })
      text(value.sessionOptions.effort, `${at}.sessionOptions.effort`, out, { max: 32, optional: true })
    }
  }
  if (value.linkMetadata !== undefined) {
    if (!isRecord(value.linkMetadata)) {
      out.push(`${at}.linkMetadata: must be an object`)
    } else {
      const entries = Object.entries(value.linkMetadata)
      if (entries.length > LIMITS.linkMetadataEntries) out.push(`${at}.linkMetadata: too many entries`)
      for (const [key, entry] of entries) {
        if (key.length > 64 || !METADATA_KEY.test(key)) {
          out.push(`${at}.linkMetadata.${key}: must be an identifier`)
        }
        text(entry, `${at}.linkMetadata.${key}`, out, { max: LIMITS.linkMetadataValue })
      }
    }
  }
}

function checkItem(value: unknown, at: string, out: Problems): void {
  if (!isRecord(value)) {
    out.push(`${at}: must be an object`)
    return
  }
  keys(
    value,
    [
      'id',
      'title',
      'status',
      'priority',
      'owner',
      'labels',
      'updatedAt',
      'summary',
      'url',
      'start',
      'startBlockedReason'
    ],
    at,
    out
  )
  text(value.id, `${at}.id`, out, { max: LIMITS.id })
  text(value.title, `${at}.title`, out, { max: LIMITS.title })
  if (value.status !== undefined) {
    if (!isRecord(value.status)) {
      out.push(`${at}.status: must be an object`)
    } else {
      keys(value.status, ['label', 'tone'], `${at}.status`, out)
      text(value.status.label, `${at}.status.label`, out, { max: LIMITS.statusLabel })
      if (!TONES.includes(value.status.tone as TaskTone)) out.push(`${at}.status.tone: unknown tone`)
    }
  }
  text(value.priority, `${at}.priority`, out, { max: LIMITS.priority, optional: true })
  text(value.owner, `${at}.owner`, out, { max: LIMITS.owner, optional: true })
  if (value.labels !== undefined) {
    if (!Array.isArray(value.labels)) {
      out.push(`${at}.labels: must be an array`)
    } else {
      if (value.labels.length > LIMITS.labels) out.push(`${at}.labels: more than ${LIMITS.labels}`)
      value.labels.forEach((label, index) =>
        text(label, `${at}.labels.${index}`, out, { max: LIMITS.label })
      )
    }
  }
  text(value.updatedAt, `${at}.updatedAt`, out, { max: LIMITS.updatedAt, optional: true })
  text(value.summary, `${at}.summary`, out, { min: 0, max: LIMITS.summary, optional: true })
  if (value.url !== undefined) {
    text(value.url, `${at}.url`, out, { min: 0, max: LIMITS.url })
    if (typeof value.url === 'string' && !isHttpUrl(value.url)) {
      out.push(`${at}.url: must be an http(s) URL`)
    }
  }
  if (value.start !== undefined) checkStart(value.start, `${at}.start`, out)
  text(value.startBlockedReason, `${at}.startBlockedReason`, out, {
    max: LIMITS.blockedReason,
    optional: true
  })
}

function checkFilter(value: unknown, at: string, out: Problems): void {
  if (!isRecord(value)) {
    out.push(`${at}: must be an object`)
    return
  }
  keys(value, ['id', 'label', 'options', 'defaultValue'], at, out)
  if (typeof value.id !== 'string' || value.id.length > 64 || !FILTER_ID.test(value.id)) {
    out.push(`${at}.id: must be kebab-case`)
  }
  text(value.label, `${at}.label`, out, { max: LIMITS.filterLabel })
  if (!Array.isArray(value.options) || value.options.length < 1) {
    out.push(`${at}.options: needs at least one option`)
  } else {
    if (value.options.length > LIMITS.filterOptions) {
      out.push(`${at}.options: more than ${LIMITS.filterOptions}`)
    }
    value.options.forEach((option, index) => {
      const here = `${at}.options.${index}`
      if (!isRecord(option)) {
        out.push(`${here}: must be an object`)
        return
      }
      keys(option, ['value', 'label', 'count'], here, out)
      text(option.value, `${here}.value`, out, { min: 0, max: LIMITS.optionValue })
      text(option.label, `${here}.label`, out, { max: LIMITS.optionLabel })
      if (
        option.count !== undefined &&
        !(typeof option.count === 'number' && Number.isInteger(option.count) && option.count >= 0)
      ) {
        out.push(`${here}.count: must be a non-negative integer`)
      }
    })
  }
  text(value.defaultValue, `${at}.defaultValue`, out, {
    min: 0,
    max: LIMITS.optionValue,
    optional: true
  })
}

/** What Orca would refuse in a `list` answer; empty when it is valid. */
export function checkListResult(value: unknown): string[] {
  const out: Problems = []
  if (!isRecord(value)) return ['(root): must be an object']
  keys(value, ['items', 'nextCursor', 'filters', 'notice'], '(root)', out)
  if (!Array.isArray(value.items)) {
    out.push('items: must be an array')
  } else {
    if (value.items.length > LIMITS.items) out.push(`items: more than ${LIMITS.items}`)
    value.items.forEach((item, index) => checkItem(item, `items.${index}`, out))
  }
  text(value.nextCursor, 'nextCursor', out, { max: LIMITS.cursor, optional: true })
  if (value.filters !== undefined) {
    if (!Array.isArray(value.filters)) {
      out.push('filters: must be an array')
    } else {
      if (value.filters.length > LIMITS.filters) out.push(`filters: more than ${LIMITS.filters}`)
      value.filters.forEach((filter, index) => checkFilter(filter, `filters.${index}`, out))
    }
  }
  text(value.notice, 'notice', out, { max: LIMITS.notice, optional: true })
  return out
}

/** What Orca would refuse in a `get` answer; empty when it is valid. */
export function checkDetail(value: unknown): string[] {
  const out: Problems = []
  if (!isRecord(value)) return ['(root): must be an object']
  keys(value, ['item', 'bodyMarkdown'], '(root)', out)
  checkItem(value.item, 'item', out)
  text(value.bodyMarkdown, 'bodyMarkdown', out, { min: 0, max: LIMITS.body, optional: true })
  return out
}
