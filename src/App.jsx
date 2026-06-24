import { useEffect, useMemo, useRef, useState } from 'react';
import { PROVIDERS, STORAGE_KEYS, TASK_TYPES } from './data.js';
import { askAgent, decomposeTaskWithAI, localExampleDecompose } from './services/aiService.js';
import {
  buildCompletionAnalytics,
  buildMonthlyRecordSummary,
  buildShareStats,
  buildWeeklyRecordSummary,
  createTask,
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
  const [weeklySummary, setWeeklySummary] = useState(null);
  const [monthlySummary, setMonthlySummary] = useState(null);

  const selectedTask = tasks.find((task) => task.id === selectedTaskId) || tasks[0];
  const selectedTaskMessages = selectedTask ? chatMessages[selectedTask.id] || [] : [];
  const chatEndRef = useRef(null);
  const completionAnalytics = useMemo(() => buildCompletionAnalytics(tasks, stepRecords), [tasks, stepRecords]);
  const shareStats = useMemo(() => buildShareStats(tasks, stepRecords), [tasks, stepRecords]);

  useEffect(() => saveJson(STORAGE_KEYS.tasks, tasks), [tasks]);
  useEffect(() => saveJson(STORAGE_KEYS.activityLog, logs), [logs]);
  useEffect(() => saveJson(STORAGE_KEYS.stepRecords, stepRecords), [stepRecords]);
  useEffect(() => saveJson(STORAGE_KEYS.chatMessages, chatMessages), [chatMessages]);
  useEffect(() => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }), [selectedTaskId, selectedTaskMessages.length]);

  function addLog(type, payload) {
    setLogs((current) => [...current, logEvent(type, payload)]);
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
    if (!selectedTask) {
      alert('请先选择或添加一个任务，再向Agent提问。');
      return;
    }
    const userMessage = { role: 'user', content: question.trim(), time: new Date().toISOString(), taskId: selectedTask.id };
    const nextMessages = [...selectedTaskMessages, userMessage];
    setChatMessages((current) => ({ ...current, [selectedTask.id]: nextMessages }));
    setQuestion('');
    try {
      const apiMessages = nextMessages.map(({ role, content }) => ({ role, content }));
      const content = await askAgent(question, selectedTask, apiMessages, aiConfig);
      const assistantMessage = { role: 'assistant', content, time: new Date().toISOString(), taskId: selectedTask.id };
      setChatMessages((current) => ({ ...current, [selectedTask.id]: [...(current[selectedTask.id] || nextMessages), assistantMessage] }));
    } catch (error) {
      const assistantMessage = { role: 'assistant', content: `${error.message}。请先在AI配置中填写并保存可用服务。`, time: new Date().toISOString(), taskId: selectedTask.id };
      setChatMessages((current) => ({ ...current, [selectedTask.id]: [...(current[selectedTask.id] || nextMessages), assistantMessage] }));
    }
  }

  function clearCurrentChat() {
    if (!selectedTask) return;
    setChatMessages((current) => ({ ...current, [selectedTask.id]: [] }));
  }

  async function copyLastAssistant() {
    const last = [...selectedTaskMessages].reverse().find((message) => message.role === 'assistant');
    if (last) await navigator.clipboard.writeText(last.content);
  }

  function clearLocalData() {
    setTasks([]);
    setLogs([]);
    setStepRecords([]);
    setWeeklySummary(null);
    setMonthlySummary(null);
    setSelectedTaskId('');
    localStorage.removeItem(STORAGE_KEYS.tasks);
    localStorage.removeItem(STORAGE_KEYS.activityLog);
    localStorage.removeItem(STORAGE_KEYS.stepRecords);
    localStorage.removeItem(STORAGE_KEYS.summaries);
  }

  const onlySetup = tasks.length === 0;

  return (
    <div className="app-shell">
      <section className="hero">
        <p className="eyebrow">Personal Task Planning Agent</p>
        <h1>TCL计划Agent</h1>
        <h2>输入真实任务，Agent帮你拆解、追踪和总结。</h2>
      </section>

      <main className={onlySetup ? 'setup-grid' : 'workspace-grid'}>
        <AIConfigPanel config={aiConfig} message={configMessage} onChange={setAiConfig} onProviderChange={handleProviderChange} onSubmit={handleSaveConfig} />
        <AddTaskPanel form={taskForm} onChange={setTaskForm} onSubmit={addTask} />

        {!onlySetup && (
          <>
            <section className="panel task-pool-panel">
              <SectionTitle index="03" title="任务列表" />
              {aiNotice && <div className="notice">{aiNotice}</div>}
              <div className="task-columns">
                {TASK_TYPES.map((type) => (
                  <div key={type.value}>
                    <h3>{type.column}</h3>
                    <p className="muted">{type.hint}</p>
                    <TaskList
                      tasks={tasks.filter((task) => task.type === type.value)}
                      selectedTaskId={selectedTaskId}
                      onSelect={setSelectedTaskId}
                      onAI={decomposeWithAI}
                      onLocal={decomposeLocally}
                      onDelete={deleteTask}
                      onUpdateTask={updateTask}
                      onUpdateStep={updateStep}
                      onAddStep={addStep}
                      onDeleteStep={deleteStep}
                      onMoveStep={moveStep}
                    />
                  </div>
                ))}
              </div>
            </section>

            <section className="panel ask-panel">
              <SectionTitle index="04" title="问问Agent" />
              <p className="muted">AI回答会结合当前选中的任务：{selectedTask ? selectedTask.name : '未选择任务'}</p>
              <div className="chat-window">
                {selectedTaskMessages.length === 0 ? <div className="empty-state">当前任务还没有对话。你可以连续追问，历史上下文会一起发送给AI。</div> : selectedTaskMessages.map((message) => (
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
                <input value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="例如：这个报告第一步怎么做？" />
                <button className="primary-action compact" onClick={sendQuestion}>发送</button>
              </div>
              <div className="summary-actions">
                <button className="secondary-action" onClick={clearCurrentChat}>清空当前任务对话</button>
                <button className="secondary-action" onClick={copyLastAssistant}>复制最后一条AI回答</button>
              </div>
            </section>

            <section className="panel visual-panel">
              <SectionTitle index="05" title="可视化与总结" />
              <VisualSummary
                tasks={tasks}
                analytics={completionAnalytics}
                shareStats={shareStats}
                weeklySummary={weeklySummary}
                monthlySummary={monthlySummary}
                onWeekly={() => setWeeklySummary(buildWeeklyRecordSummary(tasks, stepRecords))}
                onMonthly={() => setMonthlySummary(buildMonthlyRecordSummary(tasks, stepRecords))}
                onClear={clearLocalData}
              />
            </section>
          </>
        )}
      </main>
    </div>
  );
}

function SectionTitle({ index, title }) {
  return <div className="section-title"><span>{index}</span><h3>{title}</h3></div>;
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
