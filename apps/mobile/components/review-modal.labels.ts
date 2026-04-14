type ReviewLabelKey =
    | 'weeklyReview'
    | 'inbox'
    | 'ai'
    | 'calendar'
    | 'waiting'
    | 'contexts'
    | 'projects'
    | 'someday'
    | 'done'
    | 'timeFor'
    | 'timeForDesc'
    | 'startReview'
    | 'inboxDesc'
    | 'inboxGuide'
    | 'itemsInInbox'
    | 'inboxEmpty'
    | 'aiDesc'
    | 'aiRun'
    | 'aiRunning'
    | 'aiEmpty'
    | 'aiApply'
    | 'aiActionSomeday'
    | 'aiActionArchive'
    | 'aiActionBreakdown'
    | 'aiActionKeep'
    | 'loading'
    | 'calendarDesc'
    | 'calendarEmpty'
    | 'calendarUpcoming'
    | 'calendarTasks'
    | 'calendarTasksEmpty'
    | 'dueLabel'
    | 'startLabel'
    | 'allDay'
    | 'more'
    | 'less'
    | 'addTask'
    | 'addTaskPlaceholder'
    | 'cancel'
    | 'add'
    | 'waitingDesc'
    | 'waitingGuide'
    | 'contextsDesc'
    | 'contextsEmpty'
    | 'nothingWaiting'
    | 'projectsDesc'
    | 'projectsGuide'
    | 'noActiveProjects'
    | 'somedayDesc'
    | 'somedayGuide'
    | 'listEmpty'
    | 'reviewComplete'
    | 'completeDesc'
    | 'finish'
    | 'next'
    | 'back'
    | 'hasNext'
    | 'needsAction'
    | 'activeTasks'
    | 'moreItems';

export type ReviewLabels = Record<ReviewLabelKey, string>;

const defaultReviewLabels: ReviewLabels = {
    weeklyReview: 'Weekly Review',
    inbox: 'Inbox',
    ai: 'AI Insight',
    calendar: 'Calendar',
    waiting: 'Waiting For',
    contexts: 'Contexts',
    projects: 'Projects',
    someday: 'Someday/Maybe',
    done: 'Done!',
    timeFor: 'Time for Weekly Review!',
    timeForDesc: 'Take a few minutes to get your system clean and clear.',
    startReview: 'Start Review',
    inboxDesc: 'Clear Your Inbox',
    inboxGuide: 'Process each item: delete it, delegate it, set a next action, or move to Someday. Goal: inbox zero!',
    itemsInInbox: 'items in inbox',
    inboxEmpty: 'Great job! Inbox is empty!',
    aiDesc: 'AI highlights stale tasks and cleanup suggestions.',
    aiRun: 'Run analysis',
    aiRunning: 'Analyzing...',
    aiEmpty: 'No stale items found.',
    aiApply: 'Apply selected',
    aiActionSomeday: 'Move to Someday',
    aiActionArchive: 'Archive',
    aiActionBreakdown: 'Needs breakdown',
    aiActionKeep: 'Keep',
    loading: 'Loading…',
    calendarDesc: 'Review your hard landscape first: a compact summary of the next 7 days.',
    calendarEmpty: 'No calendar events in this range.',
    calendarUpcoming: 'Next 7 days',
    calendarTasks: 'Mindwtr tasks (next 7 days)',
    calendarTasksEmpty: 'No scheduled/due tasks in this range.',
    dueLabel: 'Due',
    startLabel: 'Start',
    allDay: 'All day',
    more: 'more',
    less: 'less',
    addTask: 'Add task',
    addTaskPlaceholder: 'Enter task title',
    cancel: 'Cancel',
    add: 'Add',
    waitingDesc: 'Follow Up on Waiting Items',
    waitingGuide: 'Check each item: need to follow up? Mark done if resolved. Add notes for context.',
    contextsDesc: 'Review your contexts and make sure each one has clear next actions.',
    contextsEmpty: 'No contexts with active tasks.',
    nothingWaiting: 'Nothing waiting - all clear!',
    projectsDesc: 'Review Your Projects',
    projectsGuide: 'Each active project needs a clear next action. Projects without next actions get stuck!',
    noActiveProjects: 'No active projects',
    somedayDesc: 'Revisit Someday/Maybe',
    somedayGuide: 'Anything you want to start now? Anything no longer interesting? Activate it or delete it.',
    listEmpty: 'List is empty',
    reviewComplete: 'Review Complete!',
    completeDesc: 'Your system is clean and you\'re ready for the week ahead!',
    finish: 'Finish',
    next: 'Next',
    back: 'Back',
    hasNext: '✓ Has Next',
    needsAction: '! Needs Action',
    activeTasks: 'active tasks',
    moreItems: 'more items',
};

