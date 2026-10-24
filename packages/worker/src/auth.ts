export async function secretMatches(provided: string | undefined, expected: string): Promise<boolean> {
  if (!expected || provided === undefined) return false
  const digest = (s: string) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  const [a, b] = await Promise.all([digest(provided), digest(expected)])
  return crypto.subtle.timingSafeEqual(a, b)
}
