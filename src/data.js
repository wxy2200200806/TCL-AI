export const TASK_TYPES = [
  { value: 'today', label: '今日任务', column: '今天要做', hint: '今天最好完成' },
  { value: 'short', label: '短期任务', column: '近期推进', hint: '未来1-14天推进' },
  { value: 'long', label: '长期任务', column: '长期追踪', hint: '超过14天持续推进' }
];

export const PROVIDERS = [
  { value: 'DeepSeek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash' },
  { value: 'OpenAI', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1-mini' },
  { value: 'Custom', label: '自定义OpenAI兼容接口', baseUrl: '', model: '' }
];

export const STORAGE_KEYS = {
  tasks: 'tcl-plan-agent:v2:tasks',
  activityLog: 'tcl-plan-agent:v2:activity-log',
  stepRecords: 'tcl-plan-agent:v2:step-records',
  aiConfigMeta: 'tcl-plan-agent:v2:ai-config-meta',
  chatMessages: 'tcl-plan-agent:v2:chat-messages',
  summaries: 'tcl-plan-agent:v2:summaries'
};
