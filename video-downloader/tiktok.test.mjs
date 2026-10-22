import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseTikTokDramaUrl, isTikTokDrama, tikTokCatalog, tikTokEpisode, tikTokFormats, filterTikTokCookies } from './tiktok.mjs'
import { createDownloader } from './server.mjs'

const dramaId = '7689287670527104021'
const sourceUrl = `https://www.tiktok.com/shortdrama/episode/${dramaId}/1`
const videoId = number => String(7689288747057253645n + BigInt(number - 1))
function entry(number, { media = true } = {}) {
  return { id: videoId(number), author: { uniqueId: 'test_author' },
    dramaInfo: { dramaID: dramaId, DramaVideoData: { EpisodeNumber: number, IsPreview: number < 8 } },
    video: { duration: 176, width: media ? 720 : 0, height: media ? 1280 : 0,
      playAddr: media ? `https://www.tiktok.com/test-media/${number}.mp4?expires=123&signature=abc` : '' } }
}

function fixtureFetcher({ media = true, badCursor = false, badIdentity = false, partial = false } = {}) {
  const calls = []
  const fetcher = async input => {
    const url = new URL(input); calls.push(url)
    if (url.pathname === '/api/drama/detail/') return { html: JSON.stringify({ statusCode: 0, dramaInfo: {
      dramaID: dramaId, dramaName: 'My CEO and His Cleaning Fiancée', numVideos: 51, description: '测试中文剧情',
    } }) }
    if (url.pathname === '/api/drama/episode/item_list/') {
      const cursor = Number(url.searchParams.get('cursor')), count = Number(url.searchParams.get('count'))
      const end = partial ? Math.min(cursor + count, 50) : Math.min(cursor + count, 51)
      const items = Array.from({ length: Math.max(0, end - cursor) }, (_, i) => entry(cursor + i + 1, { media })).reverse()
      if (badIdentity && items.length) items[0].dramaInfo.dramaID = '0000000000000000000'
      return { html: JSON.stringify({ statusCode: 0, totalEpisodeCount: 51, itemList: items,
        cursor: badCursor ? cursor : end, hasMore: !partial && end < 51 }) }
    }
    return { html: '<html>Sign in to TikTok</html>' }
  }
  return { fetcher, calls }
}

test('TikTok Short Drama 链接识别，保持 64 位 ID 精度，拒绝其他域名与错误路径', () => {
  assert.deepEqual(parseTikTokDramaUrl(sourceUrl), { dramaId, episode: 1 })
  assert.deepEqual(parseTikTokDramaUrl(`https://www.tiktok.com/en/shortdrama/episode/${dramaId}/51?share=1`), { dramaId, episode: 51 })
  assert.equal(isTikTokDrama(new URL('https://www.tiktok.com/@creator/video/123')), false)
  for (const url of [sourceUrl.replace('tiktok.com', 'tiktok.com.evil.test'), sourceUrl.replace('/1', '/0'),
    sourceUrl.replace('/1', '/501'), sourceUrl.replace('episode/', 'video/')]) assert.throws(() => parseTikTokDramaUrl(url))
})

test('读取全部 51 集分页，按实际 EpisodeNumber 排序，并保留对应视频 ID', async () => {
  const { fetcher, calls } = fixtureFetcher()
  const catalog = await tikTokCatalog(sourceUrl, fetcher)
  assert.equal(catalog.provider, 'TikTok Short Drama')
  assert.equal(catalog.title, 'My CEO and His Cleaning Fiancée')
  assert.equal(catalog.total, 51); assert.equal(catalog.availableCount, 51)
  assert.deepEqual(catalog.episodes.map(e => e.number), Array.from({ length: 51 }, (_, i) => i + 1))
  assert.equal(catalog.episodes[7].id, videoId(8))
  assert.equal(catalog.episodes[7].videoUrl, `https://www.tiktok.com/@test_author/video/${videoId(8)}`)
  assert.deepEqual(calls.filter(u => u.pathname.includes('item_list')).map(u => u.searchParams.get('cursor')), ['0', '24', '48'])
  assert.equal(JSON.stringify(catalog).includes('signature=abc'), false, 'Signed media URLs must not enter persistent catalog/job records')
})

test('不将目录、试看或无播放地址伪装成完整剧集可下载', async () => {
  const { fetcher } = fixtureFetcher({ media: false })
  const catalog = await tikTokCatalog(sourceUrl, fetcher)
  assert.equal(catalog.availableCount, 0)
  assert.match(catalog.accessWarning, /没有返回播放地址/)
  assert.equal(catalog.episodes[0].preview, true)
  await assert.rejects(tikTokEpisode(catalog.episodes[0], fetcher), e => e.code === 'TIKTOK_MEDIA_UNAVAILABLE')
  for (const config of [{ badCursor: true }, { badIdentity: true }, { partial: true }]) {
    await assert.rejects(tikTokCatalog(sourceUrl, fixtureFetcher(config).fetcher))
  }
})

