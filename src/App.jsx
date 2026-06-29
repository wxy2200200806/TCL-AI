import { useEffect, useMemo, useRef, useState } from 'react';
import { PROVIDERS, STORAGE_KEYS, TASK_TYPES } from './data.js';
import { askAgent, decomposeTaskWithAI, localExampleDecompose } from './services/aiService.js';
import {
  buildCompletionAnalytics,
  buildMonthlyRecordSummary,
  buildShareStats,
  buildWeeklyRecordSummary,
  createTask,
  getDaysLeft,
  getDaysText,
  getNextStep,
  getProgress,
  getTaskTypeLabel,
  loadJson,
  logEvent,
  saveJson,
  stepsFromTitles,
  todayISO,
  updateTaskAutoStatus
} from './utils.js';

const emptyTaskForm = {
  name: '',
  description: '',
  type: 'today',
  deadlineDate: ''
};

const defaultConfig = {
  provider: 'DeepSeek',
  apiKey: '',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-v4-flash',
  hasApiKey: false
};

export default function App() {
  const [tasks, setTasks] = useState(() => loadJson(STORAGE_KEYS.tasks, []));
  const [logs, setLogs] = useState(() => loadJson(STORAGE_KEYS.activityLog, []));
  const [stepRecords, setStepRecords] = useState(() => loadJson(STORAGE_KEYS.stepRecords, []));
  const [taskForm, setTaskForm] = useState(emptyTaskForm);
  const [aiConfig, setAiConfig] = useState(() => {
    const savedConfig = { ...defaultConfig, ...loadJson(STORAGE_KEYS.aiConfigMeta, {}) };
    return { ...savedConfig, hasApiKey: Boolean(savedConfig.apiKey) };
  });
  const [configMessage, setConfigMessage] = useState('');
  const [aiNotice, setAiNotice] = useState('');
  const [selectedTaskId, setSelectedTaskId] = useState('');
  const [question, setQuestion] = useState('');
  const [chatMessages, setChatMessages] = useState(() => loadJson(STORAGE_KEYS.chatMessages, {}));
  const [riskRecords, setRiskRecords] = useState(() => loadJson(STORAGE_KEYS.riskRecords, []));
  const [weeklySummary, setWeeklySummary] = useState(null);
  const [monthlySummary, setMonthlySummary] = useState(null);
  const [activeNav, setActiveNav] = useState('tasks');

  const selectedTask = tasks.find((task) => task.id === selectedTaskId) || tasks[0];
  const chatScopeId = 'global';
  const selectedTaskMessages = chatMessages[chatScopeId] || [];
  const chatEndRef = useRef(null);
  const completionAnalytics = useMemo(() => buildCompletionAnalytics(tasks, stepRecords), [tasks, stepRecords]);
  const shareStats = useMemo(() => buildShareStats(tasks, stepRecords), [tasks, stepRecords]);

  useEffect(() => saveJson(STORAGE_KEYS.tasks, tasks), [tasks]);
  useEffect(() => saveJson(STORAGE_KEYS.activityLog, logs), [logs]);
  useEffect(() => saveJson(STORAGE_KEYS.stepRecords, stepRecords), [stepRecords]);
  useEffect(() => saveJson(STORAGE_KEYS.chatMessages, chatMessages), [chatMessages]);
  useEffect(() => saveJson(STORAGE_KEYS.riskRecords, riskRecords), [riskRecords]);
  useEffect(() => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }), [selectedTaskId, selectedTaskMessages.length]);

  function addLog(type, payload) {
    setLogs((current) => [...current, logEvent(type, payload)]);
  }

  function addRiskRecord(reason) {
    setRiskRecords((current) => [...current, {
      id: `risk-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      reason,
      date: todayISO(),
      createdAt: new Date().toISOString()
    }]);
  }

  function addStepRecord(task, step, completed) {
    setStepRecords((current) => [...current, {
      id: `record-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      taskId: task.id,
      stepId: step.id,
      taskType: getTaskTypeLabel(task.type),
      taskName: task.name,
      stepTitle: step.title,
      date: todayISO(),
      completed,
      createdAt: new Date().toISOString()
    }]);
  }

  function handleProviderChange(provider) {
    const preset = PROVIDERS.find((item) => item.value === provider);
    setAiConfig({
      ...aiConfig,
      provider,
      baseUrl: provider === 'Custom' ? aiConfig.baseUrl : preset.baseUrl,
      model: provider === 'Custom' ? aiConfig.model : preset.model
    });
  }

  async function handleSaveConfig(event) {
    event.preventDefault();
    const meta = { ...aiConfig, hasApiKey: Boolean(aiConfig.apiKey) };
    setAiConfig(meta);
    saveJson(STORAGE_KEYS.aiConfigMeta, meta);
    setConfigMessage(meta.hasApiKey ? 'AI配置已保存到浏览器 localStorage。部署到 Vercel 后也会继续使用这份本地配置。' : '未配置AI服务。可使用本地示例拆解，但本地示例不是AI结果。');
  }

  function addTask(event) {
    event.preventDefault();
    if (!taskForm.name.trim() || !taskForm.deadlineDate) return;
    const task = createTask(taskForm);
    setTasks((current) => [...current, task]);
    setSelectedTaskId(task.id);
    addLog('task-added', { taskId: task.id, taskName: task.name });
    setTaskForm(emptyTaskForm);
  }

  async function createTaskFromChat(text) {
    const name = text.replace(/^(帮我)?创建任务/, '').trim() || text.trim();
    const task = createTask({ name, description: '通过对话窗口创建', type: 'today', deadlineDate: todayISO() });
    setTasks((current) => [...current, task]);
    setSelectedTaskId(task.id);
    addLog('task-added', { taskId: task.id, taskName: task.name });
    if (aiConfig.hasApiKey) {
      try {
        const steps = await decomposeTaskWithAI(task, aiConfig);
        applySteps(task.id, stepsFromTitles(steps, 'AI拆解建议，可手动修改'));
        return `我已根据你的指令创建任务，并尝试完成AI拆解。请在右侧“任务&标签管理”中检查、修改和确认。`;
      } catch {
        return `我已先创建任务，但AI拆解暂时失败。你可以在右侧使用“本地示例拆解”或补充AI配置后再拆解。`;
      }
    }
    return `我已创建任务草稿。当前是手动模式，请在右侧“任务&标签管理”中补充或拆解。`;
  }

  async function decomposeWithAI(task) {
    try {
      setAiNotice('');
      const steps = await decomposeTaskWithAI(task, aiConfig);
      applySteps(task.id, stepsFromTitles(steps, 'AI拆解建议，可手动修改'));
    } catch (error) {
      setAiNotice(`${error.message}。你可以使用“本地示例拆解”，但本地示例不是AI结果。`);
    }
  }

  function decomposeLocally(task) {
    applySteps(task.id, stepsFromTitles(localExampleDecompose(task), '本地示例，不是AI结果'));
    setAiNotice('已生成本地示例拆解：本地示例，不是AI结果。');
  }

  function applySteps(taskId, steps) {
    setTasks((current) => current.map((task) => (task.id === taskId ? { ...task, steps, updatedAt: new Date().toISOString() } : task)));
  }

  function updateTask(taskId, patch) {
    setTasks((current) => current.map((task) => (task.id === taskId ? { ...task, ...patch, updatedAt: new Date().toISOString() } : task)));
  }

  function deleteTask(taskId) {
    setTasks((current) => current.filter((task) => task.id !== taskId));
    if (selectedTaskId === taskId) setSelectedTaskId('');
  }

  function updateStep(taskId, stepId, patch) {
    const currentTask = tasks.find((task) => task.id === taskId);
    const currentStep = currentTask?.steps.find((step) => step.id === stepId);
    const isDonePatch = Object.prototype.hasOwnProperty.call(patch, 'done');
    const didDoneChange = Boolean(isDonePatch && currentStep && currentStep.done !== patch.done);
    const willCompleteStep = Boolean(patch.done && currentStep && !currentStep.done);
    const willCompleteTask = Boolean(
      currentTask &&
      patch.done &&
      currentTask.steps.map((step) => (step.id === stepId ? { ...step, ...patch } : step)).every((step) => step.done) &&
      currentTask.status !== '已完成'
    );

    setTasks((current) => current.map((task) => {
      if (task.id !== taskId) return task;
      const steps = task.steps.map((step) => (step.id === stepId ? { ...step, ...patch } : step));
      return updateTaskAutoStatus({ ...task, steps });
    }));

    if (didDoneChange) addStepRecord(currentTask, currentStep, patch.done);
    if (willCompleteStep) addLog('step-completed', { taskId, taskName: currentTask.name, stepId, stepTitle: currentStep.title });
    if (willCompleteTask) addLog('task-completed', { taskId, taskName: currentTask.name });
  }

  function addStep(taskId) {
    setTasks((current) => current.map((task) => (task.id === taskId ? { ...task, steps: [...task.steps, ...stepsFromTitles(['新增步骤'], '用户手动新增')] } : task)));
  }

  function deleteStep(taskId, stepId) {
    setTasks((current) => current.map((task) => (task.id === taskId ? { ...task, steps: task.steps.filter((step) => step.id !== stepId) } : task)));
  }

  function moveStep(taskId, stepId, direction) {
    setTasks((current) => current.map((task) => {
      if (task.id !== taskId) return task;
      const index = task.steps.findIndex((step) => step.id === stepId);
      const target = index + direction;
      if (target < 0 || target >= task.steps.length) return task;
      const steps = [...task.steps];
      [steps[index], steps[target]] = [steps[target], steps[index]];
      return { ...task, steps };
    }));
  }

  async function sendQuestion() {
    if (!question.trim()) return;
    const text = question.trim();
    const scopeId = selectedTask?.id || 'global';
    const userMessage = { role: 'user', content: text, time: new Date().toISOString(), taskId: scopeId };
    const nextMessages = [...selectedTaskMessages, userMessage];
    setChatMessages((current) => ({ ...current, [scopeId]: nextMessages }));
    setQuestion('');

    if (/创建任务/.test(text)) {
      const content = await createTaskFromChat(text);
      const assistantMessage = { role: 'assistant', content, time: new Date().toISOString(), taskId: scopeId };
      setChatMessages((current) => ({ ...current, [scopeId]: [...(current[scopeId] || nextMessages), assistantMessage] }));
      return;
    }

    if (/阻碍|卡住|困难|风险|延期|来不及/.test(text)) {
      addRiskRecord(text);
    }

    if (/明早|明天早上|开会/.test(text) && !/\d|点|:/.test(text)) {
      const assistantMessage = { role: 'assistant', content: '我可以帮你调整安排。会议大概几点开始？先告诉我一个时间就好。', time: new Date().toISOString(), taskId: scopeId };
      setChatMessages((current) => ({ ...current, [scopeId]: [...(current[scopeId] || nextMessages), assistantMessage] }));
      return;
    }

    if (!selectedTask || !aiConfig.hasApiKey) {
      const content = aiConfig.hasApiKey ? '请先创建或选择一个任务，我再结合任务上下文回答。' : '当前为手动模式：你可以创建任务、勾选进度、生成总结；需要AI问答时，请先在系统设置里填写并保存API配置。';
      const assistantMessage = { role: 'assistant', content, time: new Date().toISOString(), taskId: scopeId };
      setChatMessages((current) => ({ ...current, [scopeId]: [...(current[scopeId] || nextMessages), assistantMessage] }));
      return;
    }

    try {
      const apiMessages = nextMessages.map(({ role, content }) => ({ role, content }));
      const content = await askAgent(question, selectedTask, apiMessages, aiConfig);
      const assistantMessage = { role: 'assistant', content, time: new Date().toISOString(), taskId: scopeId };
      setChatMessages((current) => ({ ...current, [scopeId]: [...(current[scopeId] || nextMessages), assistantMessage] }));
    } catch (error) {
      const assistantMessage = { role: 'assistant', content: `${error.message}。请先在AI配置中填写并保存可用服务。`, time: new Date().toISOString(), taskId: scopeId };
      setChatMessages((current) => ({ ...current, [scopeId]: [...(current[scopeId] || nextMessages), assistantMessage] }));
    }
  }

  function clearCurrentChat() {
    setChatMessages((current) => ({ ...current, [chatScopeId]: [] }));
  }

  async function copyLastAssistant() {
    const last = [...selectedTaskMessages].reverse().find((message) => message.role === 'assistant');
    if (last) await navigator.clipboard.writeText(last.content);
  }

  function clearLocalData() {
    setTasks([]);
    setLogs([]);
    setStepRecords([]);
    setRiskRecords([]);
    setWeeklySummary(null);
    setMonthlySummary(null);
    setSelectedTaskId('');
    localStorage.removeItem(STORAGE_KEYS.tasks);
    localStorage.removeItem(STORAGE_KEYS.activityLog);
    localStorage.removeItem(STORAGE_KEYS.stepRecords);
    localStorage.removeItem(STORAGE_KEYS.riskRecords);
    localStorage.removeItem(STORAGE_KEYS.summaries);
  }

  const agendaTasks = useMemo(() => getSortedAgendaTasks(tasks), [tasks]);
  const apiConnected = Boolean(aiConfig.hasApiKey);
  const latestRisk = riskRecords[riskRecords.length - 1];

  return (
    <div className="app-shell">
      <main className="desktop-workbench">
        <aside className="left-chat panel">
          <div className="connection-row">
            <span>🌐需联网</span>
            <b className={apiConnected ? 'status-online' : 'status-offline'}>{apiConnected ? '已连接' : '手动模式'}</b>
          </div>
          <h2>智能对话窗口</h2>
          <p className="muted">{apiConnected ? '你可以直接说：创建任务xxx、反馈进度、生成总结。涉及修改时我会先说明改动。' : '当前未配置API。你仍可手动创建任务、勾选进度和查看看板。'}</p>
          <div className="chat-window workbench-chat">
            {selectedTaskMessages.length === 0 ? <div className="empty-state">可以从这里开始：例如“创建任务 写MES字段说明报告”。</div> : selectedTaskMessages.map((message) => (
              <div className={`chat-message ${message.role}`} key={`${message.taskId}-${message.time}-${message.content.slice(0, 12)}`}>
                <div className="chat-bubble">
                  <small>{message.role === 'user' ? '你' : 'Agent'} · {new Date(message.time).toLocaleTimeString()}</small>
                  <p>{message.content}</p>
                </div>
              </div>
            ))}
            <div ref={chatEndRef} />
          </div>
          <div className="ask-box">
            <input value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="输入自然语言指令..." />
            <button className="primary-action compact" onClick={sendQuestion}>发送</button>
          </div>
          <div className="summary-actions">
            <button className="secondary-action" onClick={clearCurrentChat}>清空对话</button>
            <button className="secondary-action" onClick={copyLastAssistant}>复制回复</button>
          </div>
        </aside>

        <section className="center-board">
          <TodayBoard
            agendaTasks={agendaTasks}
            latestRisk={latestRisk}
            onUpdateStep={updateStep}
            onToggleTask={updateTask}
          />
          <ActiveWorkspace
            activeNav={activeNav}
            tasks={tasks}
            taskForm={taskForm}
            config={aiConfig}
            configMessage={configMessage}
            aiNotice={aiNotice}
            selectedTaskId={selectedTaskId}
            analytics={completionAnalytics}
            shareStats={shareStats}
            weeklySummary={weeklySummary}
            monthlySummary={monthlySummary}
            onTaskFormChange={setTaskForm}
            onAddTask={addTask}
            onConfigChange={setAiConfig}
            onProviderChange={handleProviderChange}
            onSaveConfig={handleSaveConfig}
            onSelectTask={setSelectedTaskId}
            onAI={decomposeWithAI}
            onLocal={decomposeLocally}
            onDelete={deleteTask}
            onUpdateTask={updateTask}
            onUpdateStep={updateStep}
            onAddStep={addStep}
            onDeleteStep={deleteStep}
            onMoveStep={moveStep}
            onWeekly={() => setWeeklySummary(buildWeeklyRecordSummary(tasks, stepRecords))}
            onMonthly={() => setMonthlySummary(buildMonthlyRecordSummary(tasks, stepRecords))}
            onClear={clearLocalData}
          />
        </section>

        <aside className="right-nav panel">
          <h1>TCL计划Agent</h1>
          <p className="muted">桌面工作台</p>
          <NavMenu active={activeNav} onChange={setActiveNav} />
        </aside>
      </main>
    </div>
  );
}

