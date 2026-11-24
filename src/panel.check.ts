// `orca plugin check` renders the panel once per scenario. Each scenario answers the panel's
// requests itself, so check never reaches an Orbit instance.
import { defineCheck } from 'orca/testing'
import type { ConnectionStatus, ListOutput } from './protocol'

const connected: ConnectionStatus = {
  state: 'connected',
  baseUrl: 'https://orbit.example.com',
  hasToken: true,
  secretStore: 'os-keyring',
  workspace: 'Acme',
  account: 'Dev',
  tokenName: 'orca',
  expiresAt: '2027-01-01T00:00:00.000Z'
}

const tasks: ListOutput = {
  ok: true,
  result: {
    items: [
      {
        id: 'task-1',
        title: 'ENG-12 · Fix login',
        status: { label: 'In progress', tone: 'active' },
        priority: 'High',
        owner: 'Dev',
        labels: ['bug', 'api'],
        updatedAt: '2026-11-20T09:30:00.000Z',
        url: 'https://orbit.example.com/tasks/task-1',
        start: { workspaceName: 'eng-12-fix-login', agentPrompt: 'Work on ENG-12' }
      },
      {
        id: 'task-2',
        title: 'OPS-13 · Write the runbook',
        status: { label: 'Todo', tone: 'open' },
        updatedAt: '2026-11-19T09:30:00.000Z'
      }
    ],
    nextCursor: '50',
    filters: [
      {
        id: 'status',
        label: 'Status',
        defaultValue: 'open',
        options: [
          { value: 'open', label: 'Open' },
          { value: 'all', label: 'All statuses' }
        ]
      }
    ]
  },
  extra: {
    'task-1': { identifier: 'ENG-12', projectKey: 'ENG', projectName: 'Engineering' },
    'task-2': { identifier: 'OPS-13', projectKey: 'OPS', projectName: 'Operations' }
  },
  links: { 'task-1': [{ workspaceId: 'ws-1', name: 'eng-12-fix-login', createdAt: 1_800_000_000_000 }] }
}

export default defineCheck({
  'not connected': {
    requests: {
      'connection.status': {
        state: 'disconnected',
        baseUrl: '',
        hasToken: false,
        secretStore: 'os-keyring'
      }
    }
  },
  'token refused': {
    requests: {
      'connection.status': {
        state: 'error',
        baseUrl: 'https://orbit.example.com',
        hasToken: true,
        secretStore: 'os-keyring',
        error: 'Orbit refused the API token. It may be wrong, expired or revoked.'
      }
    }
  },
  'task list': {
    requests: { 'connection.status': connected, 'tasks.list': tasks }
  },
  'no tasks': {
    requests: {
      'connection.status': connected,
      'tasks.list': { ok: true, result: { items: [], filters: [] }, extra: {}, links: {} }
    }
  },
  'list failed': {
    requests: {
      'connection.status': connected,
      'tasks.list': { ok: false, error: 'Could not reach Orbit at orbit.example.com: the connection was refused.' }
    }
  }
})
