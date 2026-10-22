# ShortDownloader.com

选择几集，或收藏整部故事。支持 ReelShort、TikTok Short Drama，以及 yt-dlp 支持的视频链接与播放列表。

在线入口：[shortdownloader.xavvi.site](https://shortdownloader.xavvi.site)。品牌域名 ShortDownloader.com 已绑定 Vercel，DNS 配置生效后可使用。

## 网站与本机引擎

这是一个**线上操作界面 + 单用户本机下载引擎**的项目。Vercel 托管静态 React 界面；Node.js、Python / yt-dlp 和 FFmpeg 在用户电脑下载及合并视频。TikTok 登录也在本机独立浏览器窗口中完成。

网站本身不能在未启动本机引擎时下载，也不是多人云端下载服务。本项目不在 Vercel 运行桌面浏览器、长时间下载队列或保存用户的 TikTok Cookie。

### Windows 快速启动

1. 安装 [Node.js 22.19+](https://nodejs.org/) 与 [Python 3.10+](https://www.python.org/downloads/)，安装 Python 时勾选加入 PATH。
2. 在本仓库选择 **Code → Download ZIP**，解压后双击 `start-windows.cmd`。也可通过 Git 克隆。
3. 浏览器打开 <http://127.0.0.1:5190>，可以直接使用全部功能。下载期间保持终端运行、电脑唤醒。
4. 如需在网页操作，点击本机页面的“获取网站连接码”，复制到线上页面并点击“连接引擎”。浏览器询问时允许访问本地网络。

```powershell
git clone https://github.com/peterwu820723/shortdownloader.git
cd shortdownloader
npm ci
npm run setup
npm start
```

macOS / Linux 使用同样的终端命令；系统需要 Python 3.10+ 与 curl，若 Python 命令为 `python3`，先设置 `VIDEO_PYTHON=python3`。TikTok 登录需要已安装 Chrome / Edge，或者执行 `npx playwright install chromium`。

浏览器阻止网页访问本机时，直接使用本机页面即可。线上页面固定连接 `127.0.0.1:5190`；改变 `VIDEO_PORT` 后请使用相应本机页面。

## 功能

- ReelShort 整剧目录、单集链接；前 N 集、自选、`1-5, 8, 12-15` 范围或全剧。
- TikTok `shortdrama/episode/短剧ID/集数` 完整分页目录，64 位字符串 ID 校验，下载前刷新单集媒体。
- 在 TikTok 官方页面自行登录，独立临时 Chrome / Edge 窗口自动同步有效 TikTok Cookie，无需手动导出。
- 最佳可用、最高 1080p / 720p / 480p；逐集 MP4、独立短剧文件夹、真实下载进度、取消与失败重试。
- 本机持久任务历史、异常退出恢复、分片续传；关闭网页后保持引擎运行可继续下载。
- 默认路径 `Downloads/ShortDownloader/`，可用 `VIDEO_DOWNLOAD_DIR` 调整。

## 访问状态与配对

Cookie 仅保存到本机 Git 忽略的 `.video-downloader/tiktok-cookies.txt`，会话元数据仅记录 User-Agent 与时间；不返回前端，不写历史，不上传 Vercel 或 GitHub。本工具不读取用户日常浏览器配置或密码，只处理本工具独立窗口中的 TikTok Cookie。可以在界面清除已保存的访问状态。

引擎仅监听 `127.0.0.1`，校验 Host 与来源。远程操作仅允许 `https://shortdownloader.com`、`https://www.shortdownloader.com`、`https://shortdownloader.vercel.app`、`https://shortdownloader.xavvi.site`，并要求随机 256 位连接码。连接码只在当前引擎进程有效，重启或在本机页面更换后失效；线上页面仅在标签页 sessionStorage 保存它，使用 Authorization 请求头发送到本机，不进入 URL、Git 或云端。其他网站即使有连接码也不在允许来源内。不要将本机端口转发到公网。

从线上任务详情点击取回文件，会打开本机下载记录；视频此前已经自动保存到电脑，可以在本机页面另存。浏览器的本地网络访问策略可能限制线上配对，此时使用本机界面。

## 支持边界

目录识别不代表视频可下载。源站地区、账号权限、试看、下架、付费和 DRM 限制仍然有效。ReelShort 标记的付费集数会跳过；本工具不解锁付费权限或绕过 DRM。TikTok 有效登录也不保证某一视频返回播放源。仅下载你拥有版权或已获许可的内容。

2026-10-21 验证：ReelShort 示例的前两集实际下载并解码成功。TikTok 示例《My CEO and His Cleaning Fiancée》识别 51 集目录，匿名访问没有返回播放源；尚未完成该案例的真实登录后下载验收。

## 开发与部署

```powershell
npm test
npm run lint
npm run build
```

`npm start` 启动本机引擎和 Vite 开发界面；`npm run build` 生成 Vercel 静态站点 `dist/`。Vercel 项目应独立链接本仓库，使用根目录的 `vercel.json`；不要把本机状态文件或下载目录上传。无云端账号密钥或数据库依赖。

解析、队列、取消/重试、URL 校验、Cookie 过滤、登录窗口生命周期、真实 Python 下载桥接和网站配对权限均有测试。完整的引擎实现说明见 [video-downloader/README.md](video-downloader/README.md)。

可选环境变量：`VIDEO_PYTHON`、`VIDEO_FFMPEG`、`VIDEO_DOWNLOAD_DIR`、`VIDEO_PORT`、`VIDEO_BROWSER_EXECUTABLE`。修改后重启引擎。