function SectionTitle({ index, title }) {
  return <div className="section-title"><span>{index}</span><h3>{title}</h3></div>;
}

function NavMenu({ active, onChange }) {
  const items = [
    ['tasks', '🏷️', '任务&标签管理'],
    ['stats', '📊', '统计'],
    ['knowledge', '🏭', '制造知识角'],
    ['settings', '⚙️', '系统设置']
  ];
  return <nav className="nav-menu">{items.map(([key, icon, label]) => <button key={key} className={active === key ? 'active' : ''} onClick={() => onChange(key)}><span>{icon}</span>{label}</button>)}</nav>;
}

function TodayBoard({ agendaTasks, latestRisk, onUpdateStep, onToggleTask }) {
  const date = new Date();
  const weekday = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'][date.getDay()];
  const dateText = `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')} ${weekday}`;
  const { done, total } = getAgendaProgress(agendaTasks);

  return (
    <section className="today-board panel">
      <div className="board-header">
        <div>
          <p className="eyebrow">Today Command Center</p>
          <h2>{dateText}</h2>
        </div>
        <div className="board-score"><strong>{total ? Math.round((done / total) * 100) : 0}%</strong><span>今日完成率</span></div>
      </div>

      <div className="board-block">
        <h3>今日待办</h3>
        {agendaTasks.length === 0 ? <div className="empty-state">你还没有待办任务，可以在右侧创建，或直接和我说“创建任务xxx”。</div> : <div className="today-task-list">{agendaTasks.map((task) => <TodayTaskItem key={task.id} task={task} onUpdateStep={onUpdateStep} onToggleTask={onToggleTask} />)}</div>}
      </div>

      {latestRisk && <div className="risk-banner">风险提醒：{latestRisk.reason}</div>}
    </section>
  );
}

