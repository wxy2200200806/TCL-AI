import { callChatCompletions, readJson, sendJson } from './aiClient.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method Not Allowed' });

  try {
    const { question, task, messages = [], config } = await readJson(req);
    if (!question && !messages.length) return sendJson(res, 400, { error: '问题不能为空' });

    const chatMessages = [
      { role: 'system', content: '你是个人任务规划Agent。回答必须结合当前任务和历史对话，避免臆想，不确定时说明需要用户补充信息。' },
      { role: 'user', content: `当前任务：${task?.name || task?.title || '未选择任务'}\n任务说明：${task?.description || '无'}\n已有步骤：${(task?.steps || []).map((step, index) => `${index + 1}. ${step.title}`).join('\n') || '暂无'}` },
      ...messages
        .filter((message) => ['user', 'assistant'].includes(message.role) && message.content)
        .map((message) => ({ role: message.role, content: message.content }))
    ];

    const data = await callChatCompletions(config, chatMessages, false);
    return sendJson(res, 200, { answer: data.choices?.[0]?.message?.content || 'AI没有返回内容。' });
  } catch (error) {
    return sendJson(res, 500, { error: error.message || 'AI回答失败' });
  }
}