test('下载前刷新单集媒体，校验短剧/集数/视频 ID，保留签名并处理画质', async () => {
  const { fetcher } = fixtureFetcher()
  const catalog = await tikTokCatalog(sourceUrl, fetcher)
  const info = await tikTokEpisode(catalog.episodes[1], fetcher)
  assert.equal(info.id, videoId(2)); assert.match(info.formats[0].url, /signature=abc/)
  assert.equal(info.formats[0].height, 1280)
  await assert.rejects(tikTokEpisode({ ...catalog.episodes[1], id: videoId(99) }, fetcher), /不一致/)
  const rates = entry(1)
  rates.video.bitrateInfo = [{ GearName: 'h264_720', Bitrate: 900000, PlayAddr: { UrlList: ['https://www.tiktok.com/high.mp4'], Width: 720, Height: 1280 } }]
  assert.equal(tikTokFormats(rates)[0].tbr, 900)
  rates.video.hasDrm = true
  assert.deepEqual(tikTokFormats(rates), [])
})

test('只导入有效 TikTok Netscape Cookie，过滤其他网站和过期数据，不接收错误格式', () => {
  const cookie = '# Netscape HTTP Cookie File\n.tiktok.com\tTRUE\t/\tTRUE\t0\tsessionid\ttest-session-value\n' +
    '.other.example\tTRUE\t/\tTRUE\t0\tprivate\tother-site-value\n' +
    '.tiktok.com\tTRUE\t/\tTRUE\t1\texpired\told-value\n'
  const filtered = filterTikTokCookies(cookie)
  assert.match(filtered, /test-session-value/)
  assert.equal(filtered.includes('other-site-value'), false)
  assert.equal(filtered.includes('old-value'), false)
  assert.throws(() => filterTikTokCookies('sessionid=value'), /Netscape/)
  assert.throws(() => filterTikTokCookies('# Netscape HTTP Cookie File\n'), /没有有效/)
})

test('HTTP 端到端：目录、自选集数、单集刷新、MP4、历史脱敏、Cookie 导入/清除', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'shortdownloader-tiktok-'))
  const port = 22000 + Math.floor(Math.random() * 10000)
  const { fetcher, calls } = fixtureFetcher()
  let sourcePayload
  const app = await createDownloader({ port, web: false, downloadDir: path.join(directory, 'videos'), stateDir: path.join(directory, 'state'),
    fetchPageOverride: fetcher, bridgeOverride: async payload => {
      if (payload.operation === 'doctor') return { version: 'test' }
      assert.ok(payload.sourceInfo?.formats.length, 'TikTok shortdrama must use refreshed media instead of unsupported yt-dlp URL extraction')
      sourcePayload = payload
      fs.writeFileSync(payload.output + '.mp4', 'mp4-test')
      return { filename: payload.output + '.mp4', size: 8 }
    } })
  await app.listen()
  t.after(async () => { await app.close(); fs.rmSync(directory, { recursive: true, force: true }) })
  const api = async (route, body) => {
    const r = await fetch(`http://127.0.0.1:${port}/downloader-api${route}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})
    return { status: r.status, data: await r.json() }
  }
  const imported = await api('/tiktok-session', { cookies: '# Netscape HTTP Cookie File\n.tiktok.com\tTRUE\t/\tTRUE\t0\tsessionid\ttest-session-value\n' })
  assert.equal(imported.status, 200)
  assert.deepEqual(imported.data, { configured: true })
  const catalog = (await api('/analyze', { url: sourceUrl })).data
  const created = await api('/jobs', { catalogId: catalog.id, quality: 'best', selection: { mode: 'custom', numbers: [2] } })
  assert.equal(created.status, 201)
  let job
  for (let i = 0; i < 100; i++) {
    job = (await api('/jobs')).data[0]
    if (job.status === 'completed') break
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.equal(job.status, 'completed'); assert.equal(job.items[0].number, 2)
  assert.equal(sourcePayload.sourceInfo.id, videoId(2))
  assert.match(sourcePayload.cookieFile, /tiktok-cookies\.txt$/)
  assert.ok(calls.some(u => u.searchParams.get('cursor') === '1' && u.searchParams.get('count') === '1'))
  const history = fs.readFileSync(path.join(directory, 'state', 'jobs.json'), 'utf8')
  assert.equal(history.includes('signature=abc'), false); assert.equal(history.includes('test-session-value'), false)
  assert.equal((await api('/tiktok-session', { clear: true })).data.configured, false)
  assert.equal(fs.existsSync(path.join(directory, 'state', 'tiktok-cookies.txt')), false)
})

test('匿名缺少视频源时停止无效批量请求，保留明确结果，重新登录后可重试', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'shortdownloader-tiktok-limited-'))
  const { fetcher, calls } = fixtureFetcher({ media: false })
  const app = await createDownloader({ web: false, downloadDir: path.join(directory, 'videos'), stateDir: path.join(directory, 'state'),
    fetchPageOverride: fetcher, bridgeOverride: async payload => {
      assert.equal(payload.operation, 'doctor', 'No media download should start without a source')
      return { version: 'test' }
    } })
  t.after(async () => { await app.close(); fs.rmSync(directory, { recursive: true, force: true }) })
  const catalog = await app.analyze(sourceUrl)
  const job = app.createJob({ catalogId: catalog.id, quality: 'best', selection: { mode: 'all' } })
  for (let i = 0; i < 100 && job.status !== 'failed'; i++) await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(job.status, 'failed')
  assert.equal(job.items.every(i => i.status === 'failed'), true)
  assert.match(job.items[0].message, /未提供可下载/)
  assert.match(job.items[1].message, /尚未尝试/)
  assert.equal(calls.filter(u => u.pathname.includes('item_list') && u.searchParams.get('count') === '1').length, 1)
})
