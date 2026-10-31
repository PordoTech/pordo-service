# 实施进度（可恢复）

> 每完成一个可验证步骤即更新。新会话从本文件恢复上下文：先读 docs/implementation-plan.md，
> 再按下方状态继续。

## 阶段状态

- P1 服务骨架与契约：完成
  - [x] 仓库目录 + 方案文档 docs/implementation-plan.md
  - [x] PROGRESS.md / README / .gitignore
  - [x] server 骨架（Koa + routing-controllers + typedi + Prisma/SQLite，strict TS）
  - [x] 管理员初始化/登录/会话/CSRF/改密；设备 Token CRUD（明文只显示一次）
  - [x] contracts/openapi.yaml + 契约测试（Ajv 2020 校验实时响应；tests/contract.test.ts 12/12）
  - [x] web 管理 SPA（React + Vite + Tailwind）：登录/概览/源/内容测试/任务/日志/缓存/Token
  - [x] GitHub 公开仓库 PordoTech/pordo-service 推送（初始提交 779400c，63 文件）
- P2 真实源与闭环：完成
  - [x] ProviderRegistry + ComicProvider/VideoProvider 强类型接口
  - [x] Komiic 适配器（GraphQL、登录/刷新/单飞/epoch、quota 402、票据一次刷新、并发2、去重）
  - [x] MangaYun 适配器（签名协议、sites/search/details/chapter-images、图片直连/中继）——离线测试通过
  - [x] DM5 回退解析（page_endpoints、chapterfun.ashx、p.a.c.k.e.r 解包、一次签名刷新）——离线测试通过
  - [x] 资源 assetId（HMAC）+ 磁盘缓存（上限/TTL/账号上下文隔离）+ 流式转发
  - [x] resolve/prepare 兼容端点；updates/check 任务 + jobs 查询
  - [x] 管理页面完整闭环（概览/源/账号/测试/任务日志/缓存/Token）——浏览器验证通过
  - [x] 迁移行为断言测试（离线 mock；真实源显式测试）：komiic 8 + dm5 10 + mangayun 5 + api 2 + contract 12 = 37/37
- P3 Pordo 接入：主 Codex 接手，客户端与服务契约联调已完成，等待 PR 审核
  - [x] pordo-core 服务客户端 + ComicSource 远程适配（桌面共用）
  - [x] pordo-android comics.rs 改服务源发现/搜索；移除 Komiic 账号 JNI/页面
  - [x] 服务连接设置（URL + Token 存 OS 凭据库）；旧收藏 resolve 迁移路径
  - [x] 清理客户端直连抓取与源账号实现（联通后）
  - [x] 回归：cargo fmt/clippy/test、macOS 构建、Android 构建/审计/离线 smoke
  - [x] 管理页面搜索/详情/取图、Rust/JNI 阅读链路及客户端设置渲染验证
  - [x] 测量记录（RSS、耗时、缓存命中、包体/构建耗时对比）
  - [ ] 提交：pordo-service 推送公开仓库；replayer 功能分支 + draft PR

## 环境与约定

- Node：使用 Homebrew node@24（安装中/已装则以其验证）；机器默认 node 为 v26。
- 端口：服务 dev 使用 8790（避开 FlashNext :3000）；web dev 5199（vite 代理到 8790）。
- 数据目录（不入库）：server/data/（prisma dev.db、master.key、image-cache/）。
- Komiic 真实测试凭据：replayer/.env 的 KOMMIC_ACCOUNT/KOMMIC_PASSWORD，仅显式测试用，
  绝不打印或提交。

## 日志

- 2026-10-31 创建项目骨架与方案文档；读取并确认迁移契约（source.rs/sources.rs/komiic*/dm5.rs
  及 komiic tests.rs、auth_tests.rs 行为断言）。
- 2026-10-31 server 全量实现 + prisma init 迁移 + 手工 smoke 通过（healthz/setup/CSRF/token/
  resolve/comicId 对齐客户端 Book.key）。
