import http from 'node:http'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { AppError, validateUrl, isReelShort, parseNextData, reelCatalog, selectEpisodes, safeName, finalStatus } from './core.mjs'
import { isTikTok, isTikTokDrama, tikTokCatalog, tikTokEpisode, filterTikTokCookies, TIKTOK_USER_AGENT } from './tiktok.mjs'
import { createTikTokLogin } from './tiktok-login.mjs'
import { createConnectionGuard } from './connection.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.dirname(here)

function processOutput(command, args, { input, signal, timeout = 60_000, onEvent, onChild } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], signal })
    onChild?.(child)
    let stdout = '', stderr = '', line = '', result, failure
    const timer = setTimeout(() => { stopProcess(child); reject(new AppError('请求超时，请稍后重试。', 504)) }, timeout)
    child.stdout.on('data', chunk => {
      stdout += chunk.toString()
      if (stdout.length > 10 * 1024 * 1024) { stopProcess(child); return reject(new AppError('返回数据过大。', 422)) }
      if (onEvent) {
        line += chunk.toString()
        const lines = line.split('\n'); line = lines.pop()
        for (const text of lines) {
          try {
            const event = JSON.parse(text)
            if (event.event === 'result') result = event
            if (event.event === 'error') failure = event.message
            onEvent(event)
          } catch { /* Non-JSON diagnostic lines are not application events. */ }
        }
      }
    })
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4000) })
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('close', code => {
      clearTimeout(timer)
      if (code === 0) resolve(onEvent ? result : stdout)
      else reject(new AppError(failure || stderr || '下载进程已停止。', 422))
    })
    child.stdin.on('error', () => {})
    child.stdin.end(input || '')
  })
}

function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    killer.on('error', () => child.kill())
  } else child.kill('SIGTERM')
}

export async function fetchPage(input, signal, { cookieFile, userAgent } = {}) {
  let url = await validateUrl(input)
  for (let redirect = 0; redirect < 5; redirect++) {
    const output = await processOutput('curl', ['--silent', '--show-error', '--proto', '=http,https',
      '--max-time', '30', '--max-filesize', '8388608', '--user-agent', userAgent || 'Mozilla/5.0 XavviVideo/1.0',
      ...(cookieFile && isTikTok(url) ? ['--cookie', cookieFile] : []),
      '--write-out', '\n__XAVVI_STATUS__%{http_code}\n__XAVVI_REDIRECT__%{redirect_url}', '--url', url.href], { signal, timeout: 35_000 })
    const match = output.match(/\n__XAVVI_STATUS__(\d+)\n__XAVVI_REDIRECT__([^\n]*)$/)
    if (!match) throw new AppError('无法读取网站响应。', 502)
    const status = Number(match[1])
    if (status >= 300 && status < 400 && match[2]) { url = await validateUrl(match[2]); continue }
    if (status !== 200) throw new AppError(`网站返回 HTTP ${status}，可能需要登录、存在地区限制或临时限制了访问。`, 422)
    return { html: output.slice(0, match.index), url: url.href }
  }
  throw new AppError('网站跳转次数过多。', 422)
}

function friendlyError(error) {
  const text = error.message || String(error)
  if (/No module named|ENOENT|not recognized/i.test(text)) return '下载组件未就绪，请运行 npm run video:setup。'
  if (/certificate|CERTIFICATE/i.test(text)) return '证书验证失败。请检查系统证书或使用受信任的网络后重试。'
  if (/403|forbidden/i.test(text)) return '视频源拒绝访问（403），可能需要登录或链接已过期。'
  if (/404|not found/i.test(text)) return '未找到视频源（404），请检查链接或重新解析。'
  if (/DRM|encrypted/i.test(text)) return '该视频使用 DRM 或受保护的加密，当前下载器无法下载。'
  if (/requested format|formats.*available/i.test(text)) return '没有符合所选画质的视频源，请尝试“最佳可用”。'
  return text.replace(/https?:\/\/\S+/g, '[视频源]').slice(0, 400)
}

