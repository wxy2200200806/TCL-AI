import { useEffect, useMemo, useRef, useState } from 'react';
import { PROVIDERS, STORAGE_KEYS, TASK_TYPES } from './data.js';
import { analyzeAgentMessage, decomposeTaskWithAI, fetchModelList, localExampleDecompose } from './services/aiService.js';
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
  const [activeNav, setActiveNav] = useState('dashboard');
  const [dogMessage, setDogMessage] = useState('今天也带着小狗一起推进任务吧。');
  const [pendingTaskDraft, setPendingTaskDraft] = useState(null);

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

  function createTaskFromChat(text) {
    const parsed = parseNaturalTask(text);
    if (!parsed.intentCertain) return '你是想创建任务，还是想咨询这个任务怎么做？';
    if (parsed.missing) return parsed.missing;
    setPendingTaskDraft(parsed.task);
    return '我识别到一个任务草稿，请先在下方确认卡里检查和修改，确认后才会创建。';
  }

  function createTaskDraftFromAI(taskDraft = {}) {
    const draft = {
      name: taskDraft.title || taskDraft.name || '',
      description: taskDraft.description || '',
      type: ['today', 'short', 'long'].includes(taskDraft.type) ? taskDraft.type : 'today',
      deadlineDate: taskDraft.deadline || taskDraft.deadlineDate || ''
    };
    if (draft.name && draft.deadlineDate) setPendingTaskDraft(draft);
    return draft;
  }

  function buildLocalFallbackReply(text) {
    const intent = detectChatIntent(text);
    if (intent === 'create') {
      const content = createTaskFromChat(text);
      return `本地规则回复，不是 AI 结果。\n${content}`;
    }
    if (intent === 'ask') {
      return '本地规则回复，不是 AI 结果。\n当前未连接 AI 服务，我无法可靠回答这个问题。请先在系统设置中配置 API Key。';
    }
    return '本地规则回复，不是 AI 结果。\n我无法确定你是想创建任务、查询任务还是普通咨询。请先在系统设置中配置 API Key，或明确说“创建任务：xxx，截止到xxxx”。';
  }

  function getAIReplyContent(result) {
    if (result.intent === 'create_task') {
      const draft = createTaskDraftFromAI(result.taskDraft);
      if (!draft.name || !draft.deadlineDate) {
        return result.reply || 'AI识别到你可能想创建任务，但任务名称或截止日期不完整，请补充后我再生成任务草稿。';
      }
      return result.reply || 'AI已生成任务草稿。请在下方任务确认卡中修改并确认，确认后才会创建。';
    }
    if (result.intent === 'ask') return result.answer || result.reply || 'AI没有返回有效回答。';
    if (['modify_task', 'query_task', 'generate_summary', 'feedback_progress'].includes(result.intent)) {
      return result.answer || result.reply || 'AI已识别你的意图，但还需要更多信息或确认后才能继续。';
    }
    return result.reply || result.answer || 'AI暂时无法判断你的意图，请换一种说法。';
  }

  function confirmPendingTask() {
    if (!pendingTaskDraft?.name.trim() || !pendingTaskDraft.deadlineDate) return;
    const task = createTask(pendingTaskDraft);
    setTasks((current) => [...current, task]);
    setSelectedTaskId(task.id);
    addLog('task-added', { taskId: task.id, taskName: task.name });
    setActiveNav('tasks');
    setPendingTaskDraft(null);
    const assistantMessage = { role: 'assistant', content: '任务已创建，你可以稍后点击 AI拆解。', time: new Date().toISOString(), taskId: chatScopeId };
    setChatMessages((current) => ({ ...current, [chatScopeId]: [...(current[chatScopeId] || []), assistantMessage] }));
  }

  function cancelPendingTask() {
    setPendingTaskDraft(null);
    const assistantMessage = { role: 'assistant', content: '已取消创建任务，没有保存到任务列表。', time: new Date().toISOString(), taskId: chatScopeId };
    setChatMessages((current) => ({ ...current, [chatScopeId]: [...(current[chatScopeId] || []), assistantMessage] }));
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
    const currentTask = tasks.find((task) => task.id === taskId);
    const completePatch = Object.prototype.hasOwnProperty.call(patch, 'status') && patch.status === '已完成';
    const reopenPatch = Object.prototype.hasOwnProperty.call(patch, 'status') && patch.status !== '已完成';
    const nextPatch = {
      ...patch,
      ...(completePatch ? { completedAt: new Date().toISOString(), completedDate: todayISO() } : {}),
      ...(reopenPatch ? { completedAt: '', completedDate: '' } : {})
    };
    setTasks((current) => current.map((task) => (task.id === taskId ? { ...task, ...nextPatch, updatedAt: new Date().toISOString() } : task)));
    if (completePatch && currentTask?.status !== '已完成') {
      addLog('task-completed', { taskId, taskName: currentTask.name });
      setDogMessage('完成了一个完整任务，小狗开心地绕着你转了一圈。');
    }
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
      const nextTask = updateTaskAutoStatus({ ...task, steps });
      if (nextTask.status === '已完成' && task.status !== '已完成') {
        return { ...nextTask, completedAt: new Date().toISOString(), completedDate: todayISO() };
      }
      if (nextTask.status !== '已完成') {
        return { ...nextTask, completedAt: '', completedDate: '' };
      }
      return nextTask;
    }));

    if (didDoneChange) {
      addStepRecord(currentTask, currentStep, patch.done);
      if (patch.done) setDogMessage('完成一个步骤，小狗获得了一点能量。');
    }
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

  function toggleAgendaTask(task, done) {
    if (task.steps.length === 0) {
      updateTask(task.id, { status: done ? '已完成' : '进行中' });
      return;
    }

    setTasks((current) => current.map((item) => {
      if (item.id !== task.id) return item;
      const steps = item.steps.map((step) => {
        if (step.done !== done) addStepRecord(item, step, done);
        return { ...step, done };
      });
      return {
        ...item,
        steps,
        status: done ? '已完成' : '进行中',
        completedAt: done ? new Date().toISOString() : '',
        completedDate: done ? todayISO() : '',
        updatedAt: new Date().toISOString()
      };
    }));
    if (done) {
      addLog('task-completed', { taskId: task.id, taskName: task.name });
      setDogMessage('完成了一个完整任务，小狗开心地绕着你转了一圈。');
    }
  }

  async function sendQuestion() {
    if (!question.trim()) return;
    const text = question.trim();
    const scopeId = chatScopeId;
    const userMessage = { role: 'user', content: text, time: new Date().toISOString(), taskId: scopeId };
    const nextMessages = [...selectedTaskMessages, userMessage];
    setChatMessages((current) => ({ ...current, [scopeId]: nextMessages }));
    setQuestion('');

    if (/阻碍|卡住|困难|风险|延期|来不及/.test(text)) {
      addRiskRecord(text);
    }

    if (!aiConfig.hasApiKey) {
      const content = `当前未连接 AI 服务，请先在系统设置中配置 API Key。\n${buildLocalFallbackReply(text)}`;
      const assistantMessage = { role: 'assistant', content, time: new Date().toISOString(), taskId: scopeId };
      setChatMessages((current) => ({ ...current, [scopeId]: [...(current[scopeId] || nextMessages), assistantMessage] }));
      return;
    }

    try {
      const apiMessages = nextMessages.map(({ role, content }) => ({ role, content }));
      const result = await analyzeAgentMessage(text, apiMessages, tasks, aiConfig);
      const content = getAIReplyContent(result);
      const assistantMessage = { role: 'assistant', content, time: new Date().toISOString(), taskId: scopeId };
      setChatMessages((current) => ({ ...current, [scopeId]: [...(current[scopeId] || nextMessages), assistantMessage] }));
    } catch (error) {
      const content = `当前未连接 AI 服务，请先在系统设置中配置 API Key。\nAI调用失败：${error.message}\n${buildLocalFallbackReply(text)}`;
      const assistantMessage = { role: 'assistant', content, time: new Date().toISOString(), taskId: scopeId };
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
          {pendingTaskDraft && <TaskConfirmCard draft={pendingTaskDraft} onChange={setPendingTaskDraft} onConfirm={confirmPendingTask} onCancel={cancelPendingTask} />}
          <div className="summary-actions">
            <button className="secondary-action" onClick={clearCurrentChat}>清空对话</button>
            <button className="secondary-action" onClick={copyLastAssistant}>复制回复</button>
          </div>
        </aside>

        <section className="center-board">
          {activeNav === 'dashboard' ? (
            <TodayBoard agendaTasks={agendaTasks} latestRisk={latestRisk} onToggleTask={toggleAgendaTask} />
          ) : (
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
            agendaTasks={agendaTasks}
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
            onToggleAgendaTask={toggleAgendaTask}
            onWeekly={() => setWeeklySummary(buildWeeklyRecordSummary(tasks, stepRecords))}
            onMonthly={() => setMonthlySummary(buildMonthlyRecordSummary(tasks, stepRecords))}
            onClear={clearLocalData}
            />
          )}
        </section>

        <aside className="right-nav panel">
          <button className="brand-button" onClick={() => setActiveNav('dashboard')}>TCL计划Agent</button>
          <p className="muted">桌面工作台</p>
          <NavMenu active={activeNav} onChange={setActiveNav} />
          <TaskDog stepRecords={stepRecords} tasks={tasks} message={dogMessage} onInteract={setDogMessage} />
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
    ['settings', '⚙️', '系统设置']
  ];
  return <nav className="nav-menu">{items.map(([key, icon, label]) => <button key={key} className={active === key ? 'active' : ''} onClick={() => onChange(key)}><span>{icon}</span>{label}</button>)}</nav>;
}

