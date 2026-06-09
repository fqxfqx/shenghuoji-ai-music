# Auraly AI Music API 接入说明

## 当前接入方式

网站已经改成前端调用本地后端：

- 页面地址：`http://127.0.0.1:8790/index.html`
- 配置检测：`http://127.0.0.1:8790/api/config`
- 生成接口：`POST /api/generate`
- 任务轮询：`GET /api/tasks/{taskId}`
- 智能写歌助手：`POST /api/ai/song-helper`

没有 API Key 时，页面会自动使用浏览器本地演示引擎。

## 免费/低成本文本模型：OpenRouter

用于“生活故事 -> 歌曲提示词/歌词/歌名/风格/声音建议”。

1. 注册 OpenRouter：`https://openrouter.ai/`
2. 创建 API Key：`https://openrouter.ai/settings/keys`
3. 在项目根目录 `.env` 写入：

```text
OPENROUTER_API_KEY=你的_openrouter_key
OPENROUTER_TEXT_MODEL=openrouter/free
```

如果免费模型临时不可用，可以把 `OPENROUTER_TEXT_MODEL` 换成 OpenRouter 上其它 free 或低价模型。

## 优先方案：配置 MiniMax Music API

MiniMax 更适合国内/中文场景，接口支持 `prompt + lyrics` 生成歌曲，当前后端会优先使用它。

1. 申请 MiniMax API Key：`https://platform.minimaxi.com/`
2. 在项目根目录创建 `.env` 文件：

```text
MINIMAX_API_KEY=你的_minimax_api_key
MINIMAX_MUSIC_MODEL=music-2.6
```

3. 重启本地服务：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File work/music-server.ps1 -Root outputs -Port 8790 -HostName +
```

4. 打开：

```text
http://127.0.0.1:8790/index.html
```

## 备选方案：配置 Mureka API

1. 申请 Mureka API Key：`https://platform.mureka.ai/docs/`
2. 在项目根目录创建 `.env` 文件：

```text
MUREKA_API_KEY=你的_api_key
MUREKA_MODEL=auto
```

3. 重启本地服务：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File work/music-server.ps1 -Root outputs -Port 8790 -HostName +
```

4. 打开：

```text
http://127.0.0.1:8790/index.html
```

手机和电脑在同一个 Wi-Fi 下，可打开：

```text
http://192.168.1.160:8790/index.html
```

## 说明

当前后端会按以下优先级选择 provider：

1. `MINIMAX_API_KEY`
2. `MUREKA_API_KEY`
3. 浏览器本地演示引擎

MiniMax 如果返回音频 URL，前端会直接播放；如果返回 hex 音频数据，后端会保存到 `outputs/generated/` 并返回本地播放地址。
