# 更新日志

本项目所有重要变更均记录于此文件。

格式参考 [Keep a Changelog](https://keepachangelog.com/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [未发布]

### 新增
- 登录页学校下拉新增「自动选择」（已设为默认项）：不必手动输入或挑选学校代码，填好账号密码点登录即按 `AUTO_TRY_ORDER` = 省锡中 → 省锡中双语学校 → 北京市第八十中学 的顺序依次尝试，首个「能登录 + 后端认可该账号」的学校直接采用；全部失败时报错里带上各校的失败原因。命中过的学校会记到 `loginSchoolResolved`，401 自动重登时优先尝试它，避免每次都试满三所。
  - 判定命中不能只看登录接口：跨校账号在别校后端上同样会返回 200（只是拿不到用户信息），因此每个候选都要再调一次 `GetInfoAsync` 才算真正命中。
- 在线专栏模块：支持「我的订阅 / 我的收藏 / 我的消息」三个面板切换。
- 浏览专栏：左侧学科树 + 专栏列表，右侧文章列表与分页；支持按专栏名、文章名搜索。
- 我的收藏：收藏夹列表与收藏文章查看。
- 我的消息：更新消息列表，点击跳转对应文章并自动标记已读（带未读数量角标）。
- 文章详情页：复用「优客畅学」PDF 阅读器（pdfjs v4）渲染专栏 PDF，支持 PDF/视频统一卡片展示。
- 文章内资源代理：图片走图片代理；视频、PDF 渲染为可点击卡片，跳转到附件查看器。
- 附件查看器（PDF / 视频）增加「下载」按钮，使用 Blob 方式下载。
- 在线专栏首页「在新页面打开」按钮，跳转原版 iframe 页面。
- 移动端适配：
  - 首页增加与全局风格一致的移动端顶栏（左侧菜单按钮唤出侧栏抽屉、中间标题、右侧加速标签与打开按钮）。
  - 学科 / 收藏选择侧栏宽度在移动端自适应并允许滚动。

### 修复
- 修复省锡中（sxz）图库/头像等 OSS 图片全部 403 的问题：站点全局 `no-referrer`，绕过 `ezy-sxz` 桶的 Referer 白名单防盗链。
- 修复服务端维护重启后「僵尸登录态」：JWT 仍有效但服务端登录记录丢失时，自动静默重登并重试请求；未记住密码则干净登出并引导重新登录。
- 修复测评做题页返回/跳转时凭空弹出「加载题目失败：id: NaN」的幽灵报错（keep-alive 路由 watcher 补路由名守卫 + `isFinite` 参数守卫）。
- 修复笔记「导出 PDF / 下载笔记」全部报 `Failed to fetch` 的问题：学校 OSS（ezy-sxz）不返回 `Vary: Origin`，页面预览 `<img>` 的 no-cors 响应（无 ACAO 头）污染 HTTP 缓存，导出时 `fetch(cors)` 命中同一缓存被 CORS 拒绝；现导出/下载一律 `cache: no-store` 直连，且单个资源失败只跳过不再使整包报废。
- 修复错题本详情显示「无详情内容」：拍照错题（未关联题库）服务端详情接口固定返回 null，现以列表自带的题目截图兜底展示。
- 修复系统信息「待办事项」全部为 0：对照官方 APK 反编译源码（HomeService.java），`GetStudentUserTodoAsync` 必须显式传 `studentId`（取自用户 id，老会话从 JWT `sub` 兜底解析）；实测修复后作业 144 / 订正 4 / 未读专题 244 正常显示。
- 修复系统信息「公告」里 PDF 等附件不显示、点不开的问题：公告正文的附件是 easy-editor 上传卡片，点击全靠内联 onclick（官方 App 里调 JsToJava.open_file 下载打开），安全净化剥掉内联事件后沦为死链；现复刻旧站 change_all 渲染逻辑，把公告里的附件卡片（easy-editor pdf/ppt/视频/音频及 `<object>`、`<video>`、`data-type` 卡片）统一改写为「在线查看 / 点击下载」链接，PDF/视频复用内置查看器，word/excel 等无法在线预览的保留下载。
- 修复云笔记「PDF上传」全部报 `Failed to fetch` 的问题：原实现调用外部转图服务（pdf2img.zyai.cc），其返回图片所在的 OSS 桶没有 CORS 头，浏览器拉取必然被拒（所有学校均受影响，与 OSS 上传链路无关）；现改用项目自带 pdfjs-dist 在浏览器本地逐页渲染（与课程 PDF 预览同一技术栈），彻底去掉外部服务依赖。经 sxzsyxx 实测（Doc1.pdf）：模板 8 文件 + 页面图片上传 + 资源/笔记保存全部 200，笔记打开后页面渲染正常。
- 重写「PDF上传云笔记」为官方 App 原生数据结构：官方 App 打开笔记时渲染的是每页独立的 ObjectBox 画板数据库（`page_mdb/data.mdb`）+ protobuf 快照（`snapshot.bin`）+ 页面图片，而非网页回放用的页目录文件，旧结构在 App 中只能得到空画板。现以官方 App 创建的真实笔记为模板，利用其内容全部为等长 ASCII 串（uuid / fileId+页 hash 路径 / 图片 SHA-256）的特性做「模板字节复制 + 全局等长替换」逐页生成 5 件套资源（data.mdb / lock.mdb / snapshot.bin / screenshot.png / 页面图片），页 hash 按页序递增保证多页 PDF 与笔记页数一一对应。经 sxzsyxx 实测：单页与 3 页 PDF 在官方 App 中均可正常显示内容并按序翻页。
- 修复 PDF 渲染报错 `Cannot read from private field`（统一 pdfjs 主包与 Worker 模块实例，排除 Vite 预构建）。
- 修复专栏 PDF 链接双重 URL 编码问题。
- 修复专栏文章内 `<video>` 未被替换为可播放链接的问题。
- 修复无引号 `data-url` 的 PDF 包裹节点未被识别为卡片的问题。
- 修复 PDF 上传的笔记在 App 内打开后图片不显示的问题：页面数据生成改用官方 App 真实笔记为模板（图片命令携带 `parentGraphId` 挂树信息、快照携带 childGraph 条目），并经 OSS 产物逐字节校验；经北京八十中实测图片正常显示。
- 修复单页 PDF 上传后在 App 内打开不显示图片的问题：真因不是 App 缺陷，而是模板页面快照 `snapshot.bin` 缺少官方原生笔记里图片引用后的 2 字节字段（`38 01`，图片挂树标记），App 解析快照时读不到图片归属。现以 App 原生创建的单页笔记为样本逐字节比对，补齐模板快照（268 → 270 字节，两处 varint 长度同步 +2），并移除此前「单页复制为两页」的临时绕行——单页 PDF 就是单页。经北京八十中实测：上传资源数 5（绕行时为 10，现与官方原生笔记的 5 项结构完全一致），App 内页码显示 `1 / 1`，彩色页面完整渲染。
- 修复 PDF 上传的笔记在 App 内被拉伸变形的问题：模板 `data.mdb` 里写死的页面/图片显示尺寸（1920×1039）让所有页面都按横版比例铺满画板，竖版 PDF 被拉宽、横版瘦页被拉矮。现生成每页时读取该页渲染图的真实宽高，把两处尺寸字段按「高度 1039 基准、宽度 = 1039 × 页宽高比」动态改写（页面对象与图片对象各一处，等值即图片恰好铺满页面板）。经北京八十中实测：横版源图 1100×777（1.4157）在 App 内渲染框 1212×856（1.4159，此前为 1.8232 拉伸）；竖版源图 1100×1556（0.7069）写入 735×1039 后等比显示无变形；8 页横版 PDF 逐页翻页颜色顺序全部正确、每页比例一致。
- 修复省锡中（sxz，userId 为 5 位）等非 4 位 userId 学校上传的 PDF 笔记，在官方 App 里点进编辑页看不到图片的问题（双语学校 4 位、北京八十中 4 位均不受影响）：
  - 现象：笔记在 App 封面**预览**正常（预览读的是 `screenshot.png`，与页面数据无关），但点进编辑页（`NewNoteActivity`）后画板空白。
  - 真因：页面数据 `page_mdb/data.mdb` 里记录的本地路径为 ObjectBox「定长字符串槽位」（固定 120 字节）。模板取自 4 位 userId 的笔记，路径段写死为 `2295`；生成 5 位 userId（`30174`）笔记时若整条路径长度变化，会撑坏定长槽位或留下残字节，故此前只能保留模板值。于是 App 用真实路径 `30174/...` 打开数据库时与文件内记录的 `2295/...` 不匹配，`loadDirAsMdbFmt` 判定为「目录不存在」→ 走「新建空白画板」→ 回写覆盖云端同步下来的 `data.mdb`，表现就是编辑页没有图片。
  - 修复：新增「整段等长替换」`replaceAllAsciiSameTotal`——路径槽位总长恒定（前缀 + userId + `/note/` + fileId + `/` + 页 hash = 120 字节），因此 **userId 每多 1 位，页 hash 就少 1 位**（反之亦然），整条路径长度不变，从而既能修正 userId 又不破坏 ObjectBox 定长槽位。页 hash 目标位数由 `pageHashLength(userId)` 计算，并限制在 8~16 位以保证区分度与严格递增。
  - 验证（MuMu 模拟器 + adb 实测）：省锡中（`30174`，页 hash 12 位）、省锡中双语学校（`1473`，13 位）、北京八十中（`2295`，13 位）三校上传的 PDF 笔记，编辑页均能完整显示页面图片；logcat 为 `loadDirAsMdbFmt，从数据库加载数据`（修复前省锡中是「新建空白画板」）。另以脚本对三校 OSS 产物做 7 项字节级校验（资源数 5 / `data.mdb` 未被撑坏 110592 字节 / 路径含正确 userId / 无 `2295` 残留 / 含本笔记 fileId / 页 hash 位数正确 / 页 hash 与资源 URL 一致），全部通过。
- 修复在线专栏「在新页面打开」打开的地址里出现 `[object Object]`、浏览器报「找不到此网页」的问题：`ColumnView.vue` / `IframeViews.vue` 在 `<script setup>` 里用模板字符串拼 `navPage.html` 地址时，把 `computed` 出来的 `iframeBase` **当成普通变量**直接插值（`${iframeBase}`）。`<template>` 中 ref 会自动解包，但 `<script>` 的 JS 表达式里**不会**——`${iframeBase}` 得到的是 ref 对象，字符串化即 `[object Object]`（经 `encodeURIComponent` 后为 `[object%20Object]`），于是 URL 变成 `http://127.0.0.1:54111/[object%20Object]/navPage.html?...`。现两处均改为 `iframeBase.value`。同时全项目扫描过一遍 `computed`/`ref` 变量在 script 区模板字符串中的裸用，确认无其他同类遗漏。
- 修复云笔记「删除后不消失、回收站里也看不到」的问题（两个独立缺陷叠加）：
  - **列表过滤漏排除回收站条目**：`getAllNotes()` 只按 `type === 1 || type === 12` 过滤，而移入回收站的笔记 `type` 仍是 12、仅 `isRecycleBin` 变 true，因此删除后它**依旧出现在「全部笔记」列表里**。实测 sxz 账号 `GetAll` 共 1026 条，其中 3 条 `isRecycleBin=true`，修复前会被算作正常笔记。现改为 `type === 12 && isRecycleBin !== true`；`searchNotes()` 同样处理，避免搜到已删除的笔记。顺带修正了原先无效的 `type === 1` 判断（服务端只返回 `type=12` 笔记与 `type=0` 文件夹，`type=1` 已不存在），并给 `NoteItem` 补上 `parentId` / `isRecycleBin` 字段声明。
  - **keep-alive 下列表缓存不失效**：`/note` 与 `/note/:fileId` 均标记 `keepAlive`，从详情页返回列表时组件实例被复用、`onMounted` 不再触发，而 `loadAllNotes()` 又有「已加载则复用缓存」的优化，于是即使数据已变列表也不刷新。现新增极轻量的 `src/utils/noteEvents.ts`（版本号 + 订阅，不引入 Pinia/mitt 等额外依赖）：详情页移入回收站 / 恢复后 `bumpNoteDataVersion()`，列表页在 `onActivated` 比对版本号，不一致则强制重拉当前目录、全部笔记与回收站。
  - 验证（真实接口端到端）：以 sxz 账号实测——恢复回收站笔记后离开回收站且回到正常列表、再次移入后离开正常列表且出现在回收站，两步均 PASS；修复后正常列表返回 931 条（回收站笔记 0 条），对照修复前的 934 条（含 3 条回收站笔记）。
- 修复安装版安装后桌面没有快捷方式的问题：`setup.iss` 的 `[Tasks]` 虽定义了 `desktopicon`，但缺少 `Flags: checkedonce`，安装向导里「创建桌面快捷方式」复选框**默认未勾选**，用户一路「下一步」就不会生成桌面图标。现改为默认勾选，并在桌面图标项补上 `WorkingDir: "{app}"`。
- 修复在线专栏里有 PDF 的文章点开后一律报 `Failed to fetch`、PDF 区域空白的问题：专栏 PDF 直链走中育 CDN（`sxzsyxx-alicdn.zyai.cc`），该响应**不带 `Access-Control-Allow-Origin`**，`pdfjs.getDocument(url)` 的跨域取流被浏览器直接拦截（伴随 `TypeError: Failed to fetch`）。现新增 `proxyCorsUrl()`——需要 CORS 的取数（pdfjs / ArrayBuffer / office 组件）自动改走**同源转发代理**（宿主在同源暴露的 `/proxy/{url}` 与 `/proxy?u=`，以 `/proxy/ping` 返回 `pong` 探测可用性），同源不可用时回落到本机 `127.0.0.1:5005` 代理，再不行才直连；同源与相对地址直接原样返回、不套代理，图片/视频仍走原有的 `proxyImgSrc` 直连。经 sxzsyxx 实测：专栏 ID 4273 的 PDF 请求变为 `/proxy/http://sxzsyxx-alicdn.zyai.cc/...pdf` → 200，`canvas count: 2`，页数提示「共 3 页 · 已渲染 2/3 页」。
- 新增「所有非 PDF 附件均可在线查看」：此前在线专栏、优客畅学章节、系统信息公告里的附件只有 PDF / 视频能在线打开，Word（doc/docx）与 Excel（xls/xlsx）点开是空白或死链。现引入 `@vue-office/docx`、`@vue-office/excel`（与已有的 `@vue-office/pptx` 同一系列），把附件按扩展名统一路由到对应查看器：`pdf`→pdfjs、`pptx / ppt`→vue-office/pptx、`docx / doc`→vue-office/docx、`xlsx / xls`→vue-office/excel，其余类型保留「点击下载」。三处调用点（`LessonViewerView`、`LessonChapterView`、`SystemInfoView`）与统一附件分发器 `useContentRenderer` 均已打通，专栏正文内的附件卡片（`ColumnDetailView`）也改为按类型识别并跳转对应查看器。渲染失败时降级为「下载文件」按钮而非白屏。经实测：docx 渲染出正文、xlsx 渲染出表格（`canvas count: 1`）、pptx 渲染出幻灯片文字，三路均通过。

### 移除
- 删除独立的 `PdfPlayerView` 路由，PDF 统一交由「优客畅学」阅读器处理。
- 在线专栏首页移除「发布时间 / 更新时间」按钮，保留「在新页面打开」。