function getAgendaProgress(tasks) {
  return tasks.reduce((acc, task) => {
    if (task.steps.length === 0) {
      return { done: acc.done + (task.status === '已完成' ? 1 : 0), total: acc.total + 1 };
    }
    const progress = getProgress(task);
    return { done: acc.done + progress.done, total: acc.total + progress.total };
  }, { done: 0, total: 0 });
}

function getSortedAgendaTasks(tasks) {
  return tasks
    .filter((task) => task.status !== '已完成')
    .sort((a, b) => getSortRank(a) - getSortRank(b) || getDaysLeft(a.deadlineDate) - getDaysLeft(b.deadlineDate) || a.createdAt.localeCompare(b.createdAt));
}

function getSortRank(task) {
  const days = getDaysLeft(task.deadlineDate);
  if (days < 0) return 0;
  if (task.type === 'today') return 1;
  if (days === 0) return 2;
  if (days <= 3) return 3;
  if (days <= 7) return 4;
  if (task.type === 'long') return 5;
  return 6;
}

function TodayTaskItem({ task, onUpdateStep, onToggleTask }) {
  const progress = getProgress(task);
  const daysText = getDaysText(task.deadlineDate);
  return (
    <article className="today-item">
      <div className="task-card-head"><h4>{task.name}</h4><span>{daysText}</span></div>
      {task.steps.length === 0 ? (
        <label className="today-step whole-task">
          <input type="checkbox" checked={task.status === '已完成'} onChange={(event) => onToggleTask(task.id, { status: event.target.checked ? '已完成' : '进行中' })} />
          <span>完整任务：未拆分，直接勾选即可完成</span>
        </label>
      ) : (
        <>
          <MiniProgress label={`母任务进度 ${progress.done}/${progress.total}`} value={progress.percent} />
          {task.steps.map((step) => (
            <label className="today-step" key={step.id}>
              <input type="checkbox" checked={step.done} onChange={(event) => onUpdateStep(task.id, step.id, { done: event.target.checked })} />
              <span>{step.title}</span>
            </label>
          ))}
        </>
      )}
    </article>
  );
}

