import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose'
import type { Env } from './env.js'

const remoteKeys = new Map<string, JWTVerifyGetKey>()

function keysFor(domain: string): JWTVerifyGetKey {
  let keys = remoteKeys.get(domain)
  if (keys === undefined) {
    keys = createRemoteJWKSet(new URL(`https://${domain}/cdn-cgi/access/certs`))
    remoteKeys.set(domain, keys)
  }
  return keys
}

export async function verifyAccess(req: Request, env: Env, deps: { jwks?: JWTVerifyGetKey } = {}): Promise<boolean> {
  const token = req.headers.get('cf-access-jwt-assertion')
  if (!token || !env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return false
  try {
    await jwtVerify(token, deps.jwks ?? keysFor(env.ACCESS_TEAM_DOMAIN), {
      issuer: `https://${env.ACCESS_TEAM_DOMAIN}`,
      audience: env.ACCESS_AUD,
      algorithms: ['RS256'],
    })
    return true
  } catch {
    return false
  }
}
