import { AppError, validateUrl } from './core.mjs'

const HOST = 'https://www.tiktok.com'
export const TIKTOK_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
export const isTikTok = url => /(^|\.)tiktok\.com$/i.test(url.hostname)
export const isTikTokDrama = url => isTikTok(url) && /^\/(?:[a-z]{2}(?:-[A-Z]{2})?\/)?shortdrama(?:\/|$)/.test(url.pathname)

export function parseTikTokDramaUrl(input) {
  const url = input instanceof URL ? input : new URL(input)
  const match = url.pathname.match(/^\/(?:[a-z]{2}(?:-[A-Z]{2})?\/)?shortdrama\/episode\/(\d{10,25})\/(\d{1,3})\/?$/)
  if (!isTikTok(url) || !match || Number(match[2]) < 1 || Number(match[2]) > 500) {
    throw new AppError('请使用 TikTok 短剧单集链接，例如 https://www.tiktok.com/shortdrama/episode/短剧ID/1。')
  }
  return { dramaId: match[1], episode: Number(match[2]) }
}

function apiUrl(route, query) {
  const url = new URL(`/api/drama/${route}/`, HOST)
  url.search = new URLSearchParams({ ...query, aid: '1988', language: 'en', region: 'US', storeRegion: 'us' }).toString()
  return url.href
}

async function api(fetcher, route, query, signal) {
  const page = await fetcher(apiUrl(route, query), signal)
  let data
  try { data = JSON.parse(page.html) }
  catch { throw new AppError('TikTok 未返回短剧数据，可能要求登录或验证访问。请先在 TikTok 确认该剧可播放，再重试或导入自己的 Cookie。', 422) }
  const status = data.statusCode ?? data.status_code
  if (status !== 0) {
    throw new AppError(`TikTok 短剧接口返回状态 ${status ?? '未知'}。${data.statusMsg || data.status_msg || '请确认链接、登录状态及当前地区能否播放。'}`, 422)
  }
  return data
}

function metadata(item) {
  const info = item?.dramaInfo
  const videoData = info?.DramaVideoData || info?.dramaVideoData
  return { dramaId: info?.dramaID, number: Number(videoData?.EpisodeNumber ?? videoData?.episodeNumber),
    preview: videoData?.IsPreview === true || videoData?.isPreview === true }
}

function firstUrl(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.find(x => typeof x === 'string') || ''
  if (!value || typeof value !== 'object') return ''
  return firstUrl(value.UrlList || value.urlList || value.url_list || value.src)
}

// Normal web video objects use playAddr/bitrateInfo; alternative CDN URLs retain
// their query signatures. Never write these expiring media URLs into job history.
export function tikTokFormats(item) {
  const video = item?.video || {}
  if (item?.has_drm || video.hasDrm || video.hasDRM || video.drmType || video.drm_type) return []
  const formats = []
  const append = (value, extra = {}) => {
    const media = firstUrl(value)
    if (!media) return
    let url
    try { url = new URL(media) } catch { return }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return
    if (formats.some(f => f.url === url.href)) return
    formats.push({ url: url.href, ext: 'mp4', format_id: String(extra.format_id || `tiktok-${formats.length}`),
      width: Number(extra.width || video.width) || undefined, height: Number(extra.height || video.height) || undefined,
      tbr: Number(extra.bitrate) > 0 ? Number(extra.bitrate) / 1000 : undefined })
  }
  for (const [index, rate] of (video.bitrateInfo || []).entries()) {
    append(rate.PlayAddr || rate.playAddr, { format_id: rate.GearName || rate.gearName || `bitrate-${index}`,
      width: rate.PlayAddr?.Width, height: rate.PlayAddr?.Height, bitrate: rate.Bitrate || rate.bitrate })
  }
  append(video.playAddr)
  append(video.downloadAddr, { format_id: 'download' })
  return formats
}

function ensureItem(item, dramaId, number, expectedId) {
  const meta = metadata(item)
  if (!item || typeof item.id !== 'string' || !/^\d{10,25}$/.test(item.id) ||
      meta.dramaId !== dramaId || !Number.isInteger(meta.number) || meta.number < 1 || meta.number > 500 ||
      (number !== undefined && meta.number !== number) || (expectedId && item.id !== expectedId)) {
    throw new AppError('TikTok 返回的短剧、视频 ID 或集数不一致，请重新解析目录。', 422)
  }
  return meta
}

