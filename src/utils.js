import { TASK_TYPES } from './data.js';

export function todayISO() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60 * 1000).toISOString().slice(0, 10);
}

export function uid(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function loadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

export function saveJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

export function getTaskTypeMeta(type) {
  return TASK_TYPES.find((item) => item.value === type) || TASK_TYPES[0];
}

export function getTaskTypeLabel(type) {
  return getTaskTypeMeta(type).label;
}

export function getDaysText(deadlineDate, today = todayISO()) {
  const days = getDaysLeft(deadlineDate, today);
  if (days > 0) return `距离截止还有${days}天`;
  if (days === 0) return '今天截止';
  return `已逾期${Math.abs(days)}天`;
}

export function getDaysLeft(deadlineDate, today = todayISO()) {
  const oneDay = 24 * 60 * 60 * 1000;
  const start = new Date(`${today}T00:00:00`);
  const end = new Date(`${deadlineDate}T00:00:00`);
  return Math.ceil((end - start) / oneDay);
}

export function createTask(form) {
  const now = new Date().toISOString();
  return {
    id: uid('task'),
    name: form.name.trim(),
    description: form.description.trim(),
    type: form.type,
    deadlineDate: form.deadlineDate,
    status: '进行中',
    steps: [],
    createdAt: now,
    updatedAt: now
  };
}

export function stepsFromTitles(titles, source = 'AI拆解建议，可手动修改') {
  return titles.map((title) => ({
    id: uid('step'),
    title,
    done: false,
    source
  }));
}

export function getProgress(task) {
  const total = task.steps.length;
  const done = task.steps.filter((step) => step.done).length;
  return { done, total, percent: total ? Math.round((done / total) * 100) : 0 };
}

export function getNextStep(task) {
  return task.steps.find((step) => !step.done)?.title || '暂无未完成步骤';
}

export function isTaskComplete(task) {
  return task.steps.length > 0 && task.steps.every((step) => step.done);
}

export function updateTaskAutoStatus(task) {
  if (isTaskComplete(task)) return { ...task, status: '已完成' };
  return { ...task, status: task.status === '已完成' ? '进行中' : task.status };
}

export function logEvent(type, payload) {
  return {
    id: uid('log'),
    type,
    date: todayISO(),
    createdAt: new Date().toISOString(),
    ...payload
  };
}

export function getTypeDistribution(tasks) {
  return TASK_TYPES.map((type) => ({
    ...type,
    count: tasks.filter((task) => task.type === type.value).length
  }));
}

export function getOverallStepProgress(tasks) {
  const steps = tasks.flatMap((task) => task.steps);
  const done = steps.filter((step) => step.done).length;
  return { done, total: steps.length, percent: steps.length ? Math.round((done / steps.length) * 100) : 0 };
}

export function buildDailySummary(tasks, logs) {
  const today = todayISO();
  const todayLogs = logs.filter((log) => log.date === today);
  if (!todayLogs.length) return null;
  return {
    addedTasks: todayLogs.filter((log) => log.type === 'task-added').map((log) => log.taskName),
    completedSteps: todayLogs.filter((log) => log.type === 'step-completed').map((log) => log.stepTitle),
    completedTasks: todayLogs.filter((log) => log.type === 'task-completed').map((log) => log.taskName),
    unfinishedTasks: tasks.filter((task) => task.status !== '已完成').map((task) => task.name),
    tomorrowSuggestion: getTomorrowSuggestion(tasks)
  };
}

export function buildWeeklySummary(tasks, logs) {
  const weekLogs = filterRecentLogs(logs, 7);
  if (!weekLogs.length) return null;
  const longTasks = tasks.filter((task) => task.type === 'long');
  return {
    completedTaskCount: weekLogs.filter((log) => log.type === 'task-completed').length,
    completedStepCount: weekLogs.filter((log) => log.type === 'step-completed').length,
    delayedTasks: tasks.filter((task) => task.status !== '已完成' && getDaysLeft(task.deadlineDate) < 0).map((task) => task.name),
    longProgress: longTasks.map((task) => ({ name: task.name, ...getProgress(task) })),
    nextWeekSuggestion: getTomorrowSuggestion(tasks)
  };
}

export function buildCompletionAnalytics(tasks, records) {
  const days = getRecentDates(7);
  const latestRecords = getLatestRecords(records);
  const today = todayISO();
  const todayStats = { ...getDateStats(today, tasks, latestRecords), ...getCurrentTodayTaskStats(tasks) };
  const trend = days.map((date) => getDateStats(date, tasks, latestRecords));
  return {
    hasRecords: records.length > 0,
    today: todayStats,
    trend
  };
}

export function buildShareStats(tasks, records) {
  const analytics = buildCompletionAnalytics(tasks, records);
  const todayTasks = tasks.filter((task) => task.type === 'today');
  const completedTodayTasks = todayTasks.filter((task) => isTaskComplete(task)).length;
  const allSteps = tasks.flatMap((task) => task.steps);
  const completedSteps = allSteps.filter((step) => step.done).length;
  const totalSteps = allSteps.length;
  const completionRate = totalSteps ? Math.round((completedSteps / totalSteps) * 100) : 0;
  const hasTodayRecord = records.some((record) => record.date === todayISO() && record.completed);
  return {
    date: todayISO(),
    todayTaskDone: completedTodayTasks,
    todayTaskTotal: todayTasks.length,
    allTodayTasksCompleted: todayTasks.length > 0 && completedTodayTasks === todayTasks.length,
    stepDone: completedSteps,
    stepTotal: totalSteps,
    shortDone: analytics.today.shortDone,
    longDone: analytics.today.longDone,
    completionRate,
    hasShareData: (todayTasks.length > 0 || hasTodayRecord) && totalSteps > 0,
    encouragement: getEncouragement(completionRate, completedSteps)
  };
}

function getCurrentTodayTaskStats(tasks) {
  const todayTasks = tasks.filter((task) => task.type === 'today');
  const steps = todayTasks.flatMap((task) => task.steps);
  const done = steps.filter((step) => step.done).length;
  return {
    todayTaskCompleted: steps.length > 0 && done === steps.length,
    todayDone: done,
    todayTotal: steps.length
  };
}

function getEncouragement(rate, completedSteps) {
  if (!completedSteps) return '先迈出第一步，监督卡会记录你的真实推进。';
  if (rate >= 100) return '今天完成得很稳，给自己一个漂亮收尾。';
  if (rate >= 70) return '今天推进不错，明天继续保持节奏。';
  if (rate >= 30) return '今天有推进，明天继续。';
  return '有一点推进也算数，明天把颗粒度再切小一点。';
}

export function buildWeeklyRecordSummary(tasks, records) {
  return buildPeriodRecordSummary(tasks, records, getWeekStart(todayISO()), todayISO(), '下周');
}

export function buildMonthlyRecordSummary(tasks, records) {
  const today = todayISO();
  return buildPeriodRecordSummary(tasks, records, today.slice(0, 8) + '01', today, '下月');
}

function filterRecentLogs(logs, days) {
  const now = new Date(`${todayISO()}T00:00:00`);
  const start = new Date(now.getTime() - (days - 1) * 24 * 60 * 60 * 1000);
  return logs.filter((log) => {
    const date = new Date(`${log.date}T00:00:00`);
    return date >= start && date <= now;
  });
}

function getTomorrowSuggestion(tasks) {
  const active = tasks.filter((task) => task.status !== '已完成');
  if (!active.length) return '暂无未完成任务。';
  const sorted = [...active].sort((a, b) => getDaysLeft(a.deadlineDate) - getDaysLeft(b.deadlineDate));
  return `建议继续推进「${sorted[0].name}」：${getNextStep(sorted[0])}`;
}

function getRecentDates(days) {
  const today = new Date(`${todayISO()}T00:00:00`);
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(today.getTime() - (days - 1 - index) * 24 * 60 * 60 * 1000);
    return date.toISOString().slice(0, 10);
  });
}