function ActiveWorkspace(props) {
  const {
    activeNav,
    tasks,
    taskForm,
    config,
    configMessage,
    aiNotice,
    selectedTaskId,
    analytics,
    shareStats,
    weeklySummary,
    monthlySummary,
    onTaskFormChange,
    onAddTask,
    onConfigChange,
    onProviderChange,
    onSaveConfig,
    onSelectTask,
    onAI,
    onLocal,
    onDelete,
    onUpdateTask,
    onUpdateStep,
    onAddStep,
    onDeleteStep,
    onMoveStep,
    onWeekly,
    onMonthly,
    onClear
  } = props;

  if (activeNav === 'settings') return <AIConfigPanel config={config} message={configMessage} onChange={onConfigChange} onProviderChange={onProviderChange} onSubmit={onSaveConfig} />;
  if (activeNav === 'stats') return <section className="panel"><SectionTitle index="03" title="统计" /><VisualSummary tasks={tasks} analytics={analytics} shareStats={shareStats} weeklySummary={weeklySummary} monthlySummary={monthlySummary} onWeekly={onWeekly} onMonthly={onMonthly} onClear={onClear} /></section>;
  if (activeNav === 'knowledge') return <section className="panel"><SectionTitle index="03" title="制造知识角" /><div className="empty-state">这里预留制造知识、SOP、FAQ 与内部资料入口。当前不展示假资料。</div></section>;

  return (
    <section className="panel task-pool-panel">
      <SectionTitle index="03" title="任务&标签管理" />
      <div className="motivation">今日激励语：把计划变成下一步，把下一步变成一个可勾选动作。</div>
      <AddTaskPanel form={taskForm} onChange={onTaskFormChange} onSubmit={onAddTask} />
      {aiNotice && <div className="notice">{aiNotice}</div>}
      <div className="task-columns">
        {TASK_TYPES.map((type) => (
          <div key={type.value}>
            <h3>{type.column}</h3>
            <p className="muted">{type.hint}</p>
            <TaskList
              tasks={tasks.filter((task) => task.type === type.value)}
              selectedTaskId={selectedTaskId}
              onSelect={onSelectTask}
              onAI={onAI}
              onLocal={onLocal}
              onDelete={onDelete}
              onUpdateTask={onUpdateTask}
              onUpdateStep={onUpdateStep}
              onAddStep={onAddStep}
              onDeleteStep={onDeleteStep}
              onMoveStep={onMoveStep}
            />
          </div>
        ))}
      </div>
    </section>
  );
}

