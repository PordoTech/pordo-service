# pordo-service

> **本项目由 Qwen3.8 Max 开发**

独立的内容源服务，为 [Pordo](https://github.com/PordoTech/pordo) 阅读客户端集中提供漫画
（后续影视）源能力：源发现、搜索、详情、章节/页面列表、封面与图片资源转发，以及上游会话、
配额、请求调度、磁盘缓存与目录更新检查。单管理员、自部署、多设备使用——每台设备持有可撤销
的独立 Bearer Token；源账号、密码、Cookie、并发与额度全部在服务端集中维护，客户端只配置
服务 URL 与设备 Token。

## 架构

- `server/` — TypeScript + Koa + routing-controllers + typedi；Prisma 6.19 + SQLite；strict TS。
  controllers → modules（application + infrastructure）。Node.js 24 LTS。
- `web/` — React + Vite + Tailwind 管理 SPA，与 API 同源由单容器提供。
- `contracts/` — OpenAPI 3.1 规范（`openapi.yaml`），由契约测试对实时响应做 Ajv 校验。
- `docs/implementation-plan.md` — 已批准的实施方案。

### 身份兼容

- `comicId = Book.key = SHA256(provider + NUL + siteId + NUL + 原 detailUrl)`，与服务部署
  地址、数据库随机 ID 无关；重启或换域名后身份稳定。
- 空数据库可通过 `POST /api/v1/comics/resolve` 按旧 provider/site/detailUrl 批量解析，直接
  打开旧收藏，无需重新搜索。
- 内容身份（原始 URL）与访问地址（HMAC 签名的 `assetId`）分离；代理 URL 绝不写回 detailUrl。

### 内置源

- **Komiic** — GraphQL；登录/刷新单飞、会话 epoch、账号切换隔离、票据 403 只刷新一次、
  配额 402 阻断（搜索/详情仍可用）、每账号并发 2、同图去重。
- **MangaYun** — 外部聚合服务，签名协议；图片直连或中继。
- **DM5** — 作为 MangaYun 的回退解析（`page_endpoints`、`chapterfun.ashx`、p.a.c.k.e.r
  解包、一次签名刷新），非独立源。

## 安全

- 源密码以 AES-256-GCM 加密存储，主密钥独立于数据库（`PORDO_MASTER_KEY` 或受限权限的
  `master.key` 文件）；管理员密码用 scrypt 哈希；设备 Token 仅存 SHA-256 校验值。
- 账号读取只返回掩码 / `hasPassword`；空密码表示保留，清除需显式操作。
- 管理端使用会话 Cookie + CSRF 双提交；设备 Token 不能调用管理 API。
- 无开放 URL 代理：资源访问需 HMAC 签名的 `assetId`，生产环境对内网/环回目标做 SSRF 防护。
- 响应与日志不泄漏凭据、Cookie 或票据。

## 开发

要求 Node.js 24 LTS 与 npm 11+。

```bash
# 服务端
cd server
cp .env.example .env          # 按需调整；DATABASE_URL 相对 server/prisma/ 解析
npm install
npm install-scripts approve prisma @prisma/engines esbuild
npx prisma generate
npx prisma db push            # 或 npm run prisma:migrate
npm run dev                   # http://127.0.0.1:8790

# 管理 SPA（另开终端）
cd web
npm install
npm install-scripts approve esbuild && npm rebuild esbuild
npm run dev                   # http://127.0.0.1:5199（代理到 :8790）
npm run build                 # 产物 web/dist，由服务端同源提供
```

首次启动引导创建管理员；随后在管理页面配置源、账号与设备 Token。

## 测试

```bash
cd server
npm test          # node --test，离线 mock；不触达真实上游
npm run typecheck
```

真实 Komiic 测试为显式 opt-in：在 `replayer/.env` 提供 `KOMMIC_ACCOUNT` / `KOMMIC_PASSWORD`
（绝不打印或提交）。

## API 信封

- 成功：`{ data, meta?, requestId }`
- 错误：`{ error: { code, message, retryable, retryAfter }, requestId }`
- 资源端点流式返回真实字节并带 `X-Cache: HIT|MISS`（不走信封）。

完整端点见 `contracts/openapi.yaml`。

## 许可

自用项目，未定许可。
