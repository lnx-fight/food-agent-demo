# 小饭 变更日志

本文件记录用户提出并已经落实的项目修改，便于回顾功能演进。日期使用 Asia/Shanghai 时区。

## 2026-10-20

### 检索：餐食名直接匹配 USDA，补齐不依赖模型额度的中文路径

- 按补充要求保持“餐食名→USDA 中整道食物记录→原始营养值”的直接自动匹配流程，不弹分类候选，不做拆食材估值。线上验证常见汉堡正常，同时发现千问免费额度耗尽阻断未收录中文转换，新增离线中文词汇及生熟、配方词组合检索，牛油果等不再依赖模型；词汇有未知部分则不降为局部食材。
- 增加完整词形与加工形式排序，避免草莓匹配成果奶、豌豆匹配成花生；只读 USDA 原记录并保留原名和来源。主要文件：`nutrition-dataset.mjs`、`data/usda/chinese-search-terms.json`、营养与D1测试、README 和营养 Skill 规则。验证：94项Node/workerd回归通过，覆盖牛油果、草莓、豌豆、火腿与烤土豆的离线直接匹配。离线词汇仍非全部中餐，未收录名称的模型转换受现有额度限制，没有启用付费调用。

### 检索：统一使用英文 USDA 前的中文检索层

- 按要求将全部营养查询统一为“中文名称/别名或离线检索词→USDA 英文记录→原始营养值”，移除千问名称转换及其开关，搜索、图片识别后的营养匹配、DIY 和 Agent 营养工具共用同一路径，不再受模型额度影响。
- 主要文件：`nutrition-dataset.mjs`、`server.mjs`、营养/D1测试、README 和营养 Skill 规则。验证：95项Node/workerd回归、3项导入测试和30条评测结构校验通过，覆盖配置千问密钥时仍无营养检索外部请求。USDA 原始表及用户历史数据不改写；中文词库尚未覆盖全部餐食，未匹配时提示补充具体名称、英文原名或 FDC 编号，不宣称已翻译全部13,588条。

### 账号：无需单独注册，首次登录自动创建账号

- 按要求将注册/登录合并为单一入口，未使用的用户名首次提交合法密码后自动创建账号并签发会话；已有用户名仍校验原密码。并发首次登录使用用户名唯一约束，失败者重新验证获胜账号的密码，不覆盖身份或密码；旧注册接口保留客户端兼容。
- 页面移除注册切换，新增首次登录说明，更新 Service Worker 缓存；正式站 `?demo` 不再跳过登录，业务数据继续要求有效会话，独立 GitHub Pages 静态演示保持样例模式。主要文件：`accounts.mjs`、`account-ui.js`、`index.html`、`account.css`、`app.js`、`sw.js`、账号/D1测试和 README。
- 验证：102项Node/workerd测试通过，覆盖首次自动创建、既有账号验密、同名并发和未登录访问拦截。无需数据库迁移，保留历史账号和数据；首次登录使用未占用的用户名会创建新账号，暂不提供邮件找回密码。

### 浏览：访客自由浏览，实际使用功能时再弹登录

- 按澄清后的要求移除进入网站即强制登录的遮挡，新增可直接浏览、分类筛选和展开详情的公开发现页，展示餐食灵感、计划与记录、功能示例；点击营养查询、记餐、生成计划/食谱或对话才显示登录弹窗，支持关闭、继续浏览和 Esc 返回，并恢复原按钮焦点。
- 访客不读取个人档案缓存、不请求个人业务接口，账号服务不可用时仍可浏览公开内容；有效会话加载本人状态后进入原产品。保留统一首次登录建号及全部业务 API 的会话校验，无需数据库迁移，已有账号和记录保留。公开卡片为静态示例，尚非用户发布的社区内容。
- 主要文件：`index.html`、`guest.css`、`guest-ui.js`、`account-ui.js`、`account.css`、`app.js`、`public-files.mjs`、`sw.js`、`test/guest-auth.test.mjs`、`test/public-files.test.mjs`、`package.json` 和 README；更新资源白名单及 PWA 缓存，为页面脚本/样式增加版本参数并同步离线预缓存，避免旧浏览器缓存混用新页面与旧账号脚本导致按钮失效。验证：106项Node/workerd回归、3项导入测试、30条评测结构校验及 Pages 构建通过；新增访客隔离、弹窗关闭、服务离线与有效会话恢复测试，并以隔离浏览器验证分类、详情展开、功能触发、Esc 返回及已有账号登录。

### 营养：删除 USDA，切换为台湾食药署完整数据集

- 按要求移除当前 USDA 快照、中文映射、下载原包与导入脚本，将唯一内置营养源切换为台湾食药署官方 CSV：2,213 个食品条目、230,152 条营养分析明细。保存原始 ZIP、SHA-256、原名/俗名、样品描述、单位和样本信息，依据政府资料开放授权条款第1版展示署名、来源与授权链接。新增 OpenCC 简繁转换和经核对的地区名称别名；新查询仅使用食药署，旧FDC编号提示已停用。
- 新增 `0007_tfda_schema.sql`、22份 `0008_tfda_snapshot_*.sql` 和 `0009_tfda_activate.sql`：完整导入并校验数量后才删除 USDA 表与FTS，营养明细按食品聚合保存以控制免费D1写入量。当前树移除旧 `0004_usda_snapshot.sql` 数据文件，既有D1已执行记录及其余历史迁移保留；本地升级前已备份。账号、密码、饮食/体重/对话等用户数据保留，历史摄入及旧USDA来源不重算。
- 主要文件：`data/tfda/`、`scripts/import-tfda.py`、`scripts/tfda-labels.mjs`、`nutrition-names.mjs`、`nutrition-dataset.mjs`、`server.mjs`、新迁移、`app.js`、`index.html`、样式与缓存、发布/备份脚本、营养与D1测试、Skill数据规则和 README。营养结果新增完整指标展开，重新打开/修改餐食时清除过期的查询结果；图片、DIY、菜单、文字记录与Agent营养Tool共用新库。摘要优先官方修正热量，保留原热量及缺失值；白饭182 kcal/100g是本快照原值，不套用旧USDA数值。
- 限制：该快照包含食材、加工食品和部分成品，未收录回锅肉、牛肉汉堡等时明确返回未匹配；不将麻婆酱、汉堡面包/肉饼或冷冻炒饭当作其他整道菜。切换后旧代码不能单独回滚，需修复前进或同步恢复对应食品库。
- 验证：107项Node/workerd回归、5项导入测试、30条评测结构校验及Pages构建通过；覆盖原账号/历史摄入保留、部分导入拒绝激活、简繁体与别名、完整明细/单位/缺失值、分类适配与食谱计算、未收录整菜不误配。隔离浏览器完成查询、展开104项明细及保存TFDA来源记餐验证；对比本地迁移前后用户、饮食和体重数量一致。

### 显示：食药署营养查询统一使用简体中文

- 按“只使用简体字”的要求，去掉结果中的繁体原名，新增简体能量口径标签，食品名、样品说明、营养指标及营养查询对话统一显示简体；保留繁体输入检索能力。官方原包、原始字段与营养数值继续用于追溯，无需数据库迁移。
- 主要文件：`nutrition-dataset.mjs`、`app.js`、`server.mjs`、`index.html`、`sw.js`、营养回归测试、README 和营养 Skill 数据规则；升级页面缓存，避免旧界面继续显示繁体。
- 验证：109项Node/workerd回归、5项导入测试、30条评测结构校验及Pages构建通过；全量核对2,213个食品的简体名称、样品说明和能量标签，同时修复部分预生成说明的乱码。隔离浏览器验证繁体输入返回简体结果及104项简体营养指标，营养数值保持不变。

### 使用：移除账号密码登录，先浏览、开始使用后再填写资料

- 按要求移除注册登录表单、改密码与退出入口，旧认证及账号接口返回410；用户点击“开始使用”或具体功能后才初始化独立的浏览器使用空间，无需账号密码。每次访问先展示公开发现页，不要求填写个人信息，不加载个人档案；首次真正使用时才建档，有效旧Cookie继续读取本人历史记录。
- 复用现有数据表与安全Cookie，随机浏览器凭证保留180天并在使用时续期；保持来源校验、身份隔离、版本锁与冲突副本。“我的数据”保留导出、重试同步和确认文字保护的清空/删除，不再要求密码。原账号、密码哈希、历史记录及本机暂存不删除、不重算，无需数据库迁移；没有有效Cookie时不能再凭账号密码恢复，换设备或清除浏览器数据后无法自动恢复。
- 主要文件：`accounts.mjs`、`account-ui.js`、`guest-ui.js`、`app.js`、`index.html`、`account.css`、`guest.css`、`sw.js`、账号/访客/D1测试及README；同步升级页面缓存。验证：103项Node/workerd回归、5项导入测试、30条评测结构校验通过，覆盖未开始使用时零个人请求、不弹建档、旧会话延续、跨浏览器隔离与密码接口停用；真实浏览器控制被设置关闭，本轮未进行点击和视觉验收。

## 2026-10-19

### 营养：中文检索 USDA 并移除旧本地估算食品库

- 按要求仅保留 USDA 营养数据，删除 `data/foods.json`、旧种子加载及中文模糊估算回退；新增 `0006_usda_only.sql` 删除 `foods`、`aliases`、`candidates` 与停用参考表，保留 USDA 13,588 条、账号和已确认饮食/体重记录；已发布历史迁移保持不变。
- 新增中文名称/别名到 FDC 编号的纯元数据映射；未收录中文由模型仅翻译英文检索词，再检索 USDA。按用户后续要求自动检索匹配：汉堡使用通用记录，牛肉/芝士/鸡肉/炸鸡按具体品类命中；未细分部位的鸡腿汉堡明确标注通用鸡肉参考，不再弹三选一；英文全文检索按完整食品词与相关性自动匹配并标注参考性质，保留原文、来源及每100g口径；图片、DIY、菜单和文字记餐统一读取 USDA，不再自动使用网页估值或第三方条码库。
- 主要文件：`nutrition-dataset.mjs`、`data/usda/chinese-foods.json`、`server.mjs`、`app.js`、`index.html`、`sw.js`、`migrations/0006_usda_only.sql`、构建/发布/备份脚本、营养相关测试、Skill 数据规则与 README。验证：93项Node/workerd测试、3项导入测试及30条评测结构校验通过，隔离页面验证汉堡/鸡腿汉堡自动匹配和份量换算。未覆盖所有中餐；单次菜单营养排序最多比较前12个合规条目以控制免费D1查询量；缺少匹配时不自动估算，用户可按包装标签手动输入。数据库删表后不兼容旧版代码，回滚须同时恢复数据库或修复前进。

## 2026-10-16

### 品牌：更换无 agent 的网址并设计小饭网站头像

- 按要求将正式访问地址切换为 `https://xiaofan-food.pages.dev`；Cloudflare 的既有 pages.dev 子域名不能直接重命名，因此创建 `xiaofan-food` 并继续绑定原 `xiaofan-production` D1，迁移生产配置与经用户确认的应用密钥；`cloudflare/project.json` 和 GitHub 自动部署目标、README 同步更新。
- 使用内置 image_gen 设计浅绿色背景、深绿色笑脸饭碗与嫩芽头像，替换登录页、侧栏及建档页品牌标记，新增多尺寸 favicon、Apple touch icon 与 PWA 图标/manifest；保留可复现原图、提示词和尺寸生成脚本，更新静态资源白名单、媒体类型和离线缓存版本。
- 主要文件：`assets/`、`scripts/build-icons.mjs`、`index.html`、`styles.css`、`account.css`、`public-files.mjs`、`sw.js`、`site.webmanifest`、`cloudflare/project.json`、`package.json`、`README.md`。新域名需要重新登录；云端账号记录保留，旧域名尚未同步的浏览器记录需先同步。网页 Agent 功能文案按本次澄清保留。

### 部署：Cloudflare Pages、免费 D1 与 GitHub CI/CD

- 为将当前完整功能版部署到 Cloudflare，新增 `cloudflare/`、`database.mjs`、`runtime.mjs`、构建/迁移/发布脚本和 GitHub Actions；保留既有本地修改，Node SQLite 与线上 D1 共用业务代码，数据库调用改为异步，状态保存和账号清理通过原子批次及版本守卫防止并发覆盖。
- 创建 Pages 项目 `xiaofan-food-agent` 与 D1 `xiaofan-production`；GitHub `main` 在 CI 通过后才运行数据库迁移、上传同次构建并检查线上健康。静态资源按白名单发布，API 密钥存于 Pages Secret，专用部署令牌存于仓库 Actions Secret。
- 主要文件：`server.mjs`、`accounts.mjs`、`package.json`、`package-lock.json`、`.github/workflows/cloudflare.yml`、`migrations/`、`test/cloudflare.test.mjs`、`README.md`；本地 SQLite 数据不自动迁移。Pages 提醒为请求触发与 SSE 重连快照，不提供常驻定时推送。当前 cf beta 不支持 Pages 上传，仅该步骤采用固定版本临时上传命令；资源管理与 D1 迁移继续使用 cf。

- CI 首次实跑发现 Ubuntu Python 标准库 `test` 包与测试目录重名；已在 `package.json` 改为直接执行数据测试脚本，避免模块导入冲突。

### 数据：下载并导入 USDA 公开权威食材和餐食营养数据

- 按新增要求，从 USDA 官方下载 Foundation Foods 2026-04、SR Legacy 2018-04 与 FNDDS 2021–2023 数据，依据 CC0 保存版本、来源 URL 和 SHA-256；导入 D1 的独立权威表及 FTS5 索引，保留原有中文食物库。
- 导入 13,588 条有效记录，其中 13,545 条有热量；Foundation 原包 32 个空记录不计作食物，未知值保持 NULL。统一每100g可食部，区分 kcal/kJ，保留 FDC 编号与能量计算口径，新增登录后的全文检索和精确读取接口；原名以英文为主，尚未批量翻译或完整覆盖中餐。
- 主要文件：`scripts/import-usda.py`、`nutrition-dataset.mjs`、`data/usda/manifest.json`、`migrations/0003_authoritative_foods.sql` 至 `0005_usda_search.sql`、`test/nutrition-dataset.test.mjs`、`test/usda_import_test.py`；原包与 CSV 留在本机且不提交，已发布迁移须新增版本而非改写。

### 账号与数据：补齐完整功能版的身份验证和个人数据管理

- 需求：公开部署完整功能版，并补齐账号和数据管理。
- 结果：新增用户名注册登录、scrypt密码派生、7天HttpOnly会话、生产HTTPS Cookie、来源校验及持久化登录限流；所有业务接口按服务器会话绑定身份，修复待办ID越权。新增账号与数据界面，支持修改密码、退出当前/全部设备、个人数据导出、密码与确认文字保护的清空/注销，并清理记忆、嵌入和执行步骤等派生数据。浏览器缓存按账号隔离，采用版本校验与独立冲突副本，防止旧设备或标签页静默覆盖；旧本机档案需明确确认后导入，不允许凭旧clientId认领云端数据。
- 数据：自动新增accounts、account_sessions、auth_attempts表，保留原表；启用SQLite WAL及安全删除，提供一致性备份、完整性校验和拒绝覆盖的恢复脚本，恢复撤销全部会话。Render配置改为付费Starter及1GB持久磁盘，避免账号随部署丢失，尚未创建付费资源。
- 验证：语法检查、83项回归测试、30条评测数据校验及隔离DOM交互验证通过；覆盖注册登录、跨账号读写隔离、待办越权、会话撤销、同步冲突、后台结果晚到和备份恢复。
- 限制：没有邮箱验证/邮件找回、第三方登录、管理员用户管理后台、定时异地备份和自动备份清理；SQLite限单实例，历史备份中的注销数据需按运营保留策略处理。完整公网部署仍需托管账号连接与费用确认，尚未产生新的公开地址；真实浏览器控制不可用，视觉验收未完成。
- 主要修改文件：`accounts.mjs`、`account-ui.js`、`account.css`、`server.mjs`、`app.js`、`index.html`、`public-files.mjs`、`sw.js`、`scripts/manage-data.mjs`、`test/accounts.test.mjs`、`test/data-management.test.mjs`、`package.json`、`render.yaml`、`.env.example`、`README.md`、`CHANGELOG.md`。

## 2026-10-15

### 接入：完整健康管理流程

- 需求：将已安装的 health-coach 所覆盖的健康能力全部接入小饭产品。
- 结果：新增“健康”导航与体型、运动、睡眠、活动、心率/HRV、化验、补剂/药物、心情记录的保存、编辑和删除；接入7日/30日趋势与可导出报告、饮食结构及微量营养来源补充、Apple Health XML/JSON/CSV本地解析与确认导入、跨夜睡眠合并和多设备活动去重、自定义健康提醒及真实服务器调度。健康对话使用确定性统计并打开对应页面，健康记录和对话历史不进入外部模型；DIY、手动记餐与图片确认保留已知碳水、脂肪、纤维，USDA缺失宏量素保持未知且正确换算千焦。启动自动新增`meal_logs.details`，保留餐食标识、未吃状态及扩展营养值；PWA缓存升级。
- 限制：不提供临床诊断、处方剂量、用药资格判断或完整相互作用检查；化验只按原报告区间比较，未知营养值不补零。Apple Health不实时连接，ZIP需解压，支持30MB内文本、10万条原始观测、5000条规范化记录/5MB档案；多设备活动可能低估。提醒在页面打开时显示，没有关闭页面后的后台推送；报告为随数据更新的7日/30日摘要，没有独立自动周/月推送。账户仍沿用Demo的clientId识别。已通过83项回归测试及隔离DOM交互验证；当前电脑未授予界面控制权限，尚未完成真实浏览器视觉验收。
- 主要修改文件：`health-core.js`、`health-import.js`、`health-center.js`、`health-center.css`、`app.js`、`server.mjs`、`index.html`、`sw.js`、`package.json`、`test/health-coach.test.mjs`、`README.md`、`references/health-coach/README.md`、`references/health-coach/workflows.md`、`CHANGELOG.md`。

### 撤回：取消新增健康管理模块

- 需求：用户不再需要此次新增的健康管理功能。
- 结果：移除健康导航、记录与趋势页面、周/月报告、Apple Health导入、自定义健康提醒和专用对话/接口，并撤回配套营养扩展控件；更新PWA缓存及使用说明，原有饮食、体重、自然周计划和此前资料适配继续保留。
- 兼容：已安装的RedSkill与health-coach技能保留；不清除历史用户数据，已有健康记录仅存档，旧健康提醒不再展示或占用原有提醒额度，历史健康对话继续从外部模型上下文隔离；保留餐食详情的兼容读写，避免丢失标识和未吃状态。
- 验证：语法检查、67项回归测试及30条评测数据校验通过；隔离DOM验证原有五个页面可切换、手动记餐可保存，健康入口已消失且本地历史数据仍保留。
- 主要修改文件：`app.js`、`server.mjs`、`index.html`、`sw.js`、`package.json`、`README.md`、`references/health-coach/README.md`、`test/health-withdrawal.test.mjs`、`CHANGELOG.md`；删除本次新增的`health-*`模块、专用测试与流程说明。

### 卸载：移除本次安装的技能与RedSkill商店