export async function tikTokCatalog(input, fetcher) {
  const { dramaId, episode } = parseTikTokDramaUrl(input)
  const detail = await api(fetcher, 'detail', { dramaID: dramaId })
  const info = detail.dramaInfo
  if (!info || info.dramaID !== dramaId || !info.dramaName) throw new AppError('TikTok 没有返回匹配的短剧详情。', 422)
  const episodes = new Map(), ids = new Set()
  let cursor = 0, total = Number(info.numVideos), more = true
  if (!Number.isInteger(total) || total < 1 || total > 500) throw new AppError('支持 1–500 集的 TikTok 短剧目录。', 422)
  for (let page = 0; more && page < 22; page++) {
    const data = await api(fetcher, 'episode/item_list', { dramaID: dramaId, cursor: String(cursor), count: '24' })
    if (!Array.isArray(data.itemList) || !data.itemList.length) throw new AppError('TikTok 剧集目录为空或分页不完整，请稍后重新解析。', 422)
    if (Number(data.totalEpisodeCount) !== total) throw new AppError('TikTok 剧集总数发生变化，请重新解析，避免遗漏剧集。', 409)
    for (const item of data.itemList) {
      const meta = ensureItem(item, dramaId)
      if (episodes.has(meta.number) || ids.has(item.id)) throw new AppError('TikTok 返回重复剧集，暂时无法确认完整顺序。', 422)
      const author = item.author?.uniqueId || info.author?.user?.uniqueId
      if (typeof author !== 'string' || !/^[\w.]{1,64}$/.test(author)) throw new AppError('TikTok 未提供有效的原视频作者信息。', 422)
      const formats = tikTokFormats(item)
      episodes.set(meta.number, { id: item.id, number: meta.number, title: `第 ${meta.number} 集`,
        url: `${HOST}/shortdrama/episode/${dramaId}/${meta.number}`, dramaId,
        videoUrl: `${HOST}/@${author}/video/${item.id}`, duration: Number(item.video?.duration) || null,
        locked: false, preview: meta.preview, sourceHasMedia: formats.length > 0,
        thumbnail: firstUrl(item.video?.cover) || null })
      ids.add(item.id)
    }
    if (episodes.size > total) throw new AppError('TikTok 返回的目录超出声明的总集数。', 422)
    more = data.hasMore === true || data.hasMore === 1
    const nextCursor = Number(data.cursor)
    if (more && (!Number.isInteger(nextCursor) || nextCursor <= cursor)) throw new AppError('TikTok 分页游标没有前进，请稍后重试。', 422)
    cursor = nextCursor
  }
  if (more || episodes.size !== total || [...episodes.keys()].some(n => n > total)) {
    throw new AppError(`TikTok 目录未完整返回（${episodes.size}/${total} 集），请重新解析后再下载全剧。`, 422)
  }
  const list = [...episodes.values()].sort((a, b) => a.number - b.number)
  if (!episodes.has(episode)) throw new AppError('该链接指向的集数不在当前短剧目录中。', 422)
  const available = list.filter(e => e.sourceHasMedia).length
  return { provider: 'TikTok Short Drama', dramaId, title: info.dramaName, description: info.description || '',
    sourceUrl: `${HOST}/shortdrama/episode/${dramaId}/${episode}`, requestedEpisode: episode,
    total, reportedTotal: total, episodes: list, availableCount: available,
    thumbnail: list.find(e => e.thumbnail)?.thumbnail || null,
    accessWarning: available ? '' : '目录已识别，但 TikTok 当前没有返回播放地址。请先确认原网页可播放；需要登录时可点击“登录 TikTok，自动同步”，再重新解析或重试任务。',
    note: '按 TikTok 目录的真实视频 ID 和集数下载。下载前重新获取视频源；登录、地区、试看或付费限制会明确提示，不能将试看内容视为完整剧集。' }
}

