import { randomBytes, timingSafeEqual } from 'node:crypto'

export const WEB_ORIGINS = new Set([
  'https://shortdownloader.com',
  'https://www.shortdownloader.com',
  'https://shortdownloader.vercel.app',
  'https://shortdownloader.xavvi.site',
])

// This capability is scoped to this engine process, never written to disk or URLs.
export function createConnectionGuard({ origins = WEB_ORIGINS } = {}) {
  let token = randomBytes(32).toString('hex')
  return {
    token: () => token,
    rotate: () => { token = randomBytes(32).toString('hex'); return token },
    authorize(req, res, host) {
      const origin = req.headers.origin
      const remote = origin && origin !== `http://${host}`
      if (!remote) return req.headers['sec-fetch-site'] !== 'cross-site' ? 'local' : 'denied'
      if (!origins.has(origin)) return 'denied'
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Vary', 'Origin')
      if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        res.setHeader('Access-Control-Allow-Private-Network', 'true')
        res.writeHead(204); res.end(); return 'preflight'
      }
      const candidate = req.headers.authorization?.replace(/^Bearer /, '') || ''
      if (!/^[a-f0-9]{64}$/.test(candidate)) return 'denied'
      return timingSafeEqual(Buffer.from(candidate), Buffer.from(token)) ? 'remote' : 'denied'
    },
  }
}
