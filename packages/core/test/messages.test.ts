import { describe, expect, it } from 'vitest'
import {
  FIX_HINTS,
  brokenMessage,
  recoveredMessage,
  renewedMessage,
  statusMessage,
  surplusMessage,
  useOrLoseMessage,
} from '../src/messages.js'
import { PROVIDER_LABELS, type ProviderId } from '../src/types.js'
import type { ProviderHealth } from '../src/alerts/health.js'
import type { TrackedQuota } from '../src/alerts/use-or-lose.js'

const now = new Date('2026-10-25T18:00:00.000Z')

const tracked = (over: Partial<TrackedQuota> = {}): TrackedQuota => ({
  provider: 'antigravity',
  quotaId: 'claude-gpt',
  name: 'Claude y GPT',
  window: 'weekly',
  remainingFraction: 0.06,
  resetsAt: '2026-10-26T14:13:00.000Z',
  periodResetAt: '2026-10-26T14:13:00.000Z',
  readAt: '2026-10-25T17:30:00.000Z',
  ...over,
})

describe('useOrLoseMessage', () => {
  it('lists quotas with percentage, renewal and relative time', () => {
    const msg = useOrLoseMessage(
      [
        tracked(),
        tracked({ quotaId: 'gemini', name: 'Gemini', remainingFraction: 0.5 }),
        tracked({ provider: 'copilot', quotaId: 'premium', name: 'Premium', window: 'monthly', remainingFraction: 0.3, resetsAt: '2026-11-01T00:00:00.000Z' }),
      ],
      now,
    )
    expect(msg).toMatchInlineSnapshot(`
      "⏳ <b>Úsalo o piérdelo</b>
      Te queda saldo y está a punto de renovarse:
      • <b>Antigravity</b> · Claude y GPT — 6 % · se renueva lun 26 oct, 15:13 (en 20 h)
      • <b>Antigravity</b> · Gemini — 50 % · se renueva lun 26 oct, 15:13 (en 20 h)
      • <b>GitHub Copilot</b> — 30 % · se renueva dom 1 nov, 01:00 (en 6 d 6 h)"
    `)
  })

  it('shows only the provider label for a lone quota and the absolute amount', () => {
    const msg = useOrLoseMessage(
      [tracked({ provider: 'cursor', quotaId: 'req', name: 'Requests', remainingFraction: 0.25, remaining: 125, total: 500, unit: 'peticiones' })],
      now,
    )
    expect(msg).toMatchInlineSnapshot(`
      "⏳ <b>Úsalo o piérdelo</b>
      Te queda saldo y está a punto de renovarse:
      • <b>Cursor</b> — 25 % (125 de 500 peticiones) · se renueva lun 26 oct, 15:13 (en 20 h)"
    `)
  })

  it('appends data age when older than 6 h', () => {
    const msg = useOrLoseMessage([tracked({ readAt: '2026-10-25T10:00:00.000Z' })], now)
    expect(msg).toMatchInlineSnapshot(`
      "⏳ <b>Úsalo o piérdelo</b>
      Te queda saldo y está a punto de renovarse:
      • <b>Antigravity</b> — 6 % · se renueva lun 26 oct, 15:13 (en 20 h) · dato de hace 8 h"
    `)
  })

  it('never rounds a non-empty or non-full quota to 0 % or 100 %', () => {
    const line = (remainingFraction: number) => useOrLoseMessage([tracked({ remainingFraction })], now).split('\n')[2]
    expect(line(0.004)).toContain('— &lt;1 % ·')
    expect(line(0.995)).toContain('— &gt;99 % ·')
    expect(line(0)).toContain('— 0 % ·')
    expect(line(1)).toContain('— 100 % ·')
    expect(line(0.014)).toContain('— 1 % ·')
    expect(renewedMessage(tracked({ remainingFraction: 0.996 }))).toContain('&gt;99 %')
  })

  it('escapes HTML in quota names', () => {
    const msg = useOrLoseMessage([tracked({ name: 'A <b> & C' }), tracked({ quotaId: 'other', name: 'Otra' })], now)
    expect(msg).toMatchInlineSnapshot(`
      "⏳ <b>Úsalo o piérdelo</b>
      Te queda saldo y está a punto de renovarse:
      • <b>Antigravity</b> · A &lt;b&gt; &amp; C — 6 % · se renueva lun 26 oct, 15:13 (en 20 h)
      • <b>Antigravity</b> · Otra — 6 % · se renueva lun 26 oct, 15:13 (en 20 h)"
    `)
  })
})

describe('renewedMessage', () => {
  it('announces the new quota', () => {
    expect(renewedMessage(tracked({ remainingFraction: 1 }))).toMatchInlineSnapshot(`
      "🔄 <b>Cuota renovada</b>
      Ya tienes cuota otra vez: <b>Antigravity</b> · Claude y GPT — 100 % · próxima renovación lun 26 oct, 15:13"
    `)
  })
})

