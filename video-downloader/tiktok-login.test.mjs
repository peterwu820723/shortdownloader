import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createTikTokLogin, hasTikTokLogin, browserCookiesToNetscape, netscapeToBrowserCookies } from './tiktok-login.mjs'
import { createDownloader } from './server.mjs'

const fakeSession = { domain: '.tiktok.com', path: '/', name: 'sessionid', value: 'fake-session-for-isolated-test',
  expires: -1, httpOnly: true, secure: true, sameSite: 'None' }

class FakeContext extends EventEmitter {
  jar = []
  closed = false
  reads = []
  navigations = []
  page = { goto: async url => { this.navigations.push(url) }, bringToFront: async () => {},
    isClosed: () => this.closed, evaluate: async () => 'ShortDownloader test browser UA' }
  pages() { return [this.page] }
  async newPage() { return this.page }
  async cookies(urls) { this.reads.push(urls); return this.jar.map(cookie => ({ ...cookie })) }
  async addCookies(cookies) { this.jar.push(...cookies) }
  async close() { this.closed = true; this.emit('close') }
}

async function eventually(predicate, timeout = 2500) {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)) }
  assert.fail('Expected login state did not arrive')
}

test('识别有效 TikTok 登录 Cookie，保留 HttpOnly，过滤其他网站与过期状态', () => {
  assert.equal(hasTikTokLogin([fakeSession]), true)
  assert.equal(hasTikTokLogin([{ ...fakeSession, domain: '.tiktok.com.evil.example' }]), false)
  assert.equal(hasTikTokLogin([{ ...fakeSession, name: 'msToken' }]), false)
  assert.equal(hasTikTokLogin([{ ...fakeSession, expires: 1 }]), false)
  assert.equal(hasTikTokLogin([{ ...fakeSession, value: '' }]), false)
  const text = browserCookiesToNetscape([fakeSession, { ...fakeSession, domain: '.other.example', value: 'do-not-copy' }])
  assert.match(text, /#HttpOnly_\.tiktok\.com/)
  assert.equal(text.includes('do-not-copy'), false)
  const restored = netscapeToBrowserCookies(text)
  assert.equal(restored[0].httpOnly, true); assert.equal(restored[0].expires, -1)
  assert.equal(restored[0].value, fakeSession.value)
})

test('专用窗口打开后自动捕获登录态；API 状态不含 Cookie，关闭窗口保留已保存状态', async t => {
  const context = new FakeContext(), saved = []
  const login = createTikTokLogin({ launch: async () => ({ context, name: 'test Chrome' }),
    saveCookies: (text, meta) => saved.push({ text, meta }), pollMs: 10 })
  t.after(() => login.dispose())
  assert.equal((await login.open()).windowOpen, true)
  assert.equal(login.snapshot().status, 'waiting')
  context.jar = [fakeSession]
  await eventually(() => login.snapshot().status === 'saved')
  assert.equal(saved.length, 1)
  assert.equal(saved[0].meta.userAgent, 'ShortDownloader test browser UA')
  assert.equal(JSON.stringify(login.snapshot()).includes(fakeSession.value), false)
  assert.ok(context.reads.every(urls => urls.length === 3 && urls.every(url => /tiktok|tiktokw/.test(url))))
  context.jar.push({ ...fakeSession, domain: '.other.example', value: 'other-site-value' })
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(saved.length, 1, 'Unrelated cookies must not trigger capture')
  await login.close()
  assert.equal(context.closed, true); assert.equal(login.snapshot().windowOpen, false)
  assert.equal(login.snapshot().status, 'saved')
})

test('并发打开仅创建一个窗口；下载过程中等待同步，结束后自动继续', async t => {
  const context = new FakeContext()
  let launches = 0, busy = false, saves = 0
  const login = createTikTokLogin({ launch: async () => { launches++; return { context, name: 'test' } },
    saveCookies: () => { saves++ }, canSave: () => !busy, pollMs: 10 })
  t.after(() => login.dispose())
  await Promise.all([login.open(), login.open()])
  assert.equal(launches, 1)
  busy = true; context.jar = [fakeSession]
  await eventually(() => login.snapshot().status === 'pending')
  assert.equal(saves, 0)
  busy = false
  await eventually(() => login.snapshot().status === 'saved')
  assert.equal(saves, 1)
})

test('启动失败可重试且错误不暴露内部内容；拒绝非 TikTok 或非 HTTPS 登录地址', async t => {
  const context = new FakeContext()
  let fail = true, launches = 0
  const login = createTikTokLogin({ launch: async () => { launches++; if (fail) throw new Error('private-cookie-value'); return { context, name: 'test' } },
    saveCookies: () => {}, pollMs: 10 })
  t.after(() => login.dispose())
  for (const url of ['https://example.com/login', 'http://www.tiktok.com/login', 'http://127.0.0.1/login']) await assert.rejects(login.open(url))
  assert.equal(launches, 0)
  await assert.rejects(login.open(), error => !error.message.includes('private-cookie-value'))
  assert.equal(JSON.stringify(login.snapshot()).includes('private-cookie-value'), false)
  fail = false
  assert.equal((await login.open()).windowOpen, true)
  await assert.rejects(login.capture(), /尚未检测到/)
})

test('清除时终止正在进行的同步，避免清除后被异步回写', async t => {
  const context = new FakeContext()
  let release, evaluating = false, saves = 0
  context.page.evaluate = () => { evaluating = true; return new Promise(resolve => { release = resolve }) }
  const login = createTikTokLogin({ launch: async () => ({ context, name: 'test' }), saveCookies: () => { saves++ }, pollMs: 10 })
  t.after(() => login.dispose())
  await login.open(); context.jar = [fakeSession]
  await eventually(() => evaluating)
  const closing = login.close({ reset: true })
  release('test UA'); await closing
  assert.equal(saves, 0); assert.equal(login.snapshot().status, 'idle')
  assert.equal(login.snapshot().savedAt, null)
})

test('HTTP 全流程：登录后自动保存，下载请求使用同一 Cookie/UA，清除后停止捕获', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'shortdownloader-auto-login-'))
  const port = 23000 + Math.floor(Math.random() * 10000), context = new FakeContext()
  const stateDir = path.join(directory, 'state')
  let launches = 0, requestOptions, downloadPayload
  const dramaId = '7689287670527104021', itemId = '7689288747057253645'
  const app = await createDownloader({ port, web: false, downloadDir: path.join(directory, 'videos'), stateDir, loginPollMs: 10,
    loginLauncher: async () => { launches++; return { context, name: 'test Chrome' } },
    fetchPageOverride: async (input, _signal, options) => {
      requestOptions = options
      const url = new URL(input)
      return { html: JSON.stringify(url.pathname.includes('/detail/') ? {
        statusCode: 0, dramaInfo: { dramaID: dramaId, dramaName: 'Auto login test', numVideos: 1 },
      } : { statusCode: 0, totalEpisodeCount: 1, hasMore: false, cursor: 1, itemList: [{ id: itemId,
        author: { uniqueId: 'test_author' }, dramaInfo: { dramaID: dramaId, DramaVideoData: { EpisodeNumber: 1 } },
        video: { playAddr: 'https://www.tiktok.com/fixture.mp4', height: 720, width: 480 } }] }) }
    },
    bridgeOverride: async payload => {
      if (payload.operation === 'doctor') return { version: 'test' }
      downloadPayload = payload
      fs.writeFileSync(payload.output + '.mp4', 'fixture-mp4')
      return { filename: payload.output + '.mp4', size: 11 }
    } })
  await app.listen()
  t.after(async () => { await app.close(); fs.rmSync(directory, { recursive: true, force: true }) })
  const api = async (route, body, origin) => {
    const res = await fetch(`http://127.0.0.1:${port}/downloader-api${route}`, { ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(origin ? { Origin: origin } : {}) } })
    return { status: res.status, data: await res.json() }
  }
  assert.equal((await api('/tiktok-login', { action: 'open' }, 'https://evil.example')).status, 403)
  assert.equal(launches, 0)
  assert.equal((await api('/tiktok-login', { action: 'open' })).status, 200)
  assert.equal((await api('/tiktok-login', { action: 'sync' })).status, 409)
  context.jar = [fakeSession, { ...fakeSession, domain: '.other.example', value: 'do-not-store' }]
  await eventually(async () => (await api('/health')).data.tiktokCookies === true)
  const health = (await api('/health')).data
  assert.equal(health.tiktokLogin.status, 'saved')
  assert.equal(JSON.stringify(health).includes(fakeSession.value), false)
  assert.equal(fs.readFileSync(path.join(stateDir, 'tiktok-cookies.txt'), 'utf8').includes('do-not-store'), false)
  const catalog = (await api('/analyze', { url: `https://www.tiktok.com/shortdrama/episode/${dramaId}/1` })).data
  assert.equal(requestOptions.userAgent, 'ShortDownloader test browser UA')
  assert.equal(requestOptions.cookieFile, path.join(stateDir, 'tiktok-cookies.txt'))
  await api('/jobs', { catalogId: catalog.id, quality: 'best', selection: { mode: 'all' } })
  await eventually(async () => (await api('/jobs')).data[0]?.status === 'completed')
  assert.equal(downloadPayload.userAgent, 'ShortDownloader test browser UA')
  assert.equal(downloadPayload.cookieFile, path.join(stateDir, 'tiktok-cookies.txt'))
  assert.equal(fs.readFileSync(path.join(stateDir, 'jobs.json'), 'utf8').includes(fakeSession.value), false)
  await api('/tiktok-session', { clear: true })
  assert.equal(context.closed, true)
  assert.equal(fs.existsSync(path.join(stateDir, 'tiktok-cookies.txt')), false)
  assert.equal(fs.existsSync(path.join(stateDir, 'tiktok-session.json')), false)
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal((await api('/health')).data.tiktokCookies, false)
})

