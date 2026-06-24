export function resolveConfig(config = {}) {
  const env = globalThis.process?.env || {};
  return {
    provider: config.provider || env.AI_PROVIDER || 'Custom',
    apiKey: config.apiKey || env.AI_API_KEY || '',
    baseUrl: config.baseUrl || env.AI_BASE_URL || '',
    model: config.model || env.AI_MODEL || ''
  };
}

export async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

export async function callChatCompletions(configInput, messages, jsonMode = false) {
  const config = resolveConfig(configInput);
  if (!config.apiKey || !config.baseUrl || !config.model) {
    throw new Error('未配置AI服务。请在页面中填写 Provider、API Key、Base URL 和 Model。');
  }

  const endpoint = `${config.baseUrl.replace(/\/$/, '')}/chat/completions`;
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
    throw new Error(`无法连接AI服务：${endpoint}。请检查 Base URL、网络或模型服务状态。原始错误：${error.message}`);
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`AI服务调用失败：${response.status} ${text.slice(0, 240)}`);
  }

  return response.json();
}

export function parseJsonContent(content) {
  const cleaned = String(content || '').replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
  return JSON.parse(cleaned);
}

export function sendJson(res, statusCode, data) {
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(data));
}