- 需求：删除本次安装的health-coach及RedSkill商店。
- 结果：卸载`~/.codex/skills/health-coach`，移除`find-redskills`、`redskill-preference`的Codex链接与原始目录，删除RedSkill CLI、运行目录及空安装锁文件，并清理本次加入`~/.zshrc`的PATH配置；已核验安装路径全部消失。
- 范围：不删除其他技能、用户数据或项目此前的饮食资料适配。同步更新`README.md`、`references/health-coach/README.md`、`CHANGELOG.md`；无产品代码变更。

### 数据：接入 health-coach 食品热量参考库

- 需求：提取 health-coach 的食物热量数据并让小饭产品可以使用。
- 结果：固定GitHub提交并保留原文、MIT许可和SHA256，离线解析品牌表339条及基础营养表36条，共375条原表记录；启动时写入独立的`reference_foods`表，新增分页查询，接入手动记餐、Agent营养查询与菜单参考估算；规格歧义供用户选择，支持参考份和半份，来源及蛋白质未知状态随记录保存，静态演示和PWA同步使用参考数据。
- 限制：375条包含重复和不同规格，不能等同独立食品数；均为社区未核验参考值，保留原始计量口径，缺少克重时不生成每100克数据，毫升不按克计算，缺失宏量素不补为已知零。未取得逐项官方证据，不凭参考表推断门店供应。保留300条基础库及用户记录，首次启动只新增参考数据表；没有重新安装完整健康技能或新增健康模块。
- 验证：73项回归测试、语法检查、30条评测数据校验、隔离HTTP与DOM交互测试通过；本地8080服务已重启并确认基础库300条、参考库375条。当前无可用浏览器，未完成真实浏览器视觉检查。
- 主要修改文件：`data/health-coach/`、`food-catalog.mjs`、`scripts/import-health-coach-foods.mjs`、`server.mjs`、`app.js`、`sw.js`、`package.json`、`test/food-catalog.test.mjs`、`README.md`、`references/health-coach/README.md`、`CHANGELOG.md`。


### 清理：删除 health-coach 饮食资料及食品参考库

- 需求：不再保留此前 Skill 提取的饮食资料和食品热量数据。
- 结果：删除 `references/health-coach/`、`data/health-coach/`、参考库解析模块及导入脚本；移除图片识别、官方检索和复盘的资料注入，以及食品参考表查询、规格选择、菜单估算和静态演示接入；清理 README、营养 reference 与 PWA 缓存。服务启动自动删除独立 `reference_foods` 表，保留原有300条基础食品及已确认用户记录。
- 验证：语法检查、原有67项回归测试、新增1项旧表迁移及历史记录兼容测试、30条评测数据校验通过。营养单位校验和记录不足不调整预算的通用保护继续保留，相关测试更名为 `test/nutrition-validation.test.mjs`；未新增官方数据库下载或接入，未进行浏览器视觉验收。
- 主要修改文件：`server.mjs`、`app.js`、`sw.js`、`package.json`、`README.md`、`skills/next-meal-decision/references/nutrition-data.md`、`test/nutrition-removal.test.mjs`、`test/nutrition-validation.test.mjs`、`CHANGELOG.md`，以及上述删除目录和文件。

### 部署准备：限制公开服务的静态文件范围

- 需求：将小饭产品提供为可公开访问的服务。
- 结果：静态文件改为应用资源白名单，阻止访问环境密钥、Git 元数据、服务端源码、SQLite 和个人文件；补齐 GET/HEAD、非法路径及不支持方法的处理，新增资源完整性和敏感文件访问回归测试，更新公开部署说明。
- 验证：语法检查、70项回归测试及30条评测数据校验通过；未进行公网连通性或浏览器验收。
- 限制：本条仅记录公开部署前的文件访问修复；尚未创建或验证新的公网部署，完整功能需要 Node.js 托管，现有静态演示不包含真实 AI 接口；账户仍使用 Demo 的 clientId 识别。
- 主要修改文件：`public-files.mjs`、`server.mjs`、`test/public-files.test.mjs`、`README.md`、`CHANGELOG.md`。

## 2026-10-14

### 适配：选用 health-coach 可用资料改进现有工具

- 需求：选择适合小饭的 health-coach 资料进行项目适配。
- 结果：选取并改写照片份量与不确定性、中国食品/品牌规格核对、饮食与体重复盘原则，分别接入现有视觉识别、官方营养检索和每日复盘；每份营养按明确克数换算，未知单位或缺少来源时不生成可计算候选，缺失宏量素保留未知；记录不足时拦截模型及规则的新增预算调整和提醒；保留来源版本、包校验值、MIT 许可与适配说明，并修正已滞后的提示词版本测试。
- 限制：未安装 RedSkill 或完整 health-coach，未导入无逐项来源的估算营养表；没有新增 Skill、健康档案、医学/用药能力或自动周/月报告。复盘完整度仍沿用现有最近14天至少10条餐食的粗粒度口径，真实模型效果尚需评测。
- 主要修改文件：`references/health-coach/`、`skills/next-meal-decision/references/nutrition-data.md`、`server.mjs`、`test/health-materials.test.mjs`、`test/prompt.test.mjs`、`README.md`、`CHANGELOG.md`。

## 2026-09-14

### 优化：用受控 Workflow 修复 Agent 评测 Bad Case

- 需求：针对端到端通过率、Tool 链路、P95 响应时间和一票否决违规进行优化，并重新运行同一套30条单次评测。
- 结果：将自由规划与二次 Tool 调用改为“高置信规则路由 / LLM 兜底 + 场景 Workflow + 证据渲染”，餐厅链固定为搜索→菜单→个性化，DIY、营养、记忆和记录按意图白名单执行；新增参数标准化、调用去重、过敏食材过滤、失败即停止、空结果与高风险确定性降级，以及 preflight / decision / tools / generation / total 分段耗时；校准禁用表达的否定语境和大模型裁判的一票否决定义。修复后第二轮完整30条单次评测中，自动规则通过率100%、必要 Tool / 调用精确率 / 参数正确率均100%、非菜单 P95 为483ms、一票否决为0；大模型裁判发现复杂日程样本的餐次标记和无加热替代方案仍需修正，补丁完成后该 Bad Case 的单条联网复核已通过全部自动断言、语义标准和硬约束。
- 限制：本轮按要求每条只运行一次，决策稳定率未评测；完整报告仍使用与 Agent 相同的 `qwen3.6-27b` 作为裁判，不可替代独立裁判校准；冻结 fixture 会绕过真实外部 Tool 延迟，生产环境仍需单独压测。主要修改文件：`server.mjs`、`data/foods.json`、`scripts/agent-behavior-eval.mjs`、`scripts/agent-model-judge.mjs`、`test/controlled-agent-workflow.test.mjs`、`README.md`、`EVALUATION.md`、`CHANGELOG.md`。

### 评测：修复真实基线运行中的基础设施与统计问题

- 需求：修复首次30条单次基线暴露的问题，然后重新运行评测。
- 结果：千问调用新增可配置的30秒超时、瞬时网络/429/服务端错误重试和退避，避免请求无限挂起；测试态 Agent 输出新增其实际收到的确定性运行上下文，供大模型裁判核验预算和状态事实；个性化指标不再把不适用的 `null` 当作0分；Agent执行失败时裁判状态正确显示为未运行；新增请求重试、非瞬时错误、裁判上下文和空值聚合回归测试，并同步补充配置说明。修复后已按每条一次重新运行完整30条，Agent执行完成率和裁判覆盖率均恢复到100%，生成可读取的单次基线报告。
- 限制：重新评测结论仍为 `NOT READY`：自动规则通过率23.3%，裁判硬约束通过率80%，逐条标准通过率88.2%，并报告4项一票否决；本轮未重复运行，因此稳定率未评测；裁判与被测模型均为 `qwen3.6-27b`，严重违规结论仍需独立裁判模型校验。重跑还发现否定句可能命中 `mustNotMatch` 的自动文本规则，后续应收窄规则并把否定语义交给模型裁判。
- 主要修改文件：`server.mjs`、`scripts/agent-model-judge.mjs`、`scripts/agent-eval-metrics.mjs`、`scripts/agent-behavior-eval.mjs`、`test/qwen-chat.test.mjs`、`test/agent-model-judge.test.mjs`、`test/agent-eval-metrics.test.mjs`、`.env.example`、`README.md`、`METRICS.md`、`CHANGELOG.md`。

## 2026-09-13

### 评测：将语义质量复核改为大模型裁判

- 需求：将原先依赖人工填写的 Agent 语义评分改为由大模型自动打分裁判。
- 结果：新增独立 LLM-as-a-Judge 模块，每次 Agent 运行后基于冻结的输入、状态、Tool fixture、自动断言和逐条标准，对硬约束、安全、真实性、可执行性、个性化与清晰度评分；裁判结果采用严格 JSON 协议，无效时重试一次，失败不默认通过，并支持独立 `QWEN_JUDGE_MODEL`、提示注入隔离、逐项理由、完整报告保存和新的裁判指标/发布门槛；同步将评测集标注由人工标准改为模型裁判标准并补充回归测试。
- 限制：本次没有消耗 API 额度运行完整 30 条真实模型评测；未配置独立裁判模型时会复用被测模型并产生自评偏差警告，大模型裁判仍需定期用少量人工金标校准。
- 主要修改文件：`scripts/agent-model-judge.mjs`、`scripts/agent-behavior-eval.mjs`、`scripts/agent-eval-metrics.mjs`、`test/fixtures/agent-behavior-cases.json`、`test/fixtures/agent-eval-metrics.json`、`test/fixtures/agent-eval-model-judge-output.example.json`、`test/agent-model-judge.test.mjs`、`test/agent-eval-metrics.test.mjs`、`server.mjs`、`EVALUATION.md`、`METRICS.md`、`PRD.md`、`README.md`、`.env.example`、`CHANGELOG.md`。

### 评测：建立分层指标体系与发布判定

- 需求：在五类 Eval 建立后，继续建立可计算、可解释并能约束发布的指标体系。
- 结果：新增自动行为、五类切片、人工质量、稳定性、P95 和一票否决六组指标，明确公式、分母、阈值、五分制锚点与发布规则；评测器现可计算 Skill Precision/Recall/F1、场景、Tool、参数、动作、提案、异常/对抗、重复运行和延迟指标，可加载人工评分并输出 `PASS` / `NOT READY`，且不使用会掩盖硬失败的加权总分；新增机器可读指标配置、人工评分示例和公式回归测试。
- 限制：指标体系和计算逻辑已经验证，但尚未运行完整真实模型 Eval 或完成 30 条双人复核，因此当前没有可用于发布的实际指标结果；30 条首版数据中每类仅 6 条，切片百分比粒度较粗。
- 主要修改文件：`METRICS.md`、`test/fixtures/agent-eval-metrics.json`、`test/fixtures/agent-eval-human-scores.example.json`、`scripts/agent-eval-metrics.mjs`、`scripts/agent-behavior-eval.mjs`、`test/agent-eval-metrics.test.mjs`、`EVALUATION.md`、`PRD.md`、`README.md`、`CHANGELOG.md`。

### 评测：建立五类下一餐推荐 Agent 行为评测集

- 需求：在能力边界明确后建立正式 eval，覆盖正样本、负样本、边界与模糊情况、异常情况和对抗情况。
- 结果：新增 30 条首版行为评测样本，五类各 6 条，覆盖 Skill/意图/场景、状态与事实理解、Tool 选择和参数、确认写入、安全降级、记忆冲突、提示注入与越权请求；新增可执行评测器，自动检查结构化行为并输出人工复核标准；外部 Tool 支持仅测试环境可用的固定 fixture，避免真实网络波动影响模型评分；同步增加数据集覆盖和 fixture 隔离测试及 npm 命令。
- 限制：本次已完成离线 schema 与回归测试，尚未消耗真实模型调用运行全部 30 条；语义安全、真实性和可执行性仍必须人工复核，自动关键词与结构化检查不能单独作为发布结论。
- 主要修改文件：`test/fixtures/agent-behavior-cases.json`、`scripts/agent-behavior-eval.mjs`、`test/evaluation-dataset.test.mjs`、`server.mjs`、`package.json`、`EVALUATION.md`、`PRD.md`、`README.md`、`CHANGELOG.md`。

### 文档：定义下一餐推荐 Agent 的评测目标与能力边界

- 需求：在建立评测集前先明确 Agent 的评测目标，以及能做和不能做的事情。
- 结果：新增独立评测规范，限定评测对象为下一餐推荐 Agent，定义 Skill 路由、情境理解、Tool 编排、推荐质量、真实性、安全、状态边界和多轮稳定性；列出能力白名单、12 类硬失败、一票否决项、首版发布门槛、样本标注字段、覆盖维度和分层执行顺序，并将确定性计算、视觉精度、外部 POI 与真实用户结果从模型分数中剥离。
- 限制：本次先完成目标、边界和标注协议，尚未据此扩充正式评测样本或实现完整 Agent 评测执行器。
- 主要修改文件：`EVALUATION.md`、`PRD.md`、`README.md`、`CHANGELOG.md`。

### 功能：在周计划中直接展示具体食谱与餐厅推荐

- 需求：修复周计划仍只显示每餐名称、没有实际展示食谱和推荐餐厅的问题。
- 结果：为每个未执行餐次写入并展示带克数、步骤和耗时的在家食谱；新增整周餐厅补全工具，用户授权当前位置或输入城市、商圈、地址后，一次搜索真实 POI 并把门店、地址、距离、具体餐食和来源写入各餐次；未定位时明确显示尚未获取，演示模式则展示有明确标识的预置餐厅数据。
- 限制：真实餐厅依赖高德和位置授权，可核验公开菜单依赖已配置的模型服务；周计划餐厅是候选，未来日期的营业时间、菜单和供应仍需临近确认。
- 主要修改文件：`server.mjs`、`adaptive-plan.js`、`adaptive-plan.css`、`app.js`、`index.html`、`test/adaptive-plan.test.mjs`、`PRD.md`、`MVP.md`、`README.md`、`sw.js`、`CHANGELOG.md`。

### 文档：将产品核心定位收敛为减脂餐食推荐

- 需求：修正“背景与产品定位”，明确产品核心是为减脂用户进行餐食推荐，而不是以计划管理或饮食执行为核心。
- 结果：将核心痛点改为用户难以在每次用餐前快速获得符合减脂目标与当下条件的具体餐食；明确在家输出食谱、外食输出真实餐厅中的具体选择，并将周计划、记录、提醒和滚动更新定义为提高推荐质量的支撑能力；同步调整产品目标和项目介绍。
- 限制：本次不改变已经确定的功能范围与计划更新机制，只调整能力主次和产品叙事。
- 主要修改文件：`PRD.md`、`MVP.md`、`README.md`、`CHANGELOG.md`。

### 功能：以确认记录驱动餐后与日终滚动计划

- 需求：取消多余的 `replan_existing_plan`；每次记录后自动更新当天未执行餐次，晚餐确认、结束当天或跨日后再根据长期趋势温和更新未来计划，且不继承“热量债务”；周计划补充具体食谱与餐厅入口。
- 结果：移除计划补丁 API、Tool、聊天确认提案和重规划 UI，将唯一 Skill 收窄并更名为 `next-meal-decision`；确认记录后由确定性状态机恢复基准并重算当天剩余餐次，日终保存完整度与趋势依据；理论参考已超出时仍生成正常正餐参考而非 0 kcal，并同步修正 DIY、菜单与餐厅排序话术；本周计划为今天和明天提供具体食谱/餐厅入口，未来日期在临近用餐时结合最新状态生成。
- 限制：日终趋势目前采用最近最多 7 个结束日、至少 3 个完整记录日的规则分档，只温和更新未来计划说明，不自动修改长期减脂目标；真实 Skill Router、外部菜单和附近餐馆仍需配置对应服务后验证。
- 主要修改文件：`adaptive-plan.js`、`app.js`、`server.mjs`、`index.html`、`adaptive-plan.css`、`skills/next-meal-decision/`、`PRD.md`、`MVP.md`、`README.md`、`test/`、`sw.js`、`CHANGELOG.md`。

### 架构：将餐食场景统一为一个行为稳定 Skill

- 需求：按“Skill 用于稳定大模型意图判断、工具编排和输出边界，而非替代确定性程序”的原则修改现有 Skill。
- 结果：将 `meal-recommendation` 与 `adaptive-replanning` 合并为唯一的 `meal-decision` Skill，内部保留 `recommend_next_meal` 与 `replan_existing_plan` 两个互斥 workflow；同步统一 Router、运行时纠错、演示日志和路由评测的 Skill 标识，按业务意图隔离两个 workflow 可加载的 reference，并明确营养计算、日期与计划校验、确认写入和失败降级继续由服务端负责。
- 限制：Skill 只能提高模型行为的一致性，不能保证模型、外部 API 或系统基础设施永不失败；真实 LLM 路由效果仍需配置千问 API 后评测。
- 主要修改文件：`skills/meal-decision/SKILL.md`、`skills/meal-decision/references/`、`server.mjs`、`app.js`、`sw.js`、`test/skills.test.mjs`、`test/fixtures/skill-route-cases.json`、`test/prompt.test.mjs`、`README.md`、`CHANGELOG.md`。

## 2026-09-10

### 架构：拆分下一餐推荐与动态重规划 Skill

- 需求：不再把下一餐、当日调整和周计划调整混在一个 Skill 里；按用户目标拆分下一餐推荐与已有计划的动态重规划，重规划内部再选择下一餐、今天或本周的最小影响范围。
- 结果：收窄 `meal-recommendation` 边界并新增 `adaptive-replanning`；Router 新增 `replan` 意图，Agent 新增 `propose_plan_patch` 受控 Tool，经确定性规则拦截过去日期、已记录餐食、锁定日期、超出 `next_meal / today / week` 范围的变更和过期提案；聊天界面可展示、拒绝或确认计划变更，演示模式同步覆盖新 Skill。路由评测改为多 Skill 指标，并新增边界与变更校验回归测试。
- 限制：真实 Skill Router 评测需配置千问 API；千问不可用时，重规划会降级为只调整最近未执行餐食的安全规则提案。Skill 快速校验脚本因本机未安装 PyYAML 未能直接运行，已用等价 YAML 前置校验、仓库扫描和自动化测试验证名称、字段、参考文件与路由不变式。
- 主要修改文件：`skills/meal-recommendation/SKILL.md`、`skills/meal-recommendation/references/tool-guide.md`、`skills/adaptive-replanning/SKILL.md`、`skills/adaptive-replanning/references/replanning-rules.md`、`skills/adaptive-replanning/references/tool-guide.md`、`server.mjs`、`app.js`、`adaptive-plan.js`、`sw.js`、`scripts/skill-route-eval.mjs`、`test/fixtures/skill-route-cases.json`、`test/skills.test.mjs`、`test/prompt.test.mjs`、`README.md`、`CHANGELOG.md`。

### 功能：实现自然周驱动的动态饮食执行闭环

