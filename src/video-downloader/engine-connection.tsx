import { useState } from 'react'
import { Check, Copy, ExternalLink, HardDrive, Link2, LoaderCircle, RefreshCw, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/ui/card'
import { FieldGroup, Field, FieldLabel, FieldDescription, FieldError } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { localEngine, request } from './connection'

const repository = 'https://github.com/peterwu820723/shortdownloader'
export function EngineConnection({ connected, onConnect, onDisconnect }: {connected:boolean;onConnect:(token:string)=>Promise<void>;onDisconnect:()=>void}) {
  const [code,setCode] = useState('')
  const [localCode,setLocalCode] = useState('')
  const [pending,setPending] = useState(false)
  const [error,setError] = useState('')
  const [copied,setCopied] = useState(false)
  async function localPair(rotate = false) {
    setPending(true);setError('');setCopied(false)
    try { const data=await request<{token:string}>('/connection',rotate ? {} : undefined);setLocalCode(data.token) }
    catch {setError('无法读取连接码，请确认本机引擎仍在运行。')}
    finally {setPending(false)}
  }
  async function connect(e:React.FormEvent) {
    e.preventDefault();setError('')
    if (!/^[a-f0-9]{64}$/.test(code.trim())) {setError('请从本机页面复制完整的 64 位连接码。');return}
    setPending(true)
    try {await onConnect(code.trim());setCode('')}
    catch {setError('连接失败：确认引擎已启动、连接码有效，并允许浏览器访问本地网络。也可直接打开本机页面使用。')}
    finally {setPending(false)}
  }
  return <Card className="connection-card"><CardHeader><div className="section-heading"><HardDrive /><CardTitle>{localEngine ? '本机引擎' : '连接你的下载引擎'}</CardTitle><Badge variant={connected?'secondary':'outline'}>{connected?'已连接':'需要连接'}</Badge></div><CardDescription>网页负责操作，下载与 TikTok 登录在你的电脑完成。视频、Cookie 和任务记录保留在本机。</CardDescription></CardHeader>
    <CardContent>{localEngine ? <FieldGroup><Field><FieldDescription>可以直接在此使用全部功能。如需从线上页面操作，获取连接码，在 ShortDownloader.com 的连接区域粘贴。连接码仅在本次引擎运行期间有效。</FieldDescription><div className="connection-actions"><Button variant="outline" disabled={pending} onClick={()=>void localPair()}><Link2 data-icon="inline-start" />获取网站连接码</Button>{localCode && <Button variant="ghost" disabled={pending} onClick={()=>void localPair(true)}><RefreshCw data-icon="inline-start" />更换连接码</Button>}</div>{localCode && <><FieldLabel htmlFor="local-pair-code">网站连接码（只分享给你信任的页面）</FieldLabel><Input id="local-pair-code" readOnly value={localCode} onFocus={e=>e.target.select()} /><Button variant="secondary" onClick={async()=>{try{await navigator.clipboard.writeText(localCode);setCopied(true)}catch{setError('请选中连接码后手动复制。')}}}>{copied?<Check data-icon="inline-start" />:<Copy data-icon="inline-start" />}{copied?'已复制':'复制连接码'}</Button></>}</Field></FieldGroup> : connected ? <div className="connection-actions"><p><ShieldCheck />已连接此电脑。关闭网页后，保持本机引擎运行即可继续下载。</p><Button variant="outline" onClick={onDisconnect}>断开网页连接</Button></div> : <>
      <ol className="connection-steps"><li><strong>安装并启动引擎</strong><span>首次使用：从 GitHub 下载项目，安装 Node.js 22.19+、Python 3.10+，双击 <code>start-windows.cmd</code>。</span><Button asChild variant="outline" size="sm"><a href={repository} target="_blank" rel="noreferrer">获取本机引擎<ExternalLink data-icon="inline-end" /></a></Button></li><li><strong>获取连接码</strong><span>打开本机页面，点击“获取网站连接码”。</span><Button asChild variant="outline" size="sm"><a href="http://127.0.0.1:5190" target="_blank" rel="noreferrer">打开本机页面<ExternalLink data-icon="inline-end" /></a></Button></li><li><strong>粘贴后连接</strong><span>浏览器询问时，允许本站访问本地网络。也可以直接在本机页面使用下载器。</span></li></ol>
      <form onSubmit={e=>void connect(e)}><FieldGroup><Field data-invalid={!!error}><FieldLabel htmlFor="pair-code">本机连接码</FieldLabel><div className="pair-entry"><Input id="pair-code" type="password" autoComplete="off" placeholder="粘贴本机页面生成的连接码" value={code} onChange={e=>setCode(e.target.value)} aria-invalid={!!error} /><Button type="submit" disabled={pending||!code.trim()}>{pending?<LoaderCircle className="animate-spin" data-icon="inline-start" />:<Link2 data-icon="inline-start" />}{pending?'正在连接…':'连接引擎'}</Button></div><FieldDescription>仅授权本站操作你的引擎；连接码保存在此标签页的会话中，不会发送到 Vercel 或 GitHub。</FieldDescription></Field></FieldGroup></form>
    </>}{error && <FieldError>{error}</FieldError>}</CardContent><CardFooter><span>ReelShort · TikTok Short Drama · 兼容 yt-dlp 的视频链接</span></CardFooter></Card>
}
