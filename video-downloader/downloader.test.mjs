import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { AppError, parseNextData, reelCatalog, selectEpisodes, safeName, publicAddress, validateUrl, finalStatus } from './core.mjs'
import { parseEpisodeRange } from '../src/video-downloader/selection.ts'
import { createDownloader } from './server.mjs'

function movieHtml() {
  const data = { book_id: 'book1', book_title: '测试短剧', paid_start: 3, total: 3,
    online_base: [1, 2, 3].map(n => ({ serial_number: n, chapter_id: `ch${n}`, video_pic: null })) }
  return `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { data } } })}</script>` +
    [1, 2, 3].map(n => `<a href="/episodes/episode-${n}-test-book1-ch${n}">${n}</a>`).join('')
}

test('ReelShort 目录来自真实页面结构，付费集不伪装为可用', () => {
  const catalog = reelCatalog(movieHtml(), 'https://www.reelshort.com/movie/test-book1')
  assert.equal(catalog.title, '测试短剧')
  assert.equal(catalog.episodes.length, 3)
  assert.deepEqual(catalog.episodes.map(e => e.locked), [false, false, true])
  assert.equal(catalog.episodes[1].url, 'https://www.reelshort.com/episodes/episode-2-test-book1-ch2')
  assert.throws(() => parseNextData('<html>login</html>'), AppError)
  assert.equal(reelCatalog(movieHtml().replace('ch2">', 'ch2?x=1&amp;y=2">'), 'https://www.reelshort.com/movie/test-book1').episodes[1].url, 'https://www.reelshort.com/episodes/episode-2-test-book1-ch2?x=1&y=2')
})

test('前 N 集、全剧、自选与范围严格检查', () => {
  const catalog = reelCatalog(movieHtml(), 'https://www.reelshort.com/movie/test-book1')
  assert.equal(selectEpisodes(catalog, { mode: 'all' }).length, 3)
  assert.equal(selectEpisodes(catalog, { mode: 'first', count: 2 }).length, 2)
  assert.deepEqual(selectEpisodes(catalog, { mode: 'custom', numbers: [3, 1, 1] }).map(e => e.number), [1, 3])
  for (const count of [0, -1, 1.5, 4, 'abc']) assert.throws(() => selectEpisodes(catalog, { mode: 'first', count }), AppError)
  for (const numbers of [[], null, {}, [4], ['1']]) assert.throws(() => selectEpisodes(catalog, { mode: 'custom', numbers }), AppError)
  assert.deepEqual(parseEpisodeRange('1-3， 2, 5', [1, 2, 3, 4, 5]), [1, 2, 3, 5])
  for (const range of ['3-1', '0', '6', '1,,2', '1-99999', 'one']) assert.throws(() => parseEpisodeRange(range, [1, 2, 3]))
})

test('拒绝内网、非 HTTP、凭证链接与伪造私有 DNS', async () => {
  for (const address of ['127.0.0.1', '192.168.1.2', '10.0.0.1', '172.31.0.1', '169.254.169.254', '100.64.0.1', '::1', 'fc00::1', '::ffff:127.0.0.1']) assert.equal(publicAddress(address), false)
  for (const url of ['file:///etc/passwd', 'http://localhost', 'http://192.168.1.1', 'https://u:p@example.com', 'http://example.com:3000']) await assert.rejects(validateUrl(url), AppError)
  await assert.rejects(validateUrl('https://private.example', async () => [{ address: '127.0.0.1' }]), AppError)
  assert.equal((await validateUrl('https://public.example/video', async () => [{ address: '8.8.8.8' }])).hostname, 'public.example')
})

test('文件名保持在目录内，只有全成功才显示完成', () => {
  assert.equal(safeName('../My:Drama%/test'), '.._My_Drama__test')
  assert.equal(safeName('CON'), 'video_CON')
  assert.equal(safeName('剧名.'), '剧名')
  assert.equal(finalStatus([{ status: 'completed' }, { status: 'skipped' }]), 'partial')
  assert.equal(finalStatus([{ status: 'completed' }, { status: 'completed' }]), 'completed')
  assert.equal(finalStatus([{ status: 'failed' }]), 'failed')
  assert.equal(finalStatus([{ status: 'skipped' }]), 'unavailable')
})

