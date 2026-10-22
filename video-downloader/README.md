# ShortDownloader.com · 本地视频下载器

独立 React / Vite / Shadcn 工具，线上页面配合本机下载引擎使用。输入短剧或视频链接，解析目录，选择前 N 集、自选集数、集数范围或全剧，逐集保存为 MP4。

## 启动

需要 Node.js 22+、Python 3.10+、系统 curl 和足够的磁盘空间。Windows 10/11 已内置 curl。

```powershell
npm install
npm run video:setup
npm run video:dev
```

打开 <http://127.0.0.1:5190>。本工具仅监听本机，API 与本机页面同源。Vercel 仅部署静态网页；网站配对和运行方式见仓库根目录 README。

默认保存到当前系统用户的 `Downloads/ShortDownloader/剧名_任务ID/`，单集文件名为 `001 - 第 1 集.mp4`。文件自动写入电脑，任务详情中的按钮可以通过浏览器另存一份。

```powershell
# 可选：自定义保存目录、Python 解释器或端口，然后启动
$env:VIDEO_DOWNLOAD_DIR = 'D:\Videos'
$env:VIDEO_PORT = '5190'
$env:VIDEO_PYTHON = 'python'
npm run video:dev
```

`VIDEO_FFMPEG` 可指定已有的 FFmpeg 可执行文件。未设置时使用 imageio-ffmpeg 提供的本地二进制，TLS 证书验证保持启用；yt-dlp 使用系统受信任证书。

## 支持范围

- **ReelShort**：已根据真实公开网页适配 `movie` 详情页与 `episodes` 单集页。读取 `__NEXT_DATA__` 的 `online_base` 和页面公开集数链接；单集下载前重新获取公开 `video_url`，避免使用过期媒体地址。
- **TikTok Short Drama**：支持 `https://www.tiktok.com/shortdrama/episode/短剧ID/集数`。通过 TikTok 网页使用的 `/api/drama/detail/` 和 `/api/drama/episode/item_list/` 分页读取完整目录；保存原始字符串视频 ID，按 `DramaVideoData.EpisodeNumber` 排序，逐集核对短剧、集数和视频 ID。目录缺页、重复或总数变化会报错，不能将不完整目录当作全剧。
- TikTok 下载前刷新单集媒体，再按需读取对应普通视频页；仅将经过校验的播放源交给下载组件，解决原始 `shortdrama` 链接不被 yt-dlp 识别的问题。TikTok 的临时签名媒体链接不写入下载历史。
- 只有目录不等于可播放。TikTok 没有返回视频源时，界面显示访问提示，任务明确失败；目录中所有集数都没有媒体时，首集确认失败后停止其余无效网络请求，保留可重试结果。试看标记只作提示，不代表拥有完整版或付费权限。
- 标记 `paid_start` 后的付费集数会跳过。ReelShort 未接入会员登录或付费权限验证；不能承诺下载所有付费剧集。无公开源、网页禁止播放、受 DRM 保护的视频会跳过或明确失败。
- **其他网站 / 播放列表 / MP4 / HLS**：由 yt-dlp 解析，具体可用性取决于 yt-dlp 的适配、源站、网络与地区。最多解析 500 个条目；不支持动态追加直播流。画质为上限且取决于源站，不进行画面放大。MP4 是封装格式，不保证所有来源的编码均可由每个播放器播放。
- “全剧”创建目录中全部集数的任务。只有全部所选集数真正写入完整 MP4 才显示“下载完成”；跳过 / 失败会显示“部分完成”或对应失败状态。目录可能不含尚未上线的集数。
- 已下载内容应为你拥有版权或已获许可的内容。

## TikTok 登录与自动同步

1. 在下载器点击 **“登录 TikTok，自动同步”**。工具会打开独立的 Chrome / Edge 登录窗口。
2. 用户在 TikTok 官方页面自行登录，并完成网站要求的验证码或其他验证。工具不读取或记录密码输入。
3. 检测到 TikTok 的登录 Cookie 后，系统自动保存本次访问状态（包括 HttpOnly Cookie），无需导出文件。网页会显示 **“已自动保存 TikTok 登录状态”**。
4. 点击 **“使用当前登录状态重新解析”**，或重试之前的下载任务。是否可播放仍以 TikTok 的实际返回结果为准。

