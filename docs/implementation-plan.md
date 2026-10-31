# pordo-service 实施方案（已批准）

> 本文档保存用户已确认的方案与实施清单，作为开发依据。参考架构：FlashNext
> （/Volumes/DevData/Projects/mem/flashnext，只读）。客户端：Pordo
> （/Volumes/DevData/Projects/player/replayer，远端 PordoTech/pordo）。
> SDK：remdia（PordoTech/remdia，pin 6e6444ff7c4e60cff55e0a61172c5ec47d837cc3，不修改）。

## 1. 产品范围

1. 独立内容源服务 `pordo-service`，首版漫画，后续影视。单管理员、自部署、自己多设备使用；
   每台设备可拥有可撤销的独立 Bearer API Token。首版不是多租户系统。
2. 客户端最终只配置服务 URL 和设备 Token；源账号、密码、Cookie、自动登录、代理、超时、
   并发、额度等在管理页面集中维护。不保留客户端直连源/登录作为静默回退；先完整联通再
   移除旧实现，避免中间破坏。
3. 职责划分：
   - 服务：源发现、搜索、详情、章节/页面列表、封面与图片资源转发、上游会话/配额/请求
     调度/缓存/目录更新检查。
   - Pordo：UI、书架、收藏/已读/阅读进度、WebDAV 同步、本地缓存、预加载、图片解码缩放、
     翻译和播放。remdia 继续在客户端承担系统媒体能力，服务端不引入媒体转码系统。
4. 身份兼容：`Book.key = SHA256(provider + NUL + siteId + NUL + 原 detailUrl)`，
   `Chapter.key` 为已有 id，否则原 URL。服务 URL、部署地址、数据库随机 ID 不进入旧书
   身份。服务响应区分原始内容身份与资源访问地址，避免将代理 URL 写回 detailUrl 导致
   收藏或同步记录分叉。必须支持服务空数据库时直接打开旧收藏（提供按旧
   provider/site/url 批量 resolve 的接口），不要求先重新搜索。重启服务、更换服务域名
   之后身份仍稳定。

## 2. 技术架构

- `server/`：TypeScript + Koa + routing-controllers + typedi；controllers -> modules
  （application + infrastructure）；Prisma 6.19.x + SQLite；TypeScript strict。
  Node.js 24 LTS，锁定实际验证的依赖版本；生产采用受版本管理的迁移与可恢复备份。
- `web/`：React + Vite + Tailwind CSS；单个容器同源提供管理 SPA 与 API。
- `contracts/`：OpenAPI 3.1，固定的规范文件、示例与契约测试。
- 数据库保存源配置、加密账号、管理员、API Token 校验值、缓存索引、任务状态等。
  图片缓存为有上限的磁盘文件、过期/清理策略；原图按需流式传输，避免全量缓存进 RAM。
- 初版单进程内有限并发调度即可，任务状态必要时存 SQLite；不为了首版添加 Redis/独立
  worker 集群/账号池/运行时脚本上传。
- 共享 ProviderRegistry、配置、账号会话、缓存、限流、请求取消与错误模型；ComicProvider
  与 VideoProvider 分别强类型。VideoProvider 预留搜索/详情/剧集/线路/播放地址（格式、
  有效期、直连或代理）接口，首版不虚构影视源、不做转码。

## 3. 真实源迁移（完整）

来源（客户端 Rust，迁成 TS 适配器，复用现有脱敏 fixture / mock 服务器的行为断言；
不在 Node 后面留 Rust sidecar）：

- `crates/pordo-core/src/comics/source.rs`：ComicSource、ImageRequest 与 MangaYun。
- `source/sources.rs`：provider 分发与身份处理。
- `source/komiic.rs`、`source/komiic/auth.rs`：Komiic HTTP/GraphQL、登录、刷新、切换
  账号、票据与 quota。
- `source/dm5.rs`：DM5 回退解析。

约定：

- MangaYun 本身是外部聚合服务。首版保留它为可替换 provider，并明确声明对该上游的依赖；
  不声称已独立实现所有聚合站点的爬虫。DM5 仅迁移现有解析/回退能力。
- Komiic 行为迁到服务端：图片按账号 concurrency=2、ahead=1、额度阻断（402）、过期票据
  只刷新一次（403）、登录单飞与会话 epoch 防止旧账号请求污染新状态。所有设备共同遵守
  上游并发与配额，同图请求去重；缓存和请求结果按源/账号上下文隔离，换账号不能返回前
  账号的受限结果。不循环登录、反复获取票据或对任意错误无限重试。

## 4. 管理页面（首版）

- 初始化/管理员登录与密码修改；
- 概览：运行状态、源健康、失败请求、缓存；
- 内容源：启停、顺序、代理、超时/并发、schema 驱动的配置表单；
- 源账号：账号密码、保存后自动登录、测试/手动登录、退出、状态与额度、错误提示；
- 内容测试：搜索、详情、目录、封面与页面取图；
- 任务和日志：状态、失败原因、有限重试与脱敏；
- 缓存：空间上限、TTL、按源清理；
- 访问管理：设备 Token 创建（明文只显示一次）、命名、撤销。

## 5. 凭据与访问

- 源密码等加密后入库（AES-256-GCM），主密钥独立于数据库（受限文件或部署 secret），
  备份恢复须保留主密钥；管理员密码（scrypt）和高熵 API Token 保存不可逆校验值
  （SHA-256）。
- 查询账号配置只返回 hasPassword/掩码等状态，不返回秘密；未填写密码代表保留，显式操作
  才清除。
