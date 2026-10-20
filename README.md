# 小饭 Demo

小饭是一款面向健康成年减脂用户的个性化餐食推荐 Web Demo。用户提出“这一顿吃什么”后，产品会结合减脂目标、当天摄入、偏好与忌口、食材、厨具、时间、位置和真实菜单，给出可以直接执行的具体食谱或餐厅餐食。自然周计划、饮食记录、主动提醒和滚动更新用于持续提高推荐的准确性与及时性。

## 在线体验

完整功能版部署于 Cloudflare Pages，账号、会话和用户记录存储在 Cloudflare D1：

[打开小饭完整功能版](https://xiaofan-food.pages.dev/)

下面的 GitHub Pages 链接仍为静态面试演示。

[打开小饭面试演示](https://lnx-fight.github.io/food-agent-demo/)

演示覆盖 Skill 路由、餐食场景识别、端到端入口、多轮任务与受控 Tool 调用；相应评测脚本和用例位于 `scripts/` 与 `test/fixtures/`。GitHub Pages 版本会明确显示“面试演示模式”，所有数据保存在浏览器中，Agent、图片识别、营养检索和附近餐馆均为预置响应，不会调用外部 API 或暴露密钥。

它的核心用户是：有明确减重目标、希望通过饮食减重，但每次用餐前都要在热量、偏好、忌口和现实条件之间反复搜索与比较的人——他们需要小饭直接推荐一顿符合目标且可以马上执行的餐食。

## 运行方式

本地使用 Node.js 22.18+ 内置 HTTP 服务和 SQLite；Pages 构建、测试和部署工具通过 `npm ci` 安装：

```bash
npm ci
npm start
```

然后访问 <http://localhost:8080>。如需调整端口，可在启动前设置 `PORT`。

## Cloudflare Pages + D1 自动部署

生产站点：[xiaofan-food.pages.dev](https://xiaofan-food.pages.dev/)。Pages Functions 复用现有 Node HTTP 业务代码，数据库调用改为异步；本地继续使用 SQLite，线上通过请求上下文绑定 D1，不依赖本地磁盘。静态构建只发布 `public-files.mjs` 白名单，密钥、数据库、原始下载包和服务端源码不作为静态文件上传。

网址于 2026-10-16 更换为 `xiaofan-food.pages.dev`，继续使用同一个 D1；由于浏览器 Cookie 和本机暂存按域名隔离，新网址需重新登录，尚未同步的旧网址本机修改需先在旧网址完成同步。

项目及数据库编号等非敏感配置位于 `cloudflare/project.json`。`.github/workflows/cloudflare.yml` 对 push 和 PR 执行语法检查、Node 回归测试、真实 workerd/D1 集成测试、USDA 导入校验和 30 条 Agent 数据集结构校验；只有 `main` 的 CI 通过，才下载同一次 CI 的构建产物、执行版本化 D1 迁移并发布 Pages。PR 和其他分支不部署生产环境，也不连接生产数据库。生产部署串行执行，发布后检查 `/api/health` 的中文食物和 USDA 数据量。

仓库 Actions Secret `CLOUDFLARE_API_TOKEN` 使用当前 Cloudflare 账号的 Pages Write + D1 Write 专用令牌；其权限范围是该账号的 Pages 与 D1 产品，并非单一项目。应用 API 密钥单独存于 Pages 生产 Secret。SSH 公钥只用于 Git 推送，不能代替 Cloudflare CI 令牌。CI 不运行需要真实模型密钥的付费 Agent 语义评测。

```bash
npm ci
npm run check
npm test
npm run test:dataset
npm run eval:validate
npm run build:pages
# 已设置 CLOUDFLARE_API_TOKEN 后，按顺序执行：
npm run db:migrate
npm run deploy:pages
```

资源管理和 D1 迁移使用 `cf`。当前固定版本 `cf@1.0.0-beta.17` 的 `cf pages deploy` 明确不支持此 Pages Direct Upload；仅上传步骤按该命令的提示调用固定版本 `npx wrangler@4.151.0 pages deploy --no-bundle`，不创建 Wrangler 配置。兼容日期与 `nodejs_compat`、生产 `DB` 绑定在 Pages 项目中配置；重建项目时需重新配置这些设置。Preview 不绑定生产 D1。

初始化迁移 `migrations/0001_schema.sql` 创建业务表，后续迁移导入 USDA 数据及搜索索引；`0006_usda_only.sql` 删除旧中文估算食品、别名及网页候选表，只保留 USDA 营养数据。已发布的 `0002_foods.sql` 仅保留迁移历史，不得回改。迁移由 D1 记录，只执行尚未应用的文件；已发布迁移不得改写，应新增编号文件。现有本地 `data/nutrition.sqlite` 的个人账号和记录不会自动上传，线上从新账号开始。Pages 新密码使用带随机盐的 PBKDF2-SHA256（100,000 次，适配 Workers Web Crypto），本地原 scrypt 格式继续支持；旧 scrypt 账号若另行迁入 Pages，需先另行设计密码迁移，不能直接使用。

Pages 采用请求触发的提醒检查和约一分钟重连的 SSE 快照，不运行常驻 Node 定时器；没有浏览器请求时不会定时推送，跨实例不共享内存 SSE 连接。生产 D1 备份应使用 Cloudflare 导出或 Time Travel；`scripts/manage-data.mjs` 仅管理本地 SQLite。回滚 Pages 代码不会回滚数据库；数据库迁移应向后兼容。

D1 免费套餐当前提供每天 500 万行读取、10 万行写入和账号总计 5GB 存储；免费请求和 CPU 仍受 Pages Functions / Workers 限制，超额可能暂停服务。USDA 快照和 FTS5 索引约占 4.6MB。没有启用付费计划；千问、高德等外部服务按其自身规则计费。参见 [D1 定价](https://developers.cloudflare.com/d1/platform/pricing/)、[Pages Functions 定价](https://developers.cloudflare.com/pages/functions/pricing/)。

## 已下载的 USDA 权威营养数据

已从 [USDA FoodData Central 官方下载页](https://fdc.nal.usda.gov/download-datasets/) 下载 Foundation Foods（2026-04）、SR Legacy（2018-04 最终版）和 FNDDS（2021–2023，2024-10 发布），依据其 [CC0 授权](https://fdc.nal.usda.gov/) 保存原始压缩包、SHA-256、版本、来源和标准化快照。

共 **13,588 条**有效食物/餐食记录，其中 **13,545 条**有热量；Foundation 原始 JSON 中另有 32 个空记录，未当成食物导入。未知热量、蛋白质等保持 NULL，明确的 0 继续保留。每条记录按 **每 100 克可食部**存储，区分 kcal 与 kJ；优先保留 USDA 的食物特定 Atwater 热量（2048），再使用通用 Atwater（2047）或原 kcal（1008），仅缺少 kcal 时以 kJ / 4.184 换算，并记录所用营养素编号。

原包位于 `data/downloads/`，本地可直接打开的标准化 CSV 为 `data/usda/nutrition.csv`（这两项不提交 Git）；来源清单位于 `data/usda/manifest.json`，可复现 SQL 快照位于 `migrations/0004_usda_snapshot.sql`。重新下载和校验：`npm run data:download`；已有原包离线重建：`python3 scripts/import-usda.py --offline`。该脚本只准备快照，不直接写生产库，生产导入由后续 `npm run db:migrate` 完成。更新数据版本时应新增迁移，勿覆盖已经发布的快照。

`authoritative_foods` 保存 USDA 原始英文名、营养值、FDC 编号、版本和可追溯 URL，FTS5 提供全文搜索。唯一内置营养数据集为 USDA；旧 300 条中文估算食品及其运行时种子 `data/foods.json` 已删除。`data/usda/chinese-foods.json` 仅维护中文名称/别名、类别与 FDC 编号，不存营养值。

登录后可使用 `/api/nutrition/search?q=米饭` 查询中文映射，或 `q=fdc:168878` 精确读取熟长粒白米饭（130 kcal/100g）。中文“汉堡”自动命中 USDA 通用汉堡；“牛肉汉堡”“芝士汉堡”“鸡腿汉堡”“炸鸡汉堡”按名称匹配各自品类，不再弹三选一。USDA 通用鸡肉汉堡未细分鸡腿/鸡胸，“鸡腿汉堡”会明确标注通用鸡肉参考，不冒充精确部位或品牌配方。`resolve` 与 `search` 使用同一流程，`dataset-search` 提供结果列表接口。

中文名称先通过离线词汇转换完整检索词（包含生熟和配方词），再在 USDA 快照内全文检索和排序；离线词汇不完整时才尝试千问仅转换英文检索词，自动返回参考记录；不采用模型生成的营养值或 FDC 编号，不把复合菜降为单一食材。英文全文检索同样自动匹配，普通查询优先通用记录，避免未指定品牌却命中品牌配方；自动搜索结果标为参考匹配、medium 置信度。显示中文名、英文原文、来源与配方提示，不保证精确覆盖所有中餐；无匹配时请用户补充名称或手动填写包装信息。固定映射、离线中文检索、英文检索及 FDC 精确读取均不需要 USDA API Key 或模型额度。词汇转换时有未知部分会拒绝局部匹配；普通水果优先匹配鲜果，防止草莓匹配成果奶，词形比较避免 pea/peanut 等前缀混淆。

图片分析、DIY、菜单和文字记餐改为读取 USDA；第三方条码和自动网页营养估值停用，用户仍可按实际包装标签手动记录。账号和已确认历史摄入保留，不因切换营养库重算。旧代码依赖被删除的食品表，因此本次迁移后不能直接回滚到旧版本，需修复前进或同时恢复数据库。

## 发布面试演示到 GitHub Pages

本仓库根目录已包含静态入口文件，GitHub Pages 会自动启用面试演示模式：页面不请求 `/api/*`，以预置响应演示餐厅、计划和 Agent 对话；真实 USDA 查询、图片分析和按食材生成食谱需要登录正式服务，演示模式不再提供虚构营养查值。

1. 将本次改动推送到 `main` 分支；
2. 打开 GitHub 仓库的 **Settings → Pages**；
3. 在 **Build and deployment** 中选择 **Deploy from a branch**；
4. Branch 选择 `main`，目录选择 `/(root)`，点击 **Save**；
5. 等待 GitHub 显示网址 `https://lnx-fight.github.io/food-agent-demo/`，打开后确认页面顶部出现“面试演示模式”。

该模式适合展示产品界面、受控流程与本地交互，不替代真实模型、视觉识别、位置服务或服务端持久化。若以后恢复完整在线服务，可继续使用下文的 Render 部署方案。

## 备选：部署完整功能版（Render，需付费）

本项目由 `server.mjs` 同时提供网页和 `/api/*` 接口，因此应部署为 Render **Web Service**，而不是静态站点。仓库根目录已提供 `render.yaml`，可在 Render 中选择 **New → Blueprint** 并连接本 GitHub 仓库。

部署配置已预设为：Node.js 22、区域 Singapore、构建命令 `npm run check`、启动命令 `npm start`、健康检查路径 `/api/health`，并使用付费 Starter 实例和 1GB 持久磁盘，`DATA_DIR=/var/data`。这份配置不是免费方案；确认托管费用后再创建服务，API 用量另计。创建服务时在 Render 控制台填写以下密钥，绝不要提交到 GitHub：

```text
DASHSCOPE_API_KEY=...        # 启用真实 Agent 对话、视觉识别与联网降级
USDA_API_KEY=...             # 可选：长尾食材查询
AMAP_WEB_SERVICE_KEY=...     # 可选：附近餐馆
```

部署成功后，先访问 `https://<服务名>.onrender.com/api/health`；确认返回 `ok: true` 后，再把本 README “在线体验”中的占位链接换成该地址并推送到 GitHub。之后每次推送默认分支，Render 会自动重新部署。

公开服务的静态资源由 `public-files.mjs` 白名单控制，只提供网页、脚本和样式；`.env`、Git 文件、服务端源码、SQLite 数据库及其他个人文件不对外提供。新增浏览器资源时，需要同步更新该白名单及适用的 PWA 缓存列表。公开托管时只上传产品源码，勿上传本地 `.env`、数据库、备份和个人文件。完整功能版的全部业务接口均要求登录，服务器根据会话确定数据所属账号，不信任客户端传入的 `clientId`。

Render 默认文件系统是临时的；没有持久磁盘时，账号、密码哈希、会话和用户记录都会随重启或部署丢失。不得用临时文件系统承载正式账号。当前 SQLite 方案只运行单个服务实例；需要多实例时应迁移到共享数据库。USDA 数据首次启动由版本化快照初始化，账号和用户记录保存在持久目录中。参见 [Render 持久磁盘说明](https://render.com/docs/disks)。

线上必须通过 HTTPS 访问，生产环境会话 Cookie 强制 `Secure`。可设置 `PUBLIC_ORIGIN=https://实际域名` 固定可信来源，不能带结尾斜杠；自定义域名切换时同步修改。写接口同时验证来源、自定义请求头和 JSON 类型；不要开放通配 CORS。只有确认代理会覆盖 `X-Forwarded-For` 时才启用 `TRUST_PROXY=true`，否则登录限流按直接连接地址统计。

## 从新用户开始测试

首次访问完整功能版会先要求注册或登录，之后进入三步建档。用户名为3–32位字母、数字或下划线（不区分大小写），密码为12–128个字符，使用带独立随机盐的 scrypt 派生后存储；登录凭证使用7天有效的 HttpOnly / SameSite=Strict Cookie，数据库只保存凭证的哈希。登录和注册有持久化频率限制。当前不提供邮箱验证、忘记密码的邮件找回、第三方登录或管理员用户管理后台。

档案、体重、饮食记录、对话与计划按账号同步至服务端 SQLite，同一账号可在其他设备登录并恢复。浏览器暂存按账号分开；页面显示保存、失败和冲突状态。保存使用版本校验，多设备或多标签页发生冲突时暂停自动同步，保留本机修改，并提供“导出本机修改 / 载入云端最新数据”，不静默覆盖。启动时需要连接账号服务；离线期间已完成的本机修改会暂存，恢复后继续同步或提示冲突。

侧边栏“账号与数据”提供修改密码、退出当前/全部设备、导出全部个人数据、清空记录和注销账号。修改密码撤销其他会话；清空保留账号，注销同时删除账号。清空与注销均要求当前密码和指定确认文字，并删除档案、饮食、体重、对话、计划、提醒、记忆、工具日志及相关派生记录；旧会话被撤销，避免其他设备将旧状态重新写回。导出不含密码或会话凭证，尚未同步的本机修改会另附在导出文件中。

升级时自动新增 `accounts`、`account_sessions`、`auth_attempts` 表，保留原有用户表。旧版 `clientId` 不作为账号认领凭证；旧服务器记录不会自动分配给任意新账号。首次登录空账号时，若本机有旧档案，会要求用户明确确认后才导入。旧服务器记录只有管理员备份可保留，不能只凭知道其 `clientId` 恢复；GitHub Pages 静态演示仍保留原有浏览器模式。

## 数据备份与恢复

管理员可执行 `DATA_DIR=/var/data npm run data:backup -- /var/data/backups`，通过 SQLite `VACUUM INTO` 生成一致性快照并校验完整性，备份文件权限为 `0600`。备份包含所有账号的敏感记录和密码哈希，应放在不公开的位置，并另行保存到受控的异地存储；默认 `backups/` 不提交到 Git。当前只提供手动脚本，没有启用定时异地备份或自动保留期清理。

恢复前停止服务并保存当前数据库，执行 `npm run data:restore -- /绝对路径/备份.sqlite /新的空数据目录`；脚本验证数据表和完整性，拒绝覆盖现有数据库，恢复后撤销所有会话。然后将 `DATA_DIR` 切换至恢复目录并重新启动。恢复会回到备份时间点，包括当时的密码哈希；备份后变更的记录和密码不会保留。清空/注销仅立即删除在线数据，历史备份仍须按运营方制定的保留策略清理，恢复历史备份时也需处理备份后的注销请求。

### 配置真实服务

复制环境变量模板：

```bash
cp .env.example .env
```

按需填写：

```text
DASHSCOPE_API_KEY=...        # 阿里云百炼API Key
QWEN_VISION_MODEL=qwen3-vl-flash # 图片餐食识别专用视觉模型
QWEN_WEB_MODEL=qwen-plus
QWEN_CHAT_MODEL=qwen-plus
QWEN_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
USDA_API_KEY=...            # FoodData Central长尾食材查询
AMAP_WEB_SERVICE_KEY=...    # 高德附近餐馆POI
QWEN_EMBED_MODEL=text-embedding-v3 # 可选：语义记忆嵌入模型
AGENT_MAX_TOOL_ROUNDS=6     # 可选：单次Agent执行的最大工具轮次
```

`QWEN_VISION_MODEL` 与 `QWEN_WEB_MODEL` / `QWEN_CHAT_MODEL` 职责分离：上传餐食图片时仅调用视觉模型，文字对话与联网检索继续调用文本模型。修改 `.env` 后需重启 `npm start` 才会生效。

`/api/health` 会返回千问、USDA 和高德的配置状态。未配置千问时，Agent 对话和图片识别会明确报出服务未配置；DIY 食谱和今日三餐计划则会降级为基于 USDA 食材数据的确定性规则建议，并在界面标记为“规则建议”。

当前可真实操作：

- 创建和评估自己的目标；
- 生成并确认按 Asia/Shanghai 时区组织的周一至周日自然周计划；每个未执行餐次直接展示含食材份量、步骤和耗时的在家食谱，用户授权位置或输入地点后可一次补全整周真实附近门店与具体餐食；周中首次建档不会补写过去日期，周日会生成下周提案，确认后在周一自动生效；
- 锁定自然周基准安排；每次确认记餐后自动刷新当天未执行餐次，晚餐确认、点击“结束今天”或跨日后再温和更新未来日期；
- 在“今日”查看 Agent 当前判断的下一最佳行动，并从周计划直接进入下一餐决策；
- 记录、更新每日体重；
- 手动、拍照记录、修改和删除饮食，并在确认后更新当日预算；
- 使用家中现有食材生成动态DIY食谱，并由 USDA 营养数据校验食材克数、热量和三大营养素；
- 根据真实档案计算BMI、目标BMI、计划速度、基础能量估算和蛋白质参考值；
- 让Agent通过真实千问模型读取当前档案、最近对话及历史记录回答问题；
- 通过唯一的 `next-meal-decision` Skill 处理复杂下一餐决策；计划滚动更新由确定性状态机负责，不依赖模型生成计划补丁；
- 保存每轮 Agent 的目标、执行步骤、工具结果和待确认状态，并在“工具日志”中查看近期执行记录；
- 根据时间、未记录餐次和目标进度创建主动任务，通过 SSE 推送到当前浏览器；基于体重趋势和记录完整度进行每日复盘；
- 查询本地SQLite营养库；
- 唯一内置营养数据集为13,588条USDA记录，中文名称通过FDC映射或英文检索自动匹配；原300条估算食品库已删除；
- 配置阿里云百炼千问后进行真实图片食物识别与中文食品名称转换；
- 配置高德后使用浏览器定位查询真实附近餐馆；
- 对用户上传的菜单图片、粘贴的菜单文字或公开菜单链接进行按需完整解析，保留分类、菜名、价格、来源与完整性状态，再按当前餐次预算排序；
- 优先使用高德POI `business.tag` 返回的特色菜；没有特色菜时使用千问联网检索核验公开菜单，仍无法确认才明确降级为“按店型推荐”；
- 外食推荐会读取当前减脂计划和今日摄入，匹配 USDA 食品记录，以单一近似热量、蛋白质、距离、口味和忌口进行个性化排序；
- 使用在家DIY与外食推荐流程；
- 经用户主动开启后，根据餐前、记录中断、计划偏离和周计划状态创建提醒；支持每日上限、免打扰时段、稍后处理、接受与忽略；
- 在服务端同步可用时跨刷新恢复档案、记录、对话、自然周计划、提醒设置、菜单导入与 Agent 记忆。

## 建议演示流程

1. 完成建档，在“本周计划”确认从周一至周日组织的计划提案；
2. 返回“今日”记录一顿实际餐食，观察当天尚未执行餐次即时刷新；再点击“结束今天”，查看未来日期的温和更新说明；
3. 点击“帮我选”，分别演示在家 DIY 和附近外食；在外食结果中上传或粘贴一份菜单，展示完整菜单解析和排序；
4. 点击顶部提醒入口，开启主动提醒并查看待处理行动；
5. 在 Agent 对话中上传餐食图片，演示结构化单一近似热量、关键不确定性与确认入账；
6. 打开“工具日志”，查看 Skill、受控工具调用和目标执行轨迹。

## Agent设计

当前版本在配置千问后采用“LLM 理解 + 受控 Workflow”混合架构（`agentLoop`）：高置信请求先由确定性边界路由，复杂表达由 LLM Router 兜底；服务端根据意图和 DIY / 餐厅 / 未定场景生成结构化中间决策，并按白名单顺序调用受控工具（DIY 食谱、餐馆、菜单、营养、记忆）；最终回答只消费成功 Tool 证据，失败、空结果和安全边界使用确定性降级，写入类动作只生成确认提案。每轮执行都会持久化目标、步骤和分段耗时，方便恢复、追溯与性能定位。核心架构：

```text
Router + 主 Agent（意图理解、Skill 选择与编排）
  ├── 浏览器状态 + 服务端长期记忆（users / meal_logs / agent_memory）
  ├── 确定性工具：预算计算、营养解析、食谱实算
  ├── next-meal-decision Skill → 复杂约束理解与下一餐决策规则
  ├── 场景 Workflow → Tool 白名单、顺序、参数、安全校验与失败停止
  ├── 固定自然周、餐后/日终滚动状态机、主动任务与安全规则
  ├── 食物视觉识别工具（千问视觉模型）
  ├── 附近餐馆与公开菜单检索（高德 / 千问联网）
  ├── 受控写库：确认提案 → 用户确认 → 落库
  ├── 执行目标与步骤日志（agent_goals / agent_goal_steps / agent_logs）
  └── 健康安全规则层（年龄、极端目标、忌口）
```

产品只注册一个 `next-meal-decision` Skill，作为模型处理具体下一餐的标准操作流程，而不是营养计算、记录写入或周计划更新引擎。它负责理解用户本轮复杂事实、历史习惯与临时约束，分流为在家 DIY、附近外食或场景选择，并编排对应 Tool。

Router 只在用户需要一顿具体餐食时命中该 Skill。每次确认记餐后的当日刷新，以及晚餐确认、用户结束当天或跨日后的未来计划更新，均由确定性状态机完成：当天只改尚未执行餐次；未来日期只依据近期完整记录温和更新；单日超出不扣减次日目标，不继承“热量债务”。

菜单图片/文字解析属于 Tool，首次生成固定自然周计划与主动提醒属于 workflow，BMI、热量、营养、餐后分配和日终趋势判断由确定性程序负责，它们不单独拆成 Skill。

本地 USDA 数据与用户状态位于 `data/nutrition.sqlite`，线上使用 D1。启动时清理旧食品估算表，USDA 首次按迁移初始化，后续不覆盖用户记录。中文检索映射只保存名称和 FDC 编号，营养值始终读取 USDA。图片识别、菜单解析和附近餐馆在配置密钥后调用真实接口；没有合适 USDA 条目时显示未匹配，不以单一食材或旧近似菜编造完整菜品营养。DIY 模型不可用时使用已匹配 USDA 食材的规则模板。美团等交易平台未接入，任意餐馆菜单不保证实时完整，用户可提供菜单图片、文字或公开链接。

## Agent 评测

项目使用 `next-meal-decision` 处理下一餐决策。此前引入的 health-coach 饮食资料与375条社区食品参考记录已移除，营养查询仅使用 USDA 及中文名称映射。服务启动时删除已停用的 `reference_foods` 表；已确认的用户饮食和体重记录继续保留。

项目在 [EVALUATION.md](./EVALUATION.md) 中定义下一餐推荐 Agent 的评测对象与能力边界，并在 [METRICS.md](./METRICS.md) 中定义指标公式、大模型裁判评分锚点和发布判定。首版 Agent 行为评测集包含 30 条样本，正样本、负样本、边界/模糊样本、异常样本和对抗样本各 6 条；外部 Tool 使用仅在测试环境生效的固定 fixture，避免网络与数据波动污染模型评测结果。

- `npm run eval:validate`：不调用模型，校验评测集 schema、五类覆盖、fixture 和断言；
- `npm run eval:agent`：使用真实模型运行 Agent，再由大模型裁判逐条打分并执行发布判定；
- `AGENT_EVAL_SAMPLE_TYPE=adversarial npm run eval:agent`：只运行某一类样本；
- `AGENT_EVAL_REPEATS=3 npm run eval:agent`：每条运行三次并计算决策稳定率；
- `QWEN_JUDGE_MODEL=JUDGE_MODEL_ID AGENT_EVAL_REPORT_PATH=artifacts/agent-eval-report.json npm run eval:agent`：指定账号内可用的独立裁判模型并保存完整报告；
- `AGENT_EVAL_SKIP_MODEL_JUDGE=1 npm run eval:agent`：仅调试自动规则；该结果不能通过发布门槛；
- `NODE_ENV=test node scripts/skill-route-eval.mjs`：Skill 命中与意图边界；
- `NODE_ENV=test node scripts/meal-choice-eval.mjs`：DIY、附近餐厅与待选择入口；
- `npm test`：确定性程序、安全规则和回归测试。

评测器分别报告执行完成、Skill、意图、场景、Tool、参数、动作、提案、异常/对抗、稳定性、P95、大模型裁判质量和一票否决指标，不计算会掩盖硬失败的加权总分。裁判可以读取被测 Agent 实际收到的确定性预算与状态上下文；裁判输出必须通过 JSON schema 校验，无效时重试一次，仍失败则不能发布。千问请求默认30秒超时，并对瞬时网络错误、429和服务端错误重试一次，可通过 `QWEN_REQUEST_TIMEOUT_MS`、`QWEN_REQUEST_RETRIES` 和 `QWEN_RETRY_BASE_MS` 调整。出现过敏冲突、医疗越界、虚构餐厅/菜单、极端补偿或未授权写入时一票否决。运行真实评测需要 `DASHSCOPE_API_KEY`；正式发布建议将 `QWEN_JUDGE_MODEL` 配置为不同于被测模型的模型。

## 后端API

除 `GET /api/health` 与注册、登录、会话查询外，所有接口都需要有效登录 Cookie。写接口要求 `Content-Type: application/json` 和 `X-Requested-With: Xiaofan`。`GET /api/user/state` 返回 `stateVersion`，保存时必须在 `X-State-Version` 中回传该值，冲突返回409。

| 接口 | 功能 |
|---|---|
| `POST /api/auth/register`、`POST /api/auth/login`、`GET /api/auth/session` | 注册、登录和查看当前账号 |
| `POST /api/auth/logout`、`POST /api/auth/logout-all` | 退出当前或全部设备 |
| `POST /api/account/password` | 校验当前密码后修改密码，撤销其他会话 |
| `GET /api/account/export` | 导出当前账号的个人数据 |
| `POST /api/account/clear`、`POST /api/account/delete` | 校验密码及确认文字后清空记录或注销账号 |
| `GET /api/health` | 查看服务和密钥配置状态 |
| `GET /api/nutrition/search?q=`、`GET /api/nutrition/resolve?q=` | USDA 中文/英文自动匹配与 FDC 编号精确读取 |
| `GET /api/nutrition/barcode/:code` | 已停用（410），可按包装标签手动输入 |
| `POST /api/nutrition/web-search` | 已停用（410），统一使用 USDA |
| `POST /api/meals/analyze` | 真实视觉识别并自动匹配 USDA |
| `POST /api/recipes/diy` | 匹配现有食材、生成DIY食谱并由服务端计算营养 |
| `POST /api/agent/chat` | 使用真实LLM结合用户状态和最近对话生成回答与受控动作 |
| `GET /api/restaurants/nearby` | 定位坐标转换及高德周边POI |
| `POST /api/restaurants/recommendations` | 核验公开菜单并生成真实菜单/店型降级推荐 |
| `GET/PUT /api/user/state` | 用户档案、饮食、体重、聊天历史的服务器落库与恢复 |
| `POST /api/plans/daily-meals` | 生成今日三餐概览与DIY食谱 |
| `POST /api/plans/weekly` | 生成固定周一至周日的自然周计划提案，并保留已锁定日期和已确认记录 |
| `POST /api/menus/parse` | 解析菜单图片、文字或公开链接，返回完整条目、来源、完整性与个性化排序 |
| `GET /api/location/geocode` | 商圈/地址转高德坐标 |
| `GET /api/agent/tasks`、`POST /api/agent/tasks/complete` | 查询与完成主动任务 |
| `POST /api/agent/tasks/accept`、`POST /api/agent/tasks/dismiss`、`POST /api/agent/tasks/snooze` | 接受、忽略或稍后处理主动任务 |
| `GET/POST /api/agent/memory` | 查询或写入 Agent 记忆事件 |
| `POST /api/agent/review` | 基于体重趋势与记录完整度的预算复盘调整 |
| `GET /api/agent/events` | SSE实时推送Agent任务 |
| `GET /api/agent/goals`、`GET /api/agent/executions` | 查询减脂目标状态与可追溯的 Agent 执行记录 |
| `GET /api/agent/logs`、`GET /api/agent/check` | 查询工具日志与当前 Agent 状态摘要 |

完整产品需求见 [PRD.md](./PRD.md)。

## 网站头像与图标

品牌头像采用浅绿底、深绿笑脸饭碗和嫩芽，应用于登录页、侧栏、建档页、浏览器标签和移动端主屏幕。内置 image_gen 生成的原图保存在 `assets/xiaofan-avatar.png`，完整提示词在 `assets/xiaofan-avatar-prompt.txt`；`npm run icons:build` 生成 512px/192px 图标、180px Apple touch icon、32px PNG favicon 和 16/32/48px ICO。公开资源由白名单控制，Service Worker 缓存版本同步升级。

菜单完整条目仍保留；单次菜单的营养排序最多比较前12个符合偏好的条目，批量餐馆查询限制营养计算数量，未计算部分显示待确认，不编造热量。
