import { createHash } from 'node:crypto'
import { AppError, validateUrl } from './core.mjs'
import { isTikTok, filterTikTokCookies } from './tiktok.mjs'

const COOKIE_URLS = ['https://www.tiktok.com/', 'https://www.tiktokw.us/', 'https://www.tiktokv.com/']
const SESSION_NAMES = new Set(['sessionid', 'sessionid_ss', 'sid_tt', 'sid_guard'])
const validDomain = domain => /(^|\.)(tiktok\.com|tiktokw\.us|tiktokv\.com)$/.test(String(domain).replace(/^\./, '').toLowerCase())

export function hasTikTokLogin(cookies, now = Date.now() / 1000) {
  return cookies.some(cookie => validDomain(cookie.domain) && SESSION_NAMES.has(cookie.name) && cookie.value &&
    (cookie.expires <= 0 || cookie.expires > now))
}

export function browserCookiesToNetscape(cookies) {
  const rows = cookies.filter(cookie => validDomain(cookie.domain)).map(cookie => {
    const prefix = cookie.httpOnly ? '#HttpOnly_' : ''
    return `${prefix}${cookie.domain}\t${cookie.domain.startsWith('.') ? 'TRUE' : 'FALSE'}\t${cookie.path || '/'}\t${cookie.secure ? 'TRUE' : 'FALSE'}\t${cookie.expires > 0 ? Math.floor(cookie.expires) : 0}\t${cookie.name}\t${cookie.value}`
  })
  return filterTikTokCookies(`# Netscape HTTP Cookie File\n${rows.join('\n')}\n`)
}

