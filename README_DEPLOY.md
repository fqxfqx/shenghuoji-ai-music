# 声活记 AI 海外部署版

这是可部署到 Railway、Render 或海外 VPS 的 Node.js 版本。

## 本地运行

需要 Node.js 18+。

```bash
npm start
```

默认端口：

```text
http://127.0.0.1:3000
```

## Railway 部署

1. 把这个 `deploy/overseas-node` 目录上传到 GitHub 仓库。
2. 打开 Railway：`https://railway.app`
3. New Project -> Deploy from GitHub repo
4. 选择仓库。
5. Root Directory 设置为：

```text
deploy/overseas-node
```

6. Start Command：

```text
npm start
```

7. 添加环境变量：

```text
OPENROUTER_API_KEY=你的_openrouter_key
OPENROUTER_TEXT_MODEL=openrouter/free
MINIMAX_API_KEY=你的_minimax_key
MINIMAX_MUSIC_MODEL=music-2.6
```

## Render 部署

1. 打开 Render：`https://render.com`
2. New -> Web Service
3. 连接 GitHub 仓库。
4. Root Directory：

```text
deploy/overseas-node
```

5. Build Command 留空或填：

```text
npm install
```

6. Start Command：

```text
npm start
```

7. 添加同样的环境变量。

## 当前数据存储

当前测试版用本地 JSON 文件：

```text
data/users.json
data/songs.json
data/posts.json
```

注意：Railway/Render 免费层文件可能不是永久存储。正式运营应换 PostgreSQL。

## 下一步正式化

- PostgreSQL 保存用户、作品、帖子、评论、点赞和积分
- 对象存储保存 MP3/WAV
- 微信/支付宝/Stripe 充值
- 内容审核
- 域名和 HTTPS
