const madridFormat = new Intl.DateTimeFormat('es-ES', {
  timeZone: 'Europe/Madrid',
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

export function formatMadrid(iso: string): string {
  const parts = Object.fromEntries(
    madridFormat.formatToParts(new Date(iso)).map((p) => [p.type, p.value.replace('.', '')]),
  )
  return `${parts.weekday} ${parts.day} ${parts.month}, ${parts.hour}:${parts.minute}`
}

export function formatRelative(fromIso: string, toIso: string): string {
  const minutes = Math.max(0, Math.floor((Date.parse(toIso) - Date.parse(fromIso)) / 60000))
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  if (days > 0) return `en ${days} d ${hours} h`
  if (hours > 0) return `en ${hours} h`
  return `en ${minutes} min`
}
