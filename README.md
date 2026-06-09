# Shenghuoji AI Music

一个面向普通用户写歌、创作、分享音乐的 AI 音乐网站原型。

## 启动

```bash
npm start
```

默认端口由部署平台的 `PORT` 环境变量决定，本地没有设置时使用 `3000`。

## 环境变量

复制 `.env.example` 中的变量到部署平台后台：

- `OPENROUTER_API_KEY`: 智能提示词/歌词辅助
- `MINIMAX_API_KEY`: 真人演唱音乐生成
- `MUREKA_API_KEY`: 可选音乐生成备用通道

没有配置真实 API Key 时，网站仍可打开，但只能使用演示/本地辅助逻辑，不能真正生成歌曲。
