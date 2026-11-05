


import React from 'react';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { act, create, type ReactTestRendererJSON } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  formatTaskEditorDate,
  formatTimeEstimateLabel,
  loadTranslations,
  resetForTests,
  safeFormatDate,
  useTaskStore,
  type Area,
  type Attachment,
  type Project,
  type Section,
  type Task,
  type TimeEstimate,
} from '@mindwtr/core';

import { MarkdownInlineText, MarkdownText } from '../markdown-text';
import { TaskEditContentField } from './TaskEditContentField';
import { TaskEditViewTab } from './TaskEditViewTab';
import { useTaskEditActions } from './use-task-edit-actions';

const FIXTURE_PATH = new URL('../../../../packages/core/src/task-view-parity.fixtures.json', import.meta.url).pathname;
const CAPTURE = process.env.MINDWTR_CAPTURE_TASK_VIEW === '1';
const NOW = '2026-09-26T15:00:00.000Z';
const T0 = '2026-09-01T10:00:00.000Z';

const harness = vi.hoisted(() => ({
  strings: {} as Record<string, string>,
  uuid: 0,
  log: [] as unknown[][],
}));

const translate = (key: string) => harness.strings[key] || key;

vi.mock('@mindwtr/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mindwtr/core')>();
  return { ...actual, generateUUID: () => `uuid-${++harness.uuid}` };
});
vi.mock('lucide-react-native', () => {
  const icons = new Map<string, unknown>();
  const exports: Record<string, unknown> = { __esModule: true };
  return new Proxy(exports, {
    get: (target, prop) => {
      if (prop in target) return target[prop as string];
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      if (!icons.has(prop)) icons.set(prop, (props: any) => React.createElement('Icon', { ...props, name: prop }));
      return icons.get(prop);
    },
    has: (target, prop) => prop in target || (typeof prop !== 'symbol' && prop !== 'then'),
  });
});
vi.mock('expo-router', () => ({ router: { push: () => undefined } }));
vi.mock('@/contexts/language-context', () => ({
  useLanguage: () => ({ t: (key: string) => harness.strings[key] || key, language: 'en' }),
}));
vi.mock('@/lib/task-meta-navigation', () => ({
  openProjectScreen: (...args: unknown[]) => { harness.log.push(['openProjectScreen', ...args]); },
  openTaskScreen: (...args: unknown[]) => { harness.log.push(['openTaskScreen', ...args]); },
}));
vi.mock('expo-linking', () => ({
  openURL: (url: string) => { harness.log.push(['openURL', url]); },
}));
vi.mock('expo-clipboard', () => ({
  setStringAsync: async (text: string) => { harness.log.push(['copy', text]); },
}));
vi.mock('../task-status-badge', () => ({
  TaskStatusBadge: (props: any) => React.createElement('TaskStatusBadge', props),
}));
vi.mock('../AttachmentProgressIndicator', () => ({
  AttachmentProgressIndicator: (props: any) => React.createElement('AttachmentProgressIndicator', props),
}));
vi.mock('../markdown-reference-autocomplete', () => ({
  MarkdownReferenceAutocomplete: (props: any) => React.createElement('MarkdownReferenceAutocomplete', props),
}));
vi.mock('../../lib/app-log', () => ({ logInfo: async () => null }));


const task = (fields: Partial<Task> & Pick<Task, 'id' | 'title' | 'status'>): Task => ({
  tags: [], contexts: [], createdAt: T0, updatedAt: T0, ...fields,
});
const project = (id: string, title: string, areaId?: string, extra: Partial<Project> = {}): Project => ({
  id, title, status: 'active', color: '#94a3b8', order: 0, tagIds: [], createdAt: T0, updatedAt: T0, ...(areaId ? { areaId } : {}), ...extra,
});


const STORE = {
  tasks: [
    task({ id: 't-live', title: 'Live task', status: 'next', projectId: 'p-live' }),
    task({ id: 't-noproj', title: 'Loose task', status: 'inbox' }),
    task({ id: 't-deleted', title: 'Deleted task', status: 'next', deletedAt: T0 }),
  ],
  projects: [
    project('p-live', 'Launch', 'a-work'),
    project('p-other', 'Garden', 'a-home'),
    project('p-trashed', 'Trashed', undefined, { deletedAt: T0 }),
  ],
};
const SECTIONS: Section[] = [
  { id: 's-1', projectId: 'p-live', title: 'Phase 1', order: 0, createdAt: T0, updatedAt: T0 },
];
const AREAS: Area[] = [
  { id: 'a-work', name: 'Work', order: 0, createdAt: T0, updatedAt: T0 },
  { id: 'a-home', name: 'Home', order: 1, createdAt: T0, updatedAt: T0 },
];

type MarkdownScenario = {
  name: string;
  markdown: string;
  direction?: 'ltr' | 'rtl';
  selectable?: boolean;

  inline?: { numberOfLines?: number };
};