function AIConfigPanel({ config, message, onChange, onProviderChange, onSubmit }) {
  return (
    <section className="panel">
      <SectionTitle index="01" title="AI配置" />
      <div className="demo-banner">部署模式：API Key 由用户自行填写，并保存在当前浏览器 localStorage，不会写死在代码里。</div>
      <form className="config-form" onSubmit={onSubmit}>
        <label>Provider<select value={config.provider} onChange={(event) => onProviderChange(event.target.value)}>{PROVIDERS.map((provider) => <option value={provider.value} key={provider.value}>{provider.label}</option>)}</select></label>
        <label>API Key<input type="password" value={config.apiKey} onChange={(event) => onChange({ ...config, apiKey: event.target.value, hasApiKey: Boolean(event.target.value) })} placeholder="请输入自己的API Key" /></label>
        <label>Base URL<input value={config.baseUrl} onChange={(event) => onChange({ ...config, baseUrl: event.target.value })} /></label>
        <label>Model<input value={config.model} onChange={(event) => onChange({ ...config, model: event.target.value })} /></label>
        <button className="primary-action">保存到浏览器</button>
      </form>
      <p className={config.hasApiKey ? 'success-text' : 'warning-text'}>{config.hasApiKey ? 'AI服务已配置。请求会发送到本站 /api，再由服务端函数转发给模型。' : '未配置AI服务。可使用本地示例拆解，但必须明确：本地示例，不是AI结果。'}</p>
      {message && <div className="notice">{message}</div>}
    </section>
  );
}