export async function createDownloader({ port = 5190, downloadDir = process.env.VIDEO_DOWNLOAD_DIR || path.join(os.homedir(), 'Downloads', 'ShortDownloader'),
  stateDir = path.join(root, '.video-downloader'), bridgeOverride, fetchPageOverride, loginLauncher, loginPollMs, web = true } = {}) {
  fs.mkdirSync(stateDir, { recursive: true }); fs.mkdirSync(downloadDir, { recursive: true })
  const stateFile = path.join(stateDir, 'jobs.json')
  let jobs = []
  if (fs.existsSync(stateFile)) {
    // Preserve unreadable history instead of silently replacing it.
    try { jobs = JSON.parse(fs.readFileSync(stateFile, 'utf8')); if (!Array.isArray(jobs)) throw new Error('Invalid state') }
    catch { throw new Error(`下载历史损坏，请先备份并修复 ${stateFile}`) }
  }
  for (const job of jobs) if (['queued', 'downloading'].includes(job.status)) {
    job.status = 'interrupted'
    job.items.filter(e => ['pending', 'downloading'].includes(e.status)).forEach(e => { e.status = 'cancelled'; e.message = '服务已重启，可以重试续传。' })
  }
  const save = () => { fs.writeFileSync(stateFile + '.tmp', JSON.stringify(jobs, null, 2)); fs.renameSync(stateFile + '.tmp', stateFile) }
  save()
  const catalogs = new Map()
  const pageFetch = fetchPageOverride || fetchPage
  const tikTokCookieFile = path.join(stateDir, 'tiktok-cookies.txt')
  const tikTokSessionFile = path.join(stateDir, 'tiktok-session.json')
  const tikTokCookies = () => fs.existsSync(tikTokCookieFile) ? tikTokCookieFile : undefined
  const tikTokUserAgent = () => {
    try {
      const value = JSON.parse(fs.readFileSync(tikTokSessionFile, 'utf8')).userAgent
      return typeof value === 'string' && value.length <= 512 && !/[\r\n]/.test(value) ? value || TIKTOK_USER_AGENT : TIKTOK_USER_AGENT
    } catch { return TIKTOK_USER_AGENT }
  }
  const tikTokFetch = (url, signal) => pageFetch(url, signal, { cookieFile: tikTokCookies(), userAgent: tikTokUserAgent() })
  const bridge = bridgeOverride || ((payload, options = {}) => processOutput(process.env.VIDEO_PYTHON || 'python',
    ['-u', path.join(here, 'bridge.py')], { input: JSON.stringify(payload), onEvent: () => {}, ...options }))
  let active = null, shuttingDown = false, analyzing = false
  function saveTikTokCookies(text, metadata) {
    const cookies = filterTikTokCookies(text)
    fs.writeFileSync(tikTokCookieFile + '.tmp', cookies, { mode: 0o600 })
    fs.renameSync(tikTokCookieFile + '.tmp', tikTokCookieFile)
    if (metadata) {
      const userAgent = typeof metadata.userAgent === 'string' && metadata.userAgent.length <= 512 && !/[\r\n]/.test(metadata.userAgent) ? metadata.userAgent : ''
      fs.writeFileSync(tikTokSessionFile + '.tmp', JSON.stringify({ source: 'browser', savedAt: metadata.savedAt, userAgent }), { mode: 0o600 })
      fs.renameSync(tikTokSessionFile + '.tmp', tikTokSessionFile)
    } else if (fs.existsSync(tikTokSessionFile)) fs.unlinkSync(tikTokSessionFile)
  }
  const tikTokLogin = createTikTokLogin({ saveCookies: saveTikTokCookies,
    loadCookies: () => tikTokCookies() ? fs.readFileSync(tikTokCookieFile, 'utf8') : '',
    canSave: () => !active && !analyzing && !shuttingDown,
    ...(loginLauncher ? { launch: loginLauncher } : {}), ...(loginPollMs ? { pollMs: loginPollMs } : {}) })
  const health = { ready: false, version: '', message: '正在检查下载组件…', downloadDir,
    tiktokCookies: !!tikTokCookies(), tiktokLogin: tikTokLogin.snapshot() }
  async function checkHealth() {
    try {
      const result = await bridge({ operation: 'doctor' })
      health.ready = true; health.version = result.version; health.message = '下载引擎就绪'
    } catch (error) { health.ready = false; health.message = friendlyError(error) }
    return health
  }
  await checkHealth()

  async function analyze(input) {
    if (analyzing) throw new AppError('正在解析另一个链接，请稍后再试。', 429)
    analyzing = true
    try {
      const url = await validateUrl(input)
      let catalog
      if (isTikTokDrama(url)) {
        catalog = await tikTokCatalog(url, tikTokFetch)
      } else if (isReelShort(url)) {
        if (!/\/(movie|episodes)\//.test(url.pathname)) throw new AppError('请粘贴 ReelShort 的短剧详情页或单集播放页链接。')
        let page = await pageFetch(url.href)
        const props = parseNextData(page.html)
        if (!props.data?.online_base) {
          const match = [...page.html.matchAll(/href=["']([^"']*\/movie\/[^"']+)["']/g)]
            .map(m => new URL(m[1].replace(/&amp;/g, '&'), page.url)).find(u => isReelShort(u) && u.pathname.endsWith(`-${props.data?.book_id}`))
          if (!match) throw new AppError('找不到对应短剧目录，请使用短剧详情页链接。', 422)
          page = await pageFetch(match.href)
        }
        catalog = reelCatalog(page.html, page.url)
      } else {
        if (!health.ready) throw new AppError(health.message, 503)
        const data = await bridge({ operation: 'probe', url: url.href,
          ...(isTikTok(url) ? { cookieFile: tikTokCookies(), userAgent: tikTokUserAgent() } : {}) }, { timeout: 120_000 })
        if (!data?.entries?.length) throw new AppError('未发现可用视频或播放列表。', 422)
        catalog = { title: data.title, provider: data.provider, sourceUrl: url.href, thumbnail: data.thumbnail,
          description: data.description, episodes: data.entries, total: data.entries.length,
          note: '由 yt-dlp 解析。具体网站、地区和视频的支持情况以实际解析及下载结果为准。' }
      }
      const id = randomUUID()
      catalogs.set(id, { ...catalog, id })
      if (catalogs.size > 30) catalogs.delete(catalogs.keys().next().value)
      return catalogs.get(id)
    } finally { analyzing = false }
  }

  async function runQueue() {
    if (active || shuttingDown) return
    const job = jobs.find(j => j.status === 'queued')
    if (!job) return
    const control = { job, child: null, cancelled: false, abort: new AbortController() }
    active = control
    job.status = 'downloading'; save()
    try {
      for (const item of job.items) {
        if (control.cancelled) break
        if (['completed', 'skipped'].includes(item.status)) continue
        item.status = 'downloading'; item.message = '正在获取视频源'; item.percent = 0; save()
        try {
          if (item.locked) { item.status = 'skipped'; item.message = '网站标记为付费集数，当前未接入会员登录。'; save(); continue }
          if (!item.url) throw new AppError('目录未提供该集的播放链接。', 422)
          await validateUrl(item.url)
          let mediaUrl = item.url, sourceInfo
          if (job.provider === 'TikTok Short Drama') {
            sourceInfo = await tikTokEpisode(item, tikTokFetch, control.abort.signal)
          }
          if (job.provider === 'ReelShort') {
            const page = await pageFetch(item.url, control.abort.signal)
            const props = parseNextData(page.html)
            const data = props.data
            if (data?.chapter_id !== item.id || data?.serial_number !== item.number) {
              throw new AppError('网站返回的集数与所选剧集不一致，请重新解析目录。', 422)
            }
            if (props.web_prohibit || !data?.video_url || data.has_drm || data.is_drm ||
                (data.paid_start && data.serial_number >= data.paid_start)) {
              item.status = 'skipped'; item.message = '此集需要登录、付费或没有公开的视频源。'; save(); continue
            }
            const media = await validateUrl(data.video_url)
            if (!/(^|\.)crazymaplestudios\.com$/i.test(media.hostname) && !isReelShort(media)) throw new AppError('视频源域名发生变化，请更新 ReelShort 适配器。', 422)
            mediaUrl = media.href
          }
          const output = path.join(job.directory, `${String(item.number).padStart(3, '0')} - ${safeName(item.title)}`)
          fs.mkdirSync(job.directory, { recursive: true })
          const result = await bridge({ operation: 'download', url: mediaUrl, referer: job.sourceUrl, output, quality: job.quality,
            ...(sourceInfo ? { sourceInfo } : {}),
            ...(isTikTok(new URL(item.url)) ? { cookieFile: tikTokCookies(), userAgent: tikTokUserAgent() } : {}) }, {
            signal: control.abort.signal, timeout: 2 * 60 * 60 * 1000,
            onChild: child => { control.child = child },
            onEvent: event => {
              if (event.event === 'progress' && !control.cancelled) {
                item.percent = event.percent || 0; item.bytes = event.bytes || item.bytes || 0
                item.speed = event.speed || 0; item.eta = event.eta; item.message = event.phase || '正在下载'; save()
              }
            },
          })
          if (control.cancelled) { item.status = 'cancelled'; break }
          const filename = path.resolve(result.filename)
          if (!filename.startsWith(path.resolve(job.directory) + path.sep) || !filename.endsWith('.mp4') || !fs.statSync(filename).size) throw new AppError('下载结果无效。', 422)
          item.status = 'completed'; item.percent = 100; item.filename = filename; item.bytes = result.size; item.message = '下载完成'
        } catch (error) {
          item.status = control.cancelled ? 'cancelled' : 'failed'
          item.message = control.cancelled ? '已取消，可重试续传。' : friendlyError(error)
          if (!control.cancelled && error.code === 'TIKTOK_MEDIA_UNAVAILABLE' && job.items.every(i => i.sourceHasMedia === false)) {
            job.items.filter(i => i.status === 'pending').forEach(i => {
              i.status = 'failed'; i.message = '尚未尝试：TikTok 未提供播放地址。请确认可播放或导入自己的 Cookie 后重试。'
            })
            break
          }
        } finally { control.child = null; save() }
      }
    } finally {
      if (control.cancelled) {
        job.status = 'cancelled'
        job.items.filter(i => ['pending', 'downloading'].includes(i.status)).forEach(i => { i.status = 'cancelled'; i.message = '已取消，可重试续传。' })
      } else job.status = finalStatus(job.items)
      job.finishedAt = new Date().toISOString(); save(); active = null
      queueMicrotask(runQueue)
    }
  }

  function createJob(body) {
    if (!health.ready) throw new AppError(health.message, 503)
    const catalog = catalogs.get(body.catalogId)
    if (!catalog) throw new AppError('解析记录已失效，请重新解析链接。', 409)
    if (!['best', '1080', '720', '480'].includes(body.quality)) throw new AppError('请选择有效画质。')
    if (jobs.filter(j => ['queued', 'downloading'].includes(j.status)).length >= 10) throw new AppError('队列已满，请等待现有任务完成。', 429)
    if (jobs.length >= 1000) throw new AppError('下载历史已达 1000 项，请备份历史后清理。', 429)
    const selected = selectEpisodes(catalog, body.selection)
    const id = randomUUID()
    const job = { id, title: catalog.title, provider: catalog.provider, thumbnail: catalog.thumbnail,
      sourceUrl: catalog.sourceUrl, quality: body.quality, status: 'queued', createdAt: new Date().toISOString(),
      directory: path.join(downloadDir, `${safeName(catalog.title)}_${id.slice(0, 8)}`),
      items: selected.map(e => ({ ...e, status: 'pending', percent: 0, bytes: 0, message: '等待下载' })) }
    jobs.push(job); save(); queueMicrotask(runQueue); return job
  }

  const json = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)) }
  const connection = createConnectionGuard()
  let vite
  const server = http.createServer(async (req, res) => {
    const host = req.headers.host
    if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(host)) return json(res, 403, { error: '不允许的访问地址。' })
    const url = new URL(req.url, `http://${host}`)
    if (url.pathname.startsWith('/downloader-api/')) {
      const access = connection.authorize(req, res, host)
      if (access === 'preflight') return
      if (access === 'denied') return json(res, 403, { error: '请在本机页面获取连接码后连接。' })
      try {
        if (url.pathname === '/downloader-api/connection') {
          if (access !== 'local') throw new AppError('连接码只能在本机页面管理。', 403)
          if (req.method === 'GET') return json(res, 200, { token: connection.token() })
          if (req.method === 'POST' && req.headers['content-type']?.startsWith('application/json')) return json(res, 200, { token: connection.rotate() })
          throw new AppError('接口不存在。', 404)
        }
        if (req.method === 'GET' && url.pathname === '/downloader-api/health') {
          health.tiktokCookies = !!tikTokCookies(); health.tiktokLogin = tikTokLogin.snapshot(); return json(res, 200, health)
        }
        if (req.method === 'GET' && url.pathname === '/downloader-api/jobs') return json(res, 200, [...jobs].reverse())
        const fileMatch = url.pathname.match(/^\/downloader-api\/files\/([a-f0-9-]+)\/(\d+)$/)
        if (req.method === 'GET' && fileMatch) {
          const job = jobs.find(j => j.id === fileMatch[1]), item = job?.items.find(i => i.number === Number(fileMatch[2]))
          if (item?.status !== 'completed' || !item.filename || !fs.existsSync(item.filename)) throw new AppError('文件不存在或尚未下载完成。', 404)
          if (!path.resolve(item.filename).startsWith(path.resolve(job.directory) + path.sep)) throw new AppError('文件路径无效。', 403)
          res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': fs.statSync(item.filename).size,
            'Content-Disposition': `attachment; filename="episode-${item.number}.mp4"; filename*=UTF-8''${encodeURIComponent(path.basename(item.filename))}`, 'Cache-Control': 'no-store' })
          const stream = fs.createReadStream(item.filename)
          stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res); return
        }
        if (req.method !== 'POST') throw new AppError('接口不存在。', 404)
        if (!req.headers['content-type']?.startsWith('application/json')) throw new AppError('请使用 JSON 请求。', 415)
        let raw = ''
        const maxBody = url.pathname === '/downloader-api/tiktok-session' ? 300 * 1024 : 32768
        for await (const chunk of req) { raw += chunk.toString(); if (Buffer.byteLength(raw) > maxBody) throw new AppError('请求过大。', 413) }
        let body
        try { body = JSON.parse(raw || '{}'); if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error() }
        catch { throw new AppError('JSON 请求无效。') }
        if (url.pathname === '/downloader-api/tiktok-login') {
          if (body.action === 'open') return json(res, 200, await tikTokLogin.open(body.url))
          if (body.action === 'sync') return json(res, 200, await tikTokLogin.capture())
          if (body.action === 'close') {
            await tikTokLogin.capture().catch(() => {})
            return json(res, 200, await tikTokLogin.close())
          }
          throw new AppError('请选择打开登录窗口、立即同步或关闭窗口。')
        }
        if (url.pathname === '/downloader-api/tiktok-session') {
          if (active || analyzing) throw new AppError('请等待解析和下载结束或取消当前任务后，再更改 TikTok Cookie。', 409)
          const imported = body.clear === true ? null : filterTikTokCookies(body.cookies)
          await tikTokLogin.close({ reset: true })
          if (body.clear === true) {
            if (fs.existsSync(tikTokCookieFile)) fs.unlinkSync(tikTokCookieFile)
            if (fs.existsSync(tikTokSessionFile)) fs.unlinkSync(tikTokSessionFile)
          } else {
            saveTikTokCookies(imported)
          }
          health.tiktokCookies = !!tikTokCookies()
          return json(res, 200, { configured: health.tiktokCookies })
        }
        if (url.pathname === '/downloader-api/analyze') {
          if (typeof body.url !== 'string') throw new AppError('请填写视频链接。')
          return json(res, 200, await analyze(body.url.trim()))
        }
        if (url.pathname === '/downloader-api/health') return json(res, 200, await checkHealth())
        if (url.pathname === '/downloader-api/jobs') return json(res, 201, createJob(body))
        const action = url.pathname.match(/^\/downloader-api\/jobs\/([a-f0-9-]+)\/(cancel|retry)$/)
        if (!action) throw new AppError('接口不存在。', 404)
        const job = jobs.find(j => j.id === action[1])
        if (!job) throw new AppError('任务不存在。', 404)
        if (action[2] === 'cancel') {
          if (!['queued', 'downloading'].includes(job.status)) throw new AppError('该任务已结束。', 409)
          if (active?.job.id === job.id) { active.cancelled = true; stopProcess(active.child); active.abort.abort() }
          else { job.status = 'cancelled'; job.items.filter(i => i.status === 'pending').forEach(i => { i.status = 'cancelled'; i.message = '已取消' }) }
        } else {
          if (active?.job.id === job.id || ['queued', 'downloading', 'completed'].includes(job.status)) throw new AppError('该任务暂不能重试。', 409)
          if (!job.items.some(i => ['failed', 'cancelled'].includes(i.status))) throw new AppError('没有可重试的失败集数。', 409)
          job.items.filter(i => ['failed', 'cancelled'].includes(i.status)).forEach(i => { i.status = 'pending'; i.message = '等待重试'; i.percent = 0 })
          job.status = 'queued'; delete job.finishedAt
        }
        save(); queueMicrotask(runQueue); return json(res, 200, job)
      } catch (error) { if (!res.headersSent) json(res, error.status || 500, { error: friendlyError(error) }) }
      return
    }
    if (!vite) return json(res, 404, { error: 'Not found' })
    if (url.pathname === '/') req.url = '/index.html'
    vite.middlewares(req, res, () => { res.statusCode = 404; res.end('Not found') })
  })
  if (web) {
    const [{ createServer }, { default: react }, { default: tailwind }] = await Promise.all([import('vite'), import('@vitejs/plugin-react'), import('@tailwindcss/vite')])
    vite = await createServer({ configFile: false, root, plugins: [react(), tailwind()],
      resolve: { alias: { '@': path.join(root, 'src') } },
      server: { middlewareMode: true, hmr: { server }, allowedHosts: ['localhost', '127.0.0.1'],
        watch: { ignored: ['**/tmp/**', '**/output/**', '**/.video-downloader/**'] } }, appType: 'mpa' })
  }
  return {
    server, jobs, analyze, createJob, health,
    listen: () => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) }),
    close: async () => {
      shuttingDown = true
      if (active) { active.cancelled = true; stopProcess(active.child); active.abort.abort() }
      await tikTokLogin.dispose()
      await vite?.close()
      await new Promise(resolve => server.close(resolve))
    },
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.VIDEO_PORT || 5190)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('VIDEO_PORT 必须为 1024–65535。')
  const app = await createDownloader({ port })
  await app.listen()
  console.log(`\n  ShortDownloader.com → http://127.0.0.1:${port}\n  保存位置：${app.health.downloadDir}\n  ${app.health.message}\n`)
  const close = async () => { await app.close(); process.exit(0) }
  process.once('SIGINT', close); process.once('SIGTERM', close)
}