- 需求：根据已确定的产品设计更新代码，让 MVP 覆盖附近餐馆、按需完整菜单、主动提醒、固定自然周计划，并让 Agent 能在真实情况变化后持续调整尚未执行的餐食。
- 结果：新增周一至周日计划页、周中不补写过去日期、周日生成并确认下周提案且周一自动生效、日期锁定、版本确认与历史，确认记餐后同步回写本周执行状态；“今日”新增下一最佳行动和临时变化重规划；外食流程支持菜单图片、文字和公开链接的完整解析、来源/完整性标记与个性化排序；提醒改为显式授权并支持频率上限、免打扰、30 分钟后再提醒、接受和忽略；新增服务端 API、SQLite 状态迁移、演示模式响应、PWA 缓存和自动化回归测试。
- 限制：附近餐馆依赖高德；菜单图片和公开链接解析依赖千问，且未接入交易平台时不能保证任意门店菜单实时完整；粘贴文字可规则解析但完整性取决于用户输入；系统级后台通知受浏览器授权和部署环境限制，模型不可用时动态调整会降级为安全规则提案。
- 主要修改文件：`index.html`、`app.js`、`adaptive-plan.js`、`adaptive-plan.css`、`server.mjs`、`sw.js`、`package.json`、`test/adaptive-plan.test.mjs`、`README.md`、`CHANGELOG.md`。

### 文档：将 PRD 重构为动态减脂饮食执行 Agent

- 需求：在明确核心痛点后更新产品设计，并将长期周计划、主动提醒、不限地区的附近餐馆与按需完整菜单搜索纳入 MVP。
- 结果：重写产品定位、核心流程、P0 范围、信息架构、业务规则、异常处理、埋点和验收标准；菜单能力不设置城市、商圈或品牌白名单，支持授权或可核验来源及用户上传菜单的通用路径。
- 限制：本次仅更新产品要求，当前实现尚未同步补齐周计划、完整菜单获取与解析等新增 P0 能力；菜单实时性仍取决于外部数据权限和来源质量。
- 主要修改文件：`PRD.md`、`CHANGELOG.md`。

### 文档：拆分发布验收与真实用户验证并固定自然周

- 需求：在没有真实用户时使用可执行的上线前标准验收 MVP，将真实用户指标保留为上线后验证，并把周计划改为固定自然周。
- 结果：新增上线前发布验收表及 P95 口径，单列上线后 30 名目标用户连续 14 天的价值验证指标；周计划统一为 Asia/Shanghai 时区的周一至周日，补充周中建档和周日生成下周提案的规则。
- 限制：上线前验收只能证明产品按要求工作，不能替代真实用户对需求、采纳和留存的验证；当前实现尚未同步新增自然周计划能力。
- 主要修改文件：`PRD.md`、`CHANGELOG.md`。

## 2026-08-26

### 文档：按完整 PRD 标准补齐产品定义与发布约束

- 需求：按“背景、目标与指标、用户与场景、范围、方案、规则、异常边界、埋点、验收、依赖风险与版本计划”的标准完善项目 PRD。
- 结果：补充项目背景、量化成功指标与埋点口径、状态写入和异常处理规则、依赖风险与 P0/P1 发布条件；统一 PRD 与 MVP 对趋势建议及外食菜单核验范围的表述，并修复验收章节的 Markdown 代码块格式。
- 主要修改文件：`PRD.md`、`MVP.md`、`CHANGELOG.md`。

### 文档：精简 PRD 为十项交付章节

- 需求：删除 PRD 中不影响设计、开发、测试和上线判断的重复说明。
- 结果：将 PRD 收敛为背景、目标、用户场景、范围、方案、规则、异常、埋点、验收、依赖与版本计划十个章节，保留可执行规则和验收条件。
- 主要修改文件：`PRD.md`、`CHANGELOG.md`。

## 2026-08-24

### 修复：场景分流评测汇总指标计算

- 需求：修复 `meal-choice-eval` 的条件场景准确率恒为 0，以及 Router / 最终入口准确率百分比被错误放大 100 倍的问题。
- 结果：先写入 Router 返回的 `mealScenario` 后再判断场景命中；百分比函数统一接收“命中数、总数”，按二者比值计算，类别与对抗样本汇总同步修正。
- 主要修改文件：`scripts/meal-choice-eval.mjs`、`CHANGELOG.md`。

## 2026-08-21

### 功能：聊天 Agent 可使用浏览器授权的当前位置查询附近餐食

- 需求：Safari 已允许定位、页面外食入口可定位时，聊天 Agent 也应能获取当前位置完成附近餐食查询。
- 结果：仅当聊天消息明确询问附近餐食时，前端才请求浏览器位置并随该轮 Agent 请求发送；服务端校验经纬度后传给附近餐馆 Tool。Agent 执行日志会将坐标替换为“浏览器已授权”标记，不持久化原始经纬度；同时更新 PWA 缓存版本以加载新前端脚本。
- 限制：定位被拒绝、超时或消息未表达附近餐食意图时，不会发送位置；此时仍可输入城市/商圈搜索。
- 主要修改文件：`app.js`、`server.mjs`、`sw.js`、`test/prompt.test.mjs`、`CHANGELOG.md`。

### 性能：并行执行 Agent 的独立前置请求

- 需求：缩短每次 Agent 提问的等待时间，同时保持现有模型、提示词、工具和记录规则不变。
- 结果：记忆检索与意图路由改为并行；路由完成后的餐食场景判断与计划生成也改为并行，等待时间由两路耗时之和缩短为其中较慢一路。
- 限制：最终模型回答、实际 Tool 调用及外部检索仍需依赖前置结果顺序执行；模型调用次数和费用不变，最慢的上游请求仍决定该阶段的耗时。
- 主要修改文件：`server.mjs`、`CHANGELOG.md`。

### 修复：文字记餐校验失败后禁止伪称已确认

- 需求：解决品牌餐食未匹配本地营养库时，Agent 虽未写入饮食记录却回复“已确认记录”的问题。
- 结果：`propose_meal_record` 失败会立即终止本轮记录流程，返回“尚未记录”的真实原因并打开手动记录入口；后续路由纠正也不会覆盖该受控失败结果。新增回归测试覆盖失败文案和手动记录动作。
- 限制：未配置或未录入本地库的品牌/组合餐仍需用户提供克数、包装/门店营养信息，或以手动估算方式保存。
- 主要修改文件：`server.mjs`、`test/prompt.test.mjs`、`CHANGELOG.md`。

### 修复：本地真实服务错误显示面试演示横幅

- 需求：解决访问不含 `?demo` 的 `localhost:8080` 时，页面仍显示“面试演示模式”提示的问题。
- 结果：补充横幅的 `[hidden]` 显式隐藏规则，避免其基础样式的 `display:flex` 覆盖隐藏状态；同时递增 Service Worker 应用壳缓存版本以淘汰旧前端资源。仅 GitHub Pages 或显式 `?demo` 才会显示横幅并使用预置响应。
- 限制：已打开的受旧 Service Worker 控制的标签页需刷新一次，必要时关闭后重新打开，才会安装新版本资源。
- 主要修改文件：`index.html`、`sw.js`、`CHANGELOG.md`。

### 部署：新增 GitHub Pages 面试演示模式

- 需求：在无法使用 Render 的情况下，将产品界面发布为 GitHub Pages 网页，供面试官直接查看和操作。
- 结果：新增 GitHub Pages 自动识别的前端演示模式和醒目说明；DIY、营养查询、餐厅推荐、图片记录、Agent 对话及工具日志改由明确标注的预置响应支持，用户档案和记录仅存于当前浏览器；Service Worker 改为相对路径以兼容项目型 Pages；README 增加 `lnx-fight.github.io/food-agent-demo` 发布步骤与限制。
- 限制：该模式不调用千问、高德、USDA、Open Food Facts 或服务端 SQLite，不能作为真实模型或位置服务的证明；真实服务端部署行为保持不变。
- 主要修改文件：`index.html`、`app.js`、`styles.css`、`sw.js`、`README.md`、`CHANGELOG.md`。

### 修复：文字记餐不再生成零热量确认提案

- 需求：修复“牛肉包、猪肉包和鸡蛋”等多食物文字记录被截断、遗漏食物并生成 0 kcal 提案的问题。
- 结果：服务端会拆分多项食物、将常见肉包映射至本地营养库、按默认常见份量估算热量和蛋白质；无法可靠估算时改为拒绝提案并要求补充信息。
- 限制：包子默认按 100g/个、鸡蛋按 50g/个估算，实际大小与馅料会产生误差；用户可改用手动记录补充准确克数。
- 主要修改文件：`server.mjs`、`test/text-meal-estimate.test.mjs`、`CHANGELOG.md`。

### 部署：补齐 Render 在线 Demo 发布配置

- 需求：将完整的小饭 Web Demo 部署到 Render，并在 GitHub README 提供面试官可访问的在线链接。
- 结果：新增 `render.yaml`，预设 Node 22、Singapore、健康检查、自动部署与非提交式密钥变量；新增 `.gitignore` 排除密钥、本地 SQLite 与备份；服务端支持以 `DATA_DIR` 指向云端持久化磁盘；README 补充从 GitHub 连接 Render、填写密钥、验证健康检查和回填在线链接的步骤。
- 限制：实际 GitHub 仓库创建、Render 账户授权、密钥填写与首次部署须由账户持有人完成；免费 Render 实例会休眠且 SQLite 数据不跨重启持久化。
- 主要修改文件：`.gitignore`、`render.yaml`、`server.mjs`、`README.md`、`CHANGELOG.md`。

### 文档：更新 README 与当前产品能力对齐

- 需求：核对并修正 README，使其准确反映当前小饭产品内容。
- 结果：更新产品定位、浏览器与服务端同步存储、重置限制、模型与规则降级策略、Skill 路由、主动任务、复盘、执行目标和工具日志说明；补齐当前主要后端 API 与可选配置项。
- 限制：当前“重新开始”仍不会删除服务端同步数据，README 已明确此限制；未在本次修改中改变重置行为或数据删除能力。
- 主要修改文件：`README.md`、`CHANGELOG.md`。

## 2026-08-20

### 配置：餐食图片识别切换为独立视觉模型

- 需求：根据更新后的 `.env`，让小饭使用适合餐食图片识别的千问视觉模型，而非复用文本/联网模型。
- 结果：确认服务端图片分析已独立读取 `QWEN_VISION_MODEL`；新增无密钥的 `.env.example`，将视觉默认示例更新为 `qwen3-vl-flash`，并在 README 明确视觉、文本模型职责及配置修改后的重启要求。
- 限制：视觉模型调用仍依赖有效且与百炼接口地域匹配的 `DASHSCOPE_API_KEY`；本次仅完成本地静态检查，未发送真实图片请求。
- 主要修改文件：`.env.example`、`README.md`、`CHANGELOG.md`。

### 调整：多轮任务完成率评测集缩减至 10 条

- 需求：将任务完成率测试集精简到 10 条并重新评测，降低双轮完整 Agent 调用成本。
- 结果：`task-trajectory-cases.json` 从 30 条缩减为 10 条，保留方式选择 4 条、DIY 跟进 3 条、餐厅跟进 3 条；覆盖疲劳/减脂/食材与外卖冲突、不同食材与厨具、地点已知或后续补充等信号。
- 评测执行：`task-trajectory-eval` 新增可选 `TASK_TRAJECTORY_EVAL_PROGRESS=1`，用于长时间真实评测时逐条输出完成进度；默认输出不变。
- 限制：精简集适合快速回归，不能替代更大规模的多轮表达覆盖。
- 主要修改文件：`test/fixtures/task-trajectory-cases.json`、`CHANGELOG.md`。

### 增强：目标状态机与可恢复 Agent 执行记录

- 需求：将产品完善为围绕目标自主推进的 Agent，具备状态感知、计划执行、Tool 结果记录、失败重规划、用户确认暂停与跨会话可追溯能力。
- 结果：新增 `agent_goals` / `agent_goal_steps` 持久化模型；每轮 Agent 对话创建可追踪目标，记录每个受控 Tool 的参数、结果、预期观察与状态，返回 `goal` 状态并提供 `/api/agent/executions` 查询接口；Tool 失败时自动请求一次替代计划并执行非重复 Tool；生成记录提案后目标进入 `awaiting_user`，其他成功目标进入 `completed`，不可恢复 Tool 错误进入 `blocked`。
- 限制：当前替代计划最多执行一次，复杂的长任务仍需后续将执行器拆为独立后台 worker，以支持跨进程持续推进与更细粒度的成功标准。
- 主要修改文件：`server.mjs`、`test/agent-goal-execution.test.mjs`、`CHANGELOG.md`。

### 修复：规划步骤转为受控 Tool 调度

- 需求：解决规划器已选择 Tool、但 Agent 未真正调用 Tool 的问题。
- 结果：将规划器输出的合法 Tool 步骤转为有序受控调用队列，由运行时直接执行并把真实结果注入后续回答；饮食记录与待确认餐食修正还会按明确意图补充 `propose_meal_record` / `revise_pending_meal`，不再依赖模型是否主动发起 function call。
- 限制：外部依赖型 Tool 仍会如实报告配置或服务错误；规划器给出错误步骤时会被强制执行，因此后续应继续用 Tool 执行评测监控规划质量。
- 主要修改文件：`server.mjs`、`CHANGELOG.md`。

### 新增：Tool 执行成功率评测

- 需求：验证需要调用 Tool 的请求是否实际调用指定 Tool，且 Tool 返回成功。
- 结果：新增 8 条固定 Tool 评测夹具与 `tool-execution-eval` 命令，覆盖用户状态、餐次预算、DIY 食谱、营养查询、日计划、记忆、记录提案及待确认餐食修正；`agentChat` 返回精简 Tool 日志，评测同时报告目标 Tool 成功率、实际调用成功率、漏调与调用失败。
- 限制：当前夹具不覆盖依赖位置与高德密钥的餐厅检索链路；真实结果受模型与外部服务可用性影响。
- 主要修改文件：`server.mjs`、`test/fixtures/tool-execution-cases.json`、`scripts/tool-execution-eval.mjs`、`package.json`、`CHANGELOG.md`。

### 调整：Skill 路由评测样本缩减至 30 条

- 需求：将测试样本缩减到 30 条，降低真实模型回归的耗时与调用成本。
- 结果：`skill-route-cases.json` 从 250 条精简为 30 条代表样本，保留普通餐食推荐、DIY、外食、记录、营养、体重、通用请求、冲突边界及医疗饮食边界覆盖。
- 限制：样本集改用于快速回归，不再适合衡量大规模线上表达分布的稳定性。
- 主要修改文件：`test/fixtures/skill-route-cases.json`、`CHANGELOG.md`。

### 增强：餐食 Router 评测拆分为三层

- 需求：分别衡量 Skill/餐食意图路由、进入餐食后的三场景识别，以及包含非餐食输入的端到端入口准确率。
- 结果：保留 `skill-route-eval` 作为第一层并报告 Skill Precision / Recall / F1；`meal-choice-eval` 改为第二层并报告条件场景准确率、Router action 与最终入口准确率；新增 `router-e2e-eval`，将 30 条餐食样本与 10 条非餐食样本合并，报告端到端入口准确率。
- 评测执行：`skill-route-eval` 同步改为 1–10 路可配置并发（默认 6），以支持较大样本集的真实模型回归。
- 限制：端到端集中的非餐食样本当前覆盖通用、营养查询、医疗饮食、记录和历史背景，不替代完整线上分布。
- 主要修改文件：`scripts/meal-choice-eval.mjs`、`scripts/router-e2e-eval.mjs`、`package.json`、`CHANGELOG.md`。

### 清理：移除重复的餐食 Skill 完成校验

- 需求：删除与餐食入口评测重复的 `meal-skill-completion` 校验链路。
- 结果：移除固定结果夹具、校验脚本、单元测试和 `skill-completion-check` 命令；Skill 文档改为指向 `meal-choice-eval` 与 `task-trajectory-eval`，分别覆盖入口回归和多轮任务完成。
- 限制：历史变更记录仍保留已移除校验的说明，便于追溯。
- 主要修改文件：`package.json`、`skills/meal-recommendation/SKILL.md`、`CHANGELOG.md`；删除 `skills/meal-recommendation/scripts/verify-completion.mjs`、`test/meal-skill-completion.test.mjs`、`test/fixtures/meal-skill-completion-result.json`。

### 新增：独立的 30 条多轮任务轨迹评测

- 需求：将 Task Completion Rate 与单轮餐食入口评测分离，以 Agent 是否将模拟用户带到可完成目标的正确状态为标准。
- 结果：新增 30 条两轮任务轨迹（方式选择、DIY 跟进、餐厅跟进各 10 条）和 `task-trajectory-eval` 命令；每轮校验最终 action、Router action、action 来源与非空回答，全部轮次通过才计为任务成功，并按类别汇总模拟完成率。
- 限制：当前终态是 DIY / 餐厅工作区可用，不验证真实烹饪、下单或进食；记录确认与数据库写入将在后续任务集中覆盖。
- 主要修改文件：`test/fixtures/task-trajectory-cases.json`、`scripts/task-trajectory-eval.mjs`、`package.json`、`CHANGELOG.md`。

### 新增：餐食 Skill 的任务完成标准自动校验

- 需求：为 Skill 增加 `scripts`，自动验证任务具有明确、可判定的结束标准。
- 结果：在 `meal-recommendation` 中定义 Router 场景、最终入口动作和非空用户回答三项结束条件；新增独立的 `verify-completion.mjs`，可校验保存的 `agentChat` 返回 JSON，并以非零退出码阻断未完成或场景/动作不一致的结果；补充通过与失败回归用例，并提供 `npm run skill-completion-check` 离线命令。
- 限制：该脚本校验返回结果的完成契约，不替代需要真实模型额度的语义路由和场景分流评测。
- 主要修改文件：`skills/meal-recommendation/SKILL.md`、`skills/meal-recommendation/scripts/verify-completion.mjs`、`test/meal-skill-completion.test.mjs`、`package.json`、`CHANGELOG.md`。

### 重构：餐食入口改由 Router 直接返回

- 需求：将 DIY / 外食 / 方式选择的入口分流从 Agent 输出中移出，避免 Agent action 被确定性映射纠错或强制覆盖。
- 结果：Router 根据餐食场景直接返回前端 action，Agent 仅生成对应场景的建议、规划及 Tool 调用结果；移除了 action 不一致时的纠错重跑和强制覆盖，保留意图冲突的语义纠错；评测改为分别记录 Router、Agent 与最终 action。
- 限制：Router 仍使用 LLM 语义分类，分类缺失或非法时才回退场景分类器与正则规则；非餐食请求的前端 action 仍可由 Agent 返回。
- 主要修改文件：`server.mjs`、`test/skill-runtime.test.mjs`、`scripts/meal-choice-eval.mjs`、`CHANGELOG.md`。

### 调整：场景分流评测支持受控并发

- 需求：在当前单次命令时限内完成真实模型场景评测。
- 结果：`meal-choice-eval` 默认以 6 路并发调用 30 条夹具，可通过 `MEAL_CHOICE_EVAL_CONCURRENCY` 在 1–10 路间调整，并保持输出顺序与原夹具一致。
- 限制：并发数越高，对模型服务并发额度和速率限制的要求越高。
- 主要修改文件：`scripts/meal-choice-eval.mjs`、`CHANGELOG.md`。

### 增强：30 条场景样本增加任务轨迹模拟

- 需求：以“Agent 是否将用户带到可完成目标的正确状态”为标准，使用样本模拟用户完成下一步。
- 结果：复用 30 条餐食场景样本；评测在 Router action 正确且来源为 Router 时判为“任务就绪”，再模拟打开 DIY/餐厅工作区或在方式选择中选择 DIY，并统计任务就绪率与模拟完成率。
- 限制：当前模拟的是进入可执行工作区或完成方式选择，不代表用户已真实烹饪、下单或进食；真实用户完成率仍需前端事件埋点。
- 主要修改文件：`scripts/meal-choice-eval.mjs`、`CHANGELOG.md`。

