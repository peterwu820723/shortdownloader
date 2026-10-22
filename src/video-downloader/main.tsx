/* eslint-disable react/only-export-components -- Standalone application entry point. */
import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ArrowDown, ArrowDownToLine, ArrowRight, Check, CheckCheck, ChevronRight, CircleHelp, Clock3, ExternalLink, Film, FolderDown, HardDrive, History, Link2, ListVideo, LoaderCircle, LockKeyhole, Plus, RefreshCw, ShieldCheck, Sparkles, Video, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { InputGroup, InputGroupInput, InputGroupAddon } from '@/components/ui/input-group'
import { Field, FieldGroup, FieldLabel, FieldDescription, FieldError, FieldSet, FieldLegend } from '@/components/ui/field'
import { Checkbox } from '@/components/ui/checkbox'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectGroup, SelectItem } from '@/components/ui/select'
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from '@/components/ui/empty'
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert'
import { Progress } from '@/components/ui/progress'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { parseEpisodeRange } from './selection'
import { request, localEngine, engineOrigin, hasConnection, setConnection } from './connection'
import { EngineConnection } from './engine-connection'
import '../index.css'
import './style.css'

type Episode = { id: string; number: number; title: string; url: string | null; locked: boolean }
type Catalog = { id: string; title: string; provider: string; thumbnail?: string; description?: string; total: number; note: string; sourceUrl: string; episodes: Episode[]; accessWarning?: string; requestedEpisode?: number }
type Item = Episode & { status: string; percent: number; bytes: number; speed?: number; eta?: number; message: string }
type Job = { id: string; title: string; provider: string; directory: string; quality: string; status: string; createdAt: string; items: Item[] }
type TikTokLoginState = { status: string; windowOpen: boolean; message: string; browser: string; savedAt: string | null }
type Health = { ready: boolean; message: string; downloadDir: string; version: string; tiktokCookies?: boolean; tiktokLogin?: TikTokLoginState }
type Mode = 'all' | 'first' | 'custom'
const exampleUrl = 'https://www.reelshort.com/movie/the-triplets-final-regret-6aafa7fc530d47585a054f74'
const tikTokExampleUrl = 'https://www.tiktok.com/shortdrama/episode/7689287670527104021/1'
const statusText: Record<string, string> = { queued: '排队中', downloading: '正在下载', completed: '下载完成', partial: '部分完成', failed: '下载失败', unavailable: '暂无可用剧集', cancelled: '已取消', interrupted: '已中断', skipped: '已跳过', pending: '等待中' }
const busy = (job: Job) => ['queued', 'downloading'].includes(job.status)
const size = (bytes = 0) => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`

function CatalogCover({ thumbnail, title }: { thumbnail?: string; title: string }) {
  const [failed, setFailed] = useState(false)
  return thumbnail && !failed ? <img src={thumbnail} referrerPolicy="no-referrer" alt={`${title} 封面`} onError={() => setFailed(true)} /> : <span className="catalog-placeholder" aria-label="短剧封面"><Film /></span>
}

function JobCard({ job, action, pending }: { job: Job; action: (id: string, name: string) => void; pending: string }) {
  const done = job.items.filter(i => i.status === 'completed').length
  const skipped = job.items.filter(i => i.status === 'skipped').length
  const failed = job.items.filter(i => i.status === 'failed').length
  const current = job.items.find(i => i.status === 'downloading')
  const progress = job.items.reduce((total, i) => total + (i.status === 'completed' ? 100 : i.percent || 0), 0) / job.items.length
  return <article className="job-card">
    <div className="job-top"><span className="job-icon"><Film /></span><div className="min-w-0 flex-1"><h3>{job.title}</h3><p>{job.provider} <span>·</span> {job.items.length} 集 <span>·</span> MP4</p></div><Badge variant={job.status === 'failed' ? 'destructive' : 'secondary'}>{statusText[job.status] || job.status}</Badge></div>
    <div className="job-progress-label"><span>{current ? `第 ${current.number} 集 · ${current.message}` : `已保存 ${done} / ${job.items.length} 集`}</span><span>{busy(job) ? `${Math.round(progress)}%` : size(job.items.filter(i => i.status === 'completed').reduce((a, i) => a + i.bytes, 0))}</span></div>
    <Progress value={progress} aria-label={`${job.title} 下载进度`} />
    <div className="job-detail-line"><span>{current?.speed ? `${size(current.speed)}/s` : new Date(job.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span><span>{skipped > 0 && `${skipped} 集已跳过`}{skipped > 0 && failed > 0 && ' · '}{failed > 0 && `${failed} 集失败`}</span></div>
    <details className="job-details"><summary>查看剧集与文件 <ChevronRight /></summary><p className="job-path">保存位置：{job.directory}</p><ul>{job.items.map(i => <li key={i.id}><div><strong>第 {i.number} 集</strong><span>{i.status === 'completed' ? size(i.bytes) : i.message || statusText[i.status]}</span></div>{i.status === 'completed' ? <Button asChild variant="ghost" size="icon-sm"><a href={localEngine ? `/downloader-api/files/${job.id}/${i.number}` : `${engineOrigin}/?view=history`} target={localEngine ? undefined : '_blank'} rel="noreferrer" aria-label={localEngine ? `保存第 ${i.number} 集文件` : `在本机取回第 ${i.number} 集文件`}><ArrowDownToLine /></a></Button> : <Badge variant={i.status === 'failed' ? 'destructive' : 'outline'}>{statusText[i.status]}</Badge>}</li>)}</ul></details>
    {(busy(job) || job.items.some(i => ['failed', 'cancelled'].includes(i.status))) && <div className="job-actions">{busy(job) ? <Button variant="ghost" size="sm" disabled={pending === job.id} onClick={() => action(job.id, 'cancel')}><X data-icon="inline-start" />取消任务</Button> : <Button variant="outline" size="sm" disabled={pending === job.id} onClick={() => action(job.id, 'retry')}><RefreshCw data-icon="inline-start" />重试未完成剧集</Button>}</div>}
  </article>
}

function App() {
  const [view, setView] = useState(new URLSearchParams(location.search).get('view') === 'history' ? 'history' : 'new')
  const [url, setUrl] = useState('')
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [analyzing, setAnalyzing] = useState(false)
  const [creating, setCreating] = useState(false)
  const [mode, setMode] = useState<Mode>('first')
  const [count, setCount] = useState('3')
  const [numbers, setNumbers] = useState<number[]>([])
  const [range, setRange] = useState('')
  const [quality, setQuality] = useState('best')
  const [health, setHealth] = useState<Health | null>(null)
  const [jobs, setJobs] = useState<Job[]>([])
  const [error, setError] = useState('')
  const [rangeError, setRangeError] = useState('')
  const [notice, setNotice] = useState('')
  const [connectionError, setConnectionError] = useState('')
  const [pending, setPending] = useState('')
  const [filter, setFilter] = useState('all')
  const [queueTab, setQueueTab] = useState('active')
  const [sessionBusy, setSessionBusy] = useState(false)
  const [sessionMessage, setSessionMessage] = useState('')
  const [connection, setConnected] = useState(hasConnection)
  async function connectEngine(token: string) {
    setConnection(token)
    try {
      const [h,j] = await Promise.all([request<Health>('/health'),request<Job[]>('/jobs')])
      setHealth(h);setJobs(j);setConnectionError('');setConnected(true)
    } catch (error) {setConnection('');setConnected(false);throw error}
  }
  function disconnectEngine() {
    setConnection('');setConnected(false);setHealth(null);setJobs([]);setCatalog(null);setConnectionError('');setError('')
  }
  useEffect(() => {
    if (!connection) return
    let stopped = false, timer: ReturnType<typeof setTimeout>
    const refresh = async () => {
      try {
        const [h, j] = await Promise.all([request<Health>('/health'), request<Job[]>('/jobs')])
        if (!stopped) { setHealth(h); setJobs(j); setConnectionError('') }
      } catch { if (!stopped) setConnectionError('与本地服务的连接已断开，请确认下载器仍在运行。') }
      if (!stopped) timer = setTimeout(refresh, 1500)
    }
    void refresh()
    return () => { stopped = true; clearTimeout(timer) }
  }, [connection])
  const activeJobs = jobs.filter(busy)
  const completedCount = jobs.reduce((a, j) => a + j.items.filter(i => i.status === 'completed').length, 0)
  let selected: Episode[] = []
  if (catalog) selected = mode === 'all' ? catalog.episodes : mode === 'first' ? catalog.episodes.slice(0, Math.max(0, Number(count))) : catalog.episodes.filter(e => numbers.includes(e.number))
  const lockedCount = selected.filter(i => i.locked).length
  const countInvalid = mode === 'first' && catalog && (!Number.isInteger(Number(count)) || Number(count) < 1 || Number(count) > catalog.total)
  async function analyze(value = url) {
    setAnalyzing(true); setError(''); setNotice(''); setCatalog(null); setRange(''); setRangeError(''); setNumbers([])
    try {
      const parsed = await request<Catalog>('/analyze', { url: value })
      setCatalog(parsed); setCount(String(Math.min(3, parsed.total))); setMode(parsed.requestedEpisode ? 'custom' : 'first')
      if (parsed.requestedEpisode) setNumbers([parsed.requestedEpisode])
    } catch (e) { setError((e as Error).message) }
    finally { setAnalyzing(false) }
  }
  async function start() {
    if (!catalog) return
    setCreating(true); setError(''); setNotice('')
    try {
      await request('/jobs', { catalogId: catalog.id, quality, selection: { mode, count: Number(count), numbers } })
      setJobs(await request<Job[]>('/jobs')); setQueueTab('recent'); setNotice(`已加入下载队列，共 ${selected.length} 集。文件会自动保存到本地。`)
    } catch (e) { setError((e as Error).message) }
    finally { setCreating(false) }
  }
  async function action(id: string, name: string) {
    setPending(id); setError('')
    try { await request(`/jobs/${id}/${name}`, {}); setJobs(await request<Job[]>('/jobs')) }
    catch (e) { setError((e as Error).message) }
    finally { setPending('') }
  }
  function applyRange() {
    try { setNumbers(parseEpisodeRange(range, catalog!.episodes.map(e => e.number))); setRangeError('') }
    catch (e) { setRangeError((e as Error).message) }
  }
  async function updateTikTokSession(file?: File) {
    setSessionBusy(true); setSessionMessage(''); setError('')
    try {
      if (file && file.size > 256 * 1024) throw new Error('Cookie 文件不能超过 256 KB。')
      await request('/tiktok-session', file ? { cookies: await file.text() } : { clear: true })
      setHealth(await request<Health>('/health'))
      setSessionMessage(file ? '已保存 TikTok Cookie，请重新解析链接或重试任务。是否可播放仍以 TikTok 返回结果为准。' : '已清除本工具保存的 TikTok Cookie。')
    } catch (e) { setError((e as Error).message) }
    finally { setSessionBusy(false) }
  }
  async function loginTikTok(action: 'open' | 'sync' | 'close') {
    setSessionBusy(true); setSessionMessage(''); setError('')
    try {
      let target: string | undefined
      try { const parsed = new URL(url); if (/(^|\.)tiktok\.com$/.test(parsed.hostname)) target = parsed.href } catch { /* Use TikTok's official login page. */ }
      await request('/tiktok-login', { action, ...(action === 'open' && target ? { url: target } : {}) })
      setHealth(await request<Health>('/health'))
    } catch (e) { setError((e as Error).message) }
    finally { setSessionBusy(false) }
  }
  const loginState = health?.tiktokLogin
  const loginMessage = loginState?.windowOpen || loginState?.savedAt || ['error', 'timeout'].includes(loginState?.status || '') ? loginState?.message : sessionMessage || loginState?.message
  const jobCards = (list: Job[]) => list.length ? list.map(j => <JobCard key={j.id} job={j} action={action} pending={pending} />) : <Empty className="queue-empty"><EmptyHeader><EmptyMedia variant="icon"><FolderDown /></EmptyMedia><EmptyTitle>还没有下载任务</EmptyTitle><EmptyDescription>解析链接并选择剧集，<br />你的下载会出现在这里。</EmptyDescription></EmptyHeader></Empty>
  return <div className="download-app">
    <aside className="side-nav">
      <a className="brand" href="/" aria-label="ShortDownloader.com首页"><span className="brand-mark"><ArrowDownToLine /></span><div>ShortDownloader<span>.COM</span></div></a>
      <div className="nav-caption">工作空间</div>
      <nav aria-label="主导航"><Button variant={view === 'new' ? 'secondary' : 'ghost'} onClick={() => setView('new')}><Plus data-icon="inline-start" />新建下载</Button><Button variant={view === 'history' ? 'secondary' : 'ghost'} onClick={() => setView('history')}><History data-icon="inline-start" />下载记录<Badge variant="outline">{jobs.length}</Badge></Button><Button variant={view === 'help' ? 'secondary' : 'ghost'} onClick={() => setView('help')}><CircleHelp data-icon="inline-start" />使用说明</Button></nav>
      <div className="side-storage"><span className="storage-icon"><HardDrive /></span><h3>你的内容，本地保存</h3><p>视频直接存入电脑。<br />关闭页面，下载仍会继续。</p><Separator /><span><ShieldCheck />在你的设备上运行</span></div>
      <div className="side-bottom"><span className="small-logo">S</span><div>SHORTDOWNLOADER<span>创作，从好用的工具开始</span></div><span className="version">v1.0</span></div>
    </aside>
    <div className="app-main">
      <header className="topbar"><div className="breadcrumb">创作工具 <ChevronRight /><span>{view === 'history' ? '下载记录' : view === 'help' ? '使用说明' : '视频下载器'}</span></div><div className="engine-status"><span className={cn('status-dot', health?.ready && !connectionError && 'is-ready')} />{connectionError ? '连接已断开' : health?.ready ? '下载引擎就绪' : localEngine ? '正在检查引擎' : '等待连接本机引擎'}<Badge variant="outline">{localEngine ? 'LOCAL' : 'WEB'}</Badge></div></header>
      <main>
        <section className="hero"><div><div className="eyebrow"><span />{view === 'history' ? 'YOUR LOCAL LIBRARY' : view === 'help' ? 'A LITTLE HELP' : 'SAVE THE STORY. KEEP THE MOMENT.'}</div><h1>{view === 'history' ? '每一次下载，都在这里。' : view === 'help' ? '从链接，到你的本地片库。' : <>好故事，<span>留在本地。</span></>}</h1><p>{view === 'history' ? '查看任务进度、重试未完成的剧集，随时取回已保存的视频。' : view === 'help' ? '几个简单步骤，开始收藏你有权下载的视频。' : '粘贴短剧链接，选择想看的集数。剩下的，交给ShortDownloader.com。'}</p></div><div className="hero-art" aria-hidden="true"><div className="art-orbit" /><div className="film-back"><span /><span /><span /></div><div className="film-front"><Film /><span>KEEP IT.<br />PLAY IT.</span><div><ArrowDown /> MP4</div></div><span className="art-spark">✳</span></div></section>
        <EngineConnection connected={!!health && !connectionError} onConnect={connectEngine} onDisconnect={disconnectEngine} />
        {(error || connectionError) && <Alert variant="destructive" className="global-alert"><CircleHelp /><AlertTitle>需要留意一下</AlertTitle><AlertDescription>{error || connectionError}</AlertDescription></Alert>}
        {notice && <Alert className="global-alert"><CheckCheck /><AlertTitle>任务已创建</AlertTitle><AlertDescription>{notice}</AlertDescription></Alert>}
        {health && !health.ready && <Alert className="global-alert"><CircleHelp /><AlertTitle>下载组件尚未安装</AlertTitle><AlertDescription>{health.message} 安装完成后重新启动服务。</AlertDescription></Alert>}
        {view === 'new' && <div className="workspace-grid"><div className="workspace-left">
          <Card className="source-card"><CardHeader><div className="section-heading"><span className="step-number">01</span><CardTitle>添加视频链接</CardTitle><Badge variant="secondary">ReelShort · TikTok</Badge></div><CardDescription>支持 ReelShort、TikTok Short Drama 短剧目录，以及通用视频与播放列表。</CardDescription></CardHeader><CardContent>
            <form onSubmit={e => { e.preventDefault(); void analyze() }}><FieldGroup><Field data-invalid={!!error && !catalog}><FieldLabel htmlFor="video-url" className="sr-only">视频或短剧链接</FieldLabel><div className="url-entry"><InputGroup className="h-12"><InputGroupAddon><Link2 /></InputGroupAddon><InputGroupInput id="video-url" type="url" required placeholder="粘贴 ReelShort、TikTok 短剧或视频链接…" value={url} aria-invalid={!!error && !catalog} disabled={analyzing} onChange={e => { setUrl(e.target.value); setCatalog(null); setError(''); setNotice('') }} /></InputGroup><Button type="submit" size="lg" disabled={analyzing || !url.trim() || !health}>{analyzing ? <LoaderCircle className="animate-spin" data-icon="inline-start" /> : <Sparkles data-icon="inline-start" />}{analyzing ? '解析中…' : '解析链接'}</Button></div><FieldDescription className="example-links">试用链接：<button type="button" className="inline-link" disabled={analyzing || !health} onClick={() => { setUrl(exampleUrl); void analyze(exampleUrl) }}>ReelShort <ArrowRight /></button><button type="button" className="inline-link" disabled={analyzing || !health} onClick={() => { setUrl(tikTokExampleUrl); void analyze(tikTokExampleUrl) }}>TikTok Short Drama <ArrowRight /></button></FieldDescription></Field></FieldGroup></form>
            <details className="tiktok-session" open><summary><LockKeyhole />TikTok 登录 · 自动同步<Badge variant="outline">{health?.tiktokCookies ? '已保存访问状态' : loginState?.windowOpen ? '等待登录' : '尚未同步'}</Badge><ChevronRight /></summary><FieldGroup><Field><FieldLabel>在专用窗口登录，自动保存访问状态</FieldLabel><FieldDescription>点击下方按钮，在 TikTok 官方页面完成登录或验证。系统会自动同步 Cookie，无需导出文件；只使用本工具的独立窗口，登录信息仅供本机下载器使用。</FieldDescription><div className="login-buttons"><Button variant="secondary" disabled={sessionBusy || analyzing || activeJobs.length > 0 || !health} onClick={() => void loginTikTok('open')}>{sessionBusy ? <LoaderCircle className="animate-spin" data-icon="inline-start" /> : <ExternalLink data-icon="inline-start" />}{loginState?.windowOpen ? '查看 TikTok 登录窗口' : health?.tiktokCookies ? '重新登录 TikTok' : '登录 TikTok，自动同步'}</Button>{loginState?.windowOpen && <><Button variant="outline" disabled={sessionBusy || analyzing || activeJobs.length > 0 || !health} onClick={() => void loginTikTok('sync')}><RefreshCw data-icon="inline-start" />立即同步</Button><Button variant="ghost" disabled={sessionBusy} onClick={() => void loginTikTok('close')}>关闭登录窗口</Button></>}{(health?.tiktokCookies || loginState?.windowOpen) && <Button variant="ghost" disabled={sessionBusy || analyzing || activeJobs.length > 0 || !health} onClick={() => void updateTikTokSession()}>清除登录状态</Button>}</div><div className="login-state" role="status" aria-live="polite">{loginState?.status === 'saved' ? <CheckCheck /> : loginState?.windowOpen ? <LoaderCircle className="animate-spin" /> : <ShieldCheck />}<span>{sessionBusy ? '正在处理…' : loginMessage}</span></div>{health?.tiktokCookies && /(^|\.)tiktok\.com/.test(url) && <Button variant="outline" size="sm" className="w-fit" disabled={sessionBusy || analyzing || activeJobs.length > 0 || !health} onClick={() => void analyze()}>使用当前登录状态重新解析<ArrowRight data-icon="inline-end" /></Button>}</Field><details className="tiktok-cookie-fallback"><summary>手动导入 Cookie（高级）</summary><FieldGroup><Field><FieldLabel htmlFor="tiktok-cookies">导入自己的 TikTok cookies.txt</FieldLabel><Input id="tiktok-cookies" type="file" accept=".txt" disabled={sessionBusy || analyzing || activeJobs.length > 0 || !health} onChange={e => { const file = e.target.files?.[0]; if (file) void updateTikTokSession(file); e.target.value = '' }} /><FieldDescription>可选兼容方式：仅接受自己的 Netscape 格式 TikTok Cookie。Cookie 属于登录凭证，请勿分享。</FieldDescription></Field></FieldGroup></details></FieldGroup></details>
            <div className="source-tags"><span><Check />短剧目录自动识别</span><span><Check />支持批量下载</span><span><Check />自动封装 MP4</span></div>
          </CardContent></Card>
          <Card className="episodes-card"><CardHeader><div className="section-heading"><span className="step-number">02</span><CardTitle>选择下载剧集</CardTitle>{catalog && <Badge variant="outline">共 {catalog.total} 集</Badge>}</div><CardDescription>只存几集，或收藏整部故事，由你决定。</CardDescription></CardHeader><CardContent>
            {analyzing ? <div className="catalog-skeleton" role="status" aria-label="正在解析剧集"><Skeleton className="h-28 w-20" /><div className="flex flex-1 flex-col gap-3"><Skeleton className="h-6 w-3/4" /><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-2/3" /></div></div> : !catalog ? <Empty className="catalog-empty"><EmptyHeader><EmptyMedia><div className="empty-film"><Film /><span><Plus /></span></div></EmptyMedia><EmptyTitle>下一部好故事，从一个链接开始</EmptyTitle><EmptyDescription>解析后，这里会显示短剧信息和完整剧集目录。</EmptyDescription></EmptyHeader></Empty> : <>
              <div className="catalog-overview"><CatalogCover key={catalog.id} thumbnail={catalog.thumbnail} title={catalog.title} /><div><Badge variant="secondary">{catalog.provider}</Badge><h2>{catalog.title}</h2><p>{catalog.description || '已识别视频目录，可选择下方集数开始下载。'}</p><a href={catalog.sourceUrl} target="_blank" rel="noreferrer">查看原页面 <ExternalLink /></a></div></div>
              {catalog.accessWarning && <Alert className="catalog-access-warning"><LockKeyhole /><AlertTitle>目录已识别，播放权限待验证</AlertTitle><AlertDescription>{catalog.accessWarning}</AlertDescription></Alert>}
              <FieldGroup><FieldSet><FieldLegend className="sr-only">下载集数</FieldLegend><ToggleGroup type="single" variant="outline" value={mode} onValueChange={v => { if (v) setMode(v as Mode) }} className="selection-modes" aria-label="下载方式"><ToggleGroupItem value="first"><ListVideo />前几集</ToggleGroupItem><ToggleGroupItem value="custom"><CheckCheck />自选集数</ToggleGroupItem><ToggleGroupItem value="all"><Film />全剧下载</ToggleGroupItem></ToggleGroup>
              {mode === 'first' && <Field data-invalid={!!countInvalid} className="count-field"><FieldLabel htmlFor="episode-count">下载前</FieldLabel><Input id="episode-count" type="number" min="1" max={catalog.total} value={count} onChange={e => setCount(e.target.value)} aria-invalid={!!countInvalid} /><span>集 / 共 {catalog.total} 集</span>{countInvalid && <FieldError>请输入 1–{catalog.total} 的整数</FieldError>}</Field>}
              {mode === 'custom' && <><Field data-invalid={!!rangeError}><FieldLabel htmlFor="episode-range">按集数范围选择</FieldLabel><div className="range-entry"><Input id="episode-range" placeholder="例如：1-5, 8, 12-15" value={range} onChange={e => { setRange(e.target.value); setRangeError('') }} aria-invalid={!!rangeError} /><Button variant="outline" onClick={applyRange}>应用范围</Button><Button variant="ghost" onClick={() => { setNumbers([]); setRange(''); setRangeError('') }}>清空</Button></div>{rangeError && <FieldError>{rangeError}</FieldError>}</Field><div className="episode-grid">{catalog.episodes.map(e => <label key={e.id} className={cn('episode-tile', numbers.includes(e.number) && 'is-selected', e.locked && 'is-locked')} title={e.locked ? '网站标记付费；下载时会跳过' : e.title}><Checkbox checked={numbers.includes(e.number)} onCheckedChange={checked => setNumbers(prev => checked ? [...prev, e.number] : prev.filter(n => n !== e.number))} aria-label={`选择第 ${e.number} 集${e.locked ? '（需付费）' : ''}`} /><span>{String(e.number).padStart(2, '0')}</span>{e.locked && <LockKeyhole />}</label>)}</div><p className="muted-hint"><LockKeyhole />锁形标记表示网站付费集数，当前版本会跳过。</p></>}
              {mode === 'all' && <Alert><Film /><AlertTitle>已选择全部 {catalog.total} 集</AlertTitle><AlertDescription>按剧集顺序保存。付费、受保护或不可访问的集数会标注原因。</AlertDescription></Alert>}
              </FieldSet></FieldGroup><p className="catalog-note">{catalog.note}</p>
            </>}
          </CardContent></Card>
          <Card className="settings-card"><CardHeader><div className="section-heading"><span className="step-number">03</span><CardTitle>下载设置</CardTitle></div><CardDescription>保留原视频画质，自动整理到独立短剧文件夹。</CardDescription></CardHeader><CardContent><FieldGroup><div className="settings-row"><Field><FieldLabel htmlFor="quality">视频画质</FieldLabel><Select value={quality} onValueChange={setQuality}><SelectTrigger id="quality" className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="best">最佳可用（推荐）</SelectItem><SelectItem value="1080">最高 1080p</SelectItem><SelectItem value="720">最高 720p</SelectItem><SelectItem value="480">最高 480p</SelectItem></SelectGroup></SelectContent></Select><FieldDescription>取决于源站提供的画质，不做放大。</FieldDescription></Field><Field><FieldLabel>文件格式</FieldLabel><div className="format-display"><Video /><span>MP4 视频</span><Badge variant="outline">通用格式</Badge></div><FieldDescription>按集数命名，保存到对应剧名目录。</FieldDescription></Field></div><Field><FieldLabel>保存到</FieldLabel><div className="save-location"><FolderDown /><span>{health?.downloadDir || '连接引擎后显示本机保存目录'}</span><Badge variant="secondary">本机</Badge></div></Field></FieldGroup></CardContent><CardFooter className="download-footer"><div><strong>已选择 <span>{selected.length}</span> 集</strong><p>{lockedCount ? `${lockedCount} 集标记付费，将跳过` : '准备好，就开始保存故事'}</p></div><Button size="lg" disabled={!catalog || !selected.length || !!countInvalid || creating || !health?.ready || !!connectionError} onClick={() => void start()}>{creating ? <LoaderCircle className="animate-spin" data-icon="inline-start" /> : <ArrowDownToLine data-icon="inline-start" />}{creating ? '正在创建…' : '开始下载'}<ArrowRight data-icon="inline-end" /></Button></CardFooter></Card>
          <p className="permission-note"><ShieldCheck />请下载你拥有版权或已获许可的内容。付费解锁与 DRM 保护不在当前支持范围内。</p>
        </div><aside className="queue-panel"><div className="queue-header"><h2>下载队列 <Badge variant="secondary">{activeJobs.length}</Badge></h2><Button variant="ghost" size="sm" onClick={() => setView('history')}>全部记录<ChevronRight data-icon="inline-end" /></Button></div><Tabs value={queueTab} onValueChange={setQueueTab}><TabsList variant="line" className="w-full"><TabsTrigger value="active">进行中 {activeJobs.length > 0 && `(${activeJobs.length})`}</TabsTrigger><TabsTrigger value="recent">最近任务</TabsTrigger></TabsList><TabsContent value="active">{jobCards(activeJobs)}</TabsContent><TabsContent value="recent">{jobCards(jobs.slice(0, 5))}</TabsContent></Tabs><Separator /><div className="queue-stats"><div><ArrowDownToLine /><strong>{completedCount}</strong><span>已保存剧集</span></div><div><Clock3 /><strong>{activeJobs.length}</strong><span>进行中任务</span></div></div><div className="tip-card"><span>小提示</span><h3>把整部故事，整理好。</h3><p>每部短剧拥有独立文件夹，剧集按 001、002 顺序保存。下载失败时可单独重试，已有文件会保留。</p><span className="tip-film"><ListVideo /></span></div></aside></div>}
        {view === 'history' && <section className="history-section"><div className="history-heading"><h2>所有下载 <Badge variant="secondary">{jobs.length}</Badge></h2><ToggleGroup type="single" value={filter} onValueChange={v => { if (v) setFilter(v) }} variant="outline" aria-label="筛选下载记录"><ToggleGroupItem value="all">全部</ToggleGroupItem><ToggleGroupItem value="active">进行中</ToggleGroupItem><ToggleGroupItem value="finished">已结束</ToggleGroupItem></ToggleGroup></div><div className="history-grid">{jobCards(jobs.filter(j => filter === 'all' || (filter === 'active' ? busy(j) : !busy(j))))}</div></section>}
        {view === 'help' && <div className="help-grid">{[{ icon: Link2, title: '1. 复制并解析链接', body: '在 ReelShort 打开短剧详情页，或在 TikTok 打开 shortdrama 单集，复制链接并解析。TikTok 会加载整剧目录，并默认选中链接对应的集数。' }, { icon: ListVideo, title: '2. 选择几集，或全剧', body: '“前几集”按目录顺序选择；“自选集数”支持逐集勾选或输入 1-5, 8 这样的范围；“全剧下载”会把目录中的全部集数加入任务。' }, { icon: FolderDown, title: '3. 自动保存到电脑', body: `视频会自动保存到 ${health?.downloadDir || '系统下载目录下的 ShortDownloader 文件夹'}。在任务详情中也可点击单集的保存按钮，通过浏览器另存一份。` }, { icon: RefreshCw, title: '4. 中断后继续', body: '保持本地服务运行即可在关闭网页后继续下载。重启服务后，历史记录仍然保留；点击“重试未完成剧集”会保留完整文件，并尝试续传分片。' }, { icon: ShieldCheck, title: '支持范围', body: '已适配 ReelShort、TikTok Short Drama 目录与非 DRM 视频源。TikTok 若需要登录，点击“登录 TikTok，自动同步”，在官方窗口登录后自动保存访问状态。目录识别不代表视频可下载；地区、试看、付费和源站限制会明确提示。' }, { icon: HardDrive, title: '运行与保存位置', body: '线上网页需要先连接本机引擎，也可直接使用本机页面。可以用 VIDEO_DOWNLOAD_DIR 环境变量修改保存位置，修改后需重启服务。长时间下载需要电脑保持唤醒，终端服务保持运行。' }].map(({ icon: Icon, title, body }) => <Card key={title}><CardHeader><Icon /><CardTitle>{title}</CardTitle><CardDescription>{body}</CardDescription></CardHeader><CardContent /><CardFooter><span>ShortDownloader.com · 短剧下载工具</span></CardFooter></Card>)}</div>}
        <footer className="page-footer"><span>ShortDownloader.com <span> / </span> Made for your local library.</span><span><ShieldCheck />本地处理 · 自由整理</span></footer>
      </main>
    </div>
  </div>
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>)
