import { assert, test } from 'orca/testing'
import { BASE_URL, fakeOrbit, problem, TOKEN } from '../testing/fake-orbit'
import { normalizeBaseUrl, OrbitClient, OrbitError } from './client'

function clientFor(orbit: ReturnType<typeof fakeOrbit>, waits: number[] = [], token = TOKEN): OrbitClient {
  return new OrbitClient({
    baseUrl: BASE_URL,
    token,
    fetch: orbit.fetch,
    sleep: async (ms) => {
      waits.push(ms)
    }
  })
}

async function failureOf(run: Promise<unknown>): Promise<OrbitError> {
  try {
    await run
  } catch (error) {
    assert.ok(error instanceof OrbitError, `expected an OrbitError, got ${String(error)}`)
    return error
  }
  return assert.fail('expected the request to fail')
}

test('normalizes what a person types as the Orbit URL', () => {
  assert.equal(normalizeBaseUrl('orbit.example.com'), 'https://orbit.example.com')
  assert.equal(normalizeBaseUrl(' https://orbit.example.com/ '), 'https://orbit.example.com')
  assert.equal(normalizeBaseUrl('https://orbit.example.com/api/public/v1/'), 'https://orbit.example.com')
  assert.equal(normalizeBaseUrl('https://example.com/orbit//'), 'https://example.com/orbit')
  assert.equal(normalizeBaseUrl('http://127.0.0.1:18080?x=1#y'), 'http://127.0.0.1:18080')
  assert.equal(normalizeBaseUrl('https://box.tailnet.ts.net:24010'), 'https://box.tailnet.ts.net:24010')
  for (const bad of ['', '   ', 'ftp://orbit.example.com', 'https://user:pass@orbit.example.com', 'http://']) {
    assert.throws(() => normalizeBaseUrl(bad), (error) => error instanceof OrbitError && error.kind === 'invalid_url')
  }
})

test('sends the token as a bearer header and reads /me', async () => {
  const orbit = fakeOrbit()
  const me = await clientFor(orbit).me()
  assert.equal(me.workspace.id, 'ws-1')
  assert.deepEqual(orbit.requests, ['/me'])
})

test('maps Orbit problems to clear errors that never contain the token', async () => {
  const orbit = fakeOrbit()
  const wrong = await failureOf(clientFor(orbit, [], 'orb_wrong').me())
  assert.equal(wrong.kind, 'unauthorized')
  assert.equal(wrong.status, 401)

  orbit.next.push({ status: 403, body: problem(403, 'insufficient_scope') })
  const scope = await failureOf(clientFor(orbit).get('/workspaces/ws-1/tasks'))
  assert.equal(scope.kind, 'forbidden')
  assert.match(scope.message, /Tasks: Read/)

  orbit.next.push({ status: 404, body: problem(404, 'not_found') })
  assert.equal((await failureOf(clientFor(orbit).get('/workspaces/ws-1/tasks/ENG-99'))).kind, 'not_found')

  orbit.next.push({ status: 500, body: problem(500, 'internal_error', 'The database is unavailable.') })
  const server = await failureOf(clientFor(orbit).me())
  assert.equal(server.kind, 'server')
  assert.match(server.message, /database is unavailable/)

  for (const error of [wrong, scope, server]) {
    assert.ok(!error.message.includes(TOKEN) && !error.message.includes('orb_wrong'))
  }
})

test('says so when the URL is not an Orbit API', async () => {
  const orbit = fakeOrbit()
  orbit.next.push({ status: 200, raw: '<!doctype html><html></html>' })
  const html = await failureOf(clientFor(orbit).me())
  assert.equal(html.kind, 'bad_response')
  assert.match(html.message, /orbit\.test did not answer like an Orbit API/)

  orbit.next.push({ status: 404, raw: 'Not Found' })
  assert.equal((await failureOf(clientFor(orbit).me())).kind, 'bad_response')
})

test('reports a redirect with the address to use, and does not follow it', async () => {
  const orbit = fakeOrbit()
  orbit.next.push({
    status: 301,
    raw: '',
    headers: { Location: 'https://orbit.example.com/api/public/v1/me' }
  })
  const moved = await failureOf(clientFor(orbit).me())
  assert.equal(moved.kind, 'bad_response')
  assert.equal(moved.message, 'orbit.test redirects to https://orbit.example.com. Use that address as the Orbit URL.')
  assert.deepEqual(orbit.requests, ['/me'])

  orbit.next.push({ status: 302, raw: '', headers: { Location: '/login' } })
  assert.match((await failureOf(clientFor(orbit).me())).message, /answered with a redirect/)
})

test('waits as Retry-After says and retries once', async () => {
  const orbit = fakeOrbit()
  const waits: number[] = []
  orbit.next.push({ status: 429, body: problem(429, 'rate_limit_exceeded'), headers: { 'Retry-After': '2' } })
  const me = await clientFor(orbit, waits).me()
  assert.equal(me.workspace.name, 'Acme')
  assert.deepEqual(waits, [2000])
  assert.deepEqual(orbit.requests, ['/me', '/me'])

  const limited = { status: 429, body: problem(429, 'rate_limit_exceeded'), headers: { 'Retry-After': '3' } }
  orbit.next.push(limited, limited)
  const error = await failureOf(clientFor(orbit, waits).me())
  assert.equal(error.kind, 'rate_limited')
  assert.match(error.message, /Try again in 3 seconds/)
})

test('does not wait when Orbit asks for longer than ten seconds', async () => {
  const orbit = fakeOrbit()
  const waits: number[] = []
  orbit.next.push({ status: 429, body: problem(429, 'rate_limit_exceeded'), headers: { 'Retry-After': '120' } })
  const error = await failureOf(clientFor(orbit, waits).me())
  assert.equal(error.kind, 'rate_limited')
  assert.deepEqual(waits, [])
  assert.deepEqual(orbit.requests, ['/me'])
})

test('reports an unreachable host and a cancelled request', async () => {
  const refused = new OrbitClient({
    baseUrl: BASE_URL,
    token: TOKEN,
    fetch: async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
    }
  })
  const network = await failureOf(refused.me())
  assert.equal(network.kind, 'network')
  assert.match(network.message, /Could not reach Orbit at orbit\.test: the connection was refused/)

  const controller = new AbortController()
  controller.abort()
  const cancelled = new OrbitClient({
    baseUrl: BASE_URL,
    token: TOKEN,
    fetch: async (_url, init) => {
      if (init.signal?.aborted) throw new Error('aborted')
      return fakeOrbit().fetch(_url, init)
    }
  })
  assert.equal((await failureOf(cancelled.me(controller.signal))).kind, 'cancelled')
})

test('follows cursors and leaves unset parameters out', async () => {
  const orbit = fakeOrbit()
  const client = clientFor(orbit)
  const first = await client.page('/workspaces/ws-1/tasks', { limit: 2, cursor: undefined, q: '' })
  assert.equal(first.items.length, 2)
  assert.equal(first.next_cursor, '2')
  assert.deepEqual(orbit.requests, ['/workspaces/ws-1/tasks?limit=2'])
  const all = await client.all('/workspaces/ws-1/tasks', {}, undefined, { pageSize: 2 })
  assert.equal(all.length, 5)
  // No `limit` without a page size: Orbit refuses parameters a route does not declare.
  await client.all('/workspaces/ws-1/projects')
  assert.equal(orbit.requests.at(-1), '/workspaces/ws-1/projects')
  const refused = await failureOf(client.get('/workspaces/ws-1/projects', { limit: 100 }))
  assert.equal(refused.status, 400)
  assert.equal(refused.code, 'invalid_request')
})
