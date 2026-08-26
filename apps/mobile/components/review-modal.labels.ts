type ReviewLabelKey =
    | 'weeklyReview'
    | 'inbox'
    | 'ai'
    | 'stale'
    | 'staleDesc'
    | 'staleDaysInactive'
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
    | 'saveAndEdit'
    | 'cancel'
    | 'add'
    | 'waitingDesc'
    | 'waitingGuide'
    | 'contextsDesc'
    | 'contextsEmpty'
    | 'nothingWaiting'
    | 'notDueYet'
    | 'projectsDesc'
    | 'projectsGuide'
    | 'noActiveProjects'
    | 'somedayDesc'
    | 'somedayGuide'
    | 'listEmpty'
    | 'reviewComplete'
    | 'completeDesc'
    | 'summaryInboxEmpty'
    | 'summaryInboxCount'
    | 'summaryProjectsOk'
    | 'summaryProjectsMissing'
    | 'summaryWaitingStale'
    | 'finish'
    | 'next'
    | 'back'
    | 'hasNext'
    | 'waitingStatus'
    | 'needsAction'
    | 'activeTasks'
    | 'moreItems';

export type ReviewLabels = Record<ReviewLabelKey, string>;

type ReviewLabelTranslator = (key: string) => string;

const defaultReviewLabels: ReviewLabels = {
    weeklyReview: 'Weekly Review',
    inbox: 'Inbox',
    ai: 'AI Insight',
    stale: 'Stale items',
    staleDesc: 'No recent activity. Update each one, complete it, or let it go.',
    staleDaysInactive: '{{days}} days inactive',
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
    saveAndEdit: 'Save & edit',
    cancel: 'Cancel',
    add: 'Add',
    waitingDesc: 'Follow Up on Waiting Items',
    waitingGuide: 'Check each item: need to follow up? Mark done if resolved. Add notes for context.',
    contextsDesc: 'Review your contexts and make sure each one has clear next actions.',
    contextsEmpty: 'No contexts with active tasks.',
    nothingWaiting: 'Nothing waiting - all clear!',
    notDueYet: 'Not due yet',
    projectsDesc: 'Review Your Projects',
    projectsGuide: 'Each active project needs a clear next action. Projects without next actions get stuck!',
    noActiveProjects: 'No active projects',
    somedayDesc: 'Revisit Someday/Maybe',
    somedayGuide: 'Anything you want to start now? Anything no longer interesting? Activate it or delete it.',
    listEmpty: 'List is empty',
    reviewComplete: 'Review Complete!',
    completeDesc: 'Your system is clean and you\'re ready for the week ahead!',
    summaryInboxEmpty: 'Inbox is empty',
    summaryInboxCount: '{{count}} item(s) still in Inbox',
    summaryProjectsOk: 'Every active project has a next action',
    summaryProjectsMissing: '{{count}} project(s) have no next action',
    summaryWaitingStale: '{{count}} waiting item(s) untouched for more than two weeks',
    finish: 'Finish',
    next: 'Next',
    back: 'Back',
    hasNext: '✓ Has Next',
    waitingStatus: 'Waiting',
    needsAction: '! Needs Action',
    activeTasks: 'active tasks',
    moreItems: 'more items',
};

const reviewLabelTranslationKeys: Record<ReviewLabelKey, string> = {
    weeklyReview: 'settings.weeklyReview',
    inbox: 'nav.inbox',
    ai: 'review.aiStep',
    stale: 'review.staleStep',
    staleDesc: 'review.staleStepDesc',
    staleDaysInactive: 'review.staleDaysInactive',
    calendar: 'nav.calendar',
    waiting: 'review.waitingStep',
    contexts: 'review.contexts',
    projects: 'nav.projects',
    someday: 'review.somedayStep',
    done: 'review.allDone',
    timeFor: 'review.timeFor',
    timeForDesc: 'review.timeForDesc',
    startReview: 'review.startReview',
    inboxDesc: 'review.inboxStep',
    inboxGuide: 'review.inboxGuide',
    itemsInInbox: 'review.inboxZeroDesc',
    inboxEmpty: 'review.inboxEmpty',
    aiDesc: 'review.aiStepDesc',
    aiRun: 'review.aiRun',
    aiRunning: 'review.aiRunning',
    aiEmpty: 'review.aiEmpty',
    aiApply: 'review.aiApply',
    aiActionSomeday: 'review.aiAction.someday',
    aiActionArchive: 'review.aiAction.archive',
    aiActionBreakdown: 'review.aiAction.breakdown',
    aiActionKeep: 'review.aiAction.keep',
    loading: 'common.loading',
    calendarDesc: 'review.calendarStepDesc',
    calendarEmpty: 'review.calendarEmpty',
    calendarUpcoming: 'review.upcoming14',
    calendarTasks: 'review.calendarTasks',
    calendarTasksEmpty: 'review.calendarTasksEmpty',
    dueLabel: 'taskEdit.dueDateLabel',
    startLabel: 'taskEdit.startDateLabel',
    allDay: 'calendar.allDay',
    more: 'common.more',
    less: 'common.less',
    addTask: 'nav.addTask',
    addTaskPlaceholder: 'review.addTaskPlaceholder',
    saveAndEdit: 'quickAdd.saveAndEdit',
    cancel: 'common.cancel',
    add: 'common.add',
    waitingDesc: 'review.waitingStepDesc',
    waitingGuide: 'review.waitingHint',
    contextsDesc: 'review.contextsStepDesc',
    contextsEmpty: 'review.contextsEmpty',
    nothingWaiting: 'review.waitingEmpty',
    notDueYet: 'review.notDueYet',
    projectsDesc: 'review.projectsStep',
    projectsGuide: 'review.projectsHint',
    noActiveProjects: 'review.noActiveTasks',
    somedayDesc: 'review.somedayStepDesc',
    somedayGuide: 'review.somedayHint',
    listEmpty: 'review.listEmpty',
    reviewComplete: 'review.complete',
    completeDesc: 'review.completeDesc',
    summaryInboxEmpty: 'review.summaryInboxEmpty',
    summaryInboxCount: 'review.summaryInboxCount',
    summaryProjectsOk: 'review.summaryProjectsOk',
    summaryProjectsMissing: 'review.summaryProjectsMissing',
    summaryWaitingStale: 'review.summaryWaitingStale',
    finish: 'review.finish',
    next: 'review.next',
    back: 'review.back',
    hasNext: 'review.hasNextAction',
    waitingStatus: 'status.waiting',
    needsAction: 'review.needsAction',
    activeTasks: 'review.activeTasks',
    moreItems: 'review.moreItems',
};

const translateReviewLabel = (
    key: ReviewLabelKey,
    t: ReviewLabelTranslator | undefined
): string => {
    const translationKey = reviewLabelTranslationKeys[key];
    if (!translationKey || !t) return defaultReviewLabels[key];
    const translated = t(translationKey);
    return translated && translated !== translationKey ? translated : defaultReviewLabels[key];
};

export const getReviewLabels = (t?: ReviewLabelTranslator): ReviewLabels => (
    Object.fromEntries(
        (Object.keys(defaultReviewLabels) as ReviewLabelKey[]).map((key) => [
            key,
            translateReviewLabel(key, t),
        ])
    ) as ReviewLabels
);