function AddTaskPanel({ form, onChange, onSubmit }) {
  return (
    <section className="panel">
      <SectionTitle index="02" title="添加任务" />
      <form className="add-form" onSubmit={onSubmit}>
        <label>任务名称（必填）<input value={form.name} onChange={(event) => onChange({ ...form, name: event.target.value })} /></label>
        <label>任务说明（可选）<input value={form.description} onChange={(event) => onChange({ ...form, description: event.target.value })} /></label>
        <label>任务类型<select value={form.type} onChange={(event) => onChange({ ...form, type: event.target.value })}>{TASK_TYPES.map((type) => <option value={type.value} key={type.value}>{type.label}：{type.hint}</option>)}</select></label>
        <label>截止日期（必填）<input type="date" value={form.deadlineDate} onChange={(event) => onChange({ ...form, deadlineDate: event.target.value })} /></label>
        <button className="primary-action">创建任务</button>
      </form>
    </section>
  );
}

function TaskList({ tasks, selectedTaskId, onSelect, onAI, onLocal, onDelete, onUpdateTask, onUpdateStep, onAddStep, onDeleteStep, onMoveStep }) {
  if (!tasks.length) return <div className="empty-state">暂无任务。</div>;
  return <div className="task-list">{tasks.map((task) => <TaskCard key={task.id} task={task} selected={task.id === selectedTaskId} onSelect={onSelect} onAI={onAI} onLocal={onLocal} onDelete={onDelete} onUpdateTask={onUpdateTask} onUpdateStep={onUpdateStep} onAddStep={onAddStep} onDeleteStep={onDeleteStep} onMoveStep={onMoveStep} />)}</div>;
}

function TaskCard({ task, selected, onSelect, onAI, onLocal, onDelete, onUpdateTask, onUpdateStep, onAddStep, onDeleteStep, onMoveStep }) {
  const progress = getProgress(task);
  return (
    <article className={selected ? 'task-card selected' : 'task-card'} onClick={() => onSelect(task.id)}>
      <div className="task-card-head"><h4>{task.name}</h4><span>{getDaysText(task.deadlineDate)}</span></div>
      <p>{task.description || '无说明'}</p>
      <MiniProgress label={`完成进度 ${progress.done}/${progress.total}`} value={progress.percent} />
      {task.type === 'long' && <p className="next-step">下一个未完成步骤：{getNextStep(task)}</p>}
      <div className="button-row">
        <button onClick={(event) => { event.stopPropagation(); onAI(task); }}>AI拆解</button>
        <button onClick={(event) => { event.stopPropagation(); onLocal(task); }}>本地示例拆解</button>
        <button onClick={(event) => { event.stopPropagation(); onUpdateTask(task.id, { editing: !task.editing }); }}>编辑任务</button>
        <button className="danger-button" onClick={(event) => { event.stopPropagation(); onDelete(task.id); }}>删除任务</button>
      </div>
      {task.editing && <TaskEditForm task={task} onUpdateTask={onUpdateTask} />}
      {task.steps.length > 0 && (
        <div className="steps-box">
          <b>{task.steps[0].source}</b>
          {task.steps.map((step, index) => (
            <div className="step-row" key={step.id}>
              <input type="checkbox" checked={step.done} onChange={(event) => onUpdateStep(task.id, step.id, { done: event.target.checked })} />
              <input value={step.title} onChange={(event) => onUpdateStep(task.id, step.id, { title: event.target.value })} />
              <button onClick={() => onMoveStep(task.id, step.id, -1)} disabled={index === 0}>上移</button>
              <button onClick={() => onMoveStep(task.id, step.id, 1)} disabled={index === task.steps.length - 1}>下移</button>
              <button className="danger-button" onClick={() => onDeleteStep(task.id, step.id)}>删除</button>
            </div>
          ))}
          <button className="secondary-action" onClick={() => onAddStep(task.id)}>新增步骤</button>
        </div>
      )}
    </article>
  );
}

function TaskEditForm({ task, onUpdateTask }) {
  return (
    <div className="edit-box">
      <input value={task.name} onChange={(event) => onUpdateTask(task.id, { name: event.target.value })} />
      <input value={task.description} onChange={(event) => onUpdateTask(task.id, { description: event.target.value })} />
      <input type="date" value={task.deadlineDate} onChange={(event) => onUpdateTask(task.id, { deadlineDate: event.target.value })} />
    </div>
  );
}

