export const localEngine = ['127.0.0.1', 'localhost'].includes(window.location.hostname)
export const engineOrigin = localEngine ? window.location.origin : 'http://127.0.0.1:5190'
const key = 'shortdownloader-engine-token'
let token = localEngine ? '' : sessionStorage.getItem(key) || ''
export const hasConnection = () => localEngine || !!token
export function setConnection(value: string) {
  token = value
  if (value) sessionStorage.setItem(key, value)
  else sessionStorage.removeItem(key)
}
export async function request<T>(route: string, body?: unknown): Promise<T> {
  if (!hasConnection()) throw new Error('请先连接本机下载引擎。')
  const res = await fetch(`${engineOrigin}/downloader-api${route}`, {
    cache: 'no-store', credentials: 'omit',
    signal: AbortSignal.timeout(route === '/analyze' ? 130_000 : 20_000),
    ...(body === undefined ? {} : {method:'POST', body:JSON.stringify(body)}),
    headers: {...(body === undefined ? {} : {'Content-Type':'application/json'}), ...(!localEngine ? {Authorization:`Bearer ${token}`} : {})},
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || '请求失败，请稍后重试。')
  return data
}