export async function tikTokEpisode(item, fetcher, signal) {
  const { dramaId, episode } = parseTikTokDramaUrl(item.url)
  if (episode !== item.number || dramaId !== item.dramaId) throw new AppError('TikTok 任务的短剧或集数无效。', 422)
  const data = await api(fetcher, 'episode/item_list', { dramaID: dramaId, cursor: String(item.number - 1), count: '1' }, signal)
  const actual = data.itemList?.find(e => metadata(e).number === item.number)
  ensureItem(actual, dramaId, item.number, item.id)
  let video = actual, formats = tikTokFormats(video)
  // Some responses provide metadata only. The ordinary video page can provide
  // fresh playback data for the same ID without feeding shortdrama URLs to yt-dlp.
  if (!formats.length && item.videoUrl) {
    const canonical = await validateUrl(item.videoUrl)
    if (!isTikTok(canonical) || !canonical.pathname.endsWith(`/video/${item.id}`)) throw new AppError('TikTok 原视频链接无效。', 422)
    const page = await fetcher(canonical.href, signal)
    const match = page.html.match(/<script\b[^>]*id=["']__UNIVERSAL_DATA_FOR_REHYDRATION__["'][^>]*>([\s\S]*?)<\/script>/)
    if (match) {
      let detail
      try { detail = JSON.parse(match[1]).__DEFAULT_SCOPE__?.['webapp.video-detail']?.itemInfo?.itemStruct } catch { /* A login/challenge document has no usable media. */ }
      if (detail) {
        if (detail.id !== item.id) throw new AppError('TikTok 返回了不同视频，已停止下载以防保存错误剧集。', 422)
        if (detail.dramaInfo) ensureItem(detail, dramaId, item.number, item.id)
        video = detail; formats = tikTokFormats(video)
      }
    }
  }
  if (!formats.length) {
    const error = new AppError('TikTok 未提供可下载的播放地址。请确认该集在原网页及当前地区可播放；需要登录时点击“登录 TikTok，自动同步”，完成登录后重试。', 422)
    error.code = 'TIKTOK_MEDIA_UNAVAILABLE'
    throw error
  }
  for (const format of formats) {
    const url = await validateUrl(format.url)
    if (!/(^|\.)(tiktok\.com|tiktokv\.com|tiktokcdn\.com|tiktokcdn-us\.com|tiktokcdn-eu\.com|byteoversea\.com|ibytedtos\.com|tiktokv\.us)$/.test(url.hostname)) {
      throw new AppError('TikTok 视频源域名发生变化，请更新适配器。', 422)
    }
  }
  return { id: item.id, title: item.title, duration: Number(video.video?.duration) || undefined, formats,
    webpage_url: item.videoUrl || item.url, extractor: 'ShortDownloaderTikTokDrama', extractor_key: 'ShortDownloaderTikTokDrama' }
}

export function filterTikTokCookies(text) {
  if (typeof text !== 'string' || text.length > 256 * 1024 || !/^#(?: Netscape)? HTTP Cookie File/m.test(text)) {
    throw new AppError('请导入 Netscape 格式的 cookies.txt 文件（最大 256 KB）。')
  }
  const rows = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || (line.startsWith('#') && !line.startsWith('#HttpOnly_'))) continue
    const fields = line.replace(/^#HttpOnly_/, '').split('\t')
    if (fields.length !== 7 || !/^(TRUE|FALSE)$/.test(fields[1]) || !/^(TRUE|FALSE)$/.test(fields[3]) ||
        !fields[2].startsWith('/') || !/^\d+$/.test(fields[4]) || !fields[5] ||
        [...fields[6]].some(character => character.charCodeAt(0) < 32)) continue
    const domain = fields[0].replace(/^\./, '').toLowerCase()
    if (!/(^|\.)(tiktok\.com|tiktokw\.us|tiktokv\.com)$/.test(domain)) continue
    const expires = Number(fields[4])
    if (expires && expires < Date.now() / 1000) continue
    rows.push(line)
  }
  if (!rows.length) throw new AppError('文件中没有有效的 TikTok Cookie。其他网站的 Cookie 不会导入。')
  return `# Netscape HTTP Cookie File\n${rows.join('\n')}\n`
}
