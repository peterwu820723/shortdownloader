import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDownloader } from './server.mjs'

test('公网页面须用本机连接码；其他网站、未配对访问与远程读取连接码均被阻止', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shortdownloader-pair-'))
  const port = 42000 + Math.floor(Math.random() * 5000)
  const app = await createDownloader({ port, web: false, stateDir: path.join(dir, 'state'), downloadDir: path.join(dir, 'video'), bridgeOverride: async()=>({version:'test'}) })
  await app.listen()
  t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true})})
  const endpoint = `http://127.0.0.1:${port}/downloader-api`
  const local = await fetch(endpoint+'/connection')
  const {token} = await local.json()
  assert.match(token,/^[a-f0-9]{64}$/)
  const origin = 'https://shortdownloader.vercel.app'
  assert.equal((await fetch(endpoint+'/health',{headers:{Origin:origin}})).status,403)
  assert.equal((await fetch(endpoint+'/health',{headers:{Origin:'https://evil.example',Authorization:`Bearer ${token}`}})).status,403)
  const headers = {Origin:origin,Authorization:`Bearer ${token}`}
  const paired = await fetch(endpoint+'/health',{headers})
  assert.equal(paired.status,200)
  assert.equal(paired.headers.get('access-control-allow-origin'),origin)
  assert.equal((await paired.json()).ready,true)
  assert.equal((await fetch(endpoint+'/connection',{headers})).status,403)
  assert.equal((await fetch(endpoint+'/connection',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:'{}'})).status,403)
  const preflight = await fetch(endpoint+'/jobs',{method:'OPTIONS',headers:{Origin:origin,'Access-Control-Request-Headers':'authorization,content-type','Access-Control-Request-Private-Network':'true'}})
  assert.equal(preflight.status,204)
  assert.equal(preflight.headers.get('access-control-allow-private-network'),'true')
  await fetch(endpoint+'/connection',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})
  assert.equal((await fetch(endpoint+'/health',{headers})).status,403)
  assert.equal((await fetch(endpoint+'/jobs',{headers:{'Sec-Fetch-Site':'cross-site'}})).status,403)
})