function getLatestRecords(records) {
  const byKey = new Map();
  records.forEach((record, index) => {
    const key = `${record.date}:${record.taskId}:${record.stepId}`;
    byKey.set(key, { ...record, order: index });
  });
  return [...byKey.values()];
}

function getDateStats(date, tasks, latestRecords) {
  const dateRecords = latestRecords.filter((record) => record.date === date);
  const completed = dateRecords.filter((record) => record.completed);
  const todayTaskStepIds = new Set(tasks.filter((task) => task.type === 'today').flatMap((task) => task.steps.map((step) => `${task.id}:${step.id}`)));
  const completedTodaySteps = new Set(completed.filter((record) => record.taskType === '今日任务').map((record) => `${record.taskId}:${record.stepId}`));
  const todayTotal = todayTaskStepIds.size;
  const todayDone = [...todayTaskStepIds].filter((id) => completedTodaySteps.has(id)).length;
  return {
    date,
    todayTaskCompleted: todayTotal > 0 && todayDone === todayTotal,
    todayDone,
    todayTotal,
    shortDone: completed.filter((record) => record.taskType === '短期任务').length,
    longDone: completed.filter((record) => record.taskType === '长期任务').length
  };
}

function getWeekStart(dateText) {
  const date = new Date(`${dateText}T00:00:00`);
  const day = date.getDay() || 7;
  date.setDate(date.getDate() - day + 1);
  return date.toISOString().slice(0, 10);
}