function VisualSummary({ tasks, analytics, shareStats, weeklySummary, monthlySummary, onWeekly, onMonthly, onClear }) {
  if (!analytics.hasRecords) {
    return (
      <div className="visual-summary">
        <div className="empty-state">暂无完成记录，勾选任务步骤后会自动生成可视化。</div>
        <div className="summary-actions">
          <button className="secondary-action" onClick={onWeekly}>生成本周总结</button>
          <button className="secondary-action" onClick={onMonthly}>生成本月总结</button>
          <button className="secondary-action" onClick={onClear}>清空本地数据</button>
        </div>
        <ShareCard stats={shareStats} />
      </div>
    );
  }

  return (
    <div className="visual-summary">
      <div className="visual-grid">
        <TodayCompletionCard stats={analytics.today} />
        <div className="summary-card">
          <h4>短期任务今日推进</h4>
          <BigNumber value={analytics.today.shortDone} suffix="个步骤" />
          <Bar value={Math.min(100, analytics.today.shortDone * 20)} />
          <p>只统计今天真实勾选且当前未被取消的短期任务步骤。</p>
        </div>
        <div className="summary-card">
          <h4>长期任务今日推进</h4>
          <BigNumber value={analytics.today.longDone} suffix="个步骤" />
          <Bar value={Math.min(100, analytics.today.longDone * 20)} />
          <p>长期任务不会自动生成每日计划，只展示真实推进记录。</p>
        </div>
      </div>

      <div className="summary-card">
        <h4>最近7天完成趋势</h4>
        <div className="trend-list">
          {analytics.trend.map((day) => (
            <div className="trend-row" key={day.date}>
              <span>{day.date.slice(5)}</span>
              <b>{day.todayTaskCompleted ? '今日任务完成' : '今日任务未完成'}</b>
              <TrendBar label={`短期 ${day.shortDone}`} value={Math.min(100, day.shortDone * 20)} />
              <TrendBar label={`长期 ${day.longDone}`} value={Math.min(100, day.longDone * 20)} />
            </div>
          ))}
        </div>
      </div>

      <div className="summary-actions">
        <button className="secondary-action" onClick={onWeekly}>生成本周总结</button>
        <button className="secondary-action" onClick={onMonthly}>生成本月总结</button>
        <button className="secondary-action" onClick={onClear}>清空本地数据</button>
      </div>

      <div className="summary-grid">
        <RecordSummary title="本周总结" summary={weeklySummary} mode="week" />
        <RecordSummary title="本月总结" summary={monthlySummary} mode="month" />
      </div>

      <div className="visual-grid">
        <div className="summary-card"><h4>任务类型占比</h4>{TASK_TYPES.map((item) => <MiniProgress key={item.value} label={`${item.column} ${tasks.filter((task) => task.type === item.value).length}个`} value={tasks.length ? Math.round((tasks.filter((task) => task.type === item.value).length / tasks.length) * 100) : 0} />)}</div>
        <div className="summary-card"><h4>长期任务倒计时</h4>{tasks.filter((task) => task.type === 'long').length ? tasks.filter((task) => task.type === 'long').map((task) => <div className="countdown" key={task.id}><span>{task.name}</span><b>{getDaysText(task.deadlineDate)}</b></div>) : <p className="muted">暂无长期任务。</p>}</div>
      </div>

      <ShareCard stats={shareStats} />
    </div>
  );
}

function MiniProgress({ label, value }) {
  return <div className="mini-progress"><div><span>{label}</span><strong>{value}%</strong></div><div className="progress-track"><i style={{ width: `${value}%` }} /></div></div>;
}

function TodayCompletionCard({ stats }) {
  const label = stats.todayTotal === 0 ? '暂无今日任务步骤' : stats.todayTaskCompleted ? '今日任务已完成' : '今日任务未完成';
  const percent = stats.todayTotal ? Math.round((stats.todayDone / stats.todayTotal) * 100) : 0;
  return (
    <div className="summary-card">
      <h4>今日任务完成状态</h4>
      <BigNumber value={`${stats.todayDone}/${stats.todayTotal}`} suffix="" />
      <MiniProgress label={label} value={percent} />
      <p>今日任务是否完成，按当前今日任务的全部步骤勾选状态判断。</p>
    </div>
  );
}

function BigNumber({ value, suffix }) {
  return <div className="big-number"><strong>{value}</strong>{suffix && <span>{suffix}</span>}</div>;
}

function Bar({ value }) {
  return <div className="progress-track bar-track"><i style={{ width: `${value}%` }} /></div>;
}

function TrendBar({ label, value }) {
  return <div className="trend-bar"><span>{label}</span><div className="progress-track"><i style={{ width: `${value}%` }} /></div></div>;
}