### 调整：餐食场景收敛为三个状态

- 需求：用户状态仅保留三个状态，移除 `ambiguous`。
- 结果：场景枚举、Router/分类器提示词与动作映射均只保留 `diy`、`restaurants`、`unknown`；DIY 与外食信号冲突时统一归入 `unknown`，继续进入 `open_meal_choice`；评测夹具和单元测试同步改为三状态口径。
- 限制：历史变更记录与备份文件仍可能提及已移除的枚举，不参与当前运行逻辑。
- 主要修改文件：`server.mjs`、`test/skill-runtime.test.mjs`、`test/fixtures/meal-choice-cases.json`、`CHANGELOG.md`。

### 更新：替换场景分流评测集为另一组 30 条用例

- 需求：将 `meal-choice-cases.json` 的全部样本改为另一组 30 条，并重新进行评测。
- 结果：替换全部原有消息和 ID，保留明确 DIY、明确外食、场景未明确各 10 条及 8 条对抗样本；覆盖食材、厨具、做法、附近、外卖、到店、地点、热量、偏好、运动后与 DIY/外食抉择等表达。
- 限制：该组仍是 30 条快速回归集，真实评测结果会随模型版本、额度和采样波动。
- 主要修改文件：`test/fixtures/meal-choice-cases.json`、`CHANGELOG.md`。

### 重构：场景分流改为 LLM 语义路由与确定性动作收敛

- 需求：以 Router LLM 的语义判断替代关键词主判定；Router 输出 `intent + mealScenario`，场景合法时直接采用，缺失或非法时调用场景 LLM，仍失败才使用正则兜底；按场景映射期望动作，Agent 不一致时纠错重跑一次，仍不一致由服务端强制为期望动作。
- 结果：新增 `diy` / `restaurants` / `unknown` / `ambiguous` 场景枚举及其 `open_diy` / `open_restaurants` / `open_meal_choice` 动作映射；Router 与 Agent 上下文均携带场景约束；返回 `routing` 追踪初始动作、纠错后动作、强制状态与场景来源。评测脚本新增首次 LLM、纠错后、最终动作准确率及纠错/强制次数；补齐 `hasScenarioSignal` 导出并新增动作映射单元测试。`npm run check` 与 `npm test`（33 项）通过；3 条真实冒烟用例均由 `router_llm` 判为 `diy`、首次输出正确。
- 限制：完整 30 条评测仍会产生真实模型费用与受千问额度影响；正则仅在场景 LLM 调用异常或返回非法枚举时启用。
- 主要修改文件：`server.mjs`、`scripts/meal-choice-eval.mjs`、`test/skill-runtime.test.mjs`、`CHANGELOG.md`。

### 调整：场景分流测试集精简为 30 条

- 需求：将 `meal-choice-cases.json` 从 50 条进一步压缩到 30 条，以降低真实模型评测成本。
- 结果：保留明确 DIY、明确外食、场景未明确各 10 条，并覆盖直接/隐式做饭、做饭动作、附近/外卖/堂食、热量/偏好/运动后和场景选择信号；其中保留 8 条对抗样本。
- 限制：样本量进一步下降，适合快速冒烟验证，不再适合衡量全量场景分流的稳定性。
- 主要修改文件：`test/fixtures/meal-choice-cases.json`、`CHANGELOG.md`。

## 2026-08-19

### 调整：场景分流测试集精简为 50 条

- 需求：将 `meal-choice-cases.json` 缩减为仅 50 条，便于进行测试。
- 结果：保留 50 条代表性用例，包含明确 DIY、明确外食、场景未明确各 15 / 15 / 20 条，以及 8 条对抗样本；仍覆盖直接/隐式做饭、附近/外卖/堂食、热量/偏好/运动后与场景选择等核心分流信号。
- 限制：测试集不再覆盖原 250 条的全部措辞与细分比例，不适合作为全量回归覆盖基线。
- 主要修改文件：`test/fixtures/meal-choice-cases.json`、`CHANGELOG.md`。

### 恢复：移除 DeepSeek 配置并改回千问模型

- 需求：不保留现有 DeepSeek 配置，恢复项目最初的千问模型版本。
- 结果：服务端恢复为仅通过阿里云百炼 OpenAI 兼容接口调用千问；删除 DeepSeek 配置分支，并改用 `qwen3.8-max`（对话/联网）与 `qwen3-vl-plus`（视觉）。
- 限制：`DASHSCOPE_API_KEY` 需填入有效的百炼 API Key 后才能调用模型服务。
- 主要修改文件：`server.mjs`、`.env`、`CHANGELOG.md`。

### 扩充：场景分流评测集（meal-choice-cases）至 250 条

- 需求：用户要求把场景分流样本扩充到 250 条，并明确四类覆盖口径——明确 DIY 至少覆盖直接表达、隐式但明确、做饭动作、带强干扰；明确外食不能只有“附近餐厅”，需覆盖附近餐厅、外卖、到店、堂食、模糊外食、带位置；场景未明确作为重点扩充（含“中午吃什么”“晚饭推荐一下”“减脂期中午吃什么”“今天还剩 520 kcal，吃什么”“想吃高蛋白一点”“今天运动完吃什么”“想吃清淡点”“给我推荐一顿 500 卡的”等示例）；对抗样本增至 30–40 条。
- 结果：`test/fixtures/meal-choice-cases.json` 从 36 条扩充到 250 条：明确 DIY 75（直接 16 / 隐式 16 / 做饭动作 16 / 带强干扰 27）、明确外食 75（附近 13 / 外卖 14 / 到店 12 / 堂食 11 / 模糊外食 15 / 带位置 10）、场景未明确 100（纯问吃什么 35 / 剩余热量 12 / 目标偏好 14 / 运动后 10 / 口味 12 / 指定卡路里 12 / 场景选择类 5）。对抗样本共 35 条（DIY 12 / 外食 13 / 未明确 10），每条带 `adversarial: true` 与干扰说明；全部条目补充 `style` 字段便于按覆盖类型审计。静态校验通过：id 与 message 均唯一、expectedAction 合法；`npm test` 32 项通过。
- 限制：本轮只扩充样本与结构，未重跑全量 `npm run meal-choice-eval`（真实 LLM 调用，250 条成本与耗时较高）；建议恢复千问额度后全量评测，重点观察新增的强干扰与“场景选择类”对抗样本（如“外卖还是自己做，帮我选”）。
- 主要修改文件：`test/fixtures/meal-choice-cases.json`、`CHANGELOG.md`。

### 调整：明确场景分流动作，DIY / 外食分别返回 open_diy / open_restaurants

- 需求：用户确认评测口径——明确 DIY 的最终动作应为 `open_diy`，明确附近餐厅 / 外食应为 `open_restaurants`；首轮评测发现明确场景的样本几乎全部返回 `none`（41.7% 准确率），需要让模型输出对应分支动作。
- 结果：在 `skills/meal-recommendation/SKILL.md` 场景分流章节与示例中显式规定动作映射（明确 DIY → `open_diy`、明确餐厅 / 到店 / 外卖 → `open_restaurants`、未明确 → `open_meal_choice`），并明确“场景明确时不得返回 `none`”；`tool-guide.md` 的 DIY 示例同步补充最终输出 `open_diy`。重跑 meal-choice 评测：可计入 34/34 条全部正确（100%），三类均 100%，对抗样本 4/4 通过，兜底介入 0 次。
- 限制：评测中途遇到千问免费额度耗尽，`adv-05`（今天不想做饭）与 `adv-06`（叫外卖还是出去吃都行）未能完成复测，需恢复额度后重跑 `npm run meal-choice-eval` 确认；动作规则当前依赖模型遵循 SKILL 指令，尚未为明确场景增加确定性强制兜底。
- 主要修改文件：`skills/meal-recommendation/SKILL.md`、`skills/meal-recommendation/references/tool-guide.md`、`CHANGELOG.md`。

### 新增：场景分流准确率评测（meal-choice-eval）

- 需求：用户要求新增“场景分流”评测，口径为“场景分流准确率 = 最终进入正确场景分支的样本数 / 总场景分流样本数”，只检查最终 `action.type` 是否正确分流，不检查正文，也不拆分模型级/系统级指标。
- 结果：新增 `test/fixtures/meal-choice-cases.json`（36 条样本：明确 DIY 11、明确附近餐厅/外食 14、场景未明确 11，其中 6 条为对抗样本，覆盖“在家附近吃”“不想做饭”“外卖还是出去吃都行”等信号正则边界）；新增 `scripts/meal-choice-eval.mjs`，逐条调用完整 `agentChat`，输出整体准确率、按类别准确率、对抗样本子集准确率，并附兜底介入（correction/force）诊断信息但不计入准确率；`package.json` 增加 `npm run meal-choice-eval`，支持 `MEAL_CHOICE_EVAL_LIMIT` 冒烟跑。
- 限制：评测为真实 LLM 调用，每条会走完整 Agent 循环，成本与耗时较高，建议先用 `MEAL_CHOICE_EVAL_LIMIT` 冒烟；“场景未明确”类受服务端强制兜底影响，准确率会偏高，属于预期内，后续如需评测模型第一轮表现需另行暴露首轮 action。
- 主要修改文件：`test/fixtures/meal-choice-cases.json`、`scripts/meal-choice-eval.mjs`、`package.json`、`CHANGELOG.md`。

### 扩充：Skill routing 评测集至 250 条，新增医疗/慢病硬边界样本

- 需求：用户要求扩充 skill-route 评测集到 250 条，并加入“我高血压平时饮食要注意什么”“我痛风应该怎么吃”“胃炎吃东西有什么需要注意的”“医生说我血糖高，饮食应该怎么调整”“我有糖尿病，中午不知道吃什么”“医生让我少盐，我今天中午吃什么？”等医疗/慢病负向样本，且 Hard Boundary 占比要较高。
- 结果：`test/fixtures/skill-route-cases.json` 从 31 条扩充到 250 条（id / message 均唯一）。新增 `hard_boundary_medical` 类别 40 条（均期望 `other`、不触发 meal-recommendation），`hard_boundary` 扩至 60 条，两类 Hard Boundary 合计 100 条、占 40%；其余为 positive_simple 28 / positive_diy 24 / positive_restaurant 24 / negative_record 22 / negative_nutrition 20 / negative_weight_medical 16 / negative_other 16。首轮全量评测发现 3 条医疗样本被误路由为 meal（“我有糖尿病，中午不知道吃什么”“医生让我少盐，我今天中午吃什么？”“尿酸高，中午外卖怎么选”）；收紧 Router system prompt，明确“消息提到疾病/慢病名称、医嘱或用药背景时，即使同时出现‘中午吃什么/外卖/餐厅’等餐食表达也一律归 other”后，250 条全部通过：整体 Precision 100.0%、Recall 100.0%、F1 100.0%，TP/FP/TN/FN = 119/0/131/0。`npm test` 32 项通过、`npm run check` 通过。
- 限制：评测为单次真实 LLM 调用，输出仍可能波动；医疗负样本目前 40 条，后续可继续扩充罕见病、用药、术后等样本。强规则会把“疾病背景 + 明确下一餐请求”统一归为 `other`，符合产品医疗边界，但这部分用户将无法直接使用餐食推荐技能，需在对话层做好能力边界说明。
- 主要修改文件：`test/fixtures/skill-route-cases.json`、`server.mjs`、`CHANGELOG.md`。

### 优化：Router 提示词强调“当前主要任务”与医疗负向边界

- 需求：用户要求把 `routeDescription()` 的 Router system prompt 改为更强调用户完整语义和当前主要任务，避免局部关键词触发 Skill，并明确疾病/慢病/医疗健康相关饮食咨询应归为 `other`。
- 结果：更新 Router 提示词，保留输出 JSON 契约；重新运行 `npm run skill-route-eval`，31 条样本全部通过，整体 Precision 100.0%、Recall 100.0%、F1 100.0%，此前误报的“我糖尿病应该怎么吃”已正确归为 `other`。`npm test` 32 项通过、`npm run check` 通过。
- 限制：本轮评测为单次真实调用，LLM 输出仍可能波动；医疗负样本目前只有 1 条，后续可扩充更多慢病/药物咨询样本持续验证。
- 主要修改文件：`server.mjs`、`CHANGELOG.md`。

### 调整：meal-recommendation 描述补充医疗问题负向边界

- 需求：用户手动修改 `SKILL.md` description，把负向范围明确为“单纯查询某种食物热量、记录已经吃过的餐食、记录体重和医疗问题”。
- 结果：`skills/meal-recommendation/SKILL.md` frontmatter description 已更新；重新运行 `npm run skill-route-eval`，整体指标仍为 Precision 95.0%、Recall 100.0%、F1 97.4%，其中“我糖尿病应该怎么吃”仍被误命中为 `meal-recommendation`。
- 限制：仅靠当前一句负向描述不足以完全阻止医疗类样本误命中，后续可考虑在 Router 的 system prompt 中增加“医疗/疾病问题优先归为 other”或扩充更多医疗负样本继续校准。
- 主要修改文件：`skills/meal-recommendation/SKILL.md`、`CHANGELOG.md`。

### 新增：Skill routing 语义边界评测

- 需求：用户希望验证去掉关键词/exclude 后，`meal-recommendation` Skill 的语义路由是否真正优化成功，并重点覆盖包含冲突信号的 hard boundary 样本。
- 结果：新增 `test/fixtures/skill-route-cases.json`（31 条固定样本，覆盖 positive_simple / positive_diy / positive_restaurant / negative_record / negative_nutrition / negative_weight_medical / negative_other / hard_boundary）；新增 `scripts/skill-route-eval.mjs`，单次调用真实 `routeDescription()`，输出整体与按 category 的 Precision / Recall / F1、TP/FP/TN/FN、错误样本；`package.json` 增加 `npm run skill-route-eval`。首轮结果：整体 Precision 95.0%、Recall 100.0%、F1 97.4%，唯一误报为“我糖尿病应该怎么吃”被路由为 meal-recommendation。
- 限制：评测为单次真实调用，LLM 输出可能有波动；当前 `hard_boundary` 13/13 通过，但医疗类负样本仍需后续增加或调整语义边界。
- 主要修改文件：`test/fixtures/skill-route-cases.json`、`scripts/skill-route-eval.mjs`、`package.json`、`CHANGELOG.md`。

### 修复：Router 不再用“记录”硬正则覆盖 LLM 的 meal 意图

- 需求：用户指出语义路由边界不应被关键词硬规则破坏，例如“我刚记录完早餐，现在中午吃什么”包含“记录”，但主任务仍是下一餐推荐，不应被强制归为 `record`。
- 结果：`normalizeRouterIntent()` 改为优先信任 LLM 返回的有效 `routerIntent`；只有 LLM 未返回有效意图时，才依次使用技能命中结果和记录类正则兜底。`test/skill-runtime.test.mjs` 增加“记录完早餐后问中午吃什么仍为 meal”的回归断言，`npm test` 32 项通过、`npm run check` 通过。
- 限制：记录类正则仅作为 LLM 意图缺失时的兜底，不再作为最高优先级硬规则。
- 主要修改文件：`server.mjs`、`test/skill-runtime.test.mjs`、`CHANGELOG.md`。

## 2026-08-18

### 优化：餐厅 / 高德数据可信边界文档

- 需求：用户重写 `amap-api.md`，把它收敛为餐厅与菜单真实世界数据的可信边界说明，明确高德 POI 能/不能证明什么、公开菜单核验标准、`verified_menu` / `amap_tag` / `type_fallback` 的证据等级与表达边界。
- 结果：`skills/meal-recommendation/references/amap-api.md` 已更新，与当前 `findVerifiedRestaurantMenu()` → `buildAmapTagRecommendation()` → `type_fallback` 的代码链路对齐；同时明确 Level 2 的“相互印证、门店匹配”当前主要基于模型语义判断，不是逐字段确定性校验。
- 限制：本次只改文档，未调整代码。
- 主要修改文件：`skills/meal-recommendation/references/amap-api.md`、`CHANGELOG.md`。

### 修复：餐厅菜单核验优先级改为“真实菜单 → 高德特色菜 → 店型降级”

- 需求：用户要求把附近餐厅链路改为先针对真实餐厅尝试联网核验菜单；有官方来源或至少两个相互印证的公开来源时返回 `verified_menu`；核验不到再检查高德 `business.tag` 返回 `amap_tag`；仍无候选才进入 `type_fallback`。
- 结果：将 `findRestaurantMenu()` 重构为 `findVerifiedRestaurantMenu()` + `buildAmapTagRecommendation()` + 流程编排，联网菜单核验优先于高德特色菜。`npm test` 32 项通过、`npm run check` 通过。
- 限制：菜单核验失败后的 `amap_tag` 与 `type_fallback` 逻辑保持不变；`personalizeRestaurant()` 的评分权重无需调整，因为原有权重已符合 `verified_menu > amap_tag > type_fallback`。
- 主要修改文件：`server.mjs`、`CHANGELOG.md`。

### 优化：下一餐推荐业务规则文档

- 需求：用户要求按新职责拆分重写 `recommendation-rules.md`，将其聚焦为候选过滤、排序、选择、结果表达和降级规则；场景分流由 `SKILL.md`、Tool 编排由 `tool-guide.md`、营养与餐厅数据规则由各自 reference 负责。
- 结果：替换 `skills/meal-recommendation/references/recommendation-rules.md`，明确硬约束与软偏好、候选过滤与排序、DIY/附近餐厅候选要求、数据可信度与推荐粒度、主备选、推荐理由、失败降级和结果检查，并将内部 references 路径统一为 `references/...`。
- 限制：文档已将“不喜欢”归为软偏好，但当前 `personalizeRestaurant()` 仍把 `dislikedFoods` 与 `allergies` 一起做硬过滤；后续代码调整时需要拆分，本次只改文档。
- 主要修改文件：`skills/meal-recommendation/references/recommendation-rules.md`、`CHANGELOG.md`。

### 调整：Skill 路由改为完全 LLM + description，移除关键词/exclude 回退

- 需求：用户决定不再保留关键词 fallback，所有 Skill routing 都交给 LLM 根据技能 description 语义判断；删除 `keywords`、`exclude` 及相关关键词匹配/过滤逻辑和测试。
- 结果：`skills/meal-recommendation/SKILL.md` frontmatter 仅保留 `name` / `description` / `intents`；删除 `filterSkillsByExclude` 与 `matchSkills`，`routeDescription` 改为始终调用 LLM 路由，不再走关键词 fallback；`parseSkillFrontmatter` / `scanSkills` 只暴露 description 与 intents；`test/skill-runtime.test.mjs` 删除关键词匹配、exclude 硬门和离线回退测试，并新增/保留 skill 内容加载与 frontmatter 解析测试。`npm test` 32 项通过、`npm run check` 通过。
- 限制：未配置 `DASHSCOPE_API_KEY` 时无法进行技能路由，但这与 Agent 对话本身需要真实 LLM 的前提一致；`normalizeRouterIntent` 的记录意图兜底仍保留，用于避免 LLM 偶尔把“记录”归错。
- 主要修改文件：`skills/meal-recommendation/SKILL.md`、`server.mjs`、`test/skill-runtime.test.mjs`、`CHANGELOG.md`。

### 优化：System Prompt 按职责收敛为全局不变量

