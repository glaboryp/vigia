import { env } from 'cloudflare:workers'
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose'
import { beforeAll, beforeEach, expect, it } from 'vitest'
import { PROVIDER_LABELS, type ProviderId } from 'core'
import { Repo, type StoredQuota } from '../src/db.js'
import { verifyAccess } from '../src/access.js'
import { createWorker } from '../src/index.js'
import { renderStatusPage } from '../src/status-page.js'
import { resetDb, testEnv } from './helpers.js'

const NOW = new Date('2026-10-23T10:00:00Z')
let privateKey: CryptoKey
let jwks: ReturnType<typeof createLocalJWKSet>

beforeAll(async () => {
  const pair = await generateKeyPair('RS256')
  privateKey = pair.privateKey
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }
  jwks = createLocalJWKSet({ keys: [jwk] })
})
beforeEach(resetDb)

function sign(opts: { aud?: string; exp?: string | number; iss?: string } = {}): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(opts.iss ?? `https://${testEnv.ACCESS_TEAM_DOMAIN}`)
    .setAudience(opts.aud ?? testEnv.ACCESS_AUD)
    .setIssuedAt(Math.floor(Date.now() / 1000) - 600)
    .setExpirationTime(opts.exp ?? '5m')
    .sign(privateKey)
}

const withJwt = (jwt?: string) =>
  new Request('https://vigia.test/', jwt === undefined ? {} : { headers: { 'Cf-Access-Jwt-Assertion': jwt } })

const quota = (over: Partial<StoredQuota> = {}): StoredQuota => ({
  provider: 'copilot',
  quotaId: 'premium',
  name: 'Premium requests',
  window: 'monthly',
  remainingFraction: 0.25,
  resetsAt: '2026-11-01T00:00:00Z',
  periodResetAt: '2026-11-01T00:00:00Z',
  readAt: '2026-10-23T09:55:00Z',
  source: 'cloud',
  ...over,
})

async function fetchPage(jwt?: string): Promise<Response> {
  return createWorker({ jwks }).fetch(withJwt(jwt), testEnv, {} as ExecutionContext)
}

it('rejects requests without the Access header', async () => {
  const res = await fetchPage()
  expect(res.status).toBe(403)
  expect(res.headers.get('cache-control')).toBe('no-store')
  expect(await res.text()).toBe('Acceso denegado')
})

it('rejects invalid, wrong-audience, wrong-issuer and expired tokens', async () => {
  expect((await fetchPage('garbage')).status).toBe(403)
  expect((await fetchPage(await sign({ aud: 'other' }))).status).toBe(403)
  expect((await fetchPage(await sign({ iss: 'https://evil.example' }))).status).toBe(403)
  expect((await fetchPage(await sign({ exp: Math.floor(Date.now() / 1000) - 60 }))).status).toBe(403)
})

it('returns false when Access env is missing', async () => {
  const jwt = await sign()
  expect(await verifyAccess(withJwt(jwt), { ...testEnv, ACCESS_AUD: '' }, { jwks })).toBe(false)
  expect(await verifyAccess(withJwt(jwt), { ...testEnv, ACCESS_TEAM_DOMAIN: '' }, { jwks })).toBe(false)
  expect(await verifyAccess(withJwt(jwt), testEnv, { jwks })).toBe(true)
})

it('serves the page with seeded data for a valid token', async () => {
  const repo = new Repo(env.DB, testEnv.CREDENTIALS_KEY)
  await repo.upsertCurrentQuota(quota())
  const res = await fetchPage(await sign())
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
  expect(res.headers.get('cache-control')).toBe('no-store')
  const html = await res.text()
  expect(html).toContain('GitHub Copilot')
  expect(html).toContain('Premium requests')
  expect(html).toContain('75%')
})

const ALL = Object.keys(PROVIDER_LABELS) as ProviderId[]
const base = { quotas: [], health: [], closes: [], surplus: [], now: NOW, enabled: ALL }

it('lists every enabled provider, marking those without data', () => {
  const html = renderStatusPage({ ...base, quotas: [quota()], enabled: ['copilot', 'codex', 'mimo'] })
  const cards = [...html.matchAll(/<section class="card"><h3>([^<]+)<\/h3>\n(?:<div class="badges">.*?<\/div>\n)?(.*?)<\/section>/gs)].map((m) => [m[1], m[2]])
  expect(cards.map((c) => c[0])).toEqual(['GitHub Copilot', 'Codex', 'MiMo Code'])
  expect(cards[1]![1]).toContain('Sin datos')
  expect(cards[1]![1]).not.toContain('portátil')
  expect(cards[2]![1]).toContain('Sin datos del portátil')
  expect(html).not.toContain('Kilo Code')
})

it('serves every provider not disabled in CONFIG_JSON', async () => {
  const cfg = { ...testEnv, CONFIG_JSON: JSON.stringify({ disabled: ['kilo'] }) }
  const res = await createWorker({ jwks }).fetch(withJwt(await sign()), cfg, {} as ExecutionContext)
  const html = await res.text()
  expect(html).toContain('<h3>Freebuff</h3>')
  expect(html).toContain('<h3>opencode</h3>')
  expect(html).not.toContain('<h3>Kilo Code</h3>')
})

