# 小饭 Demo

小饭是一个可从新用户建档开始使用的个人减脂 Agent Web Demo。它围绕“下一顿吃什么”持续读取用户目标、体重趋势、饮食记录与偏好，结合工具调用、动态预算、多模态输入和安全约束给出可确认的建议，而不是只提供一个聊天框。

## 在线体验

> 首次发布后，请在 GitHub 仓库的 **Settings → Pages** 中选择 `main` 分支和 `/(root)` 目录；GitHub 完成部署后即可访问。

[打开小饭面试演示](https://lnx-fight.github.io/food-agent-demo/)

演示覆盖 Skill 路由、餐食场景识别、端到端入口、多轮任务与受控 Tool 调用；相应评测脚本和用例位于 `scripts/` 与 `test/fixtures/`。GitHub Pages 版本会明确显示“面试演示模式”，所有数据保存在浏览器中，Agent、图片识别、营养检索和附近餐馆均为预置响应，不会调用外部 API 或暴露密钥。

它的核心用户是：有明确减重目标、希望通过饮食减重，但每天难以在热量限制内决定"下一顿吃什么"的人——他们需要小饭根据口味和忌口，算好可直接确认的下一餐答案。

## 运行方式

项目使用 Node.js 22 内置 HTTP 服务和 SQLite，无需安装第三方 npm 包：

```bash
npm start
```

然后访问 <http://localhost:8080>。如需调整端口，可在启动前设置 `PORT`。

## 发布面试演示到 GitHub Pages

本仓库根目录已包含静态入口文件，GitHub Pages 会自动启用面试演示模式：页面不请求 `/api/*`，而是使用前端预置响应完成 DIY 食谱、营养查询、餐厅推荐、图片记录和 Agent 对话的交互流程。

1. 将本次改动推送到 `main` 分支；
2. 打开 GitHub 仓库的 **Settings → Pages**；
3. 在 **Build and deployment** 中选择 **Deploy from a branch**；
4. Branch 选择 `main`，目录选择 `/(root)`，点击 **Save**；
5. 等待 GitHub 显示网址 `https://lnx-fight.github.io/food-agent-demo/`，打开后确认页面顶部出现“面试演示模式”。

该模式适合展示产品界面、受控流程与本地交互，不替代真实模型、视觉识别、位置服务或服务端持久化。若以后恢复完整在线服务，可继续使用下文的 Render 部署方案。

## 部署为在线 Demo（Render）

本项目由 `server.mjs` 同时提供网页和 `/api/*` 接口，因此应部署为 Render **Web Service**，而不是静态站点。仓库根目录已提供 `render.yaml`，可在 Render 中选择 **New → Blueprint** 并连接本 GitHub 仓库。

部署配置已预设为：Node.js 22、区域 Singapore、构建命令 `npm run check`、启动命令 `npm start`，健康检查路径 `/api/health`。创建服务时在 Render 控制台填写以下密钥，绝不要提交到 GitHub：

```text
DASHSCOPE_API_KEY=...        # 启用真实 Agent 对话、视觉识别与联网降级
USDA_API_KEY=...             # 可选：长尾食材查询
AMAP_WEB_SERVICE_KEY=...     # 可选：附近餐馆
```

部署成功后，先访问 `https://<服务名>.onrender.com/api/health`；确认返回 `ok: true` 后，再把本 README “在线体验”中的占位链接换成该地址并推送到 GitHub。之后每次推送默认分支，Render 会自动重新部署。

免费实例适合面试演示，但闲置 15 分钟后会休眠，首次访问可能需要等待；它的本地文件系统也不持久化，因此 SQLite 中的演示用户数据会在重启或重新部署后重置。若需保留数据，请使用付费实例并挂载磁盘，将 Render 环境变量 `DATA_DIR` 设为磁盘挂载目录（例如 `/var/data`）。基础食物数据 `data/foods.json` 每次启动都会自动初始化。

## 从新用户开始测试

首次访问会自动进入三步建档流程。档案、体重、饮食记录和对话会先保存在浏览器 `localStorage`，并以浏览器生成的 `clientId` 自动同步到服务端 SQLite；刷新页面或同一浏览器会话恢复时会尝试读取服务端状态。服务端不可用时，页面仍可使用本地已保存的数据。

侧边栏的“重新开始 / 清除本地数据”目前只清理当前浏览器的主要档案缓存，不会删除服务端已同步的用户状态或 `clientId`。若需要模拟完全的新用户，请清除该站点的浏览器存储（包括 `clientId`）或使用新的浏览器配置文件；服务端历史数据不会由此删除。

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

`/api/health` 会返回千问、USDA 和高德的配置状态。未配置千问时，Agent 对话和图片识别会明确报出服务未配置；DIY 食谱和今日三餐计划则会降级为基于本地营养库的确定性规则建议，并在界面标记为“规则建议”。

当前可真实操作：

- 创建和评估自己的目标；
- 记录、更新每日体重；
- 手动、拍照记录、修改和删除饮食，并在确认后更新当日预算；
- 使用家中现有食材生成动态DIY食谱，并由本地营养数据库校验食材克数、热量和三大营养素；
- 根据真实档案计算BMI、目标BMI、计划速度、基础能量估算和蛋白质参考值；
- 让Agent通过真实千问模型读取当前档案、最近对话及历史记录回答问题；
- 通过 Skill 路由识别“在家 DIY / 附近外食 / 场景待选择”等餐食场景，并由受控工具完成预算、营养、食谱和记忆查询；
- 保存每轮 Agent 的目标、执行步骤、工具结果和待确认状态，并在“工具日志”中查看近期执行记录；
- 根据时间、未记录餐次和目标进度创建主动任务，通过 SSE 推送到当前浏览器；基于体重趋势和记录完整度进行每日复盘；
- 查询本地SQLite营养库；
- 本地营养库包含300种常见食材、家常菜、早餐小吃、外卖快餐、零食饮料和调味料，以及96个中文别名；
- 本地未命中时查询USDA FoodData Central；
- 通过Open Food Facts查询包装食品条码；
- 配置阿里云百炼千问后进行真实图片食物识别与官方网页降级搜索；
- 配置高德后使用浏览器定位查询真实附近餐馆；
- 优先使用高德POI `business.tag` 返回的特色菜；没有特色菜时使用千问联网检索核验公开菜单，仍无法确认才明确降级为“按店型推荐”；
- 外食推荐会读取当前减脂计划和今日摄入，匹配本地菜品营养库，以单一近似热量、蛋白质、距离、口味和忌口进行个性化排序；
- 使用在家DIY与外食推荐流程；
- 在服务端同步可用时跨刷新恢复档案、记录、对话与 Agent 记忆。

## 建议演示流程

1. 在“今日”查看 Agent 对饮食记录、热量预算与推荐的工作轨迹；
2. 进入 Agent 对话，展示长期记忆和工具调用；
3. 点击“帮我选”，分别演示在家 DIY 和附近外食两条路径；
4. 在 Agent 对话中上传餐食图片，演示结构化单一近似热量、关键不确定性与确认入账；
5. 打开“工具日志”，查看 Skill、受控工具调用和目标执行轨迹；
6. 在“体重”页解释为什么 Agent 不会因单日波动机械调整计划。

## Agent设计

当前版本在配置千问后启用真实 LLM 与工具调用循环（`agentLoop`）：Router 识别意图和餐食场景 → 主 Agent 制定执行计划 → 选择 Skill 并调用受控工具（预算、DIY 食谱、餐馆、营养、记忆）→ 观察工具回传结果 → 必要时修正或继续 → 写入类动作生成确认提案，由用户确认后落库。每轮执行都会持久化目标与步骤，方便恢复和追溯。核心架构：

```text
Router + 主 Agent（意图理解、Skill 选择与编排）
  ├── 浏览器状态 + 服务端长期记忆（users / meal_logs / agent_memory）
  ├── 确定性工具：预算计算、营养解析、食谱实算
  ├── 计划调整、主动任务与安全规则（mealTargets / 复盘 / SSE）
  ├── 食物视觉识别工具（千问视觉模型）
  ├── 附近餐馆与公开菜单检索（高德 / 千问联网）
  ├── 受控写库：确认提案 → 用户确认 → 落库
  ├── 执行目标与步骤日志（agent_goals / agent_goal_steps / agent_logs）
  └── 健康安全规则层（年龄、极端目标、忌口）
```

营养基础数据与用户同步状态位于 `data/nutrition.sqlite`。服务每次启动都会从包含 300 条数据和 96 个中文别名的 `data/foods.json` 幂等同步基础食物数据，网页检索候选数据不会被该同步删除。图片识别和附近餐馆在配置密钥后调用真实接口。复杂菜品采用单一近似热量并说明误差来源，不做无依据的精确承诺；这些整理值适合 Demo 估算，不能代替权威营养标签或医疗建议。DIY 在模型不可用时会使用规则模板；餐馆具体菜单尚未接入美团等交易平台。

## 后端API

| 接口 | 功能 |
|---|---|
| `GET /api/health` | 查看服务和密钥配置状态 |
| `GET /api/nutrition/search?q=`、`GET /api/nutrition/resolve?q=` | 本地库 → USDA → 官方网页候选的营养查询 |
| `GET /api/nutrition/barcode/:code` | Open Food Facts条码查询 |
| `POST /api/nutrition/web-search` | 受控官方网页检索并写入候选库 |
| `POST /api/meals/analyze` | 真实视觉识别并匹配本地营养库 |
| `POST /api/recipes/diy` | 匹配现有食材、生成DIY食谱并由服务端计算营养 |
| `POST /api/agent/chat` | 使用真实LLM结合用户状态和最近对话生成回答与受控动作 |
| `GET /api/restaurants/nearby` | 定位坐标转换及高德周边POI |
| `POST /api/restaurants/recommendations` | 核验公开菜单并生成真实菜单/店型降级推荐 |
| `GET/PUT /api/user/state` | 用户档案、饮食、体重、聊天历史的服务器落库与恢复 |
| `POST /api/plans/daily-meals` | 生成今日三餐概览与DIY食谱 |
| `GET /api/location/geocode` | 商圈/地址转高德坐标 |
| `GET /api/agent/tasks`、`POST /api/agent/tasks/complete` | 查询与完成主动任务 |
| `POST /api/agent/tasks/accept`、`POST /api/agent/tasks/dismiss` | 接受或忽略主动任务 |
| `GET/POST /api/agent/memory` | 查询或写入 Agent 记忆事件 |
| `POST /api/agent/review` | 基于体重趋势与记录完整度的预算复盘调整 |
| `GET /api/agent/events` | SSE实时推送Agent任务 |
| `GET /api/agent/goals`、`GET /api/agent/executions` | 查询减脂目标状态与可追溯的 Agent 执行记录 |
| `GET /api/agent/logs`、`GET /api/agent/check` | 查询工具日志与当前 Agent 状态摘要 |

完整产品需求见 [PRD.md](./PRD.md)。