const markdownScenarios: MarkdownScenario[] = [
  { name: 'empty', markdown: '' },
  { name: 'paragraphs', markdown: 'First line\nsecond line\n\nNew paragraph   \n  indented continuation\n> quoted line' },
  { name: 'headings', markdown: '# One\n## Two **bold**\n### Three\n#### Four is text\n#NoSpace\n  # Indented heading' },
  { name: 'rules', markdown: 'above\n---\n***\n___\n- - -\n--\nbelow' },
  { name: 'code', markdown: '```js\nconst a = 1;\n  indented **not bold**\n\n```\nafter\n  ```\nunclosed\nfence' },
  { name: 'task lists', markdown: '- [ ] open\n- [x] done\n* [X] star\n[ ] bare\n  - [ ] nested two\n\t- [x] tab nested\n    + [ ] deep\n- [ ]\n- [x]   spaced **bold**' },
  { name: 'bullets', markdown: '- one\n* two\n+ three\n  - nested\n    - deeper\n      - deepest\n        - beyond\n-not a bullet' },
  { name: 'ordered', markdown: '1. one\n2) two\n10. ten\n  3. nested\n1.no space' },
  { name: 'mixed', markdown: 'Intro text\n- bullet\n1. ordered\n- [ ] task\n# Heading\nparagraph after\n---\n```\ncode\n```\n> quote\ntrailing' },
  { name: 'inline', markdown: '**bold** __also__ *it* _it2_ ~~gone~~ `code` `` plain * star _ under ** half' },
  {
    name: 'links',
    markdown: '[site](https://example.com) [mail](mailto:a@b.co) [call](tel:+123) [bad](javascript:alert(1)) raw https://example.com/path. and (https://x.y/z) mid:abc@def ftp://nope [rel](/local)',
  },
  {
    name: 'references',
    markdown: 'See [[task:t-live|Live task]] and [[task:t-gone|Gone task]] and [[project:p-live|Live project]] and [[project:p-gone|Gone project]]\n- [[task:t-deleted|Deleted]] plus [T](mindwtr://task/t-noproj) and [P](mindwtr://project/p-trashed)',
  },
  { name: 'crlf', markdown: 'Line one\r\n- item\r\n\r\n# Head\r\n' },
  { name: 'whitespace', markdown: '   \n\t\n  text  \n   ' },
  { name: 'rtl', markdown: 'مرحبا **عالم**\n- بند', direction: 'rtl' },
  { name: 'selectable', markdown: '# Title\nBody [link](https://example.com)\n- item\n```\nx\n```', selectable: true },
  { name: 'inline text', markdown: '**b** and [link](https://e.com) and [[task:t-live|Live]]\nsecond line - [ ] not a list', inline: { numberOfLines: 2 } },
  { name: 'inline text plain', markdown: 'Plain title', inline: {} },
  { name: 'inline text empty', markdown: '', inline: {} },
];

type ViewTabScenario = {
  name: string;
  task: Task;
  prioritiesEnabled: boolean;
  timeEstimatesEnabled: boolean;
  showStatusField: boolean;
  readOnly: boolean;

  handlers: { project: boolean; context: boolean; tag: boolean; status: boolean };
  actions: unknown[][];
};

const DESCRIPTION = 'Plan the **launch**.\n\n- [ ] book venue\n- [x] invite [[task:t-live|Live task]]\n\n## Links\nSee https://example.com and [[project:p-gone|Old]]';
const CHECKLIST = [
  { id: 'c1', title: 'Buy **milk**', isCompleted: true },
  { id: 'c2', title: 'Call [Ann](tel:+1555)', isCompleted: false },
  { id: 'c3', title: 'Plain', isCompleted: false },
];
const ATTACHMENTS: Attachment[] = [
  { id: 'a-img', kind: 'file', title: 'photo.png', uri: 'file:///photo.png', mimeType: 'image/png', createdAt: T0, updatedAt: T0 },
  { id: 'a-img-cloud', kind: 'file', title: 'cloud.jpg', uri: '', mimeType: 'image/jpeg', cloudKey: 'attachments/cloud.jpg', createdAt: T0, updatedAt: T0 },
  { id: 'a-doc-missing', kind: 'file', title: 'doc.pdf', uri: 'file:///doc.pdf', localStatus: 'missing', createdAt: T0, updatedAt: T0 },
  { id: 'a-doc-loading', kind: 'file', title: 'big.pdf', uri: 'file:///big.pdf', localStatus: 'downloading', cloudKey: 'attachments/big.pdf', createdAt: T0, updatedAt: T0 },
  { id: 'a-link', kind: 'link', title: '', uri: 'https://example.com/page', createdAt: T0, updatedAt: T0 },
  { id: 'a-heic', kind: 'file', title: 'IMG.HEIC', uri: 'file:///IMG.HEIC', createdAt: T0, updatedAt: T0 },
];
const ALL_HANDLERS = { project: true, context: true, tag: true, status: true };
const NO_HANDLERS = { project: false, context: false, tag: false, status: false };
const FULL_TASK = task({
  id: 'task-full',
  title: '  Ship the launch  ',
  status: 'next',
  priority: 'high',
  energyLevel: 'medium',
  assignedTo: 'Alex',
  projectId: 'p-live',
  sectionId: 's-1',
  areaId: 'a-home',
  startTime: '2026-09-27T09:30:00.000Z',
  dueDate: '2026-09-30',
  suppressMindwtrReminders: true,
  reviewAt: '2026-10-01',
  timeEstimate: '30min',
  contexts: ['@home', '@phone'],
  tags: ['#launch'],
  location: 'Office',
  recurrence: { rule: 'weekly', strategy: 'strict', byDay: ['MO', 'WE'] },
  description: `  ${DESCRIPTION}  `,
  checklist: CHECKLIST,
  attachments: ATTACHMENTS,
});