const zhReviewLabels: ReviewLabels = {
    weeklyReview: '周回顾',
    inbox: '收集箱',
    ai: 'AI 洞察',
    calendar: '日历',
    waiting: '等待中',
    contexts: '情境',
    projects: '项目',
    someday: '将来/也许',
    done: '完成!',
    timeFor: '开始周回顾!',
    timeForDesc: '花几分钟整理你的系统，确保一切都在掌控之中。',
    startReview: '开始回顾',
    inboxDesc: '清空收集箱',
    inboxGuide: '处理每一项：删除、委托、设置下一步行动，或移到将来/也许。目标是清空收集箱！',
    itemsInInbox: '条在收集箱',
    inboxEmpty: '太棒了！收集箱已清空！',
    aiDesc: 'AI 标记久未推进的任务并给出清理建议。',
    aiRun: '开始分析',
    aiRunning: '分析中…',
    aiEmpty: '没有发现过期项目。',
    aiApply: '应用所选',
    aiActionSomeday: '移至将来/也许',
    aiActionArchive: '归档',
    aiActionBreakdown: '需要拆解',
    aiActionKeep: '保留',
    loading: '加载中…',
    calendarDesc: '先查看未来 7 天的日程摘要。',
    calendarEmpty: '该时间范围没有日历事件。',
    calendarUpcoming: '未来 7 天',
    calendarTasks: '未来 7 天任务',
    calendarTasksEmpty: '未来 7 天没有已安排任务。',
    dueLabel: '截止',
    startLabel: '开始',
    allDay: '全天',
    more: '更多',
    less: '收起',
    addTask: '添加任务',
    addTaskPlaceholder: '输入任务标题',
    cancel: '取消',
    add: '添加',
    waitingDesc: '跟进等待项目',
    waitingGuide: '检查每个等待项：是否需要跟进？已完成可以标记完成，需要再次跟进可以加注释。',
    contextsDesc: '回顾你的情境，确保每个情境下有清晰的下一步行动。',
    contextsEmpty: '没有带有活动任务的情境。',
    nothingWaiting: '没有等待项目',
    projectsDesc: '检查项目状态',
    projectsGuide: '确保每个活跃项目都有明确的下一步行动。没有下一步的项目会卡住！',
    noActiveProjects: '没有活跃项目',
    somedayDesc: '重新审视将来/也许',
    somedayGuide: '有没有现在想开始的？有没有不再感兴趣的？激活它或删除它。',
    listEmpty: '列表为空',
    reviewComplete: '回顾完成!',
    completeDesc: '你的系统已经整理完毕，准备好迎接新的一周了！',
    finish: '完成',
    next: '下一步',
    back: '返回',
    hasNext: '✓ 有下一步',
    needsAction: '! 需要行动',
    activeTasks: '个活跃任务',
    moreItems: '更多项目',
};

export const getReviewLabels = (lang: string): ReviewLabels => (
    lang === 'zh' || lang === 'zh-Hant' ? zhReviewLabels : defaultReviewLabels
);