- 管理页面用安全会话（httpOnly cookie）、同源与 CSRF 防护；客户端 Token 仅内容读取/
  刷新等许可，不能调管理配置 API。
- “账号密码在管理页面配置”适用于上游源账号，不要求生产用户为每个源填写 .env。
- 客户端 Token 存既有 OS 凭据库，禁止明文写设置 JSON、同步日志或普通 WebDAV 配置。
  源密码不再通过客户端或其同步传递，不自动上传旧密码。
- 资源接口按受控 assetId（HMAC 签名）取图；不开放任意 URL 代理；凭据及跳转目的地校验，
  不把上游 Cookie/图片票据泄漏给调用方或日志。

## 6. API 基线（内容面，Bearer 设备 Token）

```
GET  /api/v1/sources
GET  /api/v1/comics/search          # q/sourceId/按源能力分页；按源并行，慢源不阻塞其余
GET  /api/v1/comics/{comicId}
GET  /api/v1/comics/{comicId}/chapters
GET  /api/v1/comics/{comicId}/chapters/{chapterId}/pages
GET  /api/v1/assets/{assetId}       # 真实图片字节流，不是 JSON 包装
POST /api/v1/comics/updates/check   # 返回 jobId
GET  /api/v1/jobs/{jobId}
POST /api/v1/comics/resolve         # 兼容端点：按旧 provider/siteId/detailUrl 批量解析
POST /api/v1/assets/prepare         # 兼容端点：为旧收藏封面/图片 URL 批量换取 assetId
```

管理 API `/api/admin/v1` 独立鉴权（会话 + CSRF），另有健康检查与 OpenAPI 文档。

JSON 成功含 `data/meta/requestId`；错误含稳定 `error.code/message/retryable/retryAfter`
及 `requestId`；正确 HTTP 状态，区分服务 Token 无效与上游登录失效/额度耗尽。分页、部分
源失败、限额和重试语义写入契约。返回源 capabilities，不伪造站点并不支持的分页。

## 7. Pordo 接入

- 在 pordo-core 建立共用 Rust 服务客户端，实现 ComicSource 的远程适配；桌面与 Android
  复用，Kotlin 层保留 UI/JNI 调用职责。
- `crates/pordo-android/src/comics.rs` 的 nativeComicSearch（硬编码 Komiic）改为服务源
  发现/搜索。客户端移除 Komiic 专用账号页，改为服务连接设置及可用源展示。
- 本地 Library 与 WebDAV 同步保留；服务端目录变化不等同某用户“未读”，已读过滤仍在
  客户端。
- 旧页面缓存 key `book.key:chapter.key:index` 保持可复用；原图片缓存及阅读状态不因部署
  地址改变失效或分叉。
- 所有平台设置和 JNI 入口同步处理；处理更换 URL/Token、断线、无配置、源禁用等可理解的
  UI 状态。

## 8. 实施阶段

- P1：新仓库、方案文档、服务/管理前端、管理员与 Token、数据库、OpenAPI 契约和基础工具。
- P2：Komiic + MangaYun + DM5 真实适配器、账号与会话、资源/缓存/调度、管理页面完整闭环。
- P3：Pordo 桌面/Android 改走服务、身份/收藏/已读/同步兼容、清理客户端抓取与源账号实现、
  回归验证、文档与提交。

阶段汇报说明已实现内容、可复现验证、剩余问题；不把空页面、无源的 mock API、只完成阶段一
当成整个目标完成。

## 9. 验收

- 服务 API 契约、管理员与 Token 权限/撤销、源配置的秘密不回显、会话恢复、换账号、票据
  过期、quota、并发去重、请求取消/超时、缓存 TTL/上限、服务重启和持久化。
- 管理页面完整浏览器验证（不只 typecheck）：配置 -> 登录 -> 搜索 -> 详情 -> 取图 ->
  设备 Token -> Pordo 阅读。
- 旧收藏在新建服务 DB 直接打开，收藏/已读/阅读进度和 WebDAV 同步无身份变化；桌面与
  Android 同源读取回归。
- 客户端 cargo fmt/clippy/test；Android 构建、DEX/JNI/16KB 对齐审计及离线 smoke；Mac
  原生构建与合适的播放/阅读回归。Windows 无本机运行条件则真实标注未运行，提供 CI 检查
  而非宣称通过。
- 使用独立端口避免占用 FlashNext 的 :3000；Android 测试使用独立测试 AVD，保护用户已有
  emulator-5554/5580 及数据，结束关闭自己启动的设备。工具参考 scripts/android-dev.py、
  scripts/package-android.py。
- 记录实际服务空闲/并发 RSS、API 耗时/缓存命中，以及同配置 Pordo 包体与构建耗时前后
  变化。不预先宣称特定节省，不提交大体积测量产物。
- 用户此前允许读取客户端 .env 的 Komiic 测试账号做验证（KOMMIC_ACCOUNT/KOMMIC_PASSWORD，
  拼写以已有支持代码为准）；不打印/提交/复制秘密，真实源测试显式执行，离线测试不依赖
  外网，不影响用户现有账号配置。
- 提交清晰、分别维护两个仓库。新服务可以推送公开仓库；Pordo 变更用独立功能分支和 draft
  PR 供审核，不自动合并、不打发布 tag、不部署覆盖现有生产服务。不跟踪不相关 Actions 或
  合并 Blaze。

## 10. 仓库

- 服务：/Volumes/DevData/Projects/player/pordo-service → https://github.com/PordoTech/pordo-service（公开）
- 客户端：/Volumes/DevData/Projects/player/replayer → https://github.com/PordoTech/pordo（功能分支 + draft PR）