const viewTabScenarios: ViewTabScenario[] = [
  {
    name: 'full next task',
    task: FULL_TASK,
    prioritiesEnabled: true,
    timeEstimatesEnabled: true,
    showStatusField: true,
    readOnly: false,
    handlers: ALL_HANDLERS,
    actions: [['tick', 0], ['tick', 1], ['tick', 2], ['type', 'Half typed'], ['submit', '  New item  '], ['submit', '   '], ['submit', ''], ['attachment', 0], ['attachment', 4]],
  },
  {
    name: 'full next task without callbacks',
    task: FULL_TASK,
    prioritiesEnabled: true,
    timeEstimatesEnabled: true,
    showStatusField: true,
    readOnly: false,
    handlers: NO_HANDLERS,
    actions: [['tick', 1]],
  },
  {
    name: 'reference',
    task: task({
      id: 'task-ref',
      title: 'Manual',
      status: 'reference',
      priority: 'low',
      energyLevel: 'high',
      assignedTo: 'Sam',
      projectId: 'p-live',
      sectionId: 's-1',
      areaId: 'a-home',
      startTime: '2026-09-27',
      dueDate: '2026-09-28',
      reviewAt: '2026-10-02',
      timeEstimate: '1hr',
      contexts: ['@desk'],
      tags: ['#docs'],
      location: 'Shelf',
      recurrence: 'daily',
      description: 'Read me',
      checklist: [{ id: 'r1', title: 'Page **one**', isCompleted: true }, { id: 'r2', title: 'Page two', isCompleted: false }],
    }),
    prioritiesEnabled: true,
    timeEstimatesEnabled: true,
    showStatusField: true,
    readOnly: false,
    handlers: ALL_HANDLERS,
    actions: [],
  },
  {
    name: 'read-only done task',
    task: task({
      id: 'task-done',
      title: 'Done task',
      status: 'done',
      completedAt: '2026-09-20T08:00:00.000Z',
      projectId: 'p-live',
      checklist: [{ id: 'd1', title: 'Step', isCompleted: true }, { id: 'd2', title: 'Other', isCompleted: false }],
      attachments: [ATTACHMENTS[2]],
    }),
    prioritiesEnabled: true,
    timeEstimatesEnabled: true,
    showStatusField: true,
    readOnly: true,
    handlers: ALL_HANDLERS,
    actions: [],
  },
  {
    name: 'cancelled',
    task: task({ id: 'task-cancelled', title: 'Cancelled task', status: 'archived', cancelledAt: '2026-09-02T00:00:00.000Z' }),
    prioritiesEnabled: false,
    timeEstimatesEnabled: false,
    showStatusField: true,
    readOnly: false,
    handlers: ALL_HANDLERS,
    actions: [],
  },
  {
    name: 'cancelled without a status callback',
    task: task({ id: 'task-cancelled', title: 'Cancelled task', status: 'archived', cancelledAt: '2026-09-02T00:00:00.000Z' }),
    prioritiesEnabled: false,
    timeEstimatesEnabled: false,
    showStatusField: true,
    readOnly: false,
    handlers: NO_HANDLERS,
    actions: [],
  },
  {
    name: 'area only, features off, no status field',
    task: task({
      id: 'task-area',
      title: '   ',
      status: 'waiting',
      priority: 'urgent',
      areaId: 'a-home',
      startTime: '2026-09-27',
      dueDate: '2026-09-29T18:45:00.000Z',
      timeEstimate: '2hr',
      suppressMindwtrReminders: true,
      recurrence: { rule: 'monthly', strategy: 'fluid' },
      checklist: [{ id: 'x1', title: '', isCompleted: false }],
    }),
    prioritiesEnabled: false,
    timeEstimatesEnabled: false,
    showStatusField: false,
    readOnly: false,
    handlers: ALL_HANDLERS,
    actions: [['tick', 0], ['submit', 'second']],
  },
  {
    name: 'project area inherited, section missing',
    task: task({ id: 'task-inherit', title: 'Inherit', status: 'inbox', projectId: 'p-other', sectionId: 's-1', suppressMindwtrReminders: true, dueDate: '2026-09-30' }),
    prioritiesEnabled: true,
    timeEstimatesEnabled: true,
    showStatusField: true,
    readOnly: false,
    handlers: ALL_HANDLERS,
    actions: [],
  },
  {
    name: 'unknown project and area',
    task: task({ id: 'task-unknown', title: 'Unknown', status: 'someday', projectId: 'p-missing', areaId: 'a-missing', energyLevel: 'low' }),
    prioritiesEnabled: true,
    timeEstimatesEnabled: true,
    showStatusField: true,
    readOnly: false,
    handlers: NO_HANDLERS,
    actions: [],
  },
  {
    name: 'ended recurrence',
    task: task({
      id: 'task-ended',
      title: 'Ended',
      status: 'next',
      dueDate: '2026-09-20',
      recurrence: { rule: 'daily', strategy: 'strict', until: '2026-09-21' },
    }),
    prioritiesEnabled: true,
    timeEstimatesEnabled: true,
    showStatusField: true,
    readOnly: false,
    handlers: ALL_HANDLERS,
    actions: [],
  },
  {
    name: 'custom estimate and duplicate item ids',
    task: task({
      id: 'task-dupe',
      title: 'Dupes',
      status: 'next',
      timeEstimate: 'custom:45' as TimeEstimate,
      checklist: [{ id: 'same', title: 'One', isCompleted: false }, { id: 'same', title: 'Two', isCompleted: false }, { id: 'other', title: 'Three', isCompleted: true }],
    }),
    prioritiesEnabled: true,
    timeEstimatesEnabled: true,
    showStatusField: true,
    readOnly: false,
    handlers: ALL_HANDLERS,
    actions: [['tick', 0], ['tick', 2]],
  },
  {
    name: 'minimal',
    task: task({ id: 'task-min', title: 'Only a title', status: 'inbox' }),
    prioritiesEnabled: true,
    timeEstimatesEnabled: true,
    showStatusField: true,
    readOnly: false,
    handlers: ALL_HANDLERS,
    actions: [],
  },
];

type ChecklistFieldScenario = {
  name: string;
  checklist: Task['checklist'];

  draftStatus: Task['status'] | null;
  taskStatus: Task['status'];
  actions: unknown[][];
};

const THREE = [
  { id: 'k1', title: 'First', isCompleted: true },
  { id: 'k2', title: 'Second', isCompleted: false },
  { id: 'k3', title: '**Third**', isCompleted: false },
];

