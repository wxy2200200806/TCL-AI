import { callChatCompletions, parseJsonContent, readJson, sendJson } from './aiClient.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method Not Allowed' });

  try {
    const { task, config } = await readJson(req);
    if (!task?.name && !task?.title) return sendJson(res, 400, { error: '任务不能为空' });

    const messages = [
      {
        role: 'system',
        content: '你是任务拆解助手。请根据用户任务名称和说明，把任务拆解成5-8个可执行步骤。不要按日期拆解。不要生成时间安排。步骤要能被勾选完成。只返回JSON，格式：{"steps":["步骤1","步骤2","步骤3"]}'
      },
      {
        role: 'user',
        content: `任务名称：${task.name || task.title}\n任务说明：${task.description || '无'}\n任务类型：${task.typeLabel || task.type || '未设置'}\n截止日期：${task.deadlineDate || task.deadline || '未设置'}`
      }
    ];

    const data = await callChatCompletions(config, messages, true);
    const parsed = parseJsonContent(data.choices?.[0]?.message?.content || '');
    if (!Array.isArray(parsed.steps)) throw new Error('AI返回格式不正确');
    return sendJson(res, 200, { steps: parsed.steps.slice(0, 8) });
  } catch (error) {
    return sendJson(res, 500, { error: error.message || 'AI拆解失败' });
  }
}