- 需求：用户要求先做提示词优化，把 System Prompt 收敛成所有对话路径都必须遵守的全局行为契约；餐食推荐场景的专项规则（如未明确在家/外食时返回 `open_meal_choice`）不写入全局 System Prompt，交给 meal-recommendation Skill 和确定性兜底。
- 结果：重写 `SYSTEM_BASE`，按「事实与数据 / 安全 / 状态变更与写入 / Tool 使用 / 输出」分组，明确 Tool 返回结果不可自行改写、历史对话数字不得当作当前状态、写库必须走 `propose_meal_record` → 用户确认、`pendingMeal` 优先走 `revise_pending_meal`；同时保留“估算数值只返回单一数值”和“未确认前不得声称已写入”等契约。`PROMPT_VERSION` 升级为 `v9`，`test/prompt.test.mjs` 相应更新，`npm test` 34 项通过、`npm run check` 通过。
- 限制：本次只改提示词，不调整提案/确认链路的代码逻辑；场景未明确时的前端入口仍由 `skills/meal-recommendation/SKILL.md` 与 `isMealChoiceActionViolation` 确定性兜底保证。
- 主要修改文件：`server.mjs`、`test/prompt.test.mjs`、`CHANGELOG.md`。

### 配置：为千问 JSON 结构化调用统一关闭思考模式

- 需求：`.env` 已将 `QWEN_WEB_MODEL` / `QWEN_CHAT_MODEL` 切换为 `qwen3.8-max`，该系列默认开启思考模式，会与项目中的 `response_format:{type:'json_object'}` 冲突。
- 结果：`qwenChat` 发送 OpenAI 兼容请求时统一附加 `enable_thinking:false`，让视觉、联网检索、食谱、Agent 与复盘等模型调用在 JSON 结构化场景下直接输出可解析内容。
- 限制：该参数由 `qwenChat` 统一注入，所有千问调用共享；如果未来某个模型必须使用思考模式，需要改为按调用场景区分。
- 主要修改文件：`server.mjs`、`CHANGELOG.md`。

## 2026-08-17

### 修复：技能路由/纠错测试引用但服务端未实现，导致测试失败且兜底逻辑未真正生效

- 需求：用户反馈“还是不行”。排查发现 `test/skill-runtime.test.mjs` 已引用 `bucketIntent`、`routeDescription`、`loadSkillCore`、`buildSkillCorrection` 等函数，但 `server.mjs` 实际只有旧版关键词匹配代码，`npm test` 在 `skill-runtime` 子套件导入阶段直接失败；同时动作违规兜底也因服务端缺少对应函数而没有真正运行。
- 结果：补齐并导出 `filterSkillsByExclude`、`routeDescription`、`normalizeRouterIntent`、`bucketIntent`、`hasScenarioSignal`、`requiresMealChoice`、`isMealChoiceActionViolation`、`checkIntentConflict`、`selectSkillReferences`、`loadSkillCore`、`buildSkillCorrection`；`agentLoop` 改为先路由、再按规划结果按需加载技能 references，并执行一次意图/动作交叉检查纠错，仍未满足时强制 `action.type=open_meal_choice`。`npm test` 恢复为 34 项全部通过，`npm run check` 通过。
- 限制：本次补齐的是服务端运行时和确定性兜底；模型正文仍可能先给出具体菜谱，只能通过纠错提示尽量修正。若之前仍在运行旧端口进程，需要彻底停止旧进程后用最新代码重启，并刷新浏览器/Service Worker 缓存后再验证。
- 主要修改文件：`server.mjs`、`CHANGELOG.md`。

### 修复：无场景餐食请求仍可能不展示“在家 DIY / 附近餐厅”入口

- 需求：用户反馈重启后“今晚不知道吃啥”这类无场景餐食请求仍然沿用旧行为，没有稳定回到 `open_meal_choice`。
- 结果：确认当前 8080 端口进程仍为旧版本启动进程，同时发现动作违规判定只覆盖 `action.type` 存在且不是 `open_meal_choice` 的情况，`action.type` 缺失或为 `none` 时会漏判；新增 `requiresMealChoice` / `isMealChoiceActionViolation`，对路由意图为 meal、消息没有在家/附近/外卖/到店信号、动作类型不是 `open_meal_choice` 的结果统一进入纠错并最终强制 `action.type=open_meal_choice`。`test/skill-runtime.test.mjs` 增加缺失动作、`none`、`open_diy` 三类兜底断言；`npm test` 34 项通过。
- 限制：确定性兜底只保证前端入口，不重写模型正文中可能已经给出的具体菜谱；正文纠错仍依赖模型重跑。需要真正停止旧进程并用最新代码重启，且刷新浏览器/Service Worker 缓存后再验证。
- 主要修改文件：`server.mjs`、`test/skill-runtime.test.mjs`、`CHANGELOG.md`。

### 修复：场景未明确时直接推荐 DIY 的违规，并增加确定性动作校验

- 需求：用户问“今晚不知道吃啥”时，Agent 直接给出「香煎鸡胸杂粮饭」等 DIY 推荐，违反技能“用户未说明在家做还是外食时，必须先返回 open_meal_choice，不替用户直接选择 DIY”的规则。
- 结果：定位到违规请求的日志 trace 中没有 `route`/`skill` 标记，属于旧服务版本未加载技能导致；当前版本已能正确加载技能并先询问场景。同时增加确定性兜底：Agent 执行后，若路由意图为 meal 且消息无场景信号（在家/现有食材/附近/外卖/到店等），而动作类型不是 `open_meal_choice`，判定为动作违规，与意图冲突共用一次纠错机会重跑，提示 Agent 先询问场景、不直接给具体食谱；重跑后仍违规则强制 `action.type=open_meal_choice` 并在 trace 标记 `force:open_meal_choice`，保证前端一定展示场景选择入口。
- 限制：回答正文的“直接推荐菜品”无法做确定性文本改写，靠纠错重跑提示修正；动作类型为确定性保证。
- 主要修改文件：`server.mjs`、`test/skill-runtime.test.mjs`、`CHANGELOG.md`。

### 重构：技能运行流程改为「路由 → 加载 → 规划按需取 references → 执行 → 交叉检查纠错」

- 需求：按用户给出的流程重构——启动只建立技能 Registry（name + description）；每次请求先由独立 Description Router 语义判定匹配 Skill 或 none；匹配才加载 SKILL.md；Planner 读取 SKILL.md 规划步骤并按需挑选 references；Agent 执行；最后用「路由意图 vs Agent 意图」交叉检查，冲突最多纠错一次后重新执行。
- 结果：`agentLoop` 重构为四阶段——① `routeDescription` 独立路由调用（LLM 语义判定，返回 skills + 粗粒度意图 meal/record/other，白名单 + exclude 硬门后生效，不可用时回退向量/关键词）；② 命中才 `loadSkillCore` 加载 SKILL.md 并交给 `planAgentTask(message, skillContext)`，规划器按需返回 `references`（显式数组精确加载、缺失时安全默认加载全部，且只允许该技能 `referenceFiles` 内的文件）；③ `runAgentRound` 执行主循环（抽取为可重跑函数）；④ `bucketIntent` 归一 Agent 意图后与路由意图交叉检查，冲突则 `buildSkillCorrection` 生成纠错提示（路由漏配时会补充加载对应技能内容）并重跑一次，最多一次。技能 frontmatter 新增 `intents` 字段（如 `meal`）用于意图归一回退与纠错映射。实测：语义餐食请求 trace 为 `route:meal,llm → skill:meal-recommendation(3份,llm)`（规划器按需只选 2 个 references，非全量 5 份）；“帮我记午餐” trace 为 `route:record,llm`、技能不加载、意图一致无需纠错。`test/skill-runtime.test.mjs` 新增路由离线回退、意图桶/交叉检查、references 按需选择、纠错构建等 4 组用例。
- 限制：路由与规划各一次模型调用，加上主循环共多次调用；纠错重跑仅提示级，若模型坚持原意图则接受结果（最多纠错一次）；references 精确加载依赖规划器返回规范数组，模型未返回时回退全量加载。
- 主要修改文件：`server.mjs`、`skills/meal-recommendation/SKILL.md`、`test/skill-runtime.test.mjs`、`CHANGELOG.md`。

### 升级：技能匹配从关键词路由改为语义理解（LLM → 向量 → 关键词三级）

- 需求：原匹配依赖 `keywords`/`exclude`，本质是字符串路由：无关键词的语义请求（如“今晚不知道怎么解决吃饭的问题”）可能漏配，出现“餐厅”等词又可能误配；要求匹配真正理解技能 description。
- 结果：技能匹配升级为三级链路——① 主判定：每次请求的规划器（`planAgentTask`）读取所有技能的 `name + description`，按整体语义返回 `skills` 数组（白名单过滤）；② 回退：规划器失败或无 skills 字段时，用 `text-embedding-v3` 向量余弦相似度匹配（技能向量首次请求时惰性生成并缓存，阈值 0.55，经真实接口校准）；③ 最后兜底：向量不可用时回退关键词规则。`exclude` 作为确定性硬门统一作用于所有层级（含 LLM 判定），避免“帮我记午餐”被误选。命中日志与执行轨迹标注匹配方式（`llm` / `语义 score` / `关键词`）。实测：9 个正负例全部按预期命中/不命中，完整对话链路验证 `skill:meal-recommendation(5份,llm)` 注入且回答遵循技能场景路由规则。
- 限制：LLM 判定是主链路，未配置 `DASHSCOPE_API_KEY` 时对话本身不可用，技能匹配会退到向量/关键词；向量回退依赖外部嵌入接口；keywords 字段保留但仅作离线兜底。
- 主要修改文件：`server.mjs`、`test/skill-runtime.test.mjs`、`CHANGELOG.md`。

### 新增：通用运行时 Skill 系统（扫描 → 匹配 → 按需加载）

- 需求：把 skills 目录变成小饭真正的运行时技能体系，要求启动时扫描所有 `skills/*/SKILL.md` 元信息；每次用户请求先做技能匹配；匹配到才加载该技能的完整内容；未匹配到则只走基础 Agent。
- 结果：服务端新增通用技能运行时——启动时扫描 `skills/*/SKILL.md` 并解析 frontmatter（`name` / `description` / `keywords` / `exclude`），建立元信息索引并打印 `技能扫描：发现 N 个 Skill`；每次 Agent 对话先按消息文本匹配（关键词命中且未被 exclude 排除，无关键词时按技能名显式提及），匹配到才实时读取该技能的 `SKILL.md` 与 `references/*.md` 完整内容注入系统提示词（总长度上限 24000 字符），未匹配则仅使用基础 `SYSTEM_BASE`；命中时写入 `agent_skill` 类型日志（如 `meal-recommendation:ok(5份)`）并在执行轨迹标记 `skill:<名称>(N份)`，工具日志界面新增「技能」筛选。`skills/meal-recommendation/SKILL.md` 增加 `keywords`（28 个）与 `exclude`（11 个）以保留原有推荐触发行为；旧的硬编码 `loadMealRecommendationSkill` / `isMealRecommendationRequest` 已移除。`test/skill-runtime.test.mjs` 覆盖 frontmatter 解析、启动扫描、匹配与按需加载。
- 限制：匹配目前为关键词规则，未接入向量检索；技能元信息（keywords/exclude）在启动时扫描，修改后需重启，技能正文与 references 每次命中时实时读取、无需重启；确定性工具 API（预算、DIY、餐厅排序）仍由代码实现，不走技能文本。
- 主要修改文件：`server.mjs`、`skills/meal-recommendation/SKILL.md`、`app.js`、`index.html`、`test/skill-runtime.test.mjs`、`CHANGELOG.md`。

### 新增：meal-recommendation 成为运行时 Skill

- 需求：`skills/meal-recommendation/` 此前只是文档，运行时不会被小饭读取；要求它成为真正的运行时 Skill，直接影响餐食推荐行为。
- 结果：服务端在每次 Agent 对话时运行时读取 `SKILL.md` 与 4 个 references（recommendation-rules / nutrition-data / amap-api / tool-guide）；当用户消息命中“下一餐推荐”场景（含餐次关键词或推荐/餐厅/在家/食谱等，排除记录、体重类请求）时，把完整技能内容注入系统提示词，让千问按技能规则执行；命中时写入 `agent_tool` 日志（`meal_recommendation_skill:ok`）并在执行轨迹中标记 `skill:meal_recommendation(5份)`，可在工具日志入口中核对。技能文件在请求时实时读取，修改文件无需重启即可生效（下一次对话即用新内容）。新增 `test/skill-runtime.test.mjs` 覆盖加载与命中判定。
- 限制：技能只影响 LLM 编排的 Agent 对话推荐；确定性工具（预算计算、DIY 食谱规则、餐厅排序）仍由 `server.mjs` 内代码实现，直接调用对应 API 不走技能文本。
- 主要修改文件：`server.mjs`、`test/skill-runtime.test.mjs`、`CHANGELOG.md`。

### 新增：Agent 工具调用日志查看入口

- 需求：服务端 `agent_logs` 表此前只写不读，用户无法查看 Agent 的对话、工具调用和复盘日志；需要加一个查看入口。
- 结果：新增 `GET /api/agent/logs?clientId=...&limit=...&kind=...` 查询接口（按时间倒序、按当前用户过滤、支持按日志类型筛选，最多 500 条）；Agent 对话页右上角新增「工具日志」按钮，弹窗展示最近 300 条日志，可切换「全部 / 工具调用 / 对话 / 复盘」筛选并手动刷新；工具调用成功显示 ✓、失败显示 ✕，并标注时间。
- 限制：日志仍为服务端持久化数据，仅展示最近记录；前端「思考与工具」面板中的实时事件依然只在页面内存中，不持久化。
- 主要修改文件：`server.mjs`、`app.js`、`index.html`、`styles.css`、`CHANGELOG.md`。

### 修复：14 日变化图固定为连续 14 个自然日

- 需求：趋势页「14日变化」图此前按最近 14 条体重记录绘制，记录跨期超过 14 天时图表会被拉长（例如横轴一直排到第 25 天）；要求该图固定为连续 14 天，窗口内没有记录的天数直接留空、不补零。
- 结果：`hydrateApp` 改为按日期生成最近 14 天（含今天，Asia/Shanghai）的连续窗口，有记录的天显示实际节点与体重标注，无记录的天不生成节点；目标虚线按计划斜率铺满 14 天窗口，不再把横轴向后延伸；x 轴刻度改为显示 `MM-DD`，便于核对是连续自然日。
- 限制：仅调整图表展示口径；服务端趋势复盘（`weightTrend`）仍按最近 14 条记录计算，未同步修改。
- 主要修改文件：`app.js`、`CHANGELOG.md`。

### 调整：趋势图记录节点显示日期与体重

- 需求：体重趋势图里的每个实际记录节点，需要标注对应记录日期和具体体重值。
- 结果：`svgChart` 支持带日期和体重的记录点，并在每个实际节点上方显示 `MM-DD 体重kg`；`hydrateApp` 传入最近 14 天体重记录的日期与体重，Service Worker 缓存版本升级为 `xiaofan-v6`。
- 限制：仅展示最近 14 条已有记录；未记录日期不生成节点，也不会补零。
- 主要修改文件：`app.js`、`sw.js`、`CHANGELOG.md`。

### 调整：快速记录入口仅保留在饮食页面

- 需求：把顶部导航里的“快速记录”按钮从全局入口改为只放在“饮食”页面。
- 结果：移除 `header.topbar` 中的 `#quickLogBtn`，在“饮食与食谱”页的 `view-intro` 区域新增同一按钮；原点击逻辑继续复用，按钮在非饮食页面不再显示。
- 限制：功能逻辑未变，仅调整入口可见范围。
- 主要修改文件：`index.html`、`sw.js`、`CHANGELOG.md`。

### 修复：外食缺位置时连续 JSON 解析失败，并支持区域名搜索

- 需求：输入“外食”时，`search_nearby_restaurants` 因缺少坐标失败，随后模型多次未返回合法 JSON，前端显示“真实模型调用失败：模型连续多次未返回合法 JSON”。
- 结果：①`search_nearby_restaurants` 工具新增 `area` 参数并允许不传经纬度，执行时优先把区域名经高德 geocode 转成坐标；②`agentLoop` 对定位工具失败增加确定性兜底 JSON，直接返回“请提供区域或手动搜索”的 `open_restaurants` 动作，避免进入无效 JSON 重试；`npm test` 23 项全部通过。
- 限制：区域名 geocode 依赖高德 key 与网络；仅覆盖 `search_nearby_restaurants` 缺少定位场景，其他工具失败仍依赖模型 JSON。
- 主要修改文件：`server.mjs`、`CHANGELOG.md`。

### 删除 .gitignore

- 需求：当前目录不是 Git 仓库，用户要求删除 `.gitignore`。
- 结果：移除项目根目录的 `.gitignore` 文件；后续如重新初始化 Git，再按需恢复忽略规则。
- 限制：本次删除仅影响 Git 忽略配置，不影响项目运行。
- 主要修改文件：`.gitignore`、`CHANGELOG.md`。

### 删除 PWA manifest 与页面引用

- 需求：用户确认当前仅作为 Web 版本使用，不打算安装成 App，要求删除 `manifest.json`。
- 结果：删除根目录 `manifest.json`，移除 `index.html` 中对应的 `<link rel="manifest">` 引用，并同步从 `sw.js` 缓存清单中移除 `/manifest.json`、升级缓存版本为 `xiaofan-v3`。
- 限制：仅移除 PWA 安装清单；`sw.js` 与图标保留，项目仍具备基础缓存能力。
- 主要修改文件：`manifest.json`、`index.html`、`sw.js`、`CHANGELOG.md`。

### 删除 icons 目录及 PWA 图标引用

- 需求：用户确认当前不考虑 App，要求删除 `icons/icon-192.png` 与 `icons/icon-512.png`。
- 结果：删除两个图标文件及空目录 `icons/`；移除 `index.html` 中 favicon 和 apple-touch-icon 引用；从 `sw.js` 缓存清单中移除两个图标路径，并将缓存版本升级为 `xiaofan-v4`。
- 限制：删除后浏览器可能使用默认站点图标；`sw.js` 仍保留静态资源缓存能力。
- 主要修改文件：`icons/`、`index.html`、`sw.js`、`CHANGELOG.md`。

### 修复：未明确就餐场景时误只显示 DIY 入口

- 需求：用户发现让小饭推荐餐食时，回答下方只有“在家 DIY”入口，没有“附近餐厅 / 堂食”入口。
- 原因：场景未明确时，模型有时会直接返回 `open_diy`；前端只有收到 `open_meal_choice` 才会同时渲染“在家 DIY”和“附近餐厅”两个入口。
- 结果：在 `SYSTEM_BASE` 新增“动作选择”硬规则——未明确“在家 / 现有食材”或“附近 / 出去吃 / 到店”时，`action.type` 必须返回 `open_meal_choice`，禁止直接返回 `open_diy` / `open_restaurants`；`SKILL.md` 的场景未明确说明同步补充；`PROMPT_VERSION` 升级为 `v8`，并新增对应提示词测试。
- 限制：该规则是模型层面的软约束，仍依赖模型遵循提示词；不改变前端按钮渲染逻辑。
- 主要修改文件：`server.mjs`、`test/prompt.test.mjs`、`skills/meal-recommendation/SKILL.md`、`CHANGELOG.md`。

## 2026-08-12

### 依据 PRD 修正完善产品：统一文档与实现

