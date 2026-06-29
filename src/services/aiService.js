export async function decomposeTaskWithAI(task, config) {
  const response = await fetch('/api/decompose', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ task, config })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'AI拆解失败');
  return data.steps;
}

export async function askAgent(question, task, messages = [], config) {
  const response = await fetch('/api/ask', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question, task, messages, config })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'AI回答失败');
  return data.answer;
}

export async function fetchModelList(config) {
  const response = await fetch('/api/models', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ config })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '模型列表拉取失败');
  return data.models;
}

export function localExampleDecompose(task) {
  const base = [
    '明确任务目标和最终交付物',
    '收集完成任务所需资料',
    '整理关键信息和约束条件',
    '完成主要内容初稿',
    '检查遗漏和风险点',
    '修改并确认最终结果'
  ];
  if (task.type === 'long') {
    return [
      '明确长期任务的阶段目标',
      '收集背景资料和关键输入',
      '拆出主要工作模块',
      '完成第一个可验证产出',
      '检查当前产出和问题清单',
      '整理阶段成果并准备下一步'
    ];
  }
  return base;
}