const checklistFieldScenarios: ChecklistFieldScenario[] = [
  {
    name: 'three items',
    checklist: THREE,
    draftStatus: 'next',
    taskStatus: 'next',
    actions: [
      ['toggle', 0], ['toggle', 1],
      ['change', 1, 'Renamed'],
      ['change', 1, 'line one\n- [x] two\n\n3. three\n  [ ]  '],
      ['change', 0, 'x\r\n[x] y'],
      ['change', 1, '\n\n'],
      ['submit', 0], ['submit', 2],
      ['remove', 0], ['remove', 2],
      ['add'],
      ['reset'],
      ['order'],
      ['orderMove', 1, 'up'], ['orderMove', 1, 'down'], ['orderMove', 0, 'down'], ['orderMove', 2, 'up'],
    ],
  },
  {
    name: 'reference list',
    checklist: THREE,
    draftStatus: 'reference',
    taskStatus: 'next',
    actions: [['change', 1, 'a\n[x] b\n- [ ] c'], ['change', 0, 'kept\n[x] done'], ['add'], ['submit', 1], ['order'], ['orderMove', 0, 'down']],
  },
  {
    name: 'with an empty item',
    checklist: [{ id: 'e1', title: 'Filled', isCompleted: false }, { id: 'e2', title: '   ', isCompleted: false }],
    draftStatus: 'inbox',
    taskStatus: 'inbox',
    actions: [['add'], ['submit', 1], ['submit', 0], ['order'], ['toggle', 1]],
  },
  {
    name: 'one item',
    checklist: [{ id: 'o1', title: 'Only', isCompleted: true }],
    draftStatus: 'done',
    taskStatus: 'done',
    actions: [['toggle', 0], ['add'], ['reset']],
  },
  {
    name: 'no items',
    checklist: [],
    draftStatus: 'next',
    taskStatus: 'next',
    actions: [['add']],
  },
  {
    name: 'no checklist, no draft, reference task',
    checklist: undefined,
    draftStatus: null,
    taskStatus: 'reference',
    actions: [['add']],
  },
];

type CascadeScenario = {
  name: string;
  taskMode: Task['taskMode'];
  taskStatus: Task['status'];

  draftStatus: Task['status'] | null;
  next: NonNullable<Task['checklist']>;
  canMutate: boolean;
};

const open = (id: string) => ({ id, title: id, isCompleted: false });
const done = (id: string) => ({ id, title: id, isCompleted: true });
const cascadeScenarios: CascadeScenario[] = [
  { name: 'task mode, all complete', taskMode: 'task', taskStatus: 'next', draftStatus: 'next', next: [done('a')], canMutate: true },
  { name: 'no mode, all complete', taskMode: undefined, taskStatus: 'next', draftStatus: 'next', next: [done('a')], canMutate: true },
  { name: 'list, all complete', taskMode: 'list', taskStatus: 'next', draftStatus: 'next', next: [done('a'), done('b')], canMutate: true },
  { name: 'list, all complete, already done', taskMode: 'list', taskStatus: 'next', draftStatus: 'done', next: [done('a')], canMutate: true },
  { name: 'list, one open, done', taskMode: 'list', taskStatus: 'done', draftStatus: 'done', next: [done('a'), open('b')], canMutate: true },
  { name: 'list, one open, inbox', taskMode: 'list', taskStatus: 'inbox', draftStatus: 'inbox', next: [open('a')], canMutate: true },
  { name: 'list, empty, done', taskMode: 'list', taskStatus: 'done', draftStatus: 'done', next: [], canMutate: true },
  { name: 'list, no draft, waiting task', taskMode: 'list', taskStatus: 'waiting', draftStatus: null, next: [done('a')], canMutate: true },
  { name: 'list, reference', taskMode: 'list', taskStatus: 'reference', draftStatus: 'reference', next: [done('a')], canMutate: true },
  { name: 'read-only', taskMode: 'list', taskStatus: 'next', draftStatus: 'next', next: [done('a')], canMutate: false },
];

type ResetScenario = {
  name: string;
  taskMode: Task['taskMode'];
  draftStatus: Task['status'];
  draftChecklist: Task['checklist'];
  storeResult: { success: boolean; error?: string };
};

const resetScenarios: ResetScenario[] = [
  { name: 'list task, done', taskMode: 'list', draftStatus: 'done', draftChecklist: [done('a'), open('b')], storeResult: { success: true } },
  { name: 'plain task', taskMode: 'task', draftStatus: 'next', draftChecklist: [done('a'), { id: 'n', title: '', isCompleted: true }], storeResult: { success: true } },
  { name: 'store refuses', taskMode: 'list', draftStatus: 'done', draftChecklist: [done('a')], storeResult: { success: false, error: 'Task not found' } },
  { name: 'empty draft checklist', taskMode: 'list', draftStatus: 'done', draftChecklist: [], storeResult: { success: true } },
];


type Json = ReactTestRendererJSON;
const tc = new Proxy({}, { get: (_target, key) => (typeof key === 'string' ? `tc.${key}` : undefined) }) as any;
const styleMarkers = new Proxy({}, { get: (_target, key) => (typeof key === 'string' ? { $style: key } : undefined) }) as any;

const flat = (style: unknown): Record<string, unknown> => {
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flat));
  return style && typeof style === 'object' ? style as Record<string, unknown> : {};
};
const styleNames = (style: unknown): string[] => {
  if (Array.isArray(style)) return style.flatMap(styleNames);
  return style && typeof style === 'object' && typeof (style as { $style?: unknown }).$style === 'string' ? [(style as { $style: string }).$style] : [];
};
const text = (node: Json | string | null | undefined): string => {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  return (node.children ?? []).map((child) => text(child as Json | string)).join('');
};
const elements = (node: Json): Json[] => (node.children ?? []).filter((child): child is Json => typeof child !== 'string');
const json = (value: unknown) => JSON.parse(JSON.stringify(value));


