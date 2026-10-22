import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const bridgePath = fileURLToPath(new URL('./bridge.py', import.meta.url))
function run(command, args, input) {
  return new Promise((resolve, reject) => {
    const process = spawn(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    const timer = setTimeout(() => { process.kill(); reject(new Error('Bridge test timed out')) }, 30000)
    process.stdout.on('data', data => { stdout += data.toString() })
    process.stderr.on('data', data => { stderr += data.toString() })
    process.on('error', error => { clearTimeout(timer); reject(error) })
    process.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
    process.stdin.end(input || '')
  })
}

test('真实 Python 下载进程接收预解析视频源，生成可解码 MP4 并保留中文路径', async t => {
  const python = process.env.VIDEO_PYTHON || 'python'
  let doctor
  try {
    const check = await run(python, ['-u', bridgePath], JSON.stringify({ operation: 'doctor' }))
    if (check.code !== 0) return t.skip('Run npm run video:setup to enable the real bridge integration test')
    doctor = JSON.parse(check.stdout.trim())
  } catch { return t.skip('Python downloader components are not installed') }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'shortdownloader-real-bridge-'))
  const clip = path.join(directory, 'source.mp4')
  let server
  t.after(async () => {
    if (server) await new Promise(resolve => server.close(resolve))
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const generated = await run(doctor.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x96:r=10:d=1',
    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-shortest', '-c:v', 'libx264', '-c:a', 'aac', '-y', clip])
  assert.equal(generated.code, 0, generated.stderr)
  const bytes = fs.readFileSync(clip)
  server = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': bytes.length }); res.end(bytes) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const mediaUrl = `http://127.0.0.1:${server.address().port}/fixture.mp4`
  const output = path.join(directory, '001 - 中文剧集')
  // This loopback URL is an isolated test fixture passed directly to the trusted
  // subprocess; the product's public API continues to reject loopback input.
  const download = await run(python, ['-u', bridgePath], JSON.stringify({ operation: 'download', url: 'https://www.tiktok.com/shortdrama/episode/7689287670527104021/1',
    output, quality: 'best', sourceInfo: { id: '7689288747057253645', title: '第 1 集',
      formats: [{ format_id: 'test', url: mediaUrl, ext: 'mp4', width: 64, height: 96 }] } }))
  assert.equal(download.code, 0, download.stdout + download.stderr)
  const result = download.stdout.trim().split('\n').map(line => JSON.parse(line)).find(event => event.event === 'result')
  assert.equal(result.filename, output + '.mp4')
  assert.equal(result.size, bytes.length)
  const decoded = await run(doctor.ffmpeg, ['-v', 'error', '-i', result.filename, '-f', 'null', '-'])
  assert.equal(decoded.code, 0, decoded.stderr)
})