- 2026-10-31 修复测试基础设施与三处服务缺陷，komiic.test.ts 8/8 通过：
  - shared/http.ts：undici.request 的 body 已是 Node 流（BodyReadable），不能再 Readable.fromWeb；
    并为 body 挂 no-op error 监听，避免 destroy 未消费 body 时进程崩溃（UND_ERR_ABORTED）。
  - configs/application.ts：useKoaServer 关闭 defaultErrorHandler，让错误进入 errorMiddleware
    的 JSON 信封；直接写 ctx.body 的流式 action（asset/admin testImage）返回 ctx 短路驱动器的
    undefined-result 404。
  - prisma：CacheSetting.maxBytes 默认 2GiB 超出 SQLite INT，改为 1GiB 并 clamp 更新值。
  - komiic configure()：对齐 Rust Sessions::configure——凭据不变保留会话，变更则整体替换
    （清 cookie/terminal/manualLoginDone/phase），修复 logout 后仍 signed_in 的偏差。
  - 测试修正：登录计数遵循 Rust 语义（失败后显式重试允许，自动重试受 backoff 阻止）；
    refresh→guest→一次密码回退经由 UNAUTHENTICATED 触发 recover() 验证。
  - 注意：改 schema 后需 npx prisma generate（生成的 client 内嵌默认值）。
- 2026-10-31 编写 contracts/openapi.yaml（OpenAPI 3.1 全量路径/信封/组件）与契约测试：
  - tests/contract.test.ts：加载 openapi.yaml，Ajv(2020-12)+ajv-formats 编译各响应 schema
    （含 $ref 到 components/responses/ErrorEnvelope 的解析），逐一校验实时响应；
    覆盖 admin-auth 全流程、源配置、Token 生命周期、content 全端点、assets 流式+X-Cache、
    updates/check 202+任务视图、管理探针、概览/任务/日志/缓存、六类错误信封、改密+登出。
  - komiic mock 抽取到 tests/mocks/komiic.ts 供行为/契约测试复用。
  - 契约测试发现并修复 1 处实现偏差：GET /api/v1/sources 返回裸数组，按契约改为
    { sources: [...] }（与 admin 端一致）。
  - 语义确认：changePassword 会删除全部会话（改密后需重新登录再登出）；
    komiic 页面 url 以配置的 baseUrl 为前缀（生产为 https://komiic.com）。
  - npm test 增加 --test-force-exit；全套 20/20 通过（komiic 8 + contract 12）。
- 2026-10-31 修复两处缺陷并完成 web SPA 浏览器端到端验证：
  - RequestLog.id 由 BigInt 改 Int @default(autoincrement())：SQLite 下 BigInt 主键无
    AUTOINCREMENT，导致每次 logRequest 插入触发 P2011（Null constraint on id）被静默
    catch 吞掉——日志页与概览 requests24h 始终为空。同步修正 init 迁移 SQL 为
    `INTEGER PRIMARY KEY AUTOINCREMENT`，npx prisma generate + db push 后落库正常。
  - 资源缓存 MISS→HIT 竞态：原先 clientBody 在上游流 end 的瞬间收尾，而落盘
    （flush→rename→cacheEntry upsert）在 done 里尚未完成，紧接的第二次请求可能仍 MISS
    （契约测试偶发 actual MISS / expected HIT）。改为 clientBody.end() 等待 done 完成
    （字节仍实时透传，仅推迟收尾），并把 enforceCap 改为后台执行不拖慢响应；
    语义变为「MISS 响应结束后，后续请求保证 HIT」。连跑 3 次全套 20/20 稳定。
  - 删除临时复现脚本 server/tmp-probe.ts。
  - 浏览器验证（http://192.168.31.30:8790，Paseo webview）：概览实时统计（RSS 74.8MB、
    24h 请求 5/失败 1、令牌 1、已解析书籍 1）；日志页渲染 5 条（200/400 各类、
    requestId/耗时/错误码齐全）；任务页空状态提示得当；内容测试页搜索/详情探针表单完整；
    退出登录→登录页→重新登录闭环正常。截图受 webview「not painted」限制略过，以 DOM 快照为证。