const press = (handler: (() => unknown) | undefined): unknown[][] => {
  const start = harness.log.length;
  act(() => {
    handler?.();
  });
  return json(harness.log.slice(start));
};

const INLINE_CODE_EDGE_SPACE = ' ';
const readInline = (children: Json['children']): unknown[] => (children ?? []).map((child) => {
  if (typeof child === 'string') return ['text', child];
  const style = flat(child.props.style);
  if (child.props.testID === 'markdown-inline-code') {
    const value = text(child);
    return ['code', value.startsWith(INLINE_CODE_EDGE_SPACE) && value.endsWith(INLINE_CODE_EDGE_SPACE) ? value.slice(1, -1) : value];
  }
  if (style.textDecorationLine === 'none') {
    const [struck, label] = elements(child);
    return ['deleted', text(struck), text(label)];
  }
  if (style.textDecorationLine === 'underline') return ['link', text(child), press(child.props.onPress)];
  if (style.textDecorationLine === 'line-through') return ['strike', text(child)];
  if (style.fontStyle === 'italic') return ['italic', text(child)];
  if (style.fontWeight === '700') return ['bold', text(child)];
  return ['unknown', child.type, text(child)];
});
const HEADING_LEVELS: Record<number, number> = { 16: 1, 15: 2, 14: 3 };
const readMarkdown = (container: Json): unknown[] => elements(container).map((block) => {
  const style = flat(block.props.style);
  if (block.type === 'View' && block.props.testID === 'markdown-blank-line') return ['blank'];
  if (block.type === 'Text') {
    if (style.fontWeight === '700' && style.lineHeight === 20) return ['heading', HEADING_LEVELS[style.fontSize as number], readInline(block.children)];
    return ['paragraph', readInline(block.children)];
  }
  if (style.marginVertical === 4) return ['rule'];
  if (style.paddingRight === 38) {
    const [copy, code] = elements(block);
    return ['code', text(code), copy.props.accessibilityLabel, press(copy.props.onPress)];
  }
  if (style.paddingLeft === 6) {
    const rows = elements(block).map((row) => {
      const [marker, item] = elements(row);
      return { marker: text(marker), wide: flat(marker.props.style).minWidth === 22, depth: (flat(row.props.style).marginLeft as number) / 14, inline: readInline(item.children) };
    });
    const kind = ['☑', '☐'].includes(rows[0]?.marker) ? 'task' : rows[0]?.wide ? 'ordered' : 'bullet';
    return ['list', kind, rows.map((row) => [row.marker, row.depth, row.inline])];
  }
  return ['unknown', block.type];
});

const readChecklistItem = (item: Json): unknown[] => {
  const [marker, title] = elements(item);
  const markerRead = marker.type === 'Icon' ? marker.props.name : text(marker);
  return [
    item.type === 'TouchableOpacity' ? 'tap' : 'static',
    markerRead,
    readInline(title.children),
    item.props.accessibilityLabel ?? null,
    item.props.accessibilityRole ?? null,
    item.props.accessibilityState?.checked ?? null,
  ];
};
const readAttachment = (card: Json): unknown[] => {
  const [content] = elements(card);
  const read = content.type === 'Image'
    ? ['image', content.props.source.uri]
    : ['file', ...elements(content).map((child) => (child.type === 'Text' ? text(child) : child.type))];
  return [card.props.disabled === true, read, press(card.props.onPress)];
};
const readViewTab = (scroll: Json): unknown[] => elements(scroll).map((child) => {
  const names = styleNames(child.props.style);
  if (names.includes('viewRow')) {
    const [label, value] = elements(child);
    const valueRead = value.type === 'TaskStatusBadge'
      ? ['badge', value.props.status, typeof value.props.onUpdate === 'function', typeof value.props.onBackdatedComplete === 'function']
      : text(value);
    const kind = styleNames(value.props.style).includes('viewTitleValue') ? 'title' : 'row';
    const tap = child.type === 'TouchableOpacity' ? [child.props.accessibilityLabel, press(child.props.onPress)] : null;
    return [kind, text(label), valueRead, tap];
  }
  if (names.includes('viewSection')) {
    const [label, body] = elements(child);
    const bodyNames = styleNames(body.props.style);
    if (bodyNames.includes('viewPillRow')) {
      return ['pills', text(label), elements(body).map((pill) => [text(pill), pill.type === 'TouchableOpacity' ? [pill.props.accessibilityLabel, press(pill.props.onPress)] : null])];
    }
    if (bodyNames.includes('viewCard')) return ['description', text(label), readMarkdown(elements(body)[0])];
    if (bodyNames.includes('viewChecklist')) {
      return ['checklist', text(label), elements(body).map((item) => (
        item.type === 'TextInput' ? ['input', item.props.placeholder, item.props.accessibilityLabel] : readChecklistItem(item)
      ))];
    }
    if (bodyNames.includes('viewAttachmentGrid')) return ['attachments', text(label), elements(body).map(readAttachment)];
  }
  return ['unknown', child.type];
});