test('真实 HTTP API：队列、部分失败、重试、文件下载、同源保护、重启历史', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'shortdownloader-test-'))
  const port = 22000 + Math.floor(Math.random() * 12000)
  let failSecond = true, downloadCalls = []
  const fetchPageOverride = async url => ({ url, html: url.includes('/movie/') ? movieHtml() :
    `<script id="__NEXT_DATA__">${JSON.stringify({ props: { pageProps: { data: { chapter_id: url.match(/-(ch\d+)$/)?.[1], serial_number: Number(url.match(/episode-(\d+)/)?.[1]), paid_start: 3,
      video_url: 'https://v-mps.crazymaplestudios.com/test.mp4' } } } })}</script>` })
  const bridgeOverride = async (payload, options) => {
    if (payload.operation === 'doctor') return { version: 'test' }
    if (payload.operation === 'probe') return { title: 'direct', provider: 'generic', entries: [{ id: 'direct', number: 1, url: payload.url, locked: false }] }
    downloadCalls.push(payload.output)
    if (failSecond && payload.output.includes('002')) throw new Error('HTTP 503 temporary failure')
    options?.onEvent?.({ event: 'progress', percent: 40, bytes: 4 })
    await new Promise(resolve => setTimeout(resolve, 20))
    fs.writeFileSync(payload.output + '.mp4', 'mock-mp4-bytes')
    return { filename: payload.output + '.mp4', size: 14 }
  }
  const settings = { port, downloadDir: path.join(directory, 'videos'), stateDir: path.join(directory, 'state'), web: false, bridgeOverride, fetchPageOverride }
  let app = await createDownloader(settings)
  await app.listen()
  t.after(async () => { await app.close(); fs.rmSync(directory, { recursive: true, force: true }) })
  const api = async (route, body, extra = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}/downloader-api${route}`, { ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }), ...extra,
      headers: { Connection: 'close', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra.headers } })
    return { status: response.status, data: await response.json() }
  }
  const wait = async predicate => {
    for (let i = 0; i < 150; i++) {
      const jobs = (await api('/jobs')).data
      if (predicate(jobs)) return jobs
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    throw new Error('Job did not reach expected status')
  }
  const catalog = (await api('/analyze', { url: 'https://www.reelshort.com/movie/test-book1' })).data
  assert.equal(catalog.total, 3)
  assert.equal((await api('/jobs', { catalogId: catalog.id, quality: 'best', selection: { mode: 'all' } })).status, 201)
  let job = (await wait(j => j[0]?.status === 'partial'))[0]
  assert.deepEqual(job.items.map(i => i.status), ['completed', 'failed', 'skipped'])
  assert.equal(downloadCalls.length, 2, 'Paid episode must never reach the media downloader')
  assert.equal((await api('/jobs', { catalogId: catalog.id, quality: 'best', selection: { mode: 'first', count: 99 } })).status, 400)
  failSecond = false
  assert.equal((await api(`/jobs/${job.id}/retry`, {})).status, 200)
  job = (await wait(j => j[0]?.status === 'partial' && j[0].items[1].status === 'completed'))[0]
  assert.equal(downloadCalls.length, 3, 'Completed first episode must not be downloaded again')
  const file = await fetch(`http://127.0.0.1:${port}/downloader-api/files/${job.id}/1`)
  assert.equal(file.status, 200); assert.equal(await file.text(), 'mock-mp4-bytes')
  assert.equal((await api('/jobs', undefined, { headers: { Origin: 'https://evil.example' } })).status, 403)
  assert.equal((await api('/jobs', { catalogId: catalog.id }, { headers: { 'Content-Type': 'text/plain' } })).status, 415)
  const badHost = await new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: '/downloader-api/jobs', headers: { Host: `evil.example:${port}` } }, res => { res.resume(); resolve(res.statusCode) })
    req.on('error', reject)
  })
  assert.equal(badHost, 403)
  assert.equal((await api('/jobs', undefined, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400)
  await app.close()
  app = await createDownloader(settings); await app.listen()
  const history = (await api('/jobs')).data
  assert.equal(history[0].id, job.id); assert.equal(history[0].items[0].status, 'completed')
  fs.unlinkSync(job.items[0].filename)
  const missing = await fetch(`http://127.0.0.1:${port}/downloader-api/files/${job.id}/1`)
  assert.equal(missing.status, 404)
})

