"""Local yt-dlp bridge. Each stdout line is a JSON event, never a shell command."""
import json
import os
import sys
import time


def emit(data):
    print(json.dumps(data, ensure_ascii=True), flush=True)


class Logger:
    def debug(self, msg):
        pass

    def warning(self, msg):
        pass

    def error(self, msg):
        pass


def main():
    import imageio_ffmpeg
    import yt_dlp
    from yt_dlp.version import __version__
    # Node writes UTF-8 on every OS; Windows Python's default pipe encoding may
    # otherwise corrupt Chinese filenames and non-ASCII output directories.
    payload = json.loads(sys.stdin.buffer.read().decode('utf-8'))
    operation = payload['operation']
    ffmpeg = os.environ.get('VIDEO_FFMPEG') or imageio_ffmpeg.get_ffmpeg_exe()
    if operation == 'doctor':
        emit({'event': 'result', 'version': __version__, 'ffmpeg': ffmpeg})
        return
    options = {
        'quiet': True, 'no_warnings': True, 'logger': Logger(),
        'socket_timeout': 25, 'retries': 2, 'fragment_retries': 2,
        'skip_unavailable_fragments': False, 'ffmpeg_location': ffmpeg,
        'compat_opts': {'no-certifi'}, 'noplaylist': operation == 'download',
    }
    if payload.get('referer'):
        options['http_headers'] = {'Referer': payload['referer']}
    if payload.get('userAgent'):
        options.setdefault('http_headers', {})['User-Agent'] = payload['userAgent']
    if payload.get('cookieFile'):
        options['cookiefile'] = payload['cookieFile']
    if operation == 'probe':
        options.update({'extract_flat': 'in_playlist', 'playlistend': 501})
        with yt_dlp.YoutubeDL(options) as ydl:
            info = ydl.extract_info(payload['url'], download=False)
            entries = info.get('entries')
            if entries is not None:
                entries = list(entries)
                if len(entries) > 500:
                    raise ValueError('播放列表超过 500 集，请使用更小的列表。')
            else:
                entries = [info]
            emit({'event': 'result', 'title': info.get('title') or '视频',
                  'thumbnail': info.get('thumbnail'), 'description': (info.get('description') or '')[:450],
                  'provider': info.get('extractor_key') or '通用视频',
                  'entries': [{'id': str(e.get('id') or i), 'number': i,
                               'title': e.get('title') or '视频',
                               'url': e.get('webpage_url') or e.get('original_url') or e.get('url'),
                               'duration': e.get('duration'), 'locked': bool(e.get('has_drm')),
                               'thumbnail': e.get('thumbnail')}
                              for i, e in enumerate(entries, 1) if e]})
        return
    last_update = [0]

    def progress(event):
        if event['status'] == 'downloading' and time.monotonic() - last_update[0] > 0.4:
            last_update[0] = time.monotonic()
            total = event.get('total_bytes') or event.get('total_bytes_estimate') or 0
            emit({'event': 'progress', 'bytes': event.get('downloaded_bytes', 0),
                  'totalBytes': total, 'speed': event.get('speed'), 'eta': event.get('eta'),
                  'percent': min(98, event.get('downloaded_bytes', 0) / total * 100) if total else 0})
        if event['status'] == 'finished':
            emit({'event': 'progress', 'percent': 99, 'phase': '正在封装 MP4'})

    def postprocess(event):
        emit({'event': 'progress', 'percent': 99, 'phase': '正在封装 MP4'})

    height = payload.get('quality', 'best')
    selector = 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b'
    if height != 'best':
        selector = f'bv*[height<={height}][ext=mp4]+ba[ext=m4a]/b[height<={height}][ext=mp4]/bv*[height<={height}]+ba/b[height<={height}]'
    output = payload['output']
    options.update({'outtmpl': output + '.%(ext)s', 'format': selector,
                    'merge_output_format': 'mp4', 'continuedl': True, 'overwrites': False,
                    'progress_hooks': [progress], 'postprocessor_hooks': [postprocess],
                    'postprocessors': [{'key': 'FFmpegVideoRemuxer', 'preferedformat': 'mp4'}]})
    with yt_dlp.YoutubeDL(options) as ydl:
        if payload.get('sourceInfo'):
            ydl.process_ie_result(payload['sourceInfo'], download=True)
        else:
            ydl.extract_info(payload['url'], download=True)
    filename = output + '.mp4'
    if not os.path.isfile(filename) or not os.path.getsize(filename):
        raise ValueError('未生成完整的 MP4 文件。')
    emit({'event': 'result', 'filename': filename, 'size': os.path.getsize(filename)})


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        emit({'event': 'error', 'message': str(error)[:1600]})
        sys.exit(1)