function TaskConfirmCard({ draft, onChange, onConfirm, onCancel }) {
  return (
    <section className="task-confirm-card">
      <h3>任务确认卡</h3>
      <p className="muted">我只是先识别出了草稿。请修改确认后再创建任务。</p>
      <label>任务名称<input value={draft.name} onChange={(event) => onChange({ ...draft, name: event.target.value })} /></label>
      <label>任务说明<input value={draft.description} onChange={(event) => onChange({ ...draft, description: event.target.value })} /></label>
      <label>任务类型<select value={draft.type} onChange={(event) => onChange({ ...draft, type: event.target.value })}>{TASK_TYPES.map((type) => <option value={type.value} key={type.value}>{type.label}</option>)}</select></label>
      <label>截止日期<input type="date" value={draft.deadlineDate} onChange={(event) => onChange({ ...draft, deadlineDate: event.target.value })} /></label>
      <div className="summary-actions">
        <button className="primary-action" onClick={onConfirm}>确认创建</button>
        <button className="secondary-action" onClick={onCancel}>取消</button>
      </div>
    </section>
  );
}

function TaskDog({ stepRecords, tasks, message, onInteract }) {
  const stats = getDogStats(stepRecords, tasks);
  const interactions = {
    feed: '你给小狗喂了一点小零食，它开心地甩了甩尾巴。',
    pat: '你摸了摸小狗的脑袋，它安静地趴在你旁边陪你工作。',
    walk: '你带小狗散步了一会儿，脑子也清醒了一点。',
    rest: '小狗趴下休息了，也提醒你别把自己安排太满。'
  };
  return (
    <section className="task-dog-card">
      <h3>任务小狗</h3>
      <div className="dog-face">🐶</div>
      <b>{stats.status}</b>
      <p>{message}</p>
      <small>今日完成步骤 {stats.todaySteps} · 今日完成任务 {stats.todayTasks} · 连续完成 {stats.streakDays} 天</small>
      <div className="dog-actions">
        <button onClick={() => onInteract(interactions.feed)}>喂食</button>
        <button onClick={() => onInteract(interactions.pat)}>摸摸</button>
        <button onClick={() => onInteract(interactions.walk)}>散步</button>
        <button onClick={() => onInteract(interactions.rest)}>休息</button>
      </div>
    </section>
  );
}