const readChecklistField = (root: Json): unknown => {
  const [header, container] = elements(root);
  const [heading, toggle] = elements(header);
  const out: Record<string, unknown> = {
    label: text(heading),
    orderToggle: toggle ? [toggle.props.accessibilityLabel, text(toggle)] : null,
  };
  const [first] = elements(container);
  if (first?.props.testID === 'mobile-checklist-order-panel') {
    out.order = elements(first).map((row) => {
      const [title, controls] = elements(row);
      const [up, down] = elements(controls);
      const button = (node: Json) => [node.props.accessibilityLabel, node.props.disabled === true, elements(node)[0]?.props.color ?? null];
      return [text(title), flat(title.props.style).color, button(up), button(down)];
    });
    return out;
  }
  out.items = [];
  for (const child of elements(container)) {
    const names = styleNames(child.props.style);
    if (names.includes('checklistItem')) {
      const [marker, input, remove] = elements(child);
      const markerRead = marker.type === 'TouchableOpacity'
        ? ['checkbox', marker.props.accessibilityLabel, marker.props.accessibilityState?.checked, elements(elements(marker)[0]).length > 0]
        : ['bullet', text(marker)];
      (out.items as unknown[]).push([
        markerRead,
        input.props.value,
        flat(input.props.style).color,
        styleNames(input.props.style).includes('completedText'),
        input.props.accessibilityLabel,
        input.props.placeholder,
        text(remove),
      ]);
    } else if (child.props.testID === 'mobile-checklist-add-item') {
      out.add = text(child);
    } else if (names.includes('checklistActions')) {
      out.reset = text(elements(child)[0]);
    } else {
      (out.items as unknown[]).push(['unknown', child.type]);
    }
  }
  return out;
};


const tree = (renderer: { toJSON: () => unknown }) => JSON.stringify(renderer.toJSON());
const formatDate = (value: string) => formatTaskEditorDate(value, safeFormatDate, translate('common.notSet'));
const formatDueDate = (value: string) => formatTaskEditorDate(value, safeFormatDate, translate('common.notSet'), { due: true });

const isImageAttachment = (attachment: Attachment) => {
  const mime = attachment.mimeType?.toLowerCase();
  if (mime?.startsWith('image/')) return true;
  return /\.(png|jpg|jpeg|gif|webp|heic|heif)$/i.test(attachment.uri);
};
const nodeMock = () => ({
  blur: () => { harness.log.push(['blur']); },
  focus: () => { harness.log.push(['focus']); },
});

function renderMarkdown(scenario: MarkdownScenario) {
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(scenario.inline
      ? <MarkdownInlineText markdown={scenario.markdown} tc={tc} direction={scenario.direction} style={styleMarkers.inlineText} numberOfLines={scenario.inline.numberOfLines} />
      : <MarkdownText markdown={scenario.markdown} tc={tc} direction={scenario.direction ?? 'ltr'} selectable={scenario.selectable} />);
  });
  const root = renderer.toJSON() as Json;
  const out = {
    tree: tree(renderer),
    read: scenario.inline ? readInline(root.children) : readMarkdown(root),
  };
  act(() => renderer.unmount());
  return out;
}

function renderViewTab(scenario: ViewTabScenario, pendingRef: { current: string }) {
  const record = (name: string) => (...args: unknown[]) => { harness.log.push([name, ...args]); };
  let renderer!: ReturnType<typeof create>;
  const visibleAttachments = (scenario.task.attachments ?? []).filter((attachment) => !attachment.deletedAt);
  act(() => {
    renderer = create(
      <TaskEditViewTab
        t={translate}
        tc={tc}
        styles={styleMarkers}
        mergedTask={scenario.task}
        projects={STORE.projects.filter((item) => !item.deletedAt)}
        sections={SECTIONS.filter((section) => section.projectId === scenario.task.projectId)}
        areas={AREAS}
        prioritiesEnabled={scenario.prioritiesEnabled}
        timeEstimatesEnabled={scenario.timeEstimatesEnabled}
        formatTimeEstimateLabel={(value) => formatTimeEstimateLabel(value, { t: translate })}
        formatDate={formatDate}
        formatDueDate={formatDueDate}
        getRecurrenceRuleValue={() => ''}
        getRecurrenceStrategyValue={() => 'strict'}
        applyChecklistUpdate={record('applyChecklistUpdate')}
        pendingChecklistDraftRef={pendingRef}
        visibleAttachments={visibleAttachments}
        openAttachment={(attachment) => { harness.log.push(['openAttachment', attachment.id]); }}
        isImageAttachment={isImageAttachment}
        textDirectionStyle={{ writingDirection: 'ltr', textAlign: 'left' }}
        resolvedDirection="ltr"
        nestedScrollEnabled
        onProjectPress={scenario.handlers.project ? record('onProjectPress') : undefined}
        onContextPress={scenario.handlers.context ? record('onContextPress') : undefined}
        onTagPress={scenario.handlers.tag ? record('onTagPress') : undefined}
        onBackdatedComplete={scenario.handlers.status ? record('onBackdatedComplete') : undefined}
        onStatusUpdate={scenario.handlers.status ? record('onStatusUpdate') : undefined}
        showStatusField={scenario.showStatusField}
        readOnly={scenario.readOnly}
      />,
      { createNodeMock: nodeMock },
    );
  });
  return renderer;
}

async function runViewTab(scenario: ViewTabScenario) {
  const fresh = () => {
    harness.uuid = 0;
    const pendingRef = { current: '' };
    return { pendingRef, renderer: renderViewTab(scenario, pendingRef) };
  };
  const { renderer } = fresh();
  const out: Record<string, unknown> = {
    tree: tree(renderer),
    read: readViewTab(renderer.toJSON() as Json),
  };
  act(() => renderer.unmount());
  const checklistItems = (renderer2: ReturnType<typeof create>) => renderer2.root.findAll((node) => (
    typeof node.type === 'string' && styleNames(node.props.style).includes('viewChecklistItem')
  ));
  const addInput = (renderer2: ReturnType<typeof create>) => renderer2.root.findAll((node) => (node.type as unknown) === 'TextInput')[0];
  out.actions = [];
  for (const action of scenario.actions) {
    const { renderer: current, pendingRef } = fresh();
    const start = harness.log.length;
    const [kind, arg] = action as [string, unknown];
    if (kind === 'tick') {
      act(() => { checklistItems(current)[arg as number].props.onPress(); });
    } else if (kind === 'type') {
      act(() => { addInput(current).props.onChangeText(arg); });
    } else if (kind === 'submit') {
      act(() => { addInput(current).props.onChangeText(arg); });
      act(() => { addInput(current).props.onSubmitEditing(); });
    } else if (kind === 'attachment') {
      const cards = current.root.findAll((node) => typeof node.type === 'string' && styleNames(node.props.style).includes('viewAttachmentCard'));
      act(() => { cards[arg as number].props.onPress(); });
    }
    (out.actions as unknown[]).push([action, json(harness.log.slice(start)), pendingRef.current, addInput(current)?.props.value ?? null]);
    act(() => current.unmount());
  }
  return out;
}