describe('brokenMessage and recoveredMessage', () => {
  it('includes the error and the fix hint', () => {
    const h: ProviderHealth = {
      provider: 'antigravity',
      consecutiveFailures: 3,
      lastError: { kind: 'auth', message: 'token <expired> & gone' },
      brokenNotified: true,
    }
    expect(brokenMessage(h)).toMatchInlineSnapshot(`
      "⚠️ <b>No puedo leer Antigravity</b>
      Último error: token &lt;expired&gt; &amp; gone
      Ejecuta <code>agy</code> y vuelve a iniciar sesión"
    `)
  })

  it('truncates long error messages to 200 characters', () => {
    const long = 'x'.repeat(500)
    const h: ProviderHealth = { provider: 'cursor', consecutiveFailures: 3, lastError: { kind: 'parse', message: long }, brokenNotified: true }
    expect(brokenMessage(h)).toContain(`Último error: ${'x'.repeat(200)}…\n`)
    expect(brokenMessage(h)).not.toContain('x'.repeat(201))
    const status = statusMessage([], [h], now, ['cursor'])
    expect(status).toContain(`no puedo leerlo: ${'x'.repeat(200)}…`)
    expect(status).not.toContain('x'.repeat(201))
  })

  it('has a hint for every provider', () => {
    for (const p of Object.keys(PROVIDER_LABELS) as ProviderId[]) expect(FIX_HINTS[p].length).toBeGreaterThan(0)
  })

  it('announces recovery', () => {
    expect(recoveredMessage('cursor')).toMatchInlineSnapshot(`"✅ <b>Cursor</b> vuelve a funcionar"`)
  })
})

describe('statusMessage', () => {
  it('groups by provider, flags broken, stale and pending renewal', () => {
    const health: ProviderHealth[] = [
      { provider: 'cursor', consecutiveFailures: 3, lastError: { kind: 'auth', message: 'sesión caducada' }, brokenNotified: true },
      { provider: 'antigravity', consecutiveFailures: 0, brokenNotified: false, lastOkAt: '2026-10-20T10:00:00.000Z' },
      { provider: 'copilot', consecutiveFailures: 0, brokenNotified: false, lastOkAt: '2026-10-25T17:30:00.000Z' },
    ]
    const msg = statusMessage(
      [
        tracked({ readAt: '2026-10-20T10:00:00.000Z' }),
        tracked({ provider: 'copilot', quotaId: 'premium', name: 'Premium', window: 'monthly', remainingFraction: 0.724, resetsAt: '2026-10-24T00:00:00.000Z', periodResetAt: '2026-10-24T00:00:00.000Z' }),
        tracked({ provider: 'codex', quotaId: '5h', name: '5 h', window: '5h', remainingFraction: 0.9, resetsAt: '2026-10-25T20:00:00.000Z', periodResetAt: '2026-10-25T20:00:00.000Z' }),
      ],
      health,
      now,
      ['copilot', 'codex', 'cursor', 'antigravity'],
    )
    expect(msg).toMatchInlineSnapshot(`
      "📊 <b>Estado de tus cuotas</b>
      • <b>GitHub Copilot</b> — 72 % · renovación pendiente de leer
      • <b>Codex</b> — 90 % · se renueva dom 25 oct, 21:00 (en 2 h)
      • <b>Cursor</b> — ⚠️ no puedo leerlo: sesión caducada
      • <b>Antigravity</b> — 6 % · se renueva lun 26 oct, 15:13 (en 20 h) · dato de hace 5 d (desactualizado)"
    `)
  })

  it('lists every enabled provider in label order, marking those without data', () => {
    const health: ProviderHealth[] = [{ provider: 'grok', consecutiveFailures: 1, brokenNotified: false, lastError: { kind: 'network', message: 'x' } }]
    const msg = statusMessage(
      [tracked({ provider: 'copilot', quotaId: 'premium', name: 'Premium', window: 'monthly', remainingFraction: 0.5 })],
      health,
      now,
      ['opencode', 'grok', 'copilot', 'kilo', 'antigravity'],
    )
    expect(msg).toMatchInlineSnapshot(`
      "📊 <b>Estado de tus cuotas</b>
      • <b>GitHub Copilot</b> — 50 % · se renueva lun 26 oct, 15:13 (en 20 h)
      • <b>Kilo Code</b> — sin datos
      • <b>Grok</b> — sin datos
      • <b>Antigravity</b> — sin datos del portátil
      • <b>opencode</b> — sin datos del portátil"
    `)
  })

  it('omits providers that are not enabled', () => {
    const msg = statusMessage([tracked({ provider: 'copilot' })], [], now, ['cursor'])
    expect(msg).not.toContain('Copilot')
    expect(msg).toContain('<b>Cursor</b> — sin datos')
  })

  it('handles no enabled providers', () => {
    expect(statusMessage([], [], now, [])).toMatchInlineSnapshot(`
      "📊 <b>Estado de tus cuotas</b>
      Todavía no hay datos."
    `)
  })
})

describe('surplusMessage', () => {
  it('lists plans that stay underused', () => {
    expect(
      surplusMessage([
        { provider: 'cursor', quotaId: 'req', avgUsed: 0.234 },
        { provider: 'kilo', quotaId: 'credits', avgUsed: 0.05 },
      ]),
    ).toMatchInlineSnapshot(`
      "💡 <b>¿Te sobra el plan?</b>
      Los últimos periodos has consumido poco:
      • <b>Cursor</b> — has usado de media un 23 %
      • <b>Kilo Code</b> — has usado de media un 5 %
      Quizá te compense un plan más barato."
    `)
  })

  it('returns empty text when nothing is underused', () => {
    expect(surplusMessage([])).toBe('')
  })
})
