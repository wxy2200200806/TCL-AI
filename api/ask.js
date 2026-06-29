import { callChatCompletions, parseJsonContent, readJson, sendJson } from './aiClient.js';

const INTENT_SYSTEM_PROMPT = `你是一个个人计划 Agent。你需要理解用户自然语言，判断用户是想创建任务、修改任务、查询任务、生成总结，还是普通咨询。不要编造任务。创建任务时只生成任务草稿，必须等待用户确认。请优先返回严格 JSON。

只返回 JSON，不要返回 Markdown。JSON 格式：
{
  "intent": "create_task | modify_task | query_task | ask | generate_summary | feedback_progress | unknown",
  "taskDraft": {
    "title": "",
    "description": "",
    "type": "today | short | long",
    "deadline": ""
  },
  "answer": "",
  "reply": ""
}

规则：
- 如果用户想新增/安排/记录一个任务，intent 使用 create_task，并填写 taskDraft。
- 创建任务时 taskDraft 只是草稿，不要说已创建。
- 如果关键信息缺失，在 reply 中只追问一个最重要的问题。
- deadline 尽量返回 YYYY-MM-DD；无法确定时返回空字符串并追问。
- 普通咨询使用 ask，并在 answer 中直接回答。
- 修改任务、查询任务、总结、反馈进度分别使用对应 intent，并在 answer 或 reply 中说明需要用户确认或补充的信息。`;

export default async function handler(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method Not Allowed' });

  try {
    const { mode, question, task, tasks = [], messages = [], config } = await readJson(req);
    if (!question && !messages.length) return sendJson(res, 400, { error: '问题不能为空' });

    if (mode === 'intent') {
      const taskContext = tasks.map((item, index) => ({
        index: index + 1,
        id: item.id,
        name: item.name,
        type: item.type,
        deadlineDate: item.deadlineDate,
        status: item.status,
        progress: `${(item.steps || []).filter((step) => step.done).length}/${(item.steps || []).length}`
      }));
      const chatMessages = [
        { role: 'system', content: INTENT_SYSTEM_PROMPT },
        { role: 'user', content: `今天日期：${new Date().toISOString().slice(0, 10)}\n当前任务列表：${JSON.stringify(taskContext)}\n用户最新输入：${question}` },
        ...messages
          .filter((message) => ['user', 'assistant'].includes(message.role) && message.content)
          .slice(-10)
          .map((message) => ({ role: message.role, content: message.content }))
      ];

      const data = await callChatCompletions(config, chatMessages, true);
      const content = data.choices?.[0]?.message?.content || '{}';
      const result = normalizeIntentResult(parseJsonContent(content));
      return sendJson(res, 200, { result });
    }

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

function normalizeIntentResult(result) {
  const intent = result.intent || 'unknown';
  const draft = result.taskDraft || {};
  return {
    intent,
    taskDraft: intent === 'create_task' ? {
      title: draft.title || draft.name || '',
      description: draft.description || '',
      type: ['today', 'short', 'long'].includes(draft.type) ? draft.type : 'today',
      deadline: draft.deadline || draft.deadlineDate || ''
    } : null,
    answer: result.answer || '',
    reply: result.reply || result.answer || ''
  };
}