function RecordSummary({ title, summary, mode }) {
  if (!summary) return <div className="summary-card"><h4>{title}</h4><div className="empty-state">暂无完成记录，勾选任务步骤后会自动生成可视化。</div></div>;
  return (
    <div className="summary-card">
      <h4>{title}</h4>
      <p>{mode === 'week' ? '本周今日任务完成天数' : '本月今日任务完成天数'}：{summary.todayTaskCompletedDays}</p>
      <p>{mode === 'week' ? '本周短期任务完成步骤' : '本月短期任务完成步骤'}：{summary.shortStepCount}</p>
      <p>{mode === 'week' ? '本周长期任务完成步骤' : '本月长期任务完成步骤'}：{summary.longStepCount}</p>
      {mode === 'month' && <p>本月完成任务总数：{summary.completedTaskCount}</p>}
      <p>推进最多：{summary.mostProgressed.join('、') || '暂无'}</p>
      <p>没有推进：{summary.noProgressTasks.join('、') || '暂无'}</p>
      <p>长期任务推进：{summary.longProgress.join('；') || '暂无'}</p>
      <p>{mode === 'week' ? '下周建议' : '下月建议'}：{summary.suggestion}</p>
    </div>
  );
}

function ShareCard({ stats }) {
  const [imageUrl, setImageUrl] = useState('');
  const [copyMessage, setCopyMessage] = useState('');
  const text = buildShareText(stats);

  async function copyShareText() {
    if (!stats.hasShareData) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        fallbackCopy(text);
      }
      setCopyMessage('分享文字已复制。');
    } catch {
      fallbackCopy(text);
      setCopyMessage('分享文字已复制。');
    }
  }

  function generateImage() {
    if (!stats.hasShareData) return;
    const canvas = document.createElement('canvas');
    canvas.width = 900;
    canvas.height = 640;
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
    gradient.addColorStop(0, '#07111f');
    gradient.addColorStop(1, '#113250');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = 'rgba(56, 222, 254, 0.45)';
    ctx.lineWidth = 3;
    roundRect(ctx, 42, 42, 816, 556, 34);
    ctx.stroke();
    ctx.fillStyle = '#38defe';
    ctx.font = '700 34px Microsoft YaHei, sans-serif';
    ctx.fillText('今日计划打卡', 86, 116);
    ctx.fillStyle = '#eef7ff';
    ctx.font = '700 48px Microsoft YaHei, sans-serif';
    ctx.fillText(formatShareDate(stats.date), 86, 178);
    ctx.font = '28px Microsoft YaHei, sans-serif';
    shareLines(stats).forEach((line, index) => ctx.fillText(line, 86, 250 + index * 56));
    ctx.fillStyle = '#60f2a5';
    ctx.font = '700 30px Microsoft YaHei, sans-serif';
    ctx.fillText(stats.encouragement, 86, 560);
    setImageUrl(canvas.toDataURL('image/png'));
  }

  return (
    <div className="share-card-wrap">
      <h4>今日监督分享卡</h4>
      {!stats.hasShareData ? (
        <div className="empty-state">今天还没有可分享的完成记录。先完成几个步骤，再生成监督卡吧。</div>
      ) : (
        <>
          <div className="share-card">
            <p className="share-title">今日计划打卡</p>
            <h3>{formatShareDate(stats.date)}</h3>
            {shareLines(stats).map((line) => <p key={line}>{line}</p>)}
            <b>{stats.encouragement}</b>
          </div>
          <p className="muted">隐私保护：分享卡不会展示任务名称、说明、具体步骤或截止日期。</p>
          <div className="summary-actions">
            <button className="secondary-action" onClick={copyShareText}>复制分享文字</button>
            <button className="secondary-action" onClick={generateImage}>生成分享图片</button>
          </div>
          {copyMessage && <p className="success-text">{copyMessage}</p>}
          {imageUrl && <img className="share-preview" src={imageUrl} alt="今日监督分享卡" />}
        </>
      )}
    </div>
  );
}

function buildShareText(stats) {
  return ['今日计划打卡', formatShareDate(stats.date), '', ...shareLines(stats), '', stats.encouragement].join('\n');
}

function shareLines(stats) {
  return [
    `今日任务：${stats.allTodayTasksCompleted ? '已全部完成' : '未全部完成'} ${stats.todayTaskDone}/${stats.todayTaskTotal}`,
    `今日步骤：完成 ${stats.stepDone}/${stats.stepTotal}`,
    `短期推进：${stats.shortDone}步`,
    `长期推进：${stats.longDone}步`,
    `今日完成率：${stats.completionRate}%`
  ];
}

function formatShareDate(dateText) {
  return dateText.replaceAll('-', '/');
}

function roundRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius);
  ctx.arcTo(x, y + height, x, y, radius);
  ctx.arcTo(x, y, x + width, y, radius);
  ctx.closePath();
}

function fallbackCopy(text) {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  document.body.removeChild(textarea);
}
