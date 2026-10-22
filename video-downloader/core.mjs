import dns from 'node:dns/promises'
import net from 'node:net'

export class AppError extends Error {
  constructor(message, status = 400) { super(message); this.status = status }
}

export function publicAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number)
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0)) ||
      (a === 100 && b >= 64 && b <= 127) || a === 198 && (b === 18 || b === 19))
  }
  // Public IPv6 global unicast only; rejects loopback, mapped IPv4 and link-local.
  return net.isIPv6(address) && /^[23][0-9a-f]{3}:/i.test(address)
}

export async function validateUrl(input, lookup = dns.lookup) {
  let url
  try { url = new URL(input) } catch { throw new AppError('请输入完整的 http:// 或 https:// 视频链接。') }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password ||
      (url.port && !['80', '443'].includes(url.port)) || input.length > 4096) {
    throw new AppError('仅支持不含账号密码的公开 HTTP / HTTPS 链接和标准端口。')
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  if (hostname === 'localhost' || hostname.endsWith('.local') || hostname.endsWith('.localhost')) {
    throw new AppError('不支持本机或内网地址。')
  }
  let addresses
  try { addresses = net.isIP(hostname) ? [{ address: hostname }] : await lookup(hostname, { all: true }) }
  catch { throw new AppError('无法解析网站域名，请检查链接或网络。') }
  if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) throw new AppError('不支持本机或内网地址。')
  url.hash = ''
  return url
}

export const isReelShort = url => /(^|\.)reelshort\.com$/i.test(url.hostname)

export function parseNextData(html) {
  const json = html.match(/<script\b[^>]*\bid=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i)?.[1]
  if (!json) throw new AppError('未找到 ReelShort 剧集数据。网站可能要求登录、限制了访问，或页面结构已更新。', 422)
  try { return JSON.parse(json).props.pageProps }
  catch { throw new AppError('ReelShort 返回的剧集数据无法读取。', 422) }
}

export function decodeHtml(text = '') {
  return text.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"').replace(/&#(?:39|x27);|&apos;/g, "'").replace(/\s+/g, ' ').trim()
}

export function reelCatalog(html, pageUrl) {
  const props = parseNextData(html)
  const data = props.data
  if (!data?.book_id || !Array.isArray(data.online_base) || !data.online_base.length) {
    throw new AppError('请粘贴具体短剧详情页或单集播放页的链接。', 422)
  }
  if (props.web_prohibit) throw new AppError('该短剧暂不允许在网页端播放。', 422)
  const links = [...html.matchAll(/href=["']([^"']*\/episodes\/[^"']+)["']/g)].map(x => x[1].replace(/&amp;/g, '&'))
  const episodes = data.online_base.filter(e => e.serial_number >= 1).map(e => {
    const candidate = links.find(link => link.split('?')[0].endsWith(`-${e.chapter_id}`))
    const url = candidate ? new URL(candidate, pageUrl) : null
    const locked = !!data.paid_start && e.serial_number >= data.paid_start
    return { id: String(e.chapter_id), number: e.serial_number, title: `第 ${e.serial_number} 集`,
      url: url && isReelShort(url) ? url.href : null, locked, thumbnail: e.video_pic || null }
  }).sort((a, b) => a.number - b.number)
  if (!episodes.length || episodes.length > 500) throw new AppError('支持 1–500 集的短剧目录。', 422)
  return { title: data.book_title, provider: 'ReelShort', sourceUrl: pageUrl,
    thumbnail: data.book_pic, description: decodeHtml(data.special_desc).slice(0, 450),
    total: episodes.length, reportedTotal: data.total || episodes.length, episodes,
    note: '公开剧集将在下载时验证视频源。标记付费的集数会跳过；当前版本不接入会员登录。' }
}

export function selectEpisodes(catalog, selection) {
  if (!selection || !['all', 'first', 'custom'].includes(selection.mode)) throw new AppError('请选择下载方式。')
  if (selection.mode === 'all') return catalog.episodes
  if (selection.mode === 'first') {
    const count = Number(selection.count)
    if (!Number.isInteger(count) || count < 1 || count > catalog.episodes.length) throw new AppError(`集数须为 1–${catalog.episodes.length} 的整数。`)
    return catalog.episodes.slice(0, count)
  }
  if (!Array.isArray(selection.numbers)) throw new AppError('请选择目录中存在的集数。')
  const numbers = new Set(selection.numbers)
  if (!numbers.size || [...numbers].some(n => !Number.isInteger(n)) ||
      [...numbers].some(n => !catalog.episodes.some(e => e.number === n))) throw new AppError('请选择目录中存在的集数。')
  return catalog.episodes.filter(e => numbers.has(e.number))
}

export function safeName(value) {
  // eslint-disable-next-line no-control-regex -- Filename sanitization must remove control bytes.
  const clean = String(value).normalize('NFKC').replace(/[<>:"/\\|?*\x00-\x1f%]/g, '_').replace(/[. ]+$/g, '').slice(0, 90)
  return !clean || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(clean) ? `video_${clean}` : clean
}

export function finalStatus(items) {
  if (items.every(x => x.status === 'completed')) return 'completed'
  if (items.some(x => x.status === 'completed')) return 'partial'
  return items.every(x => x.status === 'skipped') ? 'unavailable' : 'failed'
}