export function netscapeToBrowserCookies(text) {
  const filtered = filterTikTokCookies(text)
  return filtered.split(/\r?\n/).filter(line => line && (!line.startsWith('#') || line.startsWith('#HttpOnly_'))).map(line => {
    const httpOnly = line.startsWith('#HttpOnly_')
    const [domain, , cookiePath, secure, expiry, name, value] = line.replace(/^#HttpOnly_/, '').split('\t')
    return { domain, path: cookiePath, secure: secure === 'TRUE', httpOnly,
      expires: Number(expiry) > 0 ? Number(expiry) : -1, name, value, sameSite: 'Lax' }
  })
}

export async function launchTikTokLoginBrowser() {
  const { chromium } = await import('playwright')
  const options = { headless: false, viewport: { width: 1150, height: 850 }, acceptDownloads: false, timeout: 20_000 }
  if (process.env.VIDEO_BROWSER_EXECUTABLE) {
    try { return { context: await chromium.launchPersistentContext('', { ...options, executablePath: process.env.VIDEO_BROWSER_EXECUTABLE }), name: '自定义浏览器' } }
    catch { throw new AppError('无法打开指定浏览器。请检查 VIDEO_BROWSER_EXECUTABLE 设置。', 503) }
  }
  // Empty userDataDir asks Playwright to create and clean up a temporary profile.
  // Never point at the person's regular Chrome/Edge profile or copy its cookies.
  for (const channel of ['chrome', 'msedge', undefined]) {
    try { return { context: await chromium.launchPersistentContext('', { ...options, ...(channel ? { channel } : {}) }),
      name: channel === 'chrome' ? 'Chrome' : channel === 'msedge' ? 'Edge' : 'Chromium' } }
    catch { /* Try the next installed browser, without logging browser internals. */ }
  }
  throw new AppError('未找到可用的登录浏览器。请安装 Chrome 或 Edge，或运行 npx playwright install chromium。', 503)
}

export function createTikTokLogin({ saveCookies, loadCookies = () => '', canSave = () => true,
  launch = launchTikTokLoginBrowser, pollMs = 1500, timeoutMs = 10 * 60 * 1000 } = {}) {
  let context = null, page = null, timer, deadline, checking = null, opening = null
  let generation = 0, fingerprint = '', disposed = false
  const state = { status: 'idle', windowOpen: false, message: '点击按钮，在 TikTok 官方页面完成登录后自动同步。',
    browser: '', savedAt: null }
  const snapshot = () => ({ ...state })
  const clearTimers = () => { clearTimeout(timer); clearTimeout(deadline) }

  async function capture(force = false) {
    if (!context || disposed) return snapshot()
    if (checking) { await checking; return force ? capture(true) : snapshot() }
    const current = context, id = generation
    checking = (async () => {
      let cookies
      try { cookies = await current.cookies(COOKIE_URLS) }
      catch { return snapshot() }
      if (current !== context || id !== generation || disposed) return snapshot()
      if (!hasTikTokLogin(cookies)) {
        state.status = 'waiting'; state.message = '等待登录：请在打开的 TikTok 窗口完成登录或验证。'
        if (force) throw new AppError('尚未检测到 TikTok 登录状态，请先在专用窗口完成登录。', 409)
        return snapshot()
      }
      if (!canSave()) {
        state.status = 'pending'; state.message = '已检测到登录，当前解析或下载结束后自动同步。'
        if (force) throw new AppError('当前正在解析或下载，结束后会自动同步登录状态。', 409)
        return snapshot()
      }
      const text = browserCookiesToNetscape(cookies)
      const digest = createHash('sha256').update(text).digest('hex')
      if (digest !== fingerprint || force) {
        let userAgent = ''
        try { userAgent = await (current.pages().find(candidate => !candidate.isClosed()) || page).evaluate(() => navigator.userAgent) } catch { /* Default request headers remain usable. */ }
        if (current !== context || id !== generation || disposed) return snapshot()
        // Re-check after async browser evaluation: a download may have started.
        if (!canSave()) { state.status = 'pending'; state.message = '已检测到登录，当前解析或下载结束后自动同步。'; return snapshot() }
        await saveCookies(text, { userAgent, source: 'browser', savedAt: new Date().toISOString() })
        if (current !== context || id !== generation || disposed) return snapshot()
        fingerprint = digest; state.savedAt = new Date().toISOString()
      }
      state.status = 'saved'; state.message = '已自动保存 TikTok 登录状态。可以关闭登录窗口，重新解析短剧并下载。'
      return snapshot()
    })().finally(() => { checking = null })
    return checking
  }

  function schedule() {
    clearTimeout(timer)
    if (!context || disposed) return
    timer = setTimeout(async () => {
      try { await capture() }
      catch { state.status = 'error'; state.message = '同步登录状态失败，请点击“立即同步”重试。' }
      schedule()
    }, pollMs)
    timer.unref?.()
  }

  async function close({ captureBeforeClose = false, reset = false } = {}) {
    if (opening) await opening.catch(() => {})
    if (captureBeforeClose && context) await capture(true)
    clearTimers(); generation++
    if (checking) await checking.catch(() => {})
    const current = context; context = null; page = null; fingerprint = ''
    if (current) { try { await current.close() } catch { /* Already closed by the user. */ } }
    state.windowOpen = false
    if (reset) {
      state.status = 'idle'; state.savedAt = null; state.browser = ''; state.message = '已清除本工具保存的 TikTok 登录状态。'
    } else if (state.savedAt) {
      state.status = 'saved'; state.message = 'TikTok 登录状态已保存，可以重新解析短剧。'
    } else { state.status = 'closed'; state.message = '登录窗口已关闭，尚未保存新的登录状态。' }
    return snapshot()
  }

  async function open(input) {
    if (disposed) throw new AppError('登录服务已停止。', 503)
    if (!canSave()) throw new AppError('请等待当前解析或下载结束后，再打开登录窗口。', 409)
    if (opening) return opening
    if (context) {
      try { page = context.pages().find(candidate => !candidate.isClosed()) || await context.newPage(); await page.bringToFront() } catch { /* The user may have just closed the browser. */ }
      return snapshot()
    }
    opening = Promise.resolve().then(async () => {
      let created
      try {
        const url = await validateUrl(input || 'https://www.tiktok.com/login')
        if (!isTikTok(url) || url.protocol !== 'https:') throw new AppError('登录窗口只能从 TikTok 官方 HTTPS 页面打开。')
        state.status = 'opening'; state.message = '正在打开独立 TikTok 登录窗口…'
        const id = ++generation
        const launched = await launch()
        created = launched.context
        if (disposed || id !== generation) { await created.close(); return snapshot() }
        context = created; state.browser = launched.name; state.windowOpen = true
        page = created.pages()[0] || await created.newPage()
        const saved = loadCookies()
        if (saved) { try { await created.addCookies(netscapeToBrowserCookies(saved)) } catch { /* Expired or incompatible stored session: let the user log in again. */ } }
        created.once('close', () => {
          if (context !== created) return
          clearTimers(); generation++; context = null; page = null; state.windowOpen = false
          state.status = state.savedAt ? 'saved' : 'closed'
          state.message = state.savedAt ? 'TikTok 登录状态已保存，可以重新解析短剧。' : '登录窗口已关闭，尚未检测到登录。请重新打开并完成登录。'
        })
        const observePage = candidate => candidate.on?.('framenavigated', () => {
          if (context === created) void capture().catch(() => {})
        })
        created.pages().forEach(observePage)
        created.on('page', observePage)
        state.status = 'waiting'; state.message = '请在专用窗口登录 TikTok。检测到登录后，系统会自动保存 Cookie。'
        deadline = setTimeout(() => {
          void close().then(() => { state.status = 'timeout'; state.message = '登录窗口已超过 10 分钟并关闭，需要时可以重新打开。' })
        }, timeoutMs)
        deadline.unref?.()
        schedule()
        // Do not hold the HTTP request while TikTok loads or performs a challenge.
        void page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {
          if (context === created && state.status !== 'saved') state.message = 'TikTok 页面加载较慢，请在登录窗口检查网络或刷新；完成登录后仍会自动同步。'
        })
        return snapshot()
      } catch (error) {
        if (created) { try { await created.close() } catch { /* Clean up a partially opened browser. */ } }
        context = null; page = null; state.windowOpen = false; state.status = 'error'
        state.message = error instanceof AppError ? error.message : '无法打开 TikTok 登录窗口，请重试或检查本机浏览器。'
        throw new AppError(state.message, error instanceof AppError ? error.status : 503)
      } finally { opening = null }
    })
    return opening
  }

  return { open, capture: () => capture(true), close, snapshot,
    dispose: async () => { disposed = true; await close() } }
}
