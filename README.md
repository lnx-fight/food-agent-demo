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

网址于 2026-10-16 更换为 `xiaofan-food.pages.dev`，继续使用同一个 D1；由于浏览器 Cookie 和本机暂存按域名隔离，新网址需要独立的浏览器使用凭证，尚未同步的旧网址本机修改需先在旧网址完成同步。

项目及数据库编号等非敏感配置位于 `cloudflare/project.json`。`.github/workflows/cloudflare.yml` 对 push 和 PR 执行语法检查、Node 回归测试、真实 workerd/D1 集成测试、食药署导入校验和 30 条 Agent 数据集结构校验；只有 `main` 的 CI 通过，才下载同一次 CI 的构建产物、执行版本化 D1 迁移并发布 Pages。PR 和其他分支不部署生产环境，也不连接生产数据库。生产部署串行执行，发布后检查 `/api/health` 的食药署食品与营养明细数量。

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

初始化迁移 `migrations/0001_schema.sql` 创建业务表；`0007_tfda_schema.sql` 和 `0008_tfda_snapshot_*.sql` 导入食药署快照，`0009_tfda_activate.sql` 校验食品及营养明细数量后删除 USDA 表和搜索索引。当前仓库已移除旧 USDA 的 `0004_usda_snapshot.sql` 数据文件，既有 D1 中已经执行的迁移记录保留，新数据库跳过这份已停用快照。其他已发布的 schema/cleanup 迁移保持历史原状；后续数据更新须新增迁移。账号、历史确认的饮食、体重、对话及原始来源字段不重算、不删除。本地账号不会自动上传线上。旧密码哈希只作为历史数据保留，密码接口已停用；新使用空间不创建可登录的密码。

Pages 采用请求触发的提醒检查和约一分钟重连的 SSE 快照，不运行常驻 Node 定时器；没有浏览器请求时不会定时推送，跨实例不共享内存 SSE 连接。生产 D1 备份应使用 Cloudflare 导出或 Time Travel；`scripts/manage-data.mjs` 仅管理本地 SQLite。回滚 Pages 代码不会回滚数据库；数据库迁移应向后兼容。