test('正在运行的任务可以取消，重试只处理未完成项', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'shortdownloader-cancel-'))
  const port = 35000 + Math.floor(Math.random() * 10000)
  let block = true
  const bridgeOverride = async (payload, options) => {
    if (payload.operation === 'doctor') return { version: 'test' }
    if (payload.operation === 'probe') return { title: 'cancel-test', provider: 'generic', entries: [{ id: '1', number: 1, url: 'https://example.com/test.mp4', locked: false }] }
    if (block) await new Promise((resolve, reject) => { options.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }) })
    fs.writeFileSync(payload.output + '.mp4', 'complete')
    return { filename: payload.output + '.mp4', size: 8 }
  }
  const app = await createDownloader({ port, web: false, downloadDir: path.join(directory, 'videos'), stateDir: path.join(directory, 'state'), bridgeOverride })
  await app.listen()
  t.after(async () => { await app.close(); fs.rmSync(directory, { recursive: true, force: true }) })
  const catalog = await app.analyze('https://example.com/test.mp4')
  const job = app.createJob({ catalogId: catalog.id, quality: 'best', selection: { mode: 'all' } })
  for (let i = 0; i < 100 && job.items[0].status !== 'downloading'; i++) await new Promise(resolve => setTimeout(resolve, 20))
  await new Promise(resolve => setTimeout(resolve, 50))
  const cancel = await fetch(`http://127.0.0.1:${port}/downloader-api/jobs/${job.id}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  assert.equal(cancel.status, 200)
  for (let i = 0; i < 100 && job.status !== 'cancelled'; i++) await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(job.status, 'cancelled'); assert.equal(job.items[0].status, 'cancelled')
  block = false
  await fetch(`http://127.0.0.1:${port}/downloader-api/jobs/${job.id}/retry`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  for (let i = 0; i < 100 && job.status !== 'completed'; i++) await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(job.status, 'completed')
  assert.equal(fs.readFileSync(job.items[0].filename, 'utf8'), 'complete')
})

test('重启保留完整文件，把未完成任务标记为中断，不静默丢弃损坏历史', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'shortdownloader-restart-'))
  const stateDir = path.join(directory, 'state')
  fs.mkdirSync(stateDir)
  const stateFile = path.join(stateDir, 'jobs.json')
  fs.writeFileSync(stateFile, JSON.stringify([{ id: 'old-job', status: 'downloading', items: [
    { id: 'one', number: 1, status: 'completed', percent: 100 },
    { id: 'two', number: 2, status: 'downloading', percent: 42 },
    { id: 'three', number: 3, status: 'pending', percent: 0 },
  ] }]))
  const app = await createDownloader({ web: false, stateDir, downloadDir: path.join(directory, 'videos'), bridgeOverride: async () => ({ version: 'test' }) })
  t.after(async () => { await app.close(); fs.rmSync(directory, { recursive: true, force: true }) })
  assert.equal(app.jobs[0].status, 'interrupted')
  assert.deepEqual(app.jobs[0].items.map(i => i.status), ['completed', 'cancelled', 'cancelled'])
  fs.writeFileSync(stateFile, '{ damaged history')
  await assert.rejects(createDownloader({ web: false, stateDir, downloadDir: path.join(directory, 'videos') }), /下载历史损坏/)
  assert.equal(fs.readFileSync(stateFile, 'utf8'), '{ damaged history')
})