function getDogStats(stepRecords, tasks) {
  const today = todayISO();
  const todaySteps = getLatestStepRecords(stepRecords).filter((record) => record.date === today && record.completed).length;
  const todayTasks = tasks.filter((task) => task.completedDate === today).length;
  const activeCount = Math.max(todaySteps, todayTasks > 0 && todaySteps === 0 ? 1 : todaySteps);
  const status = activeCount === 0 ? '饿了' : activeCount <= 2 ? '普通' : activeCount <= 5 ? '开心' : '精力满满';
  return { status, todaySteps, todayTasks, streakDays: getCompletionStreak(stepRecords, tasks) };
}

function getLatestStepRecords(records) {
  const map = new Map();
  records.forEach((record, index) => map.set(`${record.date}:${record.taskId}:${record.stepId}`, { ...record, index }));
  return [...map.values()];
}

function getCompletionStreak(stepRecords, tasks) {
  const dates = new Set([
    ...getLatestStepRecords(stepRecords).filter((record) => record.completed).map((record) => record.date),
    ...tasks.filter((task) => task.completedDate).map((task) => task.completedDate)
  ]);
  let streak = 0;
  const cursor = new Date(`${todayISO()}T00:00:00`);
  while (dates.has(toLocalISO(cursor))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

function TodayBoard({ agendaTasks, latestRisk, onToggleTask }) {
  return (
    <section className="today-board panel">
      <CommandDateHeader agendaTasks={agendaTasks} />
      <TodayTaskOverview agendaTasks={agendaTasks} onToggleTask={onToggleTask} emptyText="你还没有待办任务，可以在右侧创建，或直接和我说“创建任务xxx”。" />
      {latestRisk && <div className="risk-banner">风险提醒：{latestRisk.reason}</div>}
    </section>
  );
}

function CommandDateHeader({ agendaTasks }) {
  const date = new Date();
  const weekday = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'][date.getDay()];
  const dateOnly = `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}`;
  const { done, total } = getAgendaProgress(agendaTasks);

  return (
    <div className="board-header">
      <div>
        <p className="eyebrow">TODAY COMMAND CENTER / 今日任务中心</p>
        <h2>{dateOnly}</h2>
        <p className="muted">{weekday}</p>
      </div>
      <div className="board-score"><strong>{total ? Math.round((done / total) * 100) : 0}%</strong><span>今日完成率</span></div>
    </div>
  );
}

function TodayTaskOverview({ agendaTasks, onToggleTask, emptyText }) {
  return (
    <div className="board-block">
      <h3>今日任务</h3>
      {agendaTasks.length === 0 ? <div className="empty-state">{emptyText}</div> : <div className="today-task-list">{agendaTasks.map((task) => <TodayTaskItem key={task.id} task={task} onToggleTask={onToggleTask} />)}</div>}
    </div>
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
  const today = todayISO();
  return tasks
    .filter((task) => shouldShowOnDashboard(task, today))
    .sort((a, b) => getSortRank(a) - getSortRank(b) || getDaysLeft(a.deadlineDate) - getDaysLeft(b.deadlineDate) || a.createdAt.localeCompare(b.createdAt));
}

function shouldShowOnDashboard(task, today) {
  if (task.status === '已完成') return task.completedDate === today;
  return true;
}

function getSortRank(task) {
  if (task.status === '已完成' && task.completedDate === todayISO()) return 5;
  const days = getDaysLeft(task.deadlineDate);
  if (days < 0) return 0;
  if (days === 0) return 1;
  if (task.type === 'today') return 2;
  if (task.type === 'short') return 3;
  if (task.type === 'long') return 4;
  return 6;
}

function detectChatIntent(text) {
  const createWords = /创建任务|添加任务|帮我加|加个|截止|到期|明天前|今天前|今天截止|明天截止|完成给|前完成/;
  const askWords = /怎么做|为什么|帮我想|第一步|注意什么|如何|怎么办|思路/;
  if (createWords.test(text)) return 'create';
  if (askWords.test(text)) return 'ask';
  return 'uncertain';
}

function parseNaturalTask(text) {
  const deadlineDate = parseDeadline(text);
  const name = extractTaskName(text);
  if (!name) return { intentCertain: true, missing: '我可以帮你创建任务。任务名称是什么？' };
  if (!deadlineDate) return { intentCertain: true, missing: '这个任务的截止日期是哪一天？你可以说“今天截止”“明天前”或“截止到7月3日”。' };
  return {
    intentCertain: true,
    task: {
      name,
      description: `通过智能对话创建：${text}`,
      type: inferTaskType(text, deadlineDate),
      deadlineDate
    }
  };
}

function parseDeadline(text) {
  const today = new Date(`${todayISO()}T00:00:00`);
  if (/今天前|今天截止|今天/.test(text)) return todayISO();
  if (/明天前|明天截止|明天/.test(text)) return addDays(today, 1);

  const nextMonthMatch = text.match(/下个月\s*(\d{1,2})\s*[号日]/);
  if (nextMonthMatch) {
    const date = new Date(today);
    date.setMonth(date.getMonth() + 1, Number(nextMonthMatch[1]));
    return toLocalISO(date);
  }

  const monthDayMatch = text.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[号日]?/);
  if (monthDayMatch) {
    const year = today.getFullYear();
    const candidate = new Date(year, Number(monthDayMatch[1]) - 1, Number(monthDayMatch[2]));
    if (candidate < today) candidate.setFullYear(year + 1);
    return toLocalISO(candidate);
  }

  const isoMatch = text.match(/(20\d{2})[-/年](\d{1,2})[-/月](\d{1,2})/);
  if (isoMatch) return toLocalISO(new Date(Number(isoMatch[1]), Number(isoMatch[2]) - 1, Number(isoMatch[3])));
  return '';
}

function extractTaskName(text) {
  return text
    .replace(/创建一个任务[:：]?|创建任务[:：]?|添加任务[:：]?|帮我加个?长期任务[:：]?|帮我加个?任务[:：]?/g, '')
    .replace(/(，|,)?\s*下个月\s*\d{1,2}\s*[号日](截止|到期)?/g, '')
    .replace(/(，|,)?\s*\d{1,2}\s*月\s*\d{1,2}\s*[号日]?(截止|到期)?/g, '')
    .replace(/(，|,)?\s*截止到?.*$/g, '')
    .replace(/明天前完成?/g, '')
    .replace(/今天前完成?/g, '')
    .replace(/今天截止|明天截止|截止|到期/g, '')
    .replace(/^完成/, '')
    .trim()
    .replace(/^[:：,，。]+|[:：,，。]+$/g, '');
}

function inferTaskType(text, deadlineDate) {
  if (/长期/.test(text)) return 'long';
  const days = getDaysLeft(deadlineDate);
  if (days <= 0 || /今日|今天/.test(text)) return 'today';
  if (days > 14) return 'long';
  return 'short';
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return toLocalISO(next);
}

function toLocalISO(date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60 * 1000).toISOString().slice(0, 10);
}

function TodayTaskItem({ task, onToggleTask }) {
  const progress = getProgress(task);
  const checked = task.status === '已完成';
  const hasSteps = task.steps.length > 0;
  return (
    <article className="today-item">
      <label className="today-step whole-task overview-task">
        <input type="checkbox" checked={checked} onChange={(event) => onToggleTask(task, event.target.checked)} />
        <span className={checked ? 'task-name done' : 'task-name'}>{task.name}</span>
      </label>
      <div className="overview-meta">
        <span className={getDashboardTagClass(task)}>{getDashboardTypeTag(task)}</span>
        <span>{checked ? '已完成' : getDaysText(task.deadlineDate)}</span>
        {hasSteps && <span>{progress.done}/{progress.total}</span>}
      </div>
    </article>
  );
}

function getDashboardTypeTag(task) {
  if (task.status !== '已完成' && getDaysLeft(task.deadlineDate) < 0) return '逾期';
  if (task.type === 'today') return '今日';
  if (task.type === 'short') return '短期';
  if (task.type === 'long') return '长期';
  return getTaskTypeLabel(task.type);
}

function getDashboardTagClass(task) {
  if (task.status !== '已完成' && getDaysLeft(task.deadlineDate) < 0) return 'agenda-tag overdue';
  return `agenda-tag ${task.type}`;
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
    agendaTasks,
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
    onToggleAgendaTask,
    onWeekly,
    onMonthly,
    onClear
  } = props;

  if (activeNav === 'settings') return <AIConfigPanel config={config} message={configMessage} onChange={onConfigChange} onProviderChange={onProviderChange} onSubmit={onSaveConfig} />;
  if (activeNav === 'stats') return <section className="panel"><SectionTitle index="03" title="统计" /><VisualSummary tasks={tasks} analytics={analytics} shareStats={shareStats} weeklySummary={weeklySummary} monthlySummary={monthlySummary} onWeekly={onWeekly} onMonthly={onMonthly} onClear={onClear} /></section>;

  return (
    <section className="panel task-pool-panel">
      <div className="task-management-top">
        <CommandDateHeader agendaTasks={agendaTasks} />
        <TodayTaskOverview agendaTasks={agendaTasks} onToggleTask={onToggleAgendaTask} emptyText="你还没有今日需要关注的任务，可以在下方创建，或直接和我说“创建任务xxx”。" />
      </div>
      <AddTaskPanel form={taskForm} onChange={onTaskFormChange} onSubmit={onAddTask} />
      {aiNotice && <div className="notice">{aiNotice}</div>}
      <SectionTitle index="04" title="任务详情 / AI拆解 / 可编辑步骤" />
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
      <div className="motivation">今日激励语：把计划变成下一步，把下一步变成一个可勾选动作。</div>
    </section>
  );
}