function buildPeriodRecordSummary(tasks, records, startDate, endDate, nextLabel) {
  const latestRecords = getLatestRecords(records).filter((record) => record.date >= startDate && record.date <= endDate);
  if (!latestRecords.length) return null;
  const completed = latestRecords.filter((record) => record.completed);
  const dates = getDatesBetween(startDate, endDate);
  const taskCounts = countBy(completed, 'taskId');
  const taskNameById = new Map(tasks.map((task) => [task.id, task.name]));
  const progressedTaskIds = new Set(completed.map((record) => record.taskId));
  const mostProgressed = [...taskCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([taskId, count]) => `${taskNameById.get(taskId) || '已删除任务'}（${count}步）`);
  const noProgressTasks = tasks.filter((task) => task.status !== '已完成' && !progressedTaskIds.has(task.id)).map((task) => task.name);
  const completedTaskCount = tasks.filter((task) => isTaskComplete(task) && progressedTaskIds.has(task.id)).length;
  const longProgress = tasks
    .filter((task) => task.type === 'long')
    .map((task) => `${task.name}：${completed.filter((record) => record.taskId === task.id).length}步`)
    .filter((line) => !line.endsWith('：0步'));

  return {
    todayTaskCompletedDays: dates.filter((date) => getDateStats(date, tasks, latestRecords).todayTaskCompleted).length,
    shortStepCount: completed.filter((record) => record.taskType === '短期任务').length,
    longStepCount: completed.filter((record) => record.taskType === '长期任务').length,
    completedTaskCount,
    mostProgressed,
    noProgressTasks,
    longProgress,
    suggestion: buildPeriodSuggestion(noProgressTasks, mostProgressed, nextLabel)
  };
}

function getDatesBetween(startDate, endDate) {
  const dates = [];
  const current = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate}T00:00:00`);
  while (current <= end) {
    dates.push(current.toISOString().slice(0, 10));
    current.setDate(current.getDate() + 1);
  }
  return dates;
}

function countBy(items, key) {
  const counts = new Map();
  items.forEach((item) => counts.set(item[key], (counts.get(item[key]) || 0) + 1));
  return counts;
}

function buildPeriodSuggestion(noProgressTasks, mostProgressed, nextLabel) {
  if (noProgressTasks.length) return `${nextLabel}优先补齐未推进任务：${noProgressTasks.slice(0, 3).join('、')}。`;
  if (mostProgressed.length) return `${nextLabel}可以延续当前节奏，继续推进${mostProgressed[0].replace(/（.*$/, '')}。`;
  return `${nextLabel}先选择一个真实任务，拆成可勾选步骤后持续推进。`;
}