function renderChecklistField(scenario: ChecklistFieldScenario) {
  const record = (name: string) => (...args: unknown[]) => { harness.log.push([name, ...args]); };
  const editedTask = task({ id: 'task-field', title: 'Field task', status: scenario.taskStatus, checklist: scenario.checklist });
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(
      <TaskEditContentField
        {...({} as any)}
        fieldId="checklist"
        applyChecklistUpdate={record('applyChecklistUpdate')}
        handleResetChecklist={record('handleResetChecklist')}
        handleInputFocus={() => undefined}
        checklist={scenario.checklist}
        draft={scenario.draftStatus ? { status: scenario.draftStatus } : null}
        task={editedTask}
        styles={styleMarkers}
        t={translate}
        tc={tc}
        titleDraft="Field task"
        descriptionDraft=""
        language="en"
        visibleAttachments={[]}
      />,
      { createNodeMock: nodeMock },
    );
  });
  return renderer;
}


function withoutChecklistDragAffordance(node: Json): Json {
  if (String(node.props.testID ?? '').startsWith('mobile-checklist-row-')) {
    return withoutChecklistDragAffordance(elements(node)[0]);
  }
  const props = { ...node.props };
  if (styleNames(node.props.style).includes('checklistContainer')) delete props.ref;
  return { ...node, props, children: node.children?.filter((child) => typeof child === 'string'
    || !String(child.props.testID ?? '').startsWith('mobile-checklist-drag-'))
    .map((child) => typeof child === 'string' ? child : withoutChecklistDragAffordance(child)) ?? node.children };
}

function runChecklistField(scenario: ChecklistFieldScenario) {
  const fresh = () => {
    harness.uuid = 0;
    return renderChecklistField(scenario);
  };
  const renderer = fresh();
  const projected = withoutChecklistDragAffordance(renderer.toJSON() as Json);
  const out: Record<string, unknown> = { tree: JSON.stringify(projected), read: readChecklistField(projected) };
  act(() => renderer.unmount());
  const rows = (current: ReturnType<typeof create>) => current.root.findAll((node) => (
    typeof node.type === 'string' && styleNames(node.props.style).includes('checklistItem')
  ));
  const byTestId = (current: ReturnType<typeof create>, testID: string) => current.root.findAll((node) => typeof node.type === 'string' && node.props.testID === testID)[0];
  out.actions = [];
  for (const action of scenario.actions) {
    const current = fresh();
    const start = harness.log.length;
    const [kind, index, value] = action as [string, number, string];
    let after: unknown = null;
    const row = () => rows(current)[index];
    const hostChildren = (node: any) => node.children.filter((child: any) => typeof child !== 'string'
      && !String(child.props.testID ?? '').startsWith('mobile-checklist-drag-'));
    if (kind === 'toggle') {
      act(() => { hostChildren(row())[0].props.onPress?.(); });
    } else if (kind === 'change') {
      act(() => { hostChildren(row())[1].props.onChangeText(value); });
    } else if (kind === 'submit') {
      act(() => { hostChildren(row())[1].props.onSubmitEditing(); });
    } else if (kind === 'remove') {
      act(() => { hostChildren(row())[2].props.onPress(); });
    } else if (kind === 'add') {
      act(() => { byTestId(current, 'mobile-checklist-add-item')?.props.onPress(); });
    } else if (kind === 'reset') {
      const actions = current.root.findAll((node) => typeof node.type === 'string' && styleNames(node.props.style).includes('checklistActionButton'))[0];
      act(() => { actions?.props.onPress(); });
    } else if (kind === 'order' || kind === 'orderMove') {
      act(() => { byTestId(current, 'mobile-checklist-order-toggle')?.props.onPress(); });
      after = readChecklistField(current.toJSON() as Json);
      if (kind === 'orderMove') {
        const items = (scenario.checklist ?? []);
        const key = items[index]?.id || `index:${index}`;
        act(() => { byTestId(current, `mobile-checklist-move-${value}-${key}`)?.props.onPress(); });
        after = null;
      }
    }
    (out.actions as unknown[]).push([action, json(harness.log.slice(start)), after]);
    act(() => current.unmount());
  }
  return out;
}