it('renders structure, sections and footer', () => {
  const html = renderStatusPage({ ...base, quotas: [quota()] })
  expect(html).toContain('<html lang="es">')
  expect(html).toContain('name="viewport" content="width=device-width, initial-scale=1"')
  expect(html).toContain('<title>VigIA</title>')
  expect(html).toContain('prefers-color-scheme: dark')
  expect(html).toContain('Estado actual')
  expect(html).toContain('Historial')
  expect(html).toContain('¿Me sobra el plan?')
  expect(html).toContain('Nada que señalar')
  expect(html).toContain('se renueva')
  expect(html).toContain('Actualizado')
  expect(html).not.toContain('<script')
})

it('escapes dynamic strings', () => {
  const html = renderStatusPage({
    ...base,
    quotas: [quota({ name: '<img src=x onerror=alert(1)>', unit: '<b>' })],
    health: [
      { provider: 'copilot', consecutiveFailures: 3, brokenNotified: true, lastError: { kind: 'auth', message: '<script>x</script>' } },
    ],
  })
  expect(html).not.toContain('<img src=x')
  expect(html).not.toContain('<script>x')
  expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
})

it('shows error and stale badges', () => {
  const html = renderStatusPage({
    ...base,
    quotas: [quota({ provider: 'mimo', source: 'local', readAt: '2026-10-19T00:00:00Z' })],
    health: [
      { provider: 'mimo', consecutiveFailures: 1, brokenNotified: false, lastOkAt: '2026-10-19T00:00:00Z' },
      { provider: 'copilot', consecutiveFailures: 3, brokenNotified: true, lastError: { kind: 'auth', message: 'x' } },
    ],
  })
  expect(html).toContain('desactualizado')
  expect(html).toContain('no puedo leerlo')
})

it('shows the unreadable badge only once the alert fired', () => {
  const failing = (brokenNotified: boolean) =>
    renderStatusPage({
      ...base,
      quotas: [quota()],
      health: [{ provider: 'copilot', consecutiveFailures: 1, brokenNotified, lastError: { kind: 'network', message: 'x' } }],
    })
  expect(failing(false)).not.toContain('no puedo leerlo')
  expect(failing(true)).toContain('no puedo leerlo')
})

it('does not flag a fresh local reading as stale', () => {
  const html = renderStatusPage({
    ...base,
    quotas: [quota({ provider: 'mimo', source: 'local' })],
    health: [{ provider: 'mimo', consecutiveFailures: 0, brokenNotified: false, lastOkAt: '2026-10-23T09:00:00Z' }],
  })
  expect(html).not.toContain('desactualizado')
})

it('shows pending renewal when resetsAt is in the past', () => {
  const html = renderStatusPage({ ...base, quotas: [quota({ resetsAt: '2026-10-22T00:00:00Z' })] })
  expect(html).toContain('renovación pendiente de leer')
  expect(html).not.toContain('se renueva')
  expect(html).toContain('class="bar pending"')
})

it('escapes amount units and exposes the meter', () => {
  const html = renderStatusPage({ ...base, quotas: [quota({ remaining: 5, total: 20, unit: '<u>req</u>' })] })
  expect(html).toContain('(5 de 20 &lt;u&gt;req&lt;/u&gt;)')
  expect(html).not.toContain('<u>')
  expect(html).toContain('role="meter" aria-valuenow="75"')
  expect(html).toContain('aria-label="Premium requests: 75% usado"')
})

it('lists the 12 newest closes newest first', () => {
  const closes = Array.from({ length: 13 }, (_, i) => ({
    provider: 'copilot' as const,
    quotaId: 'premium',
    window: 'monthly' as const,
    periodResetAt: new Date(Date.UTC(2025, i, 1)).toISOString(),
    usedFraction: (i + 1) / 100,
  }))
  const html = renderStatusPage({ ...base, closes })
  const pcts = [...html.matchAll(/<tr class="close"><td>[^<]*<\/td><td>(\d+)%/g)].map((m) => Number(m[1]))
  expect(pcts).toEqual([13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2])
})

it('renders closes history and surplus', () => {
  const closes = Array.from({ length: 14 }, (_, i) => ({
    provider: 'copilot' as const,
    quotaId: 'premium',
    window: 'monthly' as const,
    periodResetAt: `2025-${String((i % 12) + 1).padStart(2, '0')}-01T00:00:00Z`,
    usedFraction: 0.1,
  }))
  const html = renderStatusPage({
    ...base,
    quotas: [quota()],
    closes,
    surplus: [{ provider: 'copilot', quotaId: 'premium', avgUsed: 0.2 }],
  })
  expect(html).toContain('10%')
  expect(html).toContain('20%')
  expect(html).not.toContain('Nada que señalar')
  expect(html.match(/<tr class="close">/g)?.length).toBe(12)
})
