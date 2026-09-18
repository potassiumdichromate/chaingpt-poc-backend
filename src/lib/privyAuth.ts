import { createPublicKey, verify, type KeyObject } from 'node:crypto';

/**
 * Privy access-token verification (AUTH_MODE=privy), with no extra dependency.
 *
 * Privy issues ES256 JWTs: `iss` "privy.io", `aud` the Privy app id, `sub` the
 * user's DID (did:privy:...). KULT creator ids are those same DIDs, which is what
 * lets the API enforce "a user may only spend credits on their own Agent".
 * The verification key is the ES256 public key from the Privy dashboard.
 */

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

export interface PrivyClaims {
  sub: string;
  iss: string;
  aud: string | string[];
  exp: number;
  iat?: number;
  nbf?: number;
  sid?: string;
}

const LEEWAY_S = 30;
const keyCache = new Map<string, KeyObject>();

function b64url(part: string): Buffer {
  return Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function json(part: string): Record<string, unknown> {
  try {
    return JSON.parse(b64url(part).toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new AuthError('malformed token');
  }
}

export function verifyPrivyToken(
  token: string,
  opts: { appId: string; verificationKey: string; now?: number },
): PrivyClaims {
  if (!opts.appId || !opts.verificationKey) throw new AuthError('privy auth is not configured');

  const parts = token.split('.');
  if (parts.length !== 3) throw new AuthError('malformed token');
  const [h, p, s] = parts as [string, string, string];

  // Pinning the algorithm closes the classic "alg: none" / HMAC-confusion holes.
  if (json(h).alg !== 'ES256') throw new AuthError('unexpected token algorithm');

  let key = keyCache.get(opts.verificationKey);
  if (!key) {
    key = createPublicKey(opts.verificationKey);
    keyCache.set(opts.verificationKey, key);
  }
  const valid = verify('sha256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' }, b64url(s));
  if (!valid) throw new AuthError('invalid token signature');

  const claims = json(p) as unknown as PrivyClaims;
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];

  if (claims.iss !== 'privy.io') throw new AuthError('unexpected token issuer');
  if (!audiences.includes(opts.appId)) throw new AuthError('token issued for another app');
  if (typeof claims.exp !== 'number' || claims.exp + LEEWAY_S < now) throw new AuthError('token expired');
  if (typeof claims.nbf === 'number' && claims.nbf - LEEWAY_S > now) throw new AuthError('token not yet valid');
  if (typeof claims.sub !== 'string' || !claims.sub.startsWith('did:privy:')) throw new AuthError('token has no Privy user');

  return claims;
}