- 需求：根据当前 PRD 文档内容修正和完善产品。
- 结果：①PRD 一致性修正——核心闭环改为“记录饮食（拍照或手动）与体重（手动）”；P0 下一餐推荐改为“在家 DIY 与附近餐厅（到店推荐）两条路径”；10.4 图片估算输出结构改为单一数值；11.2 工具表替换为当前真实工具集；11.3 图片估算改为“返回单一近似数值和不确定因素”；12.1 页面清单对齐实际页面（移除每周报告页等）；13 数据模型统一为单一热量值；15.1 明确年龄表单拦截、产品面向正常健康成年人；16 图片识别性能目标调整为 10 秒；17 演示脚本清除“热量区间”残留，场景五改为“不直接拒绝但必须转述风险提示”。②README 修正——删除“当前Demo使用浏览器内状态和模拟工具调用”的过时描述，改为真实 `agentLoop` 工具调用架构，补充缺失 API 表项。③MVP 同步——将已实现的“体重趋势/目标重算”“外食菜单核验”从“暂时不做”移除或改写；注明 DIY 已支持“采用这份食谱”一键入账、图片相似度复用方案暂缓。
- 限制：独立登录页、设置与隐私页、每周报告页未实现（文档已标注为不在当前 Demo 范围）。
- 主要修改文件：`PRD.md`、`README.md`、`MVP.md`、`CHANGELOG.md`。

## 2026-08-13

### 调整：skill 身份以 SKILL.md 内容为准，文件夹与 UI 元数据对齐

- 需求：明确 `skills/xiaofan-dev` 的身份，用户决定以 `SKILL.md` 内容为准（即“下一餐推荐”产品行为 skill），且不改动 SKILL.md 内容。
- 结果：目录由 `skills/xiaofan-dev` 重命名为 `skills/meal-recommendation`（skill 名与文件夹名一致）；`agents/openai.yaml` 的展示名/简介/默认提示改为描述“下一餐推荐”行为；SKILL.md 内容保持原样（字节级恢复）。references 与 check-foods.mjs 校验脚本随目录移动，相对路径不受影响。
- 限制：skill-creator 官方 `quick_validate.py` 因沙箱缺少 PyYAML 未能运行，已按规范手工核对（name==文件夹、frontmatter 字段齐全、资源目录完整）。
- 主要修改文件：`skills/meal-recommendation/`（目录与 openai.yaml）、`CHANGELOG.md`。

### 修复：附近餐厅自动定位失效，并补充定位失败兜底

- 需求：之前点“外食推荐”能自动定位，现在不再请求定位，需要修复。
- 原因：Agent 回复中携带的商圈（area）会写入 `state.restaurantArea` 并在本次会话内一直保留；`startRestaurantSearch` 的 area 默认值取自该状态，导致后续所有“外食推荐”入口跳过浏览器定位、直接解析旧商圈；定位失败时界面只显示通用文案、没有直接的手动商圈入口；PWA Service Worker 缓存优先，前端改动可能继续命中旧缓存。
- 结果：①`startRestaurantSearch` 的 area 默认改为空串，通用入口（外食推荐卡片、帮我选、今日计划）一律先请求浏览器定位，仅 Agent 明确给出商圈时走地址转坐标；②新增 `requestGeolocation` 统一定位请求（关闭高精度、超时 15 秒、按错误码给出明确提示），弹窗与今日计划共用；③定位失败时弹窗内显示具体原因，并出现“用这个位置搜索”输入框，输入城市/商圈后由高德 geocode 转坐标继续搜索；④Service Worker 缓存版本升级为 v2，确保新前端文件生效。
- 限制：浏览器定位本身仍取决于系统/浏览器权限与 HTTPS/localhost 环境；权限被拒时界面会说明原因并提供商圈输入兜底。
- 主要修改文件：`app.js`、`index.html`、`styles.css`、`sw.js`、`CHANGELOG.md`。

### 新增 WORKFLOW.md：汇总 Demo 使用与演示流程

- 需求：把“我的 workflow”整理成文档放进仓库。
- 结果：新增 `WORKFLOW.md`，按启动准备 → 建档 → 今日计划 → Agent 对话 → DIY/到店推荐 → 拍照记餐 → 体重页 → 主动提醒与复盘 → 安全边界 → 收尾组织完整流程，并附 Agent 内部执行循环与当前口径说明（近7日平均 vs 最新记录、Agent 不记录体重、单一热量、到店推荐、肯定句提醒等）。
- 限制：为说明性文档，不改变产品行为。
- 主要修改文件：`WORKFLOW.md`、`CHANGELOG.md`。

### 调整：目标干预提醒改为“近7日平均 + 最新记录”口径，界面“趋势”页改名“体重”

- 需求：用户指出提醒显示“当前 47.07kg”但当天记录体重 46.6kg，数字对不上；同时希望界面不再叫“趋势”。
- 结果：①目标干预提醒文案由“当前 X kg”改为“近7日平均 X kg（最新记录 Y kg）”，`goalState` 新增 `latestWeight`（按日期取最新一条体重记录），趋势口径与单日记录同时展示、不再混淆；②导航、页面标题与视图标题由“趋势/体重趋势”改为“体重”，页面说明改为“记录并查看每日体重；系统使用趋势而不是单日数字做判断”，README 演示流程同步。
- 限制：判断逻辑仍使用 7 日平均与趋势（`current`/`actualWeekly` 口径不变），本次只改展示文案与页面命名。
- 主要修改文件：`server.mjs`、`index.html`、`app.js`、`README.md`、`CHANGELOG.md`。

### 修复：Agent 提醒仍显示旧反问文案（历史任务残留导致自相矛盾）

- 需求：目标进度提醒改为肯定句后，用户仍收到“要不要我重新算一下预算或调整策略？；本周继续执行原计划，无需调整”的自相矛盾提醒。
- 原因：改版前生成的 `goal_intervention` 旧文案任务仍以 pending 状态残留在 SQLite；`createAgentTask` 的同类型同日去重导致新版文案任务无法生成；复盘 LLM 违反“adjustment 为 0 时 taskText 必须为空”的约束返回了“本周继续执行原计划，无需调整”，服务端未强制拦截并生成了 `action_plan` 任务；前端把多条待办拼接成一条提醒，于是出现矛盾文案。
- 结果：`createAgentTask` 在同类任务已存在时用最新文案刷新旧任务 payload；`runAgentReview` 增加服务端硬约束——adjustment 为 0 时 strategy 固定为肯定句、taskText 强制为空，不再依赖 LLM 自觉；服务启动时执行任务维护，清理过期未处理任务、旧反问文案的 `goal_intervention` 与“无需调整”的空 `action_plan`；已清理本地库 9 条过期任务与 1 条空任务，并把今日目标干预任务刷新为肯定句。
- 限制：已取消的旧任务不再展示；同一浏览器会话内已见过的任务 id 仍按原去重逻辑只提示一次。demo 服务已用新代码重启。
- 主要修改文件：`server.mjs`、`CHANGELOG.md`。

### 调整：目标进度提醒改为肯定句，不再反问

- 需求：Agent 已经自主完成“是否调整预算”的决定，提醒文案不应再问“要不要我重新算一下预算或调整策略？”，应直接告知结论。
- 结果：`goal_intervention` 提醒文案改为“已按当前数据完成评估：预算已下调/上调 X kcal，本周按调整后的计划执行”或“当前无需调整预算，本周继续执行原计划”（按 `budget_adjustment_kcal` 当前值生成）；复盘 LLM 提示词增加约束——adjustment 为 0 时 strategy 固定为“本周继续执行原计划，无需调整”且不生成 action_plan 任务，避免与提醒文案重复；无 Key 兜底默认 strategy 与复盘返回 message 同步改为同一句式（PROMPTS_VERSION=v3）。
- 限制：改动前已生成的 pending 任务仍按旧文案显示一次；调整动作本身仍由每日复盘自动执行，本改动只影响话术。
- 主要修改文件：`server.mjs`、`test/prompt.test.mjs`、`CHANGELOG.md`。

### 修复：Agent 提醒一闪而过、来不及阅读

- 需求：Agent 主动提醒总是很快消失，用户还没看清就结束。
- 原因：提醒走通用 toast，只显示 2.6 秒；轮询每 60 秒会把同一条待办再次弹出并互相覆盖。
- 结果：新增 `showAgentReminder`——Agent 提醒单独以更大字号显示 8 秒、点击即可关闭、多条提醒合并为一条展示、同一提醒本次会话内只提示一次（`seenAgentTaskIds` 去重）；轮询与 SSE 两条推送通道统一走该函数；普通操作 toast 保持原有时长不变。
- 主要修改文件：`app.js`、`styles.css`、`CHANGELOG.md`。

### 修复：手动记录“查询营养数据”按钮无响应

- 需求：修复手动记录弹窗中点击“查询营养数据”无响应的问题。
- 原因：`hydrateApp()` 中残留一条针对旧三列指标卡布局的选择器 `$('.metric-card:nth-child(3) .metric-head small')`，首页指标卡已改为两列后该元素不存在，加载时对 null 赋值抛 TypeError，脚本在“查询营养数据”按钮绑定之前中断；同批受影响的还有“调整目标”绑定、服务端状态同步与 Agent 轮询/SSE。
- 结果：改为定位第 2 张指标卡（蛋白质卡）并加空值保护，移除无意义的 `$('.metric-head:nth-child(1)')` 残留语句；已核对 `hydrateApp` 全部类选择器在 index.html 中均存在。
- 主要修改文件：`app.js`、`CHANGELOG.md`。

### 按用户决定收敛范围：营养库改单一热量、移除外卖模式与导出功能、清理死代码

- 需求：五点产品决定——①不新增“当前健康状态”字段（产品为正常健康人群设计）；②本地营养数据库热量改为单一数值，不采用热量区间，也不再注明“区间仅内部计算”；③外卖模式暂不采用，产品仅做餐食/餐厅推荐；④数据导出与删除入口功能暂不做；⑤清理死代码。
- 结果：①移除建档与“修改个人信息”中的健康状态字段、首页健康提示及 `mealTargets` 孕期/哺乳期判断（含对应单元测试），产品面向正常健康成年人；②`data/foods.json` 中 53 条家常菜/外卖快餐的 kcalMin/kcalMax 全部移除，`foods` 表迁移去掉 kcal_min/kcal_max 列，`estimateMenuDish`、食谱计算与外食排序统一用单一 kcal；`SYSTEM_BASE` 规则改为“估算数值只返回单一数值，不输出区间”（PROMPT_VERSION=v7）；PRD 清除“区间仅内部计算”说明；③外卖模式从 PRD/MVP/UI 文案中移除（入口按钮改为“附近餐厅”，模式改为“到店就餐”），产品仅保留在家 DIY 与附近餐厅两条路径；④PRD 15.2 移除“提供数据导出与删除入口”，原则 7 不再承诺“删除数据”；⑤删除 app.js 中 Mock 外食卡片与假对话回复死代码及其 `sleep` 辅助函数，页面只走真实接口。
- 限制：用户实际生活方式中的“点外卖”不受影响，仅产品不提供外卖模式；孕期/哺乳期等特殊人群不在当前产品范围且不采集该状态。
- 主要修改文件：`server.mjs`、`app.js`、`index.html`、`data/foods.json`、`scripts/expand-foods.mjs`、`test/prompt.test.mjs`、`test/meal-targets.test.mjs`、`PRD.md`、`README.md`、`MVP.md`、`CHANGELOG.md`。

### 估算数值统一返回单一值，不再展示区间

- 需求：用户希望返回的是单一数值，不要区间。
- 结果：所有面向用户的估算数值改为单一近似值（取内部区间中值）：外食推荐卡片显示“推荐阶段估算 X kcal · 蛋白质 Yg”而非 X–Y 区间，推荐份量同样取中值；DIY 食谱的食材行与总热量只显示单一 kcal；营养查询按每100g单一 kcal 展示；演示卡片同步改为单一热量/蛋白质；Agent 提示词新增“估算数值只返回单一近似值、不要给用户展示 X–Y 区间”约束（PROMPT_VERSION=v6），语义评测标准同步调整。后端仍保留 kcal_min/kcal_max 等区间字段用于内部匹配、份量缩放与排序计算；图片识别接口的份量上下限保留，前端继续展示单一估算值。
- 限制：历史对话中已保存的旧外食/食谱卡片若含区间文本仍按旧内容渲染；PRD 中相关章节已同步改为单一数值表述。
- 主要修改文件：`server.mjs`、`app.js`、`test/prompt.test.mjs`、`scripts/semantic-eval.mjs`、`README.md`、`PRD.md`、`MVP.md`、`CHANGELOG.md`。

### 移除 Agent 体重记录，Agent 聚焦餐食记录与推荐

- 需求：Agent 不再负责体重记录，对话中只做餐食记录、食谱与餐馆推荐，消除“已记录但待确认、46.85 与 46.9 不一致、今日与昨日不一致”等体重链路问题。
- 结果：删除 `propose_weight_record` 工具及其执行分支，Agent 无法再生成体重确认提案；`SYSTEM_BASE` 移除体重相关规则（写库唯一路径改为 `propose_meal_record`/`revise_pending_meal`，删除 goals 体重进度规则，intent 枚举去掉 weight/goal），人设改为“管理饮食和热量摄入”；`buildAgentContext` 不再注入体重记录、趋势摘要与目标进度（`PROMPT_VERSION=v5`、`PROMPTS_VERSION=v2`）；Agent 循环不再识别体重/称重写入意图；调度器不再生成“晨起称重”任务；记忆摘要不再携带体重字段；前端建议文案、快捷提问与演示卡片同步改为餐食导向。
- 保留：App 手动体重记录（弹窗、趋势图、目标卡片）、档案体重参与热量预算、`/api/agent/review` 基于体重趋势的服务端预算调整仍保留，不属于对话记录链路。
- 测试：`npm test` 全量 20 用例通过；评测夹具移除“记录体重/体重无明确数字”两个用例。
- 限制：历史对话中已保存的体重确认提案卡片仍按旧逻辑渲染（兼容旧数据）；`weight_logs` 表、手动记录接口与 `/api/user/state` 同步保持不变。主要修改文件：`server.mjs`、`app.js`、`index.html`、`README.md`、`MVP.md`、`test/prompt.test.mjs`、`test/fixtures/prompt-cases.json`、`CHANGELOG.md`。

### 极端减重改为“可给方案但必须带风险提示”

- 需求：调整执行约束——疾病、药物仍不提供治疗方案（建议咨询医生）；极端减重从“不提供方案”改为“提供减重方案，但必须给出明确风险提示”。
- 结果：`mealTargets` 新增确定性 `safety` 检测（周减重超过 1 kg、预算不可行即 dailyTarget≤0、当前 BMI<18.5 仍减重、目标 BMI<18.5），命中时返回 `safety.warning`，经 `buildAgentContext` 与 `get_meal_budget` 注入提示词；`SYSTEM_BASE` 安全与诚实规则新增第 4 条（疾病/药物不做治疗方案；极端减重可给方案但必须转述 `targets.safety.warning`）；PRD 11.3 同步更新；新增 `meal-targets` 测试。
- 限制：风险提示为确定性 warning + 提示词软约束；阈值（1 kg/周、BMI 18.5）为产品默认值，可按需调整；BMI 使用建档身高体重计算。主要修改文件：`server.mjs`、`PRD.md`、`test/meal-targets.test.mjs`、`CHANGELOG.md`。

### PRD 11.4 改写：完整 Agent 执行循环

- 需求：11.4 从静态组件罗列改为体现完整 Agent 工作方式——理解目标 → 制定步骤 → 调用工具 → 观察结果 → 调整 → 继续执行。
- 结果：保留"一个主 Agent + 支撑组件"的架构，新增六步执行循环（含轮次上限、工具失败降级、写库走确认提案的例外），并把结构化用户状态、确定性工具、规则化安全层明确为支撑组件；与 10.7 意图、11.1 状态、11.2 工具、11.3 约束串成完整链路，与 `agentLoop` 实际实现一致。主要修改文件：`PRD.md`、`CHANGELOG.md`。

### 新增：基于整个产品编写 xiaofan-dev 技能（供 Codex 开发本产品与面试展示）

- 需求：用户希望根据整个产品编写一个 skill，包括 description、SKILL.md，并在必要时提供 references、scripts、assets，用于后续向面试官说明该 agent 项目。
- 结果：在仓库 `skills/xiaofan-dev/` 新建技能目录——`SKILL.md`（frontmatter 含 name/description；正文含产品定位、仓库地图、核心架构、10 条不可违反的产品约定、标准开发流程、资源索引）；`references/` 三份参考文档（product-spec 产品规格、architecture 系统架构、nutrition-data 营养与餐食数据）；`scripts/check-foods.mjs` 校验 `data/foods.json`（schema、唯一性、类别、数值范围、区间字段残留；已运行验证 300 条食材通过）；`agents/openai.yaml` 界面元数据（display_name / short_description / default_prompt）。
- 限制：本机未安装 PyYAML，`quick_validate.py` 无法直接运行，已按其校验规则手工等价验证 frontmatter 与 name/description 约束；技能内容基于当前实现与文档，后续功能演进需同步更新本技能；未创建 assets 目录（当前技能无需输出型资源）；如需 Codex 自动发现，可将 `skills/xiaofan-dev` 复制到 `~/.codex/skills`。
- 主要修改文件：`skills/xiaofan-dev/SKILL.md`、`skills/xiaofan-dev/agents/openai.yaml`、`skills/xiaofan-dev/references/*.md`、`skills/xiaofan-dev/scripts/check-foods.mjs`、`CHANGELOG.md`。

## 2026-08-14

### 重构 meal-recommendation 技能 references 为四份行为参考

- 需求：按 `SKILL.md` 的产品行为，把技能 references 重新组织为四份可直接指导推荐执行的参考：`recommendation-rules.md`（应该怎么推荐）、`nutrition-data.md`（本地营养数据从哪里来、怎么查、查不到怎么办）、`amap-api.md`（何时调用高德、数据能证明和不能证明什么、失败怎么办）、`tool-guide.md`（何时调用哪个 Tool）。
- 结果：删除了面向开发调试的旧 `product-spec.md`、`architecture.md` 和旧 `nutrition-data.md`，新增上述四份文件；`recommendation-rules.md` 依据 PRD 整理推荐优先级、硬约束、安全规则、场景路由、筛选与降级；`nutrition-data.md` 只写知识库使用说明，不复制 300 条食物；`amap-api.md` 明确高德 POI 是真实候选但不等同于实时菜单；`tool-guide.md` 按用户意图和 DIY / 到店 / 记录场景给出工具选择顺序。
- 限制：本次只改技能说明文档，不改变 `server.mjs`、`app.js` 或产品运行时行为；四份 references 与当前 `AGENT_TOOLS` / 营养解析链 / 高德接口对齐。
- 主要修改文件：`skills/meal-recommendation/references/*.md`、`CHANGELOG.md`。

### 明确：PRD 动态调整的“有效数据不足”与“记录是否完整”判定

- 需求：在 PRD 中把“动态调整”里的“有效数据不足”和“记录是否完整”从状态描述明确为可计算、可测试的判定规则。
- 结果：新增 8.2.1 有效数据不足判定——观察窗口滚动近 14 天，明确有效体重记录口径、趋势可计算（≥7 个有效记录日）、可触发调整（≥7 且最近 3 天有记录）、数据不足与数据过期条件；新增 8.2.2 记录是否完整判定——区分“覆盖 / 疑似漏记 / 完整”，有效饮食记录仅计确认入账，完整度按 14 天覆盖天数 ≥70% 且最近 3 天有覆盖，并明确当天只记一顿饭计入覆盖但不等于完整；在验收清单补充对应可测试项与示例。
- 限制：目前为产品规则定义，未同步到 `server.mjs`/实现层；若代码当前按“不足 7 条不判定、不足 14 天不调整”执行，后续需按本规则统一。
- 主要修改文件：`PRD.md`、`CHANGELOG.md`。

