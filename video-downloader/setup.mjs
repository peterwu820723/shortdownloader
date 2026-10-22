import { spawnSync } from 'node:child_process'

const python = process.env.VIDEO_PYTHON || 'python'
const check = spawnSync(python, ['--version'], { windowsHide: true, stdio: 'inherit' })
if (check.error || check.status !== 0) {
  console.error('请先安装 Python 3.10 或更高版本，并将 python 加入 PATH。也可以设置 VIDEO_PYTHON。')
  process.exit(1)
}
const result = spawnSync(python, ['-m', 'pip', 'install', 'yt-dlp>=2026.8.19', 'imageio-ffmpeg>=0.6.0'], { windowsHide: true, stdio: 'inherit' })
if (result.error || result.status !== 0) process.exit(1)
console.log('\n下载组件安装完成。运行 npm run video:dev，然后打开 http://127.0.0.1:5190。')
