import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, '.env');
dotenv.config({ path: envPath });

const app = express();
const port = Number(process.env.PORT || 8787);

app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/config', (_req, res) => {
  const config = readConfig();
  res.json({
    provider: config.provider,
    baseUrl: config.baseUrl,
    model: config.model,
    hasApiKey: Boolean(config.apiKey)
  });
});

app.post('/api/config', (req, res) => {
  const { provider, apiKey, baseUrl, model } = req.body || {};
  const previous = readConfig();
  const next = {
    provider: provider || 'DeepSeek',
    apiKey: apiKey || previous.apiKey || '',
    baseUrl: baseUrl || providerBaseUrl(provider),
    model: model || ''
  };
  writeEnv(next);
  Object.assign(process.env, {
    AI_PROVIDER: next.provider,
    AI_API_KEY: next.apiKey,
    AI_BASE_URL: next.baseUrl,
    AI_MODEL: next.model
  });
  res.json({ ok: true, hasApiKey: Boolean(next.apiKey), provider: next.provider, baseUrl: next.baseUrl, model: next.model });
});

app.post('/api/decompose', async (req, res) => {
  const { task, config: requestConfig } = req.body || {};
  if (!task?.name && !task?.title) return res.status(400).json({ error: '任务名称不能为空' });
  const config = normalizeConfig(requestConfig || readConfig());
  if (!config.apiKey) return res.status(400).json({ error: '未配置AI服务' });

  const messages = [
    {
      role: 'system',
      content: '你是任务拆解助手。请根据用户任务名称和说明，把任务拆解成5-8个可执行步骤。不要按日期拆解。不要生成时间安排。步骤要能被勾选完成。只返回JSON，格式：{"steps":["步骤1","步骤2","步骤3"]}'
    },
    {
      role: 'user',
      content: `任务名称：${task.name || task.title}\n任务说明：${task.description || '无'}\n任务类型：${task.typeLabel || task.type}\n截止日期：${task.deadlineDate || task.deadline || '未设置'}`
    }
  ];

  try {
    const data = await callChatCompletions(config, messages, true);
    const parsed = parseJsonContent(data);
    if (!Array.isArray(parsed.steps)) throw new Error('AI返回格式不正确');
    res.json({ steps: parsed.steps.slice(0, 8) });
  } catch (error) {
    res.status(500).json({ error: error.message || 'AI拆解失败' });
  }
});

app.post('/api/ask', async (req, res) => {
  const { question, task, messages = [], config: requestConfig } = req.body || {};
  if (!question && !messages.length) return res.status(400).json({ error: '问题不能为空' });
  const config = normalizeConfig(requestConfig || readConfig());
  if (!config.apiKey) return res.status(400).json({ error: '未配置AI服务' });

  const chatMessages = [
    { role: 'system', content: '你是个人任务规划Agent。回答必须结合当前任务，避免臆想，不确定时说明需要用户补充信息。' },
    { role: 'user', content: `当前任务：${task?.name || task?.title || '未选择任务'}\n任务说明：${task?.description || '无'}\n已有步骤：${(task?.steps || []).map((step, index) => `${index + 1}. ${step.title}`).join('\n') || '暂无'}` },
    ...messages.filter((message) => ['user', 'assistant'].includes(message.role)).map((message) => ({ role: message.role, content: message.content }))
  ];

  try {
    const data = await callChatCompletions(config, chatMessages, false);
    res.json({ answer: data.choices?.[0]?.message?.content || 'AI没有返回内容。' });
  } catch (error) {
    res.status(500).json({ error: error.message || 'AI回答失败' });
  }
});

app.listen(port, () => {
  console.log(`TCL计划Agent API server running at http://127.0.0.1:${port}`);
});

function readConfig() {
  dotenv.config({ path: envPath, override: true });
  return {
    provider: process.env.AI_PROVIDER || 'DeepSeek',
    apiKey: process.env.AI_API_KEY || '',
    baseUrl: process.env.AI_BASE_URL || providerBaseUrl(process.env.AI_PROVIDER),
    model: process.env.AI_MODEL || 'deepseek-v4-flash'
  };
}

function normalizeConfig(config = {}) {
  return {
    provider: config.provider || 'DeepSeek',
    apiKey: config.apiKey || '',
    baseUrl: config.baseUrl || providerBaseUrl(config.provider),
    model: config.model || 'deepseek-v4-flash'
  };
}

function writeEnv(config) {
  const lines = [
    `AI_PROVIDER=${escapeEnv(config.provider)}`,
    `AI_API_KEY=${escapeEnv(config.apiKey)}`,
    `AI_BASE_URL=${escapeEnv(config.baseUrl)}`,
    `AI_MODEL=${escapeEnv(config.model)}`,
    `PORT=${port}`
  ];
  fs.writeFileSync(envPath, `${lines.join('\n')}\n`, 'utf8');
}

function providerBaseUrl(provider) {
  if (provider === 'OpenAI') return 'https://api.openai.com/v1';
  if (provider === 'DeepSeek') return 'https://api.deepseek.com';
  return '';
}

function escapeEnv(value = '') {
  return String(value).replace(/\n/g, '');
}

async function callChatCompletions(config, messages, jsonMode) {
  const base = config.baseUrl.replace(/\/$/, '');
  const endpoint = `${base}/chat/completions`;
  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        temperature: 0.2,
        ...(jsonMode ? { response_format: { type: 'json_object' } } : {})
      })
    });
  } catch (error) {
    throw new Error(`无法连接AI服务：${endpoint}。请检查网络、代理、防火墙、Base URL 是否可访问。原始错误：${error.message}`);
  }
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`AI服务调用失败：${response.status} ${text.slice(0, 200)}`);
  }
  return response.json();
}

function parseJsonContent(data) {
  const content = data.choices?.[0]?.message?.content || '';
  const cleaned = content.replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
  return JSON.parse(cleaned);
}