提供“立即同步”作为手动补充，“关闭登录窗口”保留已保存状态，“清除登录状态”关闭专用窗口并删除本工具保存的 Cookie 与会话元数据。清除过程会停止采集任务，避免 Cookie 被后台再次写回。登录窗口最多打开 10 分钟，超时自动关闭；已保存的访问状态保留。服务正常停止时也会关闭专用窗口。

登录窗口使用 Playwright 自动管理的**临时独立浏览器配置**，不会读取、复制或连接用户平时 Chrome / Edge 的配置目录。窗口关闭后由浏览器组件清理临时配置；工具只采集 TikTok 域 Cookie，其他网站的数据不会导入。下次打开专用窗口时，可载入本工具之前保存的 TikTok Cookie，若已失效则重新登录。登录过程中如遇验证码或安全验证，由用户正常完成，工具不绕过验证。

Cookie 保存在 Git 忽略的 `.video-downloader/tiktok-cookies.txt`；`.video-downloader/tiktok-session.json` 只记录浏览器 User-Agent 与保存时间，下载请求沿用该 User-Agent。Cookie 不返回到前端、不写入下载历史或日志。其用途仅为当前本机下载器的 TikTok 请求，不上传第三方服务。Cookie 属于登录凭证，不要分享、提交 Git 或放入 Obsidian。正在解析或下载时，新的登录状态会等待任务结束后同步，避免运行中切换身份。

“手动导入 Cookie（高级）”保留自己导出的 **Netscape 格式 cookies.txt** 兼容入口，只保留有效 TikTok 域数据，过滤其他网站与过期记录。导入表示访问状态已加载，不代表已验证账号或获得付费播放权限。

需要安装 Chrome 或 Edge；均未安装时可运行 `npx playwright install chromium`。可用 `VIDEO_BROWSER_EXECUTABLE` 指定自己的浏览器可执行文件。登录窗口需要本机图形桌面，本工具仍为单用户本地版本，不能直接将此方式用作公网多人网站的登录方案。

仍受 TikTok 的地区、登录、视频下架、试看、付费与 DRM 限制。工具不会解锁付费权限或绕过 DRM。

2026-10-21 实际案例：`https://www.tiktok.com/shortdrama/episode/7689287670527104021/1` 返回《My CEO and His Cleaning Fiancée》共 51 集目录；当时匿名接口与普通视频页均未返回播放地址，不能声称该案例已下载成功。需要该视频在实际访问状态下可播放后继续验收。

## 队列、历史和重试

- 单任务逐集、单队列依次处理，最多 10 个排队 / 运行任务。下载进度来自 yt-dlp 的实际字节与封装状态，不模拟进度。
- 关闭网页后，只要终端服务仍在运行、电脑保持唤醒，下载会继续。
- 任务历史保存在仓库忽略的 `.video-downloader/jobs.json`。重启后正在执行的任务标为“已中断”，手动重试后续传。保留完整文件与 `.part`，yt-dlp 尝试从已有分片继续。
- 取消会终止当前下载子进程；Windows 同时终止其 FFmpeg 子进程。只重试失败 / 取消的集数，完整文件保留；付费跳过的集数不重试。
- 不自动删除下载文件和历史。历史最多 1000 项；达到上限时备份 `.video-downloader/jobs.json` 后再清理。文件缺失时另存接口返回 404。
- 不要将本地端口公开到互联网。这是单用户本地服务；若要部署为多人网站，需要增加身份认证、独立持久任务 Worker、配额、云端存储和更严格的出站网络隔离，不能直接放入短时 Serverless 函数。

## 验证

```powershell
npm run video:test
npm run video:build
npx tsc --noEmit
npm run lint
```

测试覆盖目录 / 付费状态、集数选择、路径净化、非法 URL、同源访问、真实 API 队列生命周期和重启历史。测试使用隔离临时目录与可控下载进程，不访问生产数据库。