test('真实独立浏览器能够自动获取 HttpOnly Cookie；不会把其他域的 Cookie 同步出去', async t => {
  const { chromium } = await import('playwright')
  let context
  try { context = await chromium.launchPersistentContext('', { channel: 'chrome', headless: true, acceptDownloads: false }) }
  catch { return t.skip('Chrome is not installed; unit and HTTP tests still cover the login lifecycle') }
  const saved = []
  await context.route('https://www.tiktok.com/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Isolated login fixture</h1>' }))
  const login = createTikTokLogin({ launch: async () => ({ context, name: 'isolated test Chrome' }),
    saveCookies: (text, metadata) => saved.push({ text, metadata }), pollMs: 40 })
  t.after(() => login.dispose())
  await login.open()
  const page = context.pages()[0]
  await page.waitForURL('https://www.tiktok.com/login')
  assert.equal(hasTikTokLogin(await context.cookies()), false, 'Temporary context must not inherit a personal browser account')
  await context.addCookies([fakeSession, { ...fakeSession, domain: '.other.example', value: 'unrelated-private-value' }])
  assert.equal((await page.evaluate(() => document.cookie)).includes(fakeSession.value), false, 'HttpOnly session is not readable by web page JavaScript')
  await eventually(() => login.snapshot().status === 'saved', 5000)
  assert.equal(saved[0].text.includes(fakeSession.value), true)
  assert.equal(saved[0].text.includes('unrelated-private-value'), false)
  assert.match(saved[0].metadata.userAgent, /Chrome/)
  assert.equal(JSON.stringify(login.snapshot()).includes(fakeSession.value), false)
})
