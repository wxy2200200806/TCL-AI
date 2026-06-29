import { readJson, resolveConfig, sendJson } from './aiClient.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method Not Allowed' });

  try {
    const { config: inputConfig } = await readJson(req);
    const config = resolveConfig(inputConfig);
    if (!config.apiKey || !config.baseUrl) {
      return sendJson(res, 400, { error: '请先填写 API Key 和 Base URL。' });
    }

    const endpoint = `${config.baseUrl.replace(/\/$/, '')}/models`;
    const response = await fetch(endpoint, {
      method: 'GET',
      headers: { authorization: `Bearer ${config.apiKey}` }
    });
    if (!response.ok) {
      const text = await response.text();
      return sendJson(res, response.status, { error: `模型列表拉取失败：${response.status} ${text.slice(0, 200)}` });
    }

    const data = await response.json();
    const models = Array.isArray(data.data) ? data.data.map((item) => item.id).filter(Boolean) : [];
    return sendJson(res, 200, { models });
  } catch (error) {
    return sendJson(res, 500, { error: error.message || '模型列表拉取失败' });
  }
}
