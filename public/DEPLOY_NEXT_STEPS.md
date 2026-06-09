# Auraly AI 上线步骤

## 当前已经完成

- 注册账号：`POST /api/auth/register`
- 登录账号：`POST /api/auth/login`
- 当前用户：`GET /api/auth/me`
- 退出登录：`POST /api/auth/logout`
- 用户作品接口：`GET /api/library`
- 真实生成接口已预留 MiniMax/Mureka provider
- 未配置 API Key 时自动使用本地演示引擎

## 当前本地可用地址

电脑：

```text
http://127.0.0.1:8793/index.html
```

手机同 Wi-Fi：

```text
http://192.168.1.160:8793/index.html
```

## 下一步正式上线

1. 买云服务器
   - 国内用户建议腾讯云、阿里云、华为云。
   - 中国大陆服务器需要 ICP 备案。

2. 绑定域名和 HTTPS
   - 域名例如 `auraly.cn`。
   - HTTPS 可用云厂商免费证书或反向代理自动证书。

3. 换正式数据库
   - 当前开发版用 `work/data/users.json` 和 `work/data/songs.json`。
   - 正式版建议 PostgreSQL 或 MySQL。

4. 换正式文件存储
   - 当前生成文件在 `outputs/generated/`。
   - 正式版建议阿里云 OSS、腾讯云 COS 或 Cloudflare R2。

5. 接支付和额度
   - 注册送积分。
   - 生成扣积分。
   - 微信支付/支付宝购买套餐。

6. 接真实音乐 API
   - 国内优先 MiniMax Music API。
   - `.env` 配置：

```text
MINIMAX_API_KEY=你的_minimax_key
MINIMAX_MUSIC_MODEL=music-2.6
```

## 注意

当前 PowerShell 服务适合开发验证，不建议直接当生产服务。正式上线时应迁移到 Node.js/Next.js、Python FastAPI 或 Go 后端。
