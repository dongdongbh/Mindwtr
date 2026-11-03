
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { filterTasksBySearch } from '../packages/core/src/search';
import type { Project, Task } from '../packages/core/src/types';

assert.equal(process.env.TZ, 'America/New_York', 'Run with TZ=America/New_York');
const now = '2026-10-05T16:00:00.000Z';
assert.equal(new Date(now).getTimezoneOffset(), 240);
const stamp = '2026-10-01T12:00:00.000Z';
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const task = (n: number, title: string, fields: Partial<Task> = {}): Task => ({
    id: id(n), title, status: 'next', tags: [], contexts: [], createdAt: stamp, updatedAt: stamp, ...fields,
});
const projects: Project[] = [{
    id: id(900), title: 'Work Launch', status: 'active', color: '#336699', order: 0,
    tagIds: [], createdAt: stamp, updatedAt: stamp,
}];
const textTasks = [
    task(1, 'Buy oat milk'),
    task(2, 'Buy milk', { description: 'Remember oat milk and foo:bar' }),
    task(3, String.raw`Read C:\temp and folder\new`),
    task(4, 'Say "hello world"'),
    task(5, 'Travel', { location: 'Airport lounge', checklist: [{ id: id(901), title: 'Book shuttle tickets', isCompleted: false }] }),
    task(6, 'Unknown', { description: 'foo:<=bar' }),
];
const metadataTasks = [
    task(10, 'Inbox item', { status: 'inbox', contexts: ['@work'], tags: ['#urgent'], projectId: id(900) }),
    task(11, 'Work child', { contexts: ['@work/office'], tags: ['#urgent/client'], assignedTo: 'Alex Smith', projectId: id(900) }),
    task(12, 'Uppercase tokens', { contexts: ['@Work'], tags: ['#Urgent'] }),
    task(13, 'Waiting for Alex', { status: 'waiting', contexts: ['@ALEX SMITH'], assignedTo: ' Alex  Smith ' }),
    task(14, 'Similar person', { contexts: ['@Alex Smith/Office'], assignedTo: 'Alex' }),
    task(15, 'Completed', { status: 'done', completedAt: stamp }),
    task(16, 'Punctuation person', { assignedTo: 'Alex: "OR" \\ Ops' }),
];
const dateTasks = [
    task(20, 'Yesterday date only', { dueDate: '2026-10-04' }),
    task(21, 'Today date only', { dueDate: '2026-10-05', startTime: '2026-10-05', reviewAt: '2026-10-05' }),
    task(22, 'Today midnight', { dueDate: '2026-10-05T00:00:00-04:00' }),
    task(23, 'Today noon', { dueDate: now, startTime: now, reviewAt: now }),
    task(24, 'Tomorrow date only', { dueDate: '2026-10-06' }),
    task(25, 'Seventh day date only', { dueDate: '2026-10-12' }),
    task(26, 'Seventh day noon', { dueDate: '2026-10-12T12:00:00-04:00' }),
    task(27, 'After seventh day noon', { dueDate: '2026-10-12T12:00:00.001-04:00' }),
    task(28, 'Offset resolves to yesterday', { dueDate: '2026-10-05T01:00:00+02:00' }),
    task(29, 'Offset resolves to today', { dueDate: '2026-10-06T01:00:00+02:00' }),
    task(30, 'Missing dates'),
];
const lifecycleTasks = [
    task(40, 'Visible inbox', { status: 'inbox' }),
    task(41, 'Deleted inbox', { status: 'inbox', deletedAt: stamp }),
    task(42, 'Purged inbox', { status: 'inbox', purgedAt: stamp }),
];
const taskSets = { text: textTasks, metadata: metadataTasks, dates: dateTasks, lifecycle: lifecycleTasks };
const cases: { name: string; query: string; taskSet: keyof typeof taskSets; expectedIds: string[] }[] = [];
const add = (name: string, query: string, taskSet: keyof typeof taskSets) => {
    cases.push({ name, query, taskSet,
        expectedIds: filterTasksBySearch(taskSets[taskSet], projects, query, new Date(now)).map((item) => item.id).sort(),
    });
};
for (const [name, query] of [
    ['quoted-free-text', '"oat milk"'],
    ['free-text-case-insensitive', 'OAT MILK'],
    ['negated-free-text', '-"oat milk"'],
    ['literal-backslash', String.raw`"C:\temp"`],
    ['escaped-backslash', String.raw`"C:\\temp"`],
    ['escaped-quotes', String.raw`"\"hello world\""`],
    ['unknown-operator-text', 'foo:bar'],
    ['unknown-operator-comparator-stripped', 'foo:<=bar'],
    ['unknown-operator-negated', '-foo:bar'],
    ['free-text-checklist', 'shuttle'],
    ['checklist-field', 'checklist:tickets'],
    ['location-alias', 'where:"airport lounge"'],
]) add(name, query, 'text');
for (const [name, query] of [
    ['status-context-tag', 'status:inbox context:work tags:urgent'],
    ['status-case-insensitive', 'STATUS:NEXT'],
    ['unknown-status-normalizes-inbox', 'status:unknown'],
    ['negation-or-precedence', 'status:inbox OR status:next -#urgent'],
    ['or-symbol', 'status:waiting || status:done'],
    ['shorthand-context-hierarchy', '@work/'],
    ['shorthand-tag-hierarchy', '#urgent'],
    ['context-case-sensitive', '@Work'],
    ['tag-case-sensitive', '#Urgent'],
    ['negated-shorthand-hierarchy', '-@work'],
    ['person-exact-shorthand', '%"alex smith"'],
    ['person-exact-negated', '-person:"alex smith"'],
    ['assignee-substring', 'assignee:alex'],
    ['person-punctuation-operators', String.raw`person:"Alex: \"OR\" \\ Ops"`],
    ['project-title-case-insensitive', 'project:"WORK LAUNCH"'],
    ['project-id', `project:${id(900)}`],
    ['id-substring', 'id:000000000011'],
]) add(name, query, 'metadata');
for (const [name, query] of [
    ['due-today-equality-local-day', 'due:today'],
    ['due-tomorrow-equality-local-day', 'due:tomorrow'],
    ['due-explicit-date-equality', 'due:2026-10-05'],
    ['due-less-equal-today-midnight', 'due:<=today'],
    ['due-less-today-midnight', 'due:<today'],
    ['due-greater-today-midnight', 'due:>today'],
    ['due-less-equal-seven-days-noon', 'due:<=7d'],
    ['due-offset-explicit-comparison', 'due:<=2026-10-05T16:00:00Z'],
    ['missing-due-negated', '-due:today'],
    ['start-today-midnight', 'start:<=today'],
    ['review-today-midnight', 'review:<=today'],
    ['created-explicit-date', 'created:2026-10-01'],
]) add(name, query, 'dates');
add('deleted-exclusion-empty-query', '', 'lifecycle');
add('deleted-exclusion-status', 'status:inbox', 'lifecycle');
add('deleted-exclusion-negation', '-status:done', 'lifecycle');
add('operator-only-query', 'OR ||', 'lifecycle');

const output = new URL('../packages/core/src/fixtures/native-task-search.json', import.meta.url);
const json = `${JSON.stringify({ now, projects, taskSets, cases }, null, 2)}\n`;
if (process.argv.includes('--check')) assert.equal(readFileSync(output, 'utf8'), json);
else {
    mkdirSync(new URL('.', output), { recursive: true });
    writeFileSync(output, json);
}
console.log(`${cases.length} core search parity cases ${process.argv.includes('--check') ? 'verified' : 'generated'} (${process.env.TZ})`);