### 修正：减重速度安全阈值统一为 > 1 kg/周

- 需求：文档中的安全阈值与实现保持一致。
- 结果：PRD 9.1 与 12.1、WORKFLOW 6.4 的减重速度阈值由 >0.9 kg/周 改回 >1 kg/周，与 `server.mjs` 中 `mealTargets` 的当前实现一致，解决了上一处“文档与代码漂移”的限制。
- 主要修改文件：`PRD.md`、`WORKFLOW.md`、`CHANGELOG.md`。

### 调整：WORKFLOW 安全规则与推荐优先级对齐 PRD

- 需求：将 WORKFLOW 的安全规则和下一餐推荐优先级按 PRD 统一。
- 结果：①WORKFLOW 第 3 节新增推荐优先级——安全与忌口 → 当餐营养匹配 → 用户偏好 → 当前现实条件 → 时间/距离 → 数据可信度，与 PRD 8.3 一致；②第 6 节新增“6.4 减脂安全规则”——目标 BMI<18.5、理论目标减重速度>0.9kg/周，触发后明确风险提示并继续原计划，LLM 不得修改安全阈值或弱化风险，医疗边界顺延为 6.5。
- 限制：PRD 9.1 的减重速度阈值写作 >0.9kg/周，但 `server.mjs` 的 `mealTargets` 当前实现仍为 >1kg/周，文档与代码仍有漂移，需后续统一（本条目按 PRD 写入 WORKFLOW）。
- 主要修改文件：`WORKFLOW.md`、`CHANGELOG.md`。

### 修复：Agent 对话偶发“模型连续多次未返回合法 JSON”失败

- 需求：用户与小饭对话输入“炸土豆 300g”时返回“真实模型调用失败：模型连续多次未返回合法 JSON，请稍后重试”。
- 原因：主 Agent 循环调用千问时未启用强制 JSON 输出；qwen-plus 在带历史上下文的餐食记录场景下，工具调用后连续多轮返回中文散文而非约定的严格 JSON，重试轮次耗尽后抛出 502。
- 结果：`agentLoop` 主循环的 `qwenChat` 调用增加 `response_format:{type:'json_object'}`，强制模型只输出 JSON；已用此前可稳定复现失败的真实对话历史回归验证通过（“炸土豆 300g”正常返回 answer/intent/action），`npm test` 22 用例全部通过。
- 限制：仅修复 JSON 解析失败；模型个别回答中仍可能自行估算热量或给出不准确的日期，依赖既有确认提案与前端校验兜底，本次未改动其他逻辑。
- 主要修改文件：`server.mjs`、`CHANGELOG.md`。

## 2026-08-10

### Agent 化改造

- 按“真 Agent”五步路线完成架构升级。第 0 步：用户状态落库——新增 `users` / `meal_logs` / `weight_logs` / `agent_memory` / `agent_tasks` 表，提供 `GET/PUT /api/user/state`，前端保存时自动同步、启动时若本地无数据则从服务器恢复；localStorage 仍作为会话内主存储。第 1 步：真实工具调用循环——基于千问 function calling 定义 11 个工具（读状态、算预算、DIY 食谱、附近餐馆、菜单检索、个性化、营养查询、三餐计划、经历记忆、餐食/体重确认提案），模型调用工具后由服务器执行并把结果作为 tool 消息回喂，写库仍走“确认提案→用户确认”的受控动作；`agentChat` 在配置 API Key 时走工具循环，无 Key 或循环失败时回退原意图流。第 2 步：规划循环——模型先输出执行计划（plan:工具名 步骤），再按步调工具，工具失败时模型根据错误结果修正或兜底。第 3 步：自主调度——服务器每分钟检查称重（07:00–09:30）、午餐（11:00–12:00）、晚餐（16:30–18:00）时间窗生成 `agent_tasks`，前端轮询 `/api/agent/check` 弹出 Agent 主动提醒，用户完成称重/记录后服务器自动把对应任务置为完成。第 4 步：经历记忆——确认餐食、体重记录、复盘结论写入 `agent_memory`，最近 7 天摘要注入 Agent 上下文，近期确认过的菜名会给个性化匹配加分（`recentConfirmed`）。第 5 步：反思自适应——`POST /api/agent/review` 用 14 天体重线性趋势对比目标周速度，趋势明显慢于目标且记录较完整时自动下调每日预算 100 kcal（累计上限 150），生成调整任务，并在客户端 `calculateProfile` 与服务端 `mealTargets` 同时生效；首页理论建议会标注“预算已调整 X kcal”。时区确认并注释：北京时间 = `Asia/Shanghai`（中国标准时间 UTC+8），统一使用 `CN_TZ` 常量。限制：服务器落库依赖前端同步（未做服务端权威存储迁移）；调度器随服务器进程运行；工具循环与复盘依赖 `DASHSCOPE_API_KEY`；写库仍需用户确认；金额预算（PRD 中的“预算 30”）仍未实现。主要修改文件：`server.mjs`、`app.js`、`data/nutrition.sqlite`（新增表结构）、`CHANGELOG.md`。

### 修复

- 修复建档流程按钮完全无响应：页面加载时 `updateDashboard()` 在第 183 行先执行，但它访问的 `userData` 在“服务器端同步”代码块之后才用 `let` 声明，触发暂时性死区（TDZ）`ReferenceError`，整个脚本中断，导致建档“下一步/创建我的 Agent”按钮的事件绑定从未执行。修复方式：将 `STORAGE_KEY`、`userData`、`onboardingStep` 三个声明上移到文件顶部，并用最小 DOM 模拟脚本验证 `app.js` 可完整加载执行、不再同步抛错。主要修改文件：`app.js`、`CHANGELOG.md`。

### Agent 完整化（目标追踪 / SSE 主动通道 / 语义记忆 / 工程化）

- 阶段一·长期目标追踪：新增 `goals` 表与 `goalState(clientId)`（起始/当前/目标体重、剩余天数、所需周速度、实际周速度、进度百分比与 pace 状态），建档时同步为 weight_loss 目标；目标进度注入 Agent 上下文并暴露 `/api/agent/goals`；首页目标卡显示进度百分比与起始/当前/目标体重；进度“偏慢/停滞”时调度器自动生成 `goal_intervention` 任务。阶段一·SSE 主动通道：新增 `/api/agent/events`（Server-Sent Events），任务一生成即推送（前端 `EventSource` 实时提醒），替代纯轮询；`POST /api/agent/tasks/accept|dismiss` 把用户接受/忽略反馈写入记忆。阶段一·模型自主复盘：`/api/agent/review` 升级为 LLM 决策——把 14 天趋势、记录完整度、确认餐数、当前累计调整打包给千问，模型只能建议 -100~100 的调整、服务器累计钳制在 -150~300，并输出策略与行动任务；无 Key 或调用失败时回退原规则。阶段二·语义记忆：用 `text-embedding-v3` 把记忆事件向量化存入 `memory_embeddings`，`agentLoop` 对用户消息做余弦检索（阈值 0.30、top-K=5）注入 `memoryHits`，模型可引用久远经历；向量接口不可用时自动跳过。阶段三·工程化：`agent_tasks` 增加 `priority/state/due_at/goal_id/dependencies`，支持 planned→pending 到期提升与接受/忽略流转；新增 `agent_logs` 表记录会话、工具调用与复盘日志；`/api/agent/chat` 增加每用户每分钟限流（默认 10 次）；新增 `AGENT_MAX_TOOL_ROUNDS`（默认 6）与 `QWEN_EMBED_MODEL` 配置并补 `.env.example`；新增 `node:test` 单元测试与离线评测夹具（12 个用例覆盖预算计算、体重趋势、余弦相似度、餐次解析、忌口词条切分），`npm test` / `npm run eval` 可运行。修复：`schedulerTick` 原先未查询 `profile` 列导致 `profile.weight` 恒为空、所有主动任务被跳过的问题。限制：语义记忆依赖向量接口与网络；SSE 随服务器进程存活；目标追踪目前只支持体重目标；LLM 复盘建议有边界钳制但策略质量尚未经过评测集验证；金额预算仍未实现。主要修改文件：`server.mjs`、`app.js`、`package.json`、`.env.example`、`test/*.test.mjs`、`data/nutrition.sqlite`、`CHANGELOG.md`。

### 产品决策

- 明确金额预算（“预算 30”）不在当前版本范围，规划为第二版功能：MVP 推荐只按热量/蛋白质预算（系统状态）计算，金钱预算不再作为当前版本的提示词约束；同步从 MVP 的产品定位、核心链路、必须做清单和“预算双来源”设计决策中移除，并在“暂时不做”清单中注明第二版规划。主要修改文件：`MVP.md`、`CHANGELOG.md`。

### 提示词人设

- 将 Agent 人设从“能调用工具完成任务的真 Agent”重构为“资深减肥管理营养师”：提示词按“人设层（专业、用数据和事实说话、不制造焦虑、不给不科学的承诺、理解外卖/加班/嘴馋等真实生活、建议具体可落地、波动时解释而非责备）＋ 能力层（可调用工具、以工具返回的真实结果为准）＋ 规则与输出契约（保持不变）”分层；同步更新工具调用循环 `agentLoop` 与旧意图流 `agentChat` 两套系统提示词。限制：人设改写后仅做语法与接口回归，语气效果建议在真实对话中抽查。主要修改文件：`server.mjs`、`CHANGELOG.md`。

### 提示词工程化与写库路径统一

- 将 `agentLoop` 系统提示词重构为「`SYSTEM_BASE` ＋ `buildAgentContext`」分层（`PROMPT_VERSION=v4`）：人设、分组规则（安全与诚实 / 写库 / 工具使用 / 授权边界 / 上下文使用）与输出契约固定为 `SYSTEM_BASE`；动态上下文由 `buildAgentContext` 构建并瘦身——体重最多注入 7 条并附趋势摘要（avg7/deltaWeek/slopePerWeek）、记忆合并为 `recent + hits` 单块、档案长文本截断到 200 字。输出契约移除旧写库 action（`save_pending_meal` / `revise_pending_meal` / `save_weight`），写库只走 propose 工具提案。
- 统一写库路径（方案 A）：饮食/体重写入唯一路径为 `propose_meal_record` / `propose_weight_record` 生成确认提案，新增 `revise_pending_meal` 工具（用户补充食材/份量/用油等信息时先修正估算再确认）；`agentLoop` 捕获提案并随响应返回 `proposal` 字段，action 白名单收紧为界面类动作（none / open_meal_choice / open_diy / open_restaurants / open_manual_log）。前端新增“确认提案”卡片：餐食提案确认后写入 `meal_logs` 并沉淀 `meal_confirmed` 记忆、体重提案确认后写入 `weight_logs`、修正提案更新本地待确认估算；对话恢复时按未确认状态重渲染，确认后标记为已处理。旧意图流（无 Key 降级路径）保留旧 action 以兼容。限制：需重启服务生效；历史对话中已保存的旧 `save_pending_meal` 条目仍按旧逻辑渲染；金额预算不受影响（仍为第二版）。主要修改文件：`server.mjs`、`app.js`、`test/prompt.test.mjs`、`CHANGELOG.md`。

### 删除旧意图流降级路径

- 移除无 Key 降级：删除 `agentChatLegacy` 函数及其专属辅助函数（`mealTimeState` / `requestedRadius` / `requestedRestaurantCount`）和整段旧意图流 system 提示词；`agentChat` 不再在缺少 `DASHSCOPE_API_KEY` 或工具循环失败时回退，缺少密钥时明确返回 503（前端提示“Agent 服务未配置”），工具循环异常直接上报错误。
- 前端同步清理：移除 `save_pending_meal` / `revise_pending_meal` / `save_weight` 旧 action 处理分支及不再使用的 `revisePendingMeal` 函数，写库确认统一走 propose 工具提案卡片；照片流的待确认估算控件与 `commitPendingMeal` 保留。限制：无 Key 环境下 Agent 对话不可用（此前可降级演示）；`npm test` 全量 18 用例通过。主要修改文件：`server.mjs`、`app.js`、`CHANGELOG.md`。

### 其他提示词优化

- 规划器：提示词增加“`steps[].tool` 必须严格来自可用工具列表、禁止编造工具名、不需要工具时 steps 为空数组”硬约束；新增 `sanitizePlanSteps` 对模型输出做工具名白名单过滤、文本截断和步数上限（最多 6 步），非法输入回退为空计划。
- 复盘专家：提示词增加“趋势数据不足或波动无明确结论时 adjustment 必须为 0、strategy 具体可落地、taskText 不写空话”约束；代码侧对 adjustment 增加 NaN 防护（非有限值按 0 处理）。
- 图片识别：提示词增加“无法确定具体菜名时使用通用类别（如‘中式汤面’）、foods 最多 8 项”；接口对识别结果强制截断为 8 项（用户补充说明原有 500 字截断保持不变）。
- 营养检索：查询词截断到 80 字；提示词增加“网页内容与查询不一致时返回 low 且数值为 null、notes 最多 3 条”；代码侧校验 sourceUrl 必须为可访问的 http(s) URL、confidence 归一化到 high/medium/low。
- 菜单检索：提示词增加“饮品/甜品/咖啡店只返回饮品候选，不编造主食；sources 的 url 必须真实可访问”。
- DIY 食谱：代码侧对模型输出做食材去重（同名只保留一次）和步骤上限 6 条。
- 工程化：新增 `PROMPTS_VERSION` 版本号并导出 `sanitizePlanSteps`；`npm test` 全量 20 用例通过（新增规划器白名单过滤、非法输入回退两条）。限制：三餐计划与 DIY 食谱的公共“食谱规则”片段尚未抽取合并（两处约束由代码层分别兜底）；提示词仍内联在各函数中，未物理迁移到 `prompts/` 目录。主要修改文件：`server.mjs`、`test/prompt.test.mjs`、`CHANGELOG.md`。

### 提示词评测工具与写库关键词修复

- 新增离线契约评测：`test/fixtures/prompt-cases.json` 固定 10 条样例（问候、确认入账、补充修正、拒绝记录、记录体重、无效体重、帮我选、过敏拦截、无待确认却要求记录、附近清淡晚餐），`scripts/prompt-eval.mjs` 真实调用 `agentChat` 后按指标统计——action 白名单合法率、期望 action/proposal 命中率、过敏排除、未生成 proposal 时不得声称已写入，输出逐条结果与汇总，支持 `PROMPT_EVAL_LIMIT` 冒烟。
- 新增产品层语义评估：`scripts/semantic-eval.mjs` 用 LLM-as-judge 对同一批样例的回答按四个维度 1–5 打分（tone 语气专业不焦虑 / noHallucination 无编造 / actionable 建议可执行 / uncertainty 不确定性透明），输出平均分、≤2 分条目和问题摘要，支持 `SEMANTIC_EVAL_LIMIT`。
- 新增 `npm run prompt-eval` / `npm run semantic-eval`；导出 `agentChat` 供评测调用。冒烟验证（各 1–2 条真实调用）：`prompt-eval` 抓出“记到午餐”未触发写库提案的缺陷——写库意图关键词正则漏掉“记到/记成/记一笔”，补齐后“确认入账”用例恢复生成 `proposal.kind=meal`；`semantic-eval` 正常产出四维打分，并提示“纯问候”回答中的示例数字（如“多 200 大卡”）缺乏工具依据——建议该用例回答不给出未经核算的具体数值。限制：评测依赖真实 API Key 与网络，每条样例约 2–4 次模型调用，完整跑 10 条约需数分钟并产生少量费用。主要修改文件：`server.mjs`、`package.json`、`test/fixtures/prompt-cases.json`、`scripts/prompt-eval.mjs`、`scripts/semantic-eval.mjs`、`CHANGELOG.md`。

### 写库提案可靠性修复

- 修复两个影响“确认入账”契约的问题。其一：模型在涉及写库的对话里可能直接用文字描述提案而不调用 propose 工具（绕过确认卡片）；`agentLoop` 现在检测写库意图（记录/入账/记上/确认记录/记一下/帮我记/称重等关键词），若回合结束未产生 `proposal`，会注入“必须调用提案工具”的系统纠错消息并重试（最多 2 次额外轮次），`SYSTEM_BASE` 写库规则同步强化为“只用文字描述提案而未实际调用工具视为未完成”。其二：`propose_meal_record` / `propose_weight_record` 此前只校验日期格式不校验范围，模型可能生成错误日期（实测给出 2024-06-07）；现改为仅接受今天或 7 天内补登，其余回退为当天。验证：真实 API 调用确认“午餐 400 大卡确认记录”会触发 `tool:propose_meal_record` 并返回 `proposal.kind=meal`，`recordDate` 为当天。限制：模型回答措辞仍可能出现“已确认记录”等提前表述，实际写入以用户点击确认卡片为准。主要修改文件：`server.mjs`、`CHANGELOG.md`。

### 对话 JSON 稳定性修复

- 修复 Web 端偶发“真实模型调用失败：Unexpected token ... is not valid JSON”的问题：删除 legacy 降级后，`agentLoop` 对模型“不按契约输出”没有兜底——模型偶尔直接回复“好的，我们来搭配一顿……”等自然语言而非严格 JSON，`parseJsonText` 抛错直接上报前端。现在无工具调用的回合先尝试解析，失败时再做「首个 `{` 到末个 `}`」的子串修复（可救回“开场白 + JSON”的情况），仍失败则在剩余轮次内注入“必须只输出 JSON、不要开场白/markdown”的纠错消息重试；连续多次失败才返回友好错误“模型连续多次未返回合法 JSON，请稍后重试”。验证：真实调用“你好，介绍一下你自己”（此前大概率触发该报错的场景）现正常返回 JSON 回答。主要修改文件：`server.mjs`、`CHANGELOG.md`。

### 体重趋势判定修复

- 修复复盘规则兜底中“明显慢于目标”的符号错误：原条件 `deltaWeek < targetWeekly*0.5` 会把“减重速度超过目标”（如 −0.30 kg/周 vs 目标 0.25）误判为偏慢并错误下调预算；改为 `增重（deltaWeek>=0）或 减重速度不足目标一半` 才判定偏慢。修复后三组示例行为正确：达标（−0.30）不调整、偏慢（−0.06）下调 100 kcal 并生成干预任务、单日暴涨但周趋势正常（−0.29）不调整。主要修改文件：`server.mjs`、`CHANGELOG.md`。

### PWA 化（手机可安装使用）

