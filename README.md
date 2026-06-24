# TCL计划Agent

TCL计划Agent 是一个“个人任务规划Agent”Demo。它不替用户编造任务，所有任务、说明和截止日期都由用户自己输入；Agent 只负责基于真实任务做 AI 拆解、问答辅助、进度追踪和真实总结。

核心流程：

```text
输入任务 → AI拆解 → 手动修改步骤 → 勾选完成 → AI提问 → 自动总结
```

## 功能模块

- AI配置：支持 DeepSeek、OpenAI、自定义 OpenAI 兼容接口，API Key 由用户在网页中自行填写并保存在浏览器 localStorage。
- 添加任务：用户输入任务名称、说明、任务类型和截止日期。
- 三栏任务列表：今天要做、近期推进、长期追踪。
- AI拆解：点击任务卡片的 `AI拆解`，前端调用 `/api/decompose`。
- 本地示例拆解：未配置AI时可演示，但明确显示 `本地示例，不是AI结果`。
- 步骤编辑：支持勾选完成、修改名称、删除、新增、上移、下移。
- 问问Agent：基于当前任务调用 `/api/ask`，支持按任务保存的多轮对话和连续追问。
- 每日总结：基于真实日志生成今天新增任务、完成步骤、完成任务、未完成任务、明天建议。
- 本周总结：基于真实日志统计完成任务数、完成步骤数、延期任务、长期任务推进情况、下周建议。
- 可视化与总结：每次勾选/取消勾选步骤都会记录 `taskId`、`stepId`、`taskType`、`date`、`completed`，每日概览、最近7天趋势、本周总结、本月总结都基于这些真实记录生成。
- 今日监督分享卡：只展示日期、任务/步骤完成数量、短期/长期推进步数、完成率和鼓励语，不展示任务名称、说明、具体步骤或截止日期；支持复制分享文字和生成分享图片。

## 运行方式

```bash
npm install
npm run dev
```

`npm run dev` 会同时启动：

- 前端 Vite：`http://localhost:5173`
- 后端 Express：`http://127.0.0.1:8787`

React 前端只调用：

- `POST /api/decompose`
- `POST /api/ask`

## AI配置方式

页面中填写：

- Provider
- API Key
- Base URL
- Model

保存后会写入当前浏览器的 localStorage，方便下次打开继续使用。API Key 不会写死在代码里，也不会提交到仓库。

部署到 Vercel 后，浏览器会把当前用户填写的配置随 `/api/decompose`、`/api/ask` 请求发送给本站 Serverless Function，再由 Serverless Function 调用对应模型服务。这样页面不依赖 localhost，也避免浏览器直接请求第三方模型接口时遇到 CORS 问题。

## DeepSeek 接入

推荐配置：

```text
Provider: DeepSeek
Base URL: https://api.deepseek.com
Model: deepseek-v4-flash
API Key: 填写你自己的 DeepSeek Key
```

后端会调用：

```text
https://api.deepseek.com/chat/completions
```

## OpenAI 接入

推荐配置：

```text
Provider: OpenAI
Base URL: https://api.openai.com/v1
Model: gpt-4.1-mini
API Key: 填写你自己的 OpenAI Key
```

后端会调用：

```text
https://api.openai.com/v1/chat/completions
```

## 自定义模型接入

如果公司内部模型或第三方网关兼容 OpenAI Chat Completions 协议，可以选择：

```text
Provider: 自定义OpenAI兼容接口
Base URL: 你的服务地址
Model: 你的模型名称
API Key: 你的访问密钥
```

无需修改前端代码或后端调用逻辑。

## API架构说明

本地 Express 后端文件：

```text
server/index.js
```

Vercel Serverless API 文件：

```text
api/decompose.js
api/ask.js
api/aiClient.js
```

核心接口：

- `POST /api/decompose`：根据任务名称、说明、类型和截止日期，请大模型返回 5-8 个可执行步骤。
- `POST /api/ask`：结合当前任务、已有步骤和历史 `messages` 回答用户问题。

拆解提示词要求：

```text
你是任务拆解助手。
请根据用户任务名称和说明。
把任务拆解成5-8个可执行步骤。
不要按日期拆解。
不要生成时间安排。
步骤要能被勾选完成。
只返回JSON。
```

返回格式：

```json
{
  "steps": ["步骤1", "步骤2", "步骤3"]
}
```

问问Agent请求格式：

```json
{
  "task": "当前任务对象",
  "messages": [
    { "role": "user", "content": "第一个问题" },
    { "role": "assistant", "content": "第一个回答" },
    { "role": "user", "content": "追问内容" }
  ]
}
```

## localStorage 保存逻辑

localStorage 会保存以下浏览器本地数据：

- 任务
- 步骤
- 完成状态
- 步骤完成记录：包含任务、步骤、任务类型、日期、完成/取消状态
- 按任务保存的多轮聊天记录
- AI配置：Provider、API Key、Base URL、Model、是否已配置Key
- 总结记录所需日志

API Key 由用户主动填写并保存在自己的浏览器 localStorage 中，不会写死在项目代码里。请只在可信设备上使用自己的 Key；如需清除，可在浏览器开发者工具中清理本站 localStorage。

## 部署到 Vercel

1. 确认本地可构建：

```bash
npm install
npm run build
```

2. 推送代码到 GitHub、GitLab 或 Bitbucket。

3. 在 Vercel 新建 Project，选择该仓库。

4. Vercel 配置保持默认即可：

```text
Framework Preset: Vite
Build Command: npm run build
Output Directory: dist
Install Command: npm install
```

项目已提供 `vercel.json`，会明确使用 `dist` 作为输出目录，并把非 API 路径回退到 React 入口。

5. 部署完成后打开 Vercel 域名，在页面 `AI配置` 中填写自己的 Provider、API Key、Base URL、Model。

6. 点击 `保存到浏览器`。之后用户在同一个浏览器再次打开页面，会继续使用自己的 localStorage 配置。

注意：最终部署入口是 React/Vite 的 `index.html` 和 `src/main.jsx`。仓库中的 `demo.html` 只是历史本地演示页，不作为 Vercel 的主入口。

## 无AI配置时

页面会显示：

```text
未配置AI服务。
```

此时可点击 `本地示例拆解`，但系统会明确提示：

```text
本地示例，不是AI结果
```

## 默认数据

页面默认没有任务、没有虚假统计、没有预设任务、没有成长记录。所有任务都必须由用户创建。