type ActionsProbe = { apply: (next: NonNullable<Task['checklist']>) => void; reset: () => Promise<void> };
function ActionsHarness({ scenario, probe }: {
  scenario: { taskMode: Task['taskMode']; taskStatus: Task['status']; draftStatus: Task['status'] | null; draftChecklist?: Task['checklist']; canMutate: boolean; storeResult?: { success: boolean; error?: string } };
  probe: { current: ActionsProbe | null };
}) {
  const record = (name: string) => (...args: unknown[]) => { harness.log.push([name, ...json(args)]); };
  const editedTask = task({ id: 'task-actions', title: 'Actions', status: scenario.taskStatus, taskMode: scenario.taskMode, checklist: scenario.draftChecklist });
  const actions = useTaskEditActions({
    aiEnabled: false,
    closeAIModal: () => undefined,
    deleteTask: async () => ({ success: true }),
    descriptionDraft: '',
    draftLifecycle: {} as any,
    duplicateTask: async () => ({ success: true }),
    mergedTask: editedTask,
    taskEditDraft: scenario.draftStatus
      ? { draft: { status: scenario.draftStatus } as any, checklist: scenario.draftChecklist, attachments: undefined }
      : null,
    formatDate: () => '',
    formatDueDate: () => '',
    formatTimeEstimateLabel: () => '',
    isAIWorking: false,
    onClose: () => undefined,
    prioritiesEnabled: true,
    resetTaskChecklist: async (id: string) => {
      harness.log.push(['resetTaskChecklist', id]);
      return scenario.storeResult ?? { success: true };
    },
    skipRecurringTaskOccurrence: async () => ({ success: true }),
    restoreTask: async () => ({ success: true }),
    setAiModal: () => undefined,
    setChecklist: record('setChecklist') as any,
    setDraftField: record('setDraftField') as any,
    setIsAIWorking: () => undefined,
    setTitleImmediate: () => undefined,
    settings: {},
    showToast: (options) => { harness.log.push(['showToast', options.tone, options.title, options.message]); },
    t: translate,
    task: editedTask,
    tasks: [editedTask],
    timeEstimatesEnabled: true,
    titleDraftRef: { current: 'Actions' },
    canMutate: () => scenario.canMutate,
  });
  probe.current = { apply: actions.applyChecklistUpdate, reset: actions.handleResetChecklist };
  return null;
}

async function runActions(scenario: Parameters<typeof ActionsHarness>[0]['scenario'], run: (probe: ActionsProbe) => unknown) {
  const probe = { current: null as ActionsProbe | null };
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(<ActionsHarness scenario={scenario} probe={probe} />);
  });
  const start = harness.log.length;
  await act(async () => {
    await run(probe.current as ActionsProbe);
  });
  const calls = json(harness.log.slice(start));
  act(() => renderer.unmount());
  return calls;
}


const inputs = () => json({
  now: NOW,
  timeZone: 'UTC',
  store: { tasks: STORE.tasks, projects: STORE.projects, sections: SECTIONS, areas: AREAS },
  markdownScenarios,
  viewTabScenarios,
  checklistFieldScenarios,
  cascadeScenarios,
  resetScenarios,
}) as Record<string, unknown>;

function captureProvenance() {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: new URL('.', import.meta.url).pathname, encoding: 'utf8' });
  const head = git('rev-parse', 'HEAD').trim();
  const harnessPath = 'apps/mobile/components/task-edit/TaskEditViewTab.parity.test.tsx';
  const changed = git('status', '--porcelain', '--untracked-files=all', '--', '../../../../apps').split('\n').filter(Boolean)
    .map((line) => line.slice(3)).filter((path) => path !== harnessPath);
  if (changed.length > 0) throw new Error(`Capture needs HEAD's apps/ code; changed: ${changed.join(', ')}`);
  return {
    command: 'cd apps/mobile && MINDWTR_CAPTURE_TASK_VIEW=1 TZ=UTC bunx vitest run components/task-edit/TaskEditViewTab.parity.test.tsx',
    capturedAt: head,
    sourceState: 'Every file under apps/ and packages/ was at HEAD except this harness and this fixture.',
    rendering: 'react-test-renderer over the apps/mobile react-native shim (host elements by name). Styles passed as props and theme colors are named markers; markdown-text.tsx keeps its own styles. Lucide icons render as Icon elements with their name. generateUUID returns uuid-1, uuid-2, ... from each fresh render. The clock is pinned to `now`, TZ is UTC, strings are English.',
  };
}

describe('React Native task View tab and checklist parity fixture', () => {
  const originalTz = process.env.TZ;
  beforeAll(async () => {
    process.env.TZ = 'UTC';
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
    harness.strings = await loadTranslations('en');
    useTaskStore.setState({ _allTasks: STORE.tasks, _allProjects: STORE.projects } as never);
  }, 30_000);
  afterAll(() => {
    vi.useRealTimers();
    resetForTests();
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it('replays every scenario exactly as frozen', async () => {
    const observations: Record<string, Record<string, unknown>> = { markdown: {}, viewTab: {}, checklistField: {}, cascade: {}, reset: {} };
    for (const scenario of markdownScenarios) observations.markdown[scenario.name] = renderMarkdown(scenario);
    for (const scenario of viewTabScenarios) observations.viewTab[scenario.name] = await runViewTab(scenario);
    for (const scenario of checklistFieldScenarios) observations.checklistField[scenario.name] = runChecklistField(scenario);
    for (const scenario of cascadeScenarios) {
      observations.cascade[scenario.name] = await runActions(scenario, (probe) => probe.apply(scenario.next));
    }
    for (const scenario of resetScenarios) {
      observations.reset[scenario.name] = await runActions({
        taskMode: scenario.taskMode,
        taskStatus: scenario.draftStatus,
        draftStatus: scenario.draftStatus,
        draftChecklist: scenario.draftChecklist,
        canMutate: true,
        storeResult: scenario.storeResult,
      }, (probe) => probe.reset());
    }
    if (CAPTURE) {
      writeFileSync(FIXTURE_PATH, `${JSON.stringify({ provenance: captureProvenance(), ...inputs(), observations }, null, 1)}\n`);
    }
    const { observations: frozen, provenance: _provenance, ...frozenInputs } = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
    expect(frozenInputs).toEqual(inputs());
    for (const group of Object.keys(observations)) {
      for (const name of Object.keys(observations[group])) {
        expect({ [group]: { [name]: observations[group][name] } }).toEqual({ [group]: { [name]: frozen[group][name] } });
      }
      expect(Object.keys(frozen[group])).toEqual(Object.keys(observations[group]));
    }
  }, 180_000);
});