- 将产品升级为 PWA：新增 `manifest.json`（应用名“小饭”、standalone 全屏、主题色、192/512 图标）、`sw.js` Service Worker（应用外壳缓存优先、`/api` 一律走网络不缓存，保证数据实时）、`scripts/generate-icons.mjs` 纯 Node 生成 PNG 图标（绿底白碗＋蒸汽）；`index.html` 增加 `theme-color`、`apple-mobile-web-app-*`、manifest 与图标链接；`app.js` 启动时注册 Service Worker。使用方式：手机与 Mac 同一 Wi-Fi，访问 `http://<Mac局域网IP>:8080`，Safari/Chrome“添加到主屏幕”后即全屏 App 体验，支持拍照记录、手动记录、SSE 实时提醒；应用外壳可离线打开，数据接口仍在线。限制：①手机浏览器对定位（附近外食）要求 HTTPS 安全上下文，局域网 HTTP 下不可用，需后续部署 HTTPS；②应用依赖 Mac 上服务进程运行，未部署云端；③未做应用商店原生包（需 Capacitor ＋ Apple 开发者账号）。主要修改文件：`manifest.json`、`sw.js`、`scripts/generate-icons.mjs`、`icons/`、`index.html`、`app.js`、`CHANGELOG.md`。

## 2026-08-07

### 项目维护

- 将用户提供的两段核心痛点原样整理进 PRD「5.3 典型痛点」：痛点一「每顿纠结吃什么——决策成本高」从表面上的选择多、信息杂的“找答案”问题，拆解为每顿重复发生的决策思考成本，落到在家 DIY（现有食材＋克数/步骤/耗时）与附近外食（位置＋热量余量＋口味忌口）推荐；痛点二「记录难——用户不清楚热量，没法记」从表面上的“不想记录”拆解为缺少热量信息导致的“记不了”，落到“拍照记一餐”的识别、营养库匹配、经验份量估算与一键确认入账闭环；原有点痛列表保留为「其他常见痛点」。主要修改文件：`PRD.md`、`CHANGELOG.md`。
- 将核心用户定位收敛为「想健康地吃，但不想为每一顿饭支付高决策成本的人」：明确用户不缺健康常识，缺的是每天为"吃什么"做决策的时间与意愿，产品价值是替用户完成决策而不是提供营养知识；同步更新 PRD 文档信息、产品概述与目标用户章节，README 简介和 MVP 产品定位。主要修改文件：`PRD.md`、`README.md`、`MVP.md`、`CHANGELOG.md`。
- 在进一步讨论后将核心用户定位修订为「有明确减重目标、想通过饮食减肥，但难以在热量限制内决定"下一顿饭吃什么"的人」：定位从抽象的"高决策成本"收敛到热量限制内的下一餐决策缺口，并移除对运动的提及（产品本身不含运动服务）；同步更新 PRD、README 和 MVP。主要修改文件：`PRD.md`、`README.md`、`MVP.md`、`CHANGELOG.md`。
- 将核心用户定位最终收敛为「有明确减重目标、希望通过饮食减重，但每天难以在热量限制内决定"下一顿吃什么"的人；需要一个 Agent 根据口味和忌口算好并可直接确认的下一餐答案」，统一 PRD、README 与 MVP 的表述。主要修改文件：`PRD.md`、`README.md`、`MVP.md`、`CHANGELOG.md`。

### 交互

- 移除首页「7日平均体重」指标卡（含 7 日迷你折线图与「查看趋势」入口）、趋势页静态「7日均值」摘要和演示对话中的 7 日均值文案：该均值此前只做展示，不参与食谱、外食推荐或理论计划计算，单看一个均值既无参照也无行动指导；删除对应的 `average` 计算与 `miniChart` 渲染逻辑，并将首页指标网格改为两列布局。保留项：趋势页 14 日实际折线与目标虚线、记录次数统计、最新单日体重驱动的 BMR/TDEE 重算。限制：首页 7 日迷你折线图随指标卡一并移除，未在其他位置重建。主要修改文件：`index.html`、`app.js`、`CHANGELOG.md`。
- 按产品原则“区间优于伪精确”调整不确定性的表达方式：移除面向用户的“营养置信度：高/中/低”等抽象标签，改为三级用户语言——本地营养库精确匹配时直接说明来源与误差范围（确定级），估算时给出“热量按常见份量估算，用油、酱汁和实际食用量可能造成偏差”等误差来源说明（区间级），查不到可靠数据时明确降级为“按同类菜估算，实际以实物为准”（降级级）；外食推荐卡片、Mock 演示卡片、营养查询工具轨迹和图片识别文案同步替换，后端仍保留 confidence 字段用于匹配与排序，计算逻辑不变。限制：外食卡片中的“个性化匹配”分数仍为数字展示，属于下一步可移除的候选。主要修改文件：`app.js`、`README.md`、`PRD.md`、`CHANGELOG.md`。

## 2026-08-05

### 项目维护

- 新增 `MVP.md`：整理 FitPilot MVP 设计文档，核心链路为"用户输入提示词 → Agent 读取记忆（减肥计划、偏好忌口、今日已摄入）→ AI 预算计算与推荐 → 用户确认 → 入账并更新预算"的单链闭环，拍照识别定位为"今日已摄入"记忆的输入方式之一；同时列出必须做与暂时不做的功能清单、关键设计决策、成功指标与 pivot 预案。主要修改文件：`MVP.md`。
- 将智能体名称由“FitPilot”统一更名为“小饭”：更新系统提示词中的自称、页面标题/侧边栏/聊天头/建档页的品牌展示，以及 README、MVP、PRD 文档中的产品名；localStorage 存储键、Open Food Facts 的 HTTP User-Agent 与高德跳转参数等外部标识保留 ASCII（`fitpilot_user_v3` / `XiaoFan`），避免丢失本地数据或出现 URL 编码问题。主要修改文件：`README.md`、`app.js`、`server.mjs`、`package.json`、`MVP.md`、`PRD.md`、`index.html`、`CHANGELOG.md`。

### 交互

- Agent 对话中触发 DIY 食谱、附近餐食或手动记录等工具动作时，不再于回答后自动弹出工具弹窗遮挡内容，改为在回答气泡下方渲染工具入口卡片，用户阅读完回答后点击再打开对应工具；`open_meal_choice` 原有内联选择保持不变，历史对话重载后同样恢复入口。主要修改文件：`app.js`、`api.css`。
- 手动记录“查询营养数据”的网页检索结果改为就地展开：显示候选来源（有网址时可点击打开）与候选说明（查过哪些官方渠道、为何没有数据）；当检索不到可靠营养值时明确提示手动填写热量与蛋白质，或换更具体的菜品名（如“赛百味金枪鱼三明治 6英寸”）再查询，不再只显示一行“已进入候选库”文字。主要修改文件：`app.js`、`api.css`。
- 为智能体“小饭”补充人设：系统提示词开头加入自我介绍（“一个帮用户把每一餐安排明白的个人减脂助手”），允许在合适时机自称“小饭”但不频繁重复名字。主要修改文件：`server.mjs`。

## 2026-08-04

### 项目维护

- 移除“两周减10公斤”等极端请求的演示拦截分支（该分支位于被真实LLM处理器覆盖的旧演示路径中，实际已不生效），并同步清理 README 演示流程中对应的步骤与已删除的“为什么？”按钮引用。主要修改文件：`app.js`、`README.md`。
- 移除“周报”栏目：删除侧边栏入口、整个报告页面与“导出报告”占位按钮及其相关样式，周报内容原本为静态演示且与趋势页、Agent对话信息重叠。主要修改文件：`index.html`、`app.js`、`styles.css`。
- 趋势页 14 日体重变化图的每一个实际记录点上方增加具体体重数值标注（保留一位小数）；首页小迷你图因尺寸限制不添加标注，避免拥挤。主要修改文件：`app.js`。
- 趋势页“理论计划会随最新体重更新”提示卡片移除“继续追问”按钮并压缩视觉尺寸：删除头像装饰、缩小内边距与标题字号，仅保留说明文字。主要修改文件：`index.html`、`styles.css`。
- Agent 对话页右侧“思考与工具”面板移除头部“可观察”标签，避免歧义；面板展示的思考轨迹与工具调用保持不变。主要修改文件：`index.html`、`styles.css`。
- 首页目标提示卡片移除“为什么？”按钮及其跳转到Agent对话的绑定逻辑，对应样式一并清理；想了解计划原因仍可直接在对话中询问。主要修改文件：`index.html`、`app.js`、`styles.css`。

- 删除饮食页面独立的“拍照记一餐”入口和视觉分析弹窗；保留Agent对话框内的图片上传、追问修正和确认记录流程。饮食页面的快捷记录按钮改为打开手动记录，外食用餐后的拍照按钮改为引导用户进入Agent上传图片，避免重复入口。主要修改文件：`index.html`、`app.js`。
- 修复删除旧餐食推荐按钮后仍对空元素绑定事件、导致建档页“下一步”无响应的问题；批量按钮绑定现在会自动忽略不存在的入口。主要修改文件：`app.js`。
- 删除“谨慎模式”及其 BMI/目标速度触发分支，首页、建档、目标调整、趋势与Agent状态统一显示理论热量计划；移除每日最低 1200 kcal 和每日缺口最多 500 kcal 的内部参考限制，餐次预算继续按理论目标计算。极端健康请求的基础安全拒绝仍保留。主要修改文件：`app.js`、`index.html`。
- 调整首页理论热量文案：将“期限反推”改为“理论建议”，并为目标日期说明增加“理论建议”前缀；计算逻辑未改变。主要修改文件：`app.js`。
- 新增 `CHANGELOG.md`，整理现有功能修改历史。
- 新增 `AGENTS.md` 仓库规则，要求后续每次实际修改同步更新变更日志。
- 当前目录尚未识别为 Git 仓库，因此日志可用于查看历史说明，但暂不能单独恢复任意代码快照。

### Agent 与工具调用

- 新增 Agent 体重记录能力：用户明确说出体重数字并表达记录意愿时（如“今天46.8”），Agent 通过受控 `save_weight` 动作写入体重，前端校验数值范围与日期、同一天覆盖旧值、自动更新当前体重并刷新页面；用户未给出明确数字时 Agent 只询问不写入，杜绝编造体重。主要修改文件：`server.mjs`、`app.js`。
- 修复用户回答图片分析追问（如“有米饭、用了酱油”）时被误判为确认记录的问题：补充食材、主食、酱汁、用油、重量或份量现在只会更新“待确认估算”，不会自动入账；更新后生成新的记录按钮，旧估算按钮失效。是否入账由 LLM 结合上下文判断，不要求出现“记录”关键词，“就这样吧”“按这个算”等明确接受当前估算的表达也可保存；意图仍有歧义时先确认。服务端新增受控 `revise_pending_meal` 动作，禁止模型仅用文字声称已经修正数据库；图片菜名同时移除“疑似”等不确定前缀，不确定性保留在说明中。主要修改文件：`app.js`、`server.mjs`。
- 图片分析结果改为“待确认餐食”：按钮明确显示记录日期、餐次与估算热量，用户可在保存前修改日期和餐次；未识别餐次时不再按当前时间随机归类。Agent 可理解“记录吧”“算到午餐”“只吃了一半”等自然语言，并只返回受控记录动作，由前端校验待记录项、日期、餐次和比例后再写入饮食记录；成功保存后才显示确认，且可防止重复记录。待确认结果 24 小时后自动失效。主要修改文件：`app.js`、`server.mjs`、`api.css`。
- 图片对话中的用户消息现在只显示用户实际输入；未输入文字时仅显示“已上传1张图片”。“分析菜名、份量和热量”等任务要求保留为后台视觉模型指令，不再伪装成用户消息。主要修改文件：`app.js`。
- Agent 对话输入区支持直接选择食物图片，并可在发送前补充菜名、实际重量、餐具大小或烹饪方式；视觉识别与热量估算结果作为Agent消息返回并持久化，可按区间中值加入饮食记录。主要修改文件：`index.html`、`app.js`、`api.css`、`server.mjs`。
- 将最近 100 条聊天消息持久化到当前浏览器用户档案，刷新或重新进入页面后自动恢复。
- 每次 LLM 请求携带最近 24 条对话，同时注入当前长期记忆、目标、体重和当天饮食记录；页面历史与模型上下文分别控制长度。
- 恢复历史消息时同步恢复“在家 DIY / 堂食外卖”操作按钮；用户主动清空对话或替换个人偏好时删除旧对话上下文。
- 对持久化聊天内容进行 HTML 转义，避免历史消息被当作页面代码执行。
- 主要修改文件：`app.js`、`server.mjs`。
- 将对话接入真实千问 LLM，并使用受控动作调用 DIY、外食、定位和记录工具。
- 明确分离 LLM 理解层、Agent 编排层和浏览器/高德/营养数据库工具层。
- 对“附近、周边、几公里内、找餐馆”等明确请求增加确定性工具路由，避免 LLM 错误拒绝定位。
- 支持从自然语言提取搜索半径，范围限制为 100–5000 米。
- 支持用户输入地区、商圈或地址，通过高德地理编码进行搜索。
- 普通餐食推荐不再自动弹出模式选择窗口，改为在回答下方显示“在家 DIY”和“堂食 / 外卖”按钮。

### 餐次与日期

- “今日餐食推荐”由三餐概览升级为双方案：每个尚未完成的餐次直接展示一份包含食材和步骤的 DIY 菜谱；同时请求浏览器定位，通过高德 POI、营业时间和个性化餐食排序展示一家附近门店、具体位置与推荐食物，定位或候选不足时明确提示并保留手动搜索入口。主要修改文件：`app.js`、`server.mjs`、`record-status.css`。
- 首页新增“今日餐食推荐”，无需先与Agent对话即可一次生成早餐、午餐、晚餐概览；按当天理论目标、已记录三餐及其他摄入动态重分配剩余热量，每个未记录餐次可直接进入“在家DIY”或“附近外食”。主要修改文件：`index.html`、`record-status.css`、`app.js`、`server.mjs`。
- 饮食记录固定按早餐、午餐、晚餐排列，缺失餐次保留“未记录”占位；原“加餐”统一兼容显示为“其他摄入”，仅有真实记录时显示。能量规划只在三餐间分配，不为其他摄入预留预算；其他摄入一旦记录，仍计入全天已摄入并减少后续三餐可用热量。主要修改文件：`app.js`、`server.mjs`、`index.html`。
- 支持早餐、午餐、晚餐和加餐，不再把记录固定保存为午餐。
- 支持今天与明天的独立预算；明天的推荐不扣除今天已摄入的热量。
- 根据剩余热量和后续餐次动态分配本餐预算。
- 增加过去餐次判断：早餐 10:30、午餐 14:30、加餐 17:30、晚餐 21:30 后视为时段已过。
- 对已经过去的今日餐次，优先回顾真实记录；没有记录时询问补记还是规划明天。
- 用户明确要求补记时，打开对应餐次的手动记录表。

### 餐馆推荐

- 接入高德 POI 的店名、地址、距离、特色菜和营业时间。
- 根据 `opentime_today` 与 `opentime_week` 判断目标餐次是否营业。
- 早餐营业判断代表时间调整为 08:30；午餐为 12:00，加餐为 15:30，晚餐为 18:30。
- 明确不营业的门店从结果中排除；无法核验营业时间的门店标记为待确认。
- 支持用户指定推荐店铺数量，最多处理 20 家候选。
- 请求数量不足时显示“请求数量 / 实际找到数量”，不使用不营业或不符合条件的门店凑数。
- 推荐与摄入记录分离：缺少可靠营养数据仍可推荐，用餐后再拍照估算或手动记录。
- 热量不足时明确提示；无特殊要求时优先低卡候选。

### DIY、营养与饮食记录

- 暂时保留现有 `data/foods.json` 生成的中国食物本地库作为第一层来源；新增统一营养解析链路：本地SQLite → USDA FoodData Central API → 千问联网检索的官方网页候选 → 用户手动填写。新增 `/api/nutrition/resolve`，图片分析也复用该链路；无法匹配的食物会在结果中标注并要求补充每100g营养值，不再静默按未知数据计算。手动记录在本地和USDA均未命中时自动进入官方网页候选查询。主要修改文件：`server.mjs`、`app.js`。
- 增加全局展示数字规范：页面文本中的数字最多保留两位小数，数字输入在变更后同样归一化为最多两位；模型生成计划也明确限制数字精度。经纬度等仅用于工具调用的底层数据不截断，避免破坏附近搜索精度。主要修改文件：`app.js`、`server.mjs`。
- 早餐、午餐、晚餐的空记录新增“未吃”选项，可区分“明确没有吃”与“忘记记录”；未吃状态按 0 kcal、0g 蛋白质参与当天汇总，但在界面中显示为状态而不是普通 0 kcal 餐食，并会将剩余热量和蛋白质重新留给尚未完成的餐次。支持历史日期标记和撤销，今日餐食计划不再为已标记未吃的餐次继续生成推荐。主要修改文件：`app.js`、`server.mjs`、`record-status.css`。
- 简化图片分析结果：不再向用户展示视觉比例、食物识别/份量置信度或热量范围；后台仍保留范围用于计算，但前端统一展示经验重量与单一近似热量，并可直接记录该估算值。主要修改文件：`app.js`。
- 图片分析新增份量范围：优先使用用户说明和视觉比例，无法可靠判断时按食物类别使用常见一人份范围；热量由份量上下限与营养数据库换算，并分别显示食物识别、份量置信度和估算依据，不再在重量未知时静默按100g计算。主要修改文件：`server.mjs`、`app.js`。
- “饮食与食谱”新增按日期查看的饮食历史，支持前后日期切换、回到今天、历史补登、修改和删除；首页“昨日饮食”已有数据时可直接进入昨日详情。主要修改文件：`index.html`、`app.js`、`record-status.css`。
- 新增昨日体重与饮食记录状态，缺失时明确显示“未记录”，不再将缺失数据解释为 `0 kg` 或 `0 kcal`。
- 体重和手动饮食弹窗支持选择历史日期补登；补登记录同时保存数据所属日期、实际补登时间与 `manual_backfill` 来源，补登旧体重不会覆盖最新体重。主要修改文件：`index.html`、`app.js`、`record-status.css`。
- DIY 食谱只允许使用用户提供且已匹配营养数据库的食材，以及用户勾选的常备调料。
- 现有食材不要求全部使用；常备调料也不要求全部加入。
- 数据库全部匹配失败时允许用户手动输入每 100g 营养值后重新生成。
- 修复只提供番茄却生成鸡蛋等未提供食材的问题。
- 首页、营养进度、DIY 和外食统一读取当天真实记录与计划目标。
- 提供拍照识别、菜名查询、条码查询和手动输入等饮食记录方式。

### 档案与长期记忆

- 个人资料改为可编辑的当前状态，不再把建档内容当作不可变标签。
- 支持修改称呼、年龄、生理性别、身高、活动水平、饮食方式、当前习惯、辣度、偏好、不喜欢食材和过敏忌口。
- 保存资料时使用新快照覆盖旧值，并清除携带旧偏好的当前对话上下文。
- Agent、DIY、外食推荐、热量计划和长期记忆统一使用最新资料。

## 2026-08-03

### 初始功能完善

- 建立本地营养数据库及食品别名匹配。
- 接入高德附近餐馆查询、公开菜单检索和按店型降级推荐。
- 修复饮品店被错误推荐鸡鱼虾主菜、饮品与食物提示矛盾、中餐缺少主食说明等问题。
- 增加可编辑口味、忌口、现有食材和常备调料设置。
- 将每日理论摄入目标与目标体重、目标日期和活动水平联动。

## 记录规范

以后每次实际修改项目时，在最新日期下追加一条记录，至少包含：

- 用户提出的修改目标。
- 实际实现或修复的内容。
- 主要涉及的文件。
- 如有未完成、限制或迁移要求，必须明确注明。

本日志用于回顾，不等同于代码快照。若需要逐行恢复历史版本，还应配合 Git 提交或其他版本控制。