- 2026-10-31 补 README.md（根）、修正 server/.env.example 的 DATABASE_URL 注释（Prisma 相对
  prisma/ 解析，应为 file:../data/pordo.db）；git init（仓库本地身份 LChris <lchris@mac.local>），
  审查暂存清单确认无 .env/master.key/db/node_modules/dist 入库，初始提交 779400c（63 文件），
  gh repo create PordoTech/pordo-service --public 并推送，本地 main 与 origin/main 同步。
- 2026-10-31 补齐 P2 迁移行为测试（全套 37/37，5 套件）：
  - tests/dm5.test.ts（10）：variable/unescapeJs/isChapter/isPage/pageEndpoints（含计数与章节
    不匹配拒绝）/unpack（真实 p.a.c.k.e.r 符号替换、非打包透传、拒绝 eval-only 不执行）/
    imageUrl（绝对/协议相对/pix 相对）纯函数单测；pages()/resolve() 走本地 mock——成功单次
    取图、签名过期时章节元数据只刷新一次（stale 500→chapter html→refreshed）。
  - tests/mocks/mangayun.ts + tests/mangayun.test.ts（5）：mock 校验 x-ym-ts/nonce/sign
    （sha256(path|body|ts|nonce|salt)，GET 含 query），计数 direct/relay/sign 失败；
    sites() 直连单测覆盖 GET 签名；走服务器验证 search 分组限定 id（mangayun:site-a）、
    detailUrl 身份不被代理化、detail 去重+自然排序、pages 保留上游原图 URL、未保护源直连
    取图 + 缓存 MISS→HIT、直连 404 时回退 /api/image 中继、comicbox 拒读、dm5 站点章节
    图失败→回退分支按 DM5 校验章节地址（离线，不触达 dm5.com）。
  - tests/api.test.ts（2）：updates/check 任务结果载荷（chapterCount=5、knownChapterCount→
    newChapters=3、knownLastChapterKey→newChapters=2、latestChapterKey）；缓存上限驱逐
    （PUT /cache maxBytes=10 同步 enforceCap→条目清零→再取图 MISS）。
  - 发现并规避：inFlight.dedupe 对并发同资源会共享同一 PassThrough（多消费者隐患），
    顺序 MISS→HIT 测试不触及；本轮不引入并发同资源断言，留待 P3 评估是否需 per-consumer tee。
  - 修正 api.test.ts 一处 jobId 解构（应从 .data 取，非顶层）。

- P3 接入修复（主 Codex）：增加受鉴权的源站点发现、章节原始 URL；保留空 provider 旧收藏及反向代理配置下的漫画身份；修复章节 path 参数二次解码。
  同图请求共享落盘完成信号，每个响应独立读取，首个客户端取消不影响其他设备；并发许可保持至完整传输结束，增加传输时限和 40 MiB 上限。
  移除 provider 层重复的流对象去重，目录缓存按账号隔离并设置上限，过期磁盘文件同步清理；OpenAPI 写管理权限改为 cookie + CSRF 同时要求。
  新增客户端联调 fixture 和多设备/取消/旧收藏回归；40 项离线服务测试、strict TS 检查通过。原日志中多消费者隐患现已修复。

- P3 验证补充：Komiic 真实账号在隔离服务中登录成功，通过真实服务 + Rust 客户端完成搜索、旧身份 resolve、162 章节/39 页目录和单页图片（263,793 B）原生解码，临时账号数据库随后清理。
  Android API 28：21 项离线通过、3 项门控跳过；显式服务 fixture JNI 用例另行通过；正式签名 release APK 13 项审计和启动通过。
  macOS：147 项普通测试、strict Clippy、真实服务用例、628/1030 px 设置渲染、release 媒体生命周期自测通过。
  Windows 未实机验证；构建/包体/内存记录见客户端 docs/development.md，原始产物均在 target 下。