D1 免费套餐当前提供每天 500 万行读取、10 万行写入和账号总计 5GB 存储；免费请求和 CPU 仍受 Pages Functions / Workers 限制，超额可能暂停服务。食药署完整明细按食品聚合为 JSON 保存，避免导入230,152条独立记录超出每日免费写入量；摘要与名称索引独立保存，普通检索无需读取完整明细。没有启用付费计划；千问、高德等外部服务按其自身规则计费。参见 [D1 定价](https://developers.cloudflare.com/d1/platform/pricing/)、[Pages Functions 定价](https://developers.cloudflare.com/pages/functions/pricing/)。

## 已导入的台湾食药署食品营养数据

唯一内置食品库为卫生福利部食品药物管理署的[食品营养成分资料集](https://data.gov.tw/dataset/8543)。原始官方 ZIP 位于 `data/tfda/source.zip`，SHA-256、来源、下载快照日期和迁移校验和位于 `data/tfda/manifest.json`。依据[政府资料开放授权条款第1版](https://data.gov.tw/license)使用并署名：**卫生福利部食品药物管理署，2026，食品营养成分资料集（小饭下载快照2026-10-20）。简体名称及检索别名由小饭整理。** 网站发现页及营养结果展示来源、署名和授权链接。

共 **2,213 个食品条目、230,152 条原始营养指标明细**，全部食品有可读取热量。`nutrition_foods` 保存简体名、繁体原名、英文名、原始俗名、样品描述和每100克可食部摘要；`nutrition_names` 建立名称/别名索引；`nutrition_nutrient_data` 按食品保存全部104项原始分析记录，包含单位、每100克含量、样本数、标准差及原始单位重/单位含量。空值保留为未知，明确的0仍是0；没有有效克重的“每单位”资料不用于按份换算。

摘要优先读取官方“修正熱量”kcal，缺少时才读取“熱量”kcal，同时保留两种原值与能量口径，不按4/4/9自行覆盖官方数据。例如 `tfda:A0550601` 白饭为182 kcal/100g（修正热量），其原始“熱量”为183；蛋白质3.1g。地区配方和含水量不同，不以旧USDA米饭130 kcal替换本快照数值。

`nutrition-names.mjs` 使用固定版 OpenCC 进行简繁转换；`data/tfda/aliases.json` 只增加核对过的名称与整合编号，不存营养值。“米饭/白飯”“土豆/馬鈴薯”“西红柿/红番茄”“鸡胸肉/去皮清肉平均值”可直接查询，显示匹配的完整样品名和生熟提示。中文名称及完整英文原名均在本地查询，不调用千问或USDA API。旧 `fdc:` 查询明确提示数据已移除。

本库主要为食材、加工食品及部分成品，**没有回锅肉等完整中餐菜单覆盖**。肉粽、冷冻虾仁炒饭可按原名直接读取；“虾仁炒饭”不能自动套用冷冻包装产品，“麻婆豆腐”不能套用麻婆酱，“牛肉汉堡”不能套用冷冻汉堡肉或面包。官方“汉堡包”条目实际为面包，结果会明确提示不包含夹馅。生熟、冷冻和配方限定不通过删词隐藏，不将整菜降为单一食材估值。

重建快照：`npm run data:download -- --offline`。原包校验不一致时脚本拒绝导入；数据更新需人工审阅并新增迁移，不覆盖已经部署的快照。脚本通过22个小于1MB的迁移文件准备完整数据；最后数量校验通过后才删除旧USDA表。图片识别、DIY、菜单、文字记餐和 Agent 营养 Tool 均改读食药署。用户仍可按实际包装标签手动记录。

API示例：`/api/nutrition/search?q=米饭`、`/api/nutrition/search?q=tfda:R0400101`；`/api/nutrition/details?q=tfda:A0550601` 返回完整104项原始营养明细及简体指标名称。网站的食品名、样品说明、能量口径（`energyBasisLabel`）、营养指标和营养查询对话统一显示简体，不展示繁体原名；繁体输入仍可检索。原始字段与官方快照仅用于追溯，数值不因文字转换而变化。这些接口均要求有效的浏览器使用凭证。历史记录保留原来的数值和来源，包括旧USDA引用；不再作为新查询的数据源。升级前已备份本地数据库。切换后回滚旧代码需同时恢复相应食品数据库，优先修复前进。

## 发布面试演示到 GitHub Pages

本仓库根目录已包含静态入口文件，GitHub Pages 会自动启用面试演示模式：页面不请求 `/api/*`，以预置响应演示餐厅、计划和 Agent 对话；真实食药署查询、图片分析和按食材生成食谱需要登录正式服务，演示模式不再提供虚构营养查值。

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
AMAP_WEB_SERVICE_KEY=...     # 可选：附近餐馆
```

部署成功后，先访问 `https://<服务名>.onrender.com/api/health`；确认返回 `ok: true` 后，再把本 README “在线体验”中的占位链接换成该地址并推送到 GitHub。之后每次推送默认分支，Render 会自动重新部署。

公开服务的静态资源由 `public-files.mjs` 白名单控制，只提供网页、脚本和样式；`.env`、Git 文件、服务端源码、SQLite 数据库及其他个人文件不对外提供。新增浏览器资源时，需要同步更新该白名单及适用的 PWA 缓存列表。公开托管时只上传产品源码，勿上传本地 `.env`、数据库、备份和个人文件。完整功能版的业务接口使用浏览器会话隔离数据，无需账号密码，服务器根据凭证确定数据所属空间，不信任客户端传入的 `clientId`。

Render 默认文件系统是临时的；没有持久磁盘时，账号、密码哈希、会话和用户记录都会随重启或部署丢失。不得用临时文件系统承载正式账号。当前 SQLite 方案只运行单个服务实例；需要多实例时应迁移到共享数据库。食药署数据首次启动由版本化快照初始化，账号和用户记录保存在持久目录中。参见 [Render 持久磁盘说明](https://render.com/docs/disks)。

线上必须通过 HTTPS 访问，生产环境会话 Cookie 强制 `Secure`。可设置 `PUBLIC_ORIGIN=https://实际域名` 固定可信来源，不能带结尾斜杠；自定义域名切换时同步修改。写接口同时验证来源、自定义请求头和 JSON 类型；不要开放通配 CORS。只有确认代理会覆盖 `X-Forwarded-For` 时才启用 `TRUST_PROXY=true`，否则使用空间创建限流按直接连接地址统计。

## 免账号使用与数据保存

网站不再提供用户名/密码注册、登录、改密码和退出入口。每次打开均先显示可自由浏览的公开内容，不弹个人资料表单、不读取个人缓存或调用个人接口；即使有旧会话，也等点击“开始使用”或具体功能后才加载已有记录，首次使用才进入个人档案设置。后台签发随机的180天 HttpOnly、SameSite=Strict 浏览器凭证，生产环境启用 Secure；访问产品时续期，不将身份凭证写入本机存储、导出或网页。

个人数据与此浏览器的凭证绑定，在服务器 SQLite / D1 保存，并在本机暂存。不同浏览器的身份独立；查询参数或请求体中的 clientId 不能认领别人的历史数据。保存仍有版本锁与冲突副本，防止多个标签页静默覆盖。公开浏览不创建个人空间。连接失败可以继续浏览并重试，Cookie被禁用时明确提示。

侧栏“我的数据”保留导出、同步重试、冲突处理及清空/删除。清空和删除需要指定确认文字，由有效浏览器凭证限定范围，不再要求密码。删除会撤销旧会话并清理对应档案、记录及派生数据；导出不包含凭证。

无需数据库迁移，旧账号及历史数据不删除、不重算；旧有效Cookie自动延续原档案。没有有效Cookie的旧账号不能再用用户名密码恢复，也不能凭旧clientId认领。清除浏览器数据、凭证过期、无痕窗口关闭或更换设备后，无法自动恢复原使用空间，请及时导出。当前不提供跨设备身份恢复或导入备份功能。原本机暂存保留，不自动混入新空间。

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
AMAP_WEB_SERVICE_KEY=...    # 高德附近餐馆POI
QWEN_EMBED_MODEL=text-embedding-v3 # 可选：语义记忆嵌入模型
AGENT_MAX_TOOL_ROUNDS=6     # 可选：单次Agent执行的最大工具轮次
```

`QWEN_VISION_MODEL` 与 `QWEN_WEB_MODEL` / `QWEN_CHAT_MODEL` 职责分离：上传餐食图片时仅调用视觉模型，文字对话与联网检索继续调用文本模型。修改 `.env` 后需重启 `npm start` 才会生效。

`/api/health` 会返回千问、食药署数据和高德的配置状态。未配置千问时，Agent 对话和图片识别会明确报出服务未配置；DIY 食谱和今日三餐计划则会降级为基于 食药署食材数据的确定性规则建议，并在界面标记为“规则建议”。

当前可真实操作：

- 创建和评估自己的目标；
- 生成并确认按 Asia/Shanghai 时区组织的周一至周日自然周计划；每个未执行餐次直接展示含食材份量、步骤和耗时的在家食谱，用户授权位置或输入地点后可一次补全整周真实附近门店与具体餐食；周中首次建档不会补写过去日期，周日会生成下周提案，确认后在周一自动生效；
- 锁定自然周基准安排；每次确认记餐后自动刷新当天未执行餐次，晚餐确认、点击“结束今天”或跨日后再温和更新未来日期；
- 在“今日”查看 Agent 当前判断的下一最佳行动，并从周计划直接进入下一餐决策；
- 记录、更新每日体重；
- 手动、拍照记录、修改和删除饮食，并在确认后更新当日预算；
- 使用家中现有食材生成动态DIY食谱，并由 食药署营养数据校验食材克数、热量和三大营养素；
- 根据真实档案计算BMI、目标BMI、计划速度、基础能量估算和蛋白质参考值；
- 让Agent通过真实千问模型读取当前档案、最近对话及历史记录回答问题；
- 通过唯一的 `next-meal-decision` Skill 处理复杂下一餐决策；计划滚动更新由确定性状态机负责，不依赖模型生成计划补丁；
- 保存每轮 Agent 的目标、执行步骤、工具结果和待确认状态，并在“工具日志”中查看近期执行记录；
- 根据时间、未记录餐次和目标进度创建主动任务，通过 SSE 推送到当前浏览器；基于体重趋势和记录完整度进行每日复盘；
- 查询本地SQLite营养库；
- 唯一内置营养数据集为2,213条食药署食品和230,152条营养明细，支持简繁体、英文原名及常见别名；USDA和旧估算库已移除；
- 配置阿里云百炼千问后进行真实图片食物识别；中文营养检索独立于模型服务；
- 配置高德后使用浏览器定位查询真实附近餐馆；
- 对用户上传的菜单图片、粘贴的菜单文字或公开菜单链接进行按需完整解析，保留分类、菜名、价格、来源与完整性状态，再按当前餐次预算排序；
- 优先使用高德POI `business.tag` 返回的特色菜；没有特色菜时使用千问联网检索核验公开菜单，仍无法确认才明确降级为“按店型推荐”；
- 外食推荐会读取当前减脂计划和今日摄入，匹配 食药署食品记录，以单一近似热量、蛋白质、距离、口味和忌口进行个性化排序；
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

本地食药署数据与用户状态位于 `data/nutrition.sqlite`，线上使用 D1。启动时清理旧食品估算表，食药署首次按迁移初始化，后续不覆盖用户记录。中文检索映射只保存名称和食药署整合编号，营养值始终读取食药署。图片识别、菜单解析和附近餐馆在配置密钥后调用真实接口；没有合适食药署条目时显示未匹配，不以单一食材或旧近似菜编造完整菜品营养。DIY 模型不可用时使用已匹配 食药署食材的规则模板。美团等交易平台未接入，任意餐馆菜单不保证实时完整，用户可提供菜单图片、文字或公开链接。

## Agent 评测

项目使用 `next-meal-decision` 处理下一餐决策。此前引入的 health-coach 饮食资料与375条社区食品参考记录已移除，营养查询仅使用食药署 及中文名称映射。服务启动时删除已停用的 `reference_foods` 表；已确认的用户饮食和体重记录继续保留。

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

除 `GET /api/health` 与浏览器会话初始化/查询外，所有业务接口都需要有效的浏览器 Cookie，不需要用户名密码。写接口要求 `Content-Type: application/json` 和 `X-Requested-With: Xiaofan`。`GET /api/user/state` 返回 `stateVersion`，保存时必须在 `X-State-Version` 中回传该值，冲突返回409。

| 接口 | 功能 |
|---|---|
| `GET/POST /api/device/session` | 查询/创建或续期浏览器使用空间，无需用户名密码 |
| `GET /api/device/export` | 导出当前浏览器的个人数据 |
| `POST /api/device/clear`、`POST /api/device/delete` | 校验浏览器凭证与确认文字，清空记录或删除使用空间 |
| `/api/auth/*`、`/api/account/*` | 账号密码功能已移除，返回410，旧客户端须刷新 |
| `GET /api/health` | 查看服务和密钥配置状态 |
| `GET /api/nutrition/search?q=`、`GET /api/nutrition/resolve?q=` | 食药署简繁体/英文自动匹配与 TFDA 整合编号精确读取 |
| `GET /api/nutrition/details?q=tfda:整合编号` | 完整营养明细、单位和样本资料 |
| `GET /api/nutrition/barcode/:code` | 已停用（410），可按包装标签手动输入 |
| `POST /api/nutrition/web-search` | 已停用（410），统一使用食药署 |
| `POST /api/meals/analyze` | 真实视觉识别并自动匹配食药署 |
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

品牌头像采用浅绿底、深绿笑脸饭碗和嫩芽，应用于发现页、侧栏、建档页、浏览器标签和移动端主屏幕。内置 image_gen 生成的原图保存在 `assets/xiaofan-avatar.png`，完整提示词在 `assets/xiaofan-avatar-prompt.txt`；`npm run icons:build` 生成 512px/192px 图标、180px Apple touch icon、32px PNG favicon 和 16/32/48px ICO。公开资源由白名单控制，Service Worker 缓存版本同步升级。

菜单完整条目仍保留；单次菜单的营养排序最多比较前12个符合偏好的条目，批量餐馆查询限制营养计算数量，未计算部分显示待确认，不编造热量。