function AIConfigPanel({ config, message, onChange, onProviderChange, onSubmit }) {
  const [modelOptions, setModelOptions] = useState([]);
  const [modelMessage, setModelMessage] = useState('');
  const [loadingModels, setLoadingModels] = useState(false);

  async function loadModels() {
    setLoadingModels(true);
    setModelMessage('');
    try {
      const models = await fetchModelList(config);
      setModelOptions(models);
      setModelMessage(models.length ? `已拉取 ${models.length} 个模型。` : '接口返回成功，但没有可用模型。你仍可手动输入 Model。');
    } catch (error) {
      setModelOptions([]);
      setModelMessage(`${error.message}。你仍可手动输入 Model。`);
    } finally {
      setLoadingModels(false);
    }
  }

  return (
    <section className="panel">
      <SectionTitle index="01" title="AI配置" />
      <div className="demo-banner">部署模式：API Key 由用户自行填写，并保存在当前浏览器 localStorage，不会写死在代码里。</div>
      <form className="config-form" onSubmit={onSubmit}>
        <label>Provider<select value={config.provider} onChange={(event) => onProviderChange(event.target.value)}>{PROVIDERS.map((provider) => <option value={provider.value} key={provider.value}>{provider.label}</option>)}</select></label>
        <label>API Key<input type="password" value={config.apiKey} onChange={(event) => onChange({ ...config, apiKey: event.target.value, hasApiKey: Boolean(event.target.value) })} placeholder="请输入自己的API Key" /></label>
        <label>Base URL<input value={config.baseUrl} onChange={(event) => onChange({ ...config, baseUrl: event.target.value })} /></label>
        <label>Model<input value={config.model} onChange={(event) => onChange({ ...config, model: event.target.value })} placeholder="可手动输入，或先拉取模型列表" /></label>
        {modelOptions.length > 0 && <label>选择模型<select value={config.model} onChange={(event) => onChange({ ...config, model: event.target.value })}><option value="">请选择模型</option>{modelOptions.map((model) => <option value={model} key={model}>{model}</option>)}</select></label>}
        <button type="button" className="secondary-action" onClick={loadModels} disabled={loadingModels}>{loadingModels ? '拉取中...' : '拉取模型列表'}</button>
        <button className="primary-action">保存到浏览器</button>
      </form>
      <p className={config.hasApiKey ? 'success-text' : 'warning-text'}>{config.hasApiKey ? 'AI服务已配置。请求会发送到本站 /api，再由服务端函数转发给模型。' : '未配置AI服务。可使用本地示例拆解，但必须明确：本地示例，不是AI结果。'}</p>
      {modelMessage && <div className="notice">{modelMessage}</div>}
      {message && <div className="notice">{message}</div>}
      <div className="settings-grid">
        <div className="settings-card"><h4>数据管理</h4><p>任务、步骤、聊天和统计数据保存在当前浏览器 localStorage。</p></div>
        <div className="settings-card"><h4>导出</h4><p>可通过浏览器开发者工具导出 localStorage。后续可扩展为一键导出 JSON。</p></div>
        <div className="settings-card"><h4>分享设置</h4><p>监督分享卡默认只分享统计结果，不展示具体任务内容。</p></div>
      </div>
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
      <select value={task.type} onChange={(event) => onUpdateTask(task.id, { type: event.target.value })}>{TASK_TYPES.map((type) => <option value={type.value} key={type.value}>{type.label}</option>)}</select>
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
        <div className="summary-card"><h4>长期任务完成率</h4><MiniProgress label={getLongTaskProgress(tasks).label} value={getLongTaskProgress(tasks).percent} /></div>
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
      <h4>今日完成率</h4>
      <BigNumber value={`${stats.todayDone}/${stats.todayTotal}`} suffix="" />
      <MiniProgress label={label} value={percent} />
      <p>按今天真实完成的步骤记录计算，不展示具体任务内容。</p>
    </div>
  );
}

function getLongTaskProgress(tasks) {
  const longTasks = tasks.filter((task) => task.type === 'long');
  const total = longTasks.length;
  const done = longTasks.filter((task) => task.status === '已完成').length;
  return { label: `${done}/${total} 个长期任务已完成`, percent: total ? Math.round((done / total) * 100) : 0 };
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
