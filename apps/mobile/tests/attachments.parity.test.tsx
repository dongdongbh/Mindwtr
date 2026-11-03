


import React from 'react';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { Alert } from 'react-native';
import { act, create } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadTranslations, type Attachment, type Project, type Task } from '@mindwtr/core';

import { useTaskEditAttachments } from '@/components/task-edit/use-task-edit-attachments';
import { useProjectAttachments } from '@/components/projects-screen/use-project-attachments';

const FIXTURE_PATH = new URL('../../../packages/core/src/attachments-parity.fixtures.json', import.meta.url).pathname;
const CAPTURE = process.env.MINDWTR_CAPTURE_ATTACHMENTS === '1';
const CAPTURE_ONLY = process.env.MINDWTR_CAPTURE_ATTACHMENTS_SCENARIOS?.split('|').filter(Boolean) ?? [];

type Ports = {
  sandbox?: boolean;
  pickDocument?: unknown;
  pickImage?: unknown;
  persist?: 'copy' | 'unreadable';
  ensure?: unknown;
  viewer?: boolean;
  shareAvailable?: boolean;
  openUrlFails?: boolean;
};
type Step = { action: string; ports?: Ports };
type Scenario = {
  name: string;
  surface: 'task' | 'project';
  attachments: Attachment[];

  stored?: Attachment[];
  projectStatus?: Project['status'];
  steps: Step[];
};

const harness = vi.hoisted(() => ({
  ports: {} as Record<string, unknown>,
  log: [] as unknown[][],
  ids: 0,
  state: {
    tasks: [] as unknown[],
    _allTasks: [] as unknown[],
    projects: [] as unknown[],
    _allProjects: [] as unknown[],
    settings: {} as Record<string, unknown>,
  },
}));

vi.mock('@mindwtr/core', async (importOriginal) => {
  const { mockCore } = await import('../test-support/mock-core');
  return mockCore(importOriginal, () => harness.state, {
    generateUUID: () => `00000000-0000-4000-8000-${String(++harness.ids).padStart(12, '0')}`,
    isSandboxMode: () => harness.ports.sandbox === true,
  });
});
vi.mock('@/lib/attachment-sync', () => ({
  deleteManagedAttachmentFile: async (attachment: unknown) => { harness.log.push(['deleteManagedAttachmentFile', attachment]); },
  persistAttachmentLocally: async (attachment: { id: string; title: string; uri: string }) => {
    harness.log.push(['persistAttachmentLocally', attachment]);
    if (harness.ports.persist === 'unreadable') return attachment;
    const extension = /\.[a-z0-9]+$/i.exec(attachment.title)?.[0] ?? '';
    return { ...attachment, uri: `file:///data/files/attachments/${attachment.id}${extension}`, localStatus: 'available' };
  },
}));
vi.mock('@/lib/attachment-sync-availability', async () => {
  const real = await import('@mindwtr/core/mobile-attachment-availability');
  return {
    getAttachmentAvailabilityPatch: real.getAttachmentAvailabilityPatch,
    getAttachmentDownloadIdentity: real.getAttachmentDownloadIdentity,
    getAttachmentUnrecoverablePatch: real.getAttachmentUnrecoverablePatch,
    hasAttachmentDownloadIdentity: real.hasAttachmentDownloadIdentity,
    ensureAttachmentAvailableDetailed: async (attachment: unknown) => {
      harness.log.push(['ensureAttachmentAvailableDetailed', attachment]);
      return harness.ports.ensure ?? { status: 'available', attachment };
    },
  };
});
vi.mock('expo-document-picker', () => ({
  getDocumentAsync: async (options: unknown) => {
    harness.log.push(['getDocumentAsync', options]);
    return harness.ports.pickDocument ?? { canceled: true, assets: [] };
  },
}));
vi.mock('expo-image-picker', () => ({
  MediaTypeOptions: { Images: 'Images' },
  getMediaLibraryPermissionsAsync: async () => ({ granted: true }),
  requestMediaLibraryPermissionsAsync: async () => ({ granted: true }),
  launchImageLibraryAsync: async (options: unknown) => {
    harness.log.push(['launchImageLibraryAsync', options]);
    return harness.ports.pickImage ?? { canceled: true, assets: [] };
  },
}));
vi.mock('expo-linking', () => ({
  openURL: async (uri: string) => {
    harness.log.push(['openURL', uri]);
    if (harness.ports.openUrlFails) throw new Error('No Activity found to handle Intent');
  },
}));
vi.mock('expo-sharing', () => ({
  isAvailableAsync: async () => {
    harness.log.push(['sharingAvailable']);
    return harness.ports.shareAvailable === true;
  },
  shareAsync: async (uri: string) => { harness.log.push(['shareAsync', uri]); },
}));
vi.mock('@/lib/open-file-externally', () => ({
  tryOpenWithAndroidViewer: async (uri: string, mimeType?: string) => {
    harness.log.push(['tryOpenWithAndroidViewer', uri, mimeType ?? null]);
    return harness.ports.viewer === true;
  },
}));
vi.mock('expo-audio', () => ({
  setAudioModeAsync: async () => undefined,
  useAudioPlayer: () => ({
    pause: () => undefined,
    play: () => { harness.log.push(['audioPlay']); },
    replace: (source: unknown) => { if (source) harness.log.push(['audioReplace', source]); },
    seekTo: () => undefined,
  }),
  useAudioPlayerStatus: () => ({ isLoaded: false }),
}));
vi.mock('expo-file-system', () => ({ Paths: { info: () => ({ exists: true, isDirectory: false }) } }));
vi.mock('@/lib/ai-config', () => ({ loadAIKey: async () => '' }));
vi.mock('@/lib/speech-to-text', () => ({
  ensureWhisperModelPathForConfigAsync: async () => null,
  processAudioCapture: async () => ({}),
  resolveSpeechToTextRuntimeSettings: () => ({ enabled: false }),
}));
vi.mock('@/lib/speech-to-text.helpers', () => ({ normalizeAudioUri: (value: string) => value }));
vi.mock('@/lib/app-log', () => ({
  logError: async (error: unknown, context?: { extra?: unknown }) => {
    harness.log.push(['logError', error instanceof Error ? error.message : String(error), context?.extra ?? null]);
  },
  logWarn: async (message: string, context?: { extra?: unknown }) => {
    harness.log.push(['logWarn', message, context?.extra ?? null]);
  },
}));

const NOW = '2026-09-30T10:00:00.000Z';
const CREATED = '2026-09-01T00:00:00.000Z';
const TASK_ID = 'task-1';
const PROJECT_ID = 'project-1';

const file = (id: string, fields: Partial<Attachment> = {}): Attachment => ({
  id, kind: 'file', title: `${id}.pdf`, uri: `file:///data/files/attachments/${id}.pdf`, mimeType: 'application/pdf',
  size: 2048, localStatus: 'available', createdAt: CREATED, updatedAt: CREATED, ...fields,
});
const link = (id: string, uri: string, title = uri): Attachment => ({
  id, kind: 'link', title, uri, createdAt: CREATED, updatedAt: CREATED,
});

const remote = (id: string, fields: Partial<Attachment> = {}): Attachment => file(id, {
  uri: '', localStatus: 'missing', cloudKey: `attachments/${id}.pdf`, fileHash: 'a'.repeat(64), contentRev: 1, ...fields,
});
const pickedPdf = { canceled: false, assets: [{ name: 'Report.pdf', uri: 'content://picker/report', mimeType: 'application/pdf', size: 1234 }] };
const downloaded = (attachment: Attachment) => ({
  status: 'available',
  attachment: { ...attachment, uri: `file:///data/files/attachments/${attachment.id}.pdf`, localStatus: 'available' },
});

const BASE = [link('link-old', 'https://old.example/doc', 'Old doc'), file('file-1')];

export const scenarios: Scenario[] = [
  { name: 'task: add a file', surface: 'task', attachments: BASE, steps: [{ action: 'addFile', ports: { pickDocument: pickedPdf } }] },
  { name: 'task: a canceled file pick adds nothing', surface: 'task', attachments: BASE, steps: [{ action: 'addFile' }] },
  {
    name: 'task: a file too large is refused', surface: 'task', attachments: BASE,
    steps: [{ action: 'addFile', ports: { pickDocument: { canceled: false, assets: [{ name: 'Huge.zip', uri: 'content://picker/huge', mimeType: 'application/zip', size: 60 * 1024 * 1024 }] } } }],
  },
  {
    name: 'task: a blocked file type is refused', surface: 'task', attachments: BASE,
    steps: [{ action: 'addFile', ports: { pickDocument: { canceled: false, assets: [{ name: 'run.exe', uri: 'content://picker/run', mimeType: 'application/x-msdownload', size: 10 }] } } }],
  },
  {
    name: 'task: a file without a size or name is still added', surface: 'task', attachments: [],
    steps: [{ action: 'addFile', ports: { pickDocument: { canceled: false, assets: [{ name: '', uri: 'content://picker/blob', mimeType: undefined }] } } }],
  },
  {
    name: 'task: a file that cannot be read is refused', surface: 'task', attachments: BASE,
    steps: [{ action: 'addFile', ports: { pickDocument: pickedPdf, persist: 'unreadable' } }],
  },
  {
    name: 'task: add an image', surface: 'task', attachments: BASE,
    steps: [{ action: 'addImage', ports: { pickImage: { canceled: false, assets: [{ fileName: 'Photo.jpg', uri: 'file:///cache/ImagePicker/photo.jpg', mimeType: 'image/jpeg', fileSize: 4096 }] } } }],
  },
  {
    name: 'task: an image without a name takes its file name, and only fileSize is kept', surface: 'task', attachments: [],
    steps: [{ action: 'addImage', ports: { pickImage: { canceled: false, assets: [{ fileName: null, uri: 'file:///cache/ImagePicker/IMG_7.heic', mimeType: 'image/heic', size: 512 }] } } }],
  },
  { name: 'task: sandbox refuses every attachment action', surface: 'task', attachments: BASE, steps: [
    { action: 'addFile', ports: { sandbox: true, pickDocument: pickedPdf } },
    { action: 'addImage', ports: { sandbox: true } },
    { action: 'openAddLink', ports: { sandbox: true } },
    { action: 'open:file-1', ports: { sandbox: true } },
    { action: 'download:file-1', ports: { sandbox: true } },
  ] },
  { name: 'task: add links, one per line, with titles', surface: 'task', attachments: BASE, steps: [
    { action: 'openAddLink' },
    { action: 'setLinkInput:https://one.example\n\nTwo | https://two.example/x\n[Three](www.three.example)' },
    { action: 'confirmLink' },
  ] },
  { name: 'task: a file path line is not a link', surface: 'task', attachments: BASE, steps: [
    { action: 'openAddLink' },
    { action: 'setLinkInput:https://one.example\n/Users/me/notes.md' },
    { action: 'confirmLink' },
  ] },
  { name: 'task: an invalid line refuses the whole paste', surface: 'task', attachments: BASE, steps: [
    { action: 'openAddLink' },
    { action: 'setLinkInput:https://three.example\ninvalid line' },
    { action: 'confirmLink' },
    { action: 'closeLinkModal' },
  ] },
  { name: 'task: an empty link marks the field touched', surface: 'task', attachments: BASE, steps: [
    { action: 'openAddLink' },
    { action: 'setLinkInput:   ' },
    { action: 'confirmLink' },
  ] },
  { name: 'task: edit a link', surface: 'task', attachments: BASE, steps: [
    { action: 'editLink:link-old' },
    { action: 'setLinkInput:New title | https://new.example/page' },
    { action: 'confirmLink' },
    { action: 'editLink:file-1' },
  ] },
  { name: 'task: an invalid edited link is refused', surface: 'task', attachments: [link('link-bare', 'https://bare.example')], steps: [
    { action: 'editLink:link-bare' },
    { action: 'setLinkInput:not a link' },
    { action: 'confirmLink' },
  ] },
  { name: 'task: remove a synced attachment', surface: 'task', attachments: [file('file-synced', { cloudKey: 'attachments/file-synced.pdf', fileHash: 'b'.repeat(64) }), ...BASE], steps: [
    { action: 'remove:file-synced' },
  ] },
  { name: 'task: open a missing file downloads it first', surface: 'task', attachments: [remote('remote-1')], steps: [
    { action: 'open:remote-1', ports: { ensure: downloaded(remote('remote-1')) } },
  ] },
  { name: 'task: open a missing file through the share sheet', surface: 'task', attachments: [remote('remote-2')], steps: [
    { action: 'open:remote-2', ports: { ensure: downloaded(remote('remote-2')), shareAvailable: true } },
  ] },
  { name: 'task: a failed download keeps the file missing', surface: 'task', attachments: [remote('remote-3')], steps: [
    { action: 'download:remote-3', ports: { ensure: { status: 'unavailable' } } },
    { action: 'open:remote-3', ports: { ensure: { status: 'unavailable' } } },
  ] },
  { name: 'task: a download conflict', surface: 'task', attachments: [remote('remote-4')], steps: [
    { action: 'download:remote-4', ports: { ensure: { status: 'generation-conflict' } } },
  ] },
  { name: 'task: a file the remote no longer has', surface: 'task', attachments: [remote('remote-5')], steps: [
    { action: 'download:remote-5', ports: { ensure: { status: 'unrecoverable', attachment: { ...remote('remote-5'), cloudKey: undefined, fileHash: undefined, deletedAt: NOW, updatedAt: NOW } } } },
  ] },
  { name: 'task: a download for an attachment the draft no longer matches is dropped', surface: 'task', attachments: [remote('remote-6')], stored: [remote('remote-6', { contentRev: 2 })], steps: [
    { action: 'download:remote-6', ports: { ensure: downloaded(remote('remote-6')) } },
  ] },
  { name: 'task: open links', surface: 'task', attachments: [
    link('web', 'https://example.com/doc'),
    link('desktop', 'D:\\Docs\\a$&b$$.docx'),
    link('file-url', 'file:///home/me/report.pdf'),
  ], steps: [
    { action: 'open:web' },
    { action: 'open:web', ports: { openUrlFails: true } },
    { action: 'open:desktop' },
    { action: 'open:file-url' },
  ] },
  { name: 'task: open an image, an audio file and a document', surface: 'task', attachments: [
    file('image-1', { title: 'Photo.png', uri: 'file:///data/files/attachments/image-1.png', mimeType: 'image/png' }),
    file('audio-1', { title: 'Memo.m4a', uri: 'file:///data/files/attachments/audio-1.m4a', mimeType: undefined }),
    file('doc-1', { mimeType: undefined }),
  ], steps: [
    { action: 'open:image-1' },
    { action: 'open:audio-1' },
    { action: 'open:doc-1', ports: { viewer: true } },
    { action: 'open:doc-1', ports: { openUrlFails: true } },
  ] },
  { name: 'project: add a file', surface: 'project', attachments: BASE, steps: [{ action: 'addFile', ports: { pickDocument: pickedPdf } }] },
  { name: 'project: a file that cannot be read is refused', surface: 'project', attachments: BASE, steps: [
    { action: 'addFile', ports: { pickDocument: pickedPdf, persist: 'unreadable' } },
  ] },
  { name: 'project: a file too large is refused', surface: 'project', attachments: BASE, steps: [
    { action: 'addFile', ports: { pickDocument: { canceled: false, assets: [{ name: 'Huge.zip', uri: 'content://picker/huge', mimeType: 'application/zip', size: 60 * 1024 * 1024 }] } } },
  ] },
  { name: 'project: add links', surface: 'project', attachments: BASE, steps: [
    { action: 'setLinkInput:https://one.example\nTwo | https://two.example' },
    { action: 'confirmLink' },
    { action: 'setLinkInput:https://three.example\ninvalid line' },
    { action: 'confirmLink' },
  ] },
  { name: 'project: an archived project takes nothing', surface: 'project', attachments: BASE, projectStatus: 'archived', steps: [
    { action: 'addFile', ports: { pickDocument: pickedPdf } },
    { action: 'setLinkInput:https://one.example' },
    { action: 'confirmLink' },
    { action: 'remove:file-1' },
    { action: 'open:file-1' },
  ] },
  { name: 'project: remove a synced attachment', surface: 'project', attachments: [file('file-synced', { cloudKey: 'attachments/file-synced.pdf', fileHash: 'b'.repeat(64) }), ...BASE], steps: [
    { action: 'remove:file-synced' },
  ] },
  { name: 'project: open a missing file downloads it first', surface: 'project', attachments: [remote('remote-1')], steps: [
    { action: 'open:remote-1', ports: { ensure: downloaded(remote('remote-1')) } },
  ] },
  { name: 'project: a failed download keeps the file missing', surface: 'project', attachments: [remote('remote-3')], steps: [
    { action: 'download:remote-3', ports: { ensure: { status: 'unavailable' } } },
  ] },
  { name: 'project: a file the remote no longer has', surface: 'project', attachments: [remote('remote-5')], steps: [
    { action: 'download:remote-5', ports: { ensure: { status: 'unrecoverable', attachment: { ...remote('remote-5'), cloudKey: undefined, fileHash: undefined, deletedAt: NOW, updatedAt: NOW } } } },
  ] },
  { name: 'project: open links, an image and a document', surface: 'project', attachments: [
    link('web', 'https://example.com/doc'),
    link('desktop', 'D:\\Docs\\a.docx'),
    file('image-1', { title: 'Photo.png', uri: 'file:///data/files/attachments/image-1.png', mimeType: 'image/png' }),
    file('doc-1'),
  ], steps: [
    { action: 'open:web', ports: { openUrlFails: true } },
    { action: 'open:desktop' },
    { action: 'open:image-1' },
    { action: 'open:doc-1', ports: { shareAvailable: true } },
  ] },
];

type TaskApi = ReturnType<typeof useTaskEditAttachments> & { draft: Attachment[] };
type ProjectApi = ReturnType<typeof useProjectAttachments> & { project: Project | null };

let strings: Record<string, string> = {};
const t = (key: string) => strings[key] ?? key;

function TaskHarness({ initial, expose }: { initial: Attachment[]; expose: { current: TaskApi | null } }) {
  const [draft, setDraft] = React.useState<Attachment[]>(initial);
  const setAttachments = React.useCallback((
    value: Attachment[] | undefined | ((current: Attachment[] | undefined) => Attachment[] | undefined),
    markDirty?: boolean,
  ) => {
    harness.log.push(['setAttachments', markDirty ?? null]);
    setDraft((current) => (typeof value === 'function' ? value(current) : value) ?? []);
  }, []);
  const hook = useTaskEditAttachments({
    attachments: draft,
    setAttachments: setAttachments as never,
    setDraftField: (() => undefined) as never,
    taskId: TASK_ID,
    t,
    visible: true,
  });
  expose.current = { ...hook, draft };
  return null;
}

function ProjectHarness({ initial, expose }: { initial: Project; expose: { current: ProjectApi | null } }) {
  const [project, setProject] = React.useState<Project | null>(initial);
  const updateProject = React.useCallback((id: string, updates: Partial<Project>) => {
    harness.log.push(['updateProject', id, updates]);
    harness.state._allProjects = (harness.state._allProjects as Project[]).map((entry) => (entry.id === id ? { ...entry, ...updates } : entry));
    harness.state.projects = harness.state._allProjects;
  }, []);
  const setSelectedProject = React.useCallback((next: Project | null) => {
    harness.log.push(['setSelectedProject', next?.id ?? null]);
    setProject(next);
  }, []);
  const hook = useProjectAttachments({
    selectedProject: project,
    setSelectedProject,
    updateProject,
    t,
    logProjectError: (message, error) => { harness.log.push(['logProjectError', message, error instanceof Error ? error.message : String(error ?? '')]); },
  });
  expose.current = { ...hook, project };
  return null;
}

const settle = async () => {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
};

async function runScenario(scenario: Scenario) {
  harness.ids = 0;
  harness.ports = {};
  const stored = scenario.stored ?? scenario.attachments;
  const project: Project = {
    id: PROJECT_ID, title: 'Project', status: scenario.projectStatus ?? 'active', color: '#3b82f6', order: 0, tagIds: [],
    attachments: stored, createdAt: CREATED, updatedAt: CREATED,
  };
  const task: Task = {
    id: TASK_ID, title: 'Task', status: 'next', tags: [], contexts: [], attachments: stored, createdAt: CREATED, updatedAt: CREATED,
  };
  harness.state.tasks = [task];
  harness.state._allTasks = [task];
  harness.state.projects = [{ ...project, attachments: stored }];
  harness.state._allProjects = harness.state.projects;
  const taskApi: { current: TaskApi | null } = { current: null };
  const projectApi: { current: ProjectApi | null } = { current: null };
  let tree!: ReturnType<typeof create>;
  act(() => {
    tree = create(scenario.surface === 'task'
      ? <TaskHarness initial={scenario.attachments} expose={taskApi} />
      : <ProjectHarness initial={{ ...project, attachments: scenario.attachments }} expose={projectApi} />);
  });
  const attachmentsNow = (): Attachment[] => (scenario.surface === 'task'
    ? taskApi.current!.draft
    : projectApi.current!.project?.attachments ?? []);
  const steps: unknown[] = [];
  for (const step of scenario.steps) {
    harness.ports = step.ports ?? {};
    harness.log = [];
    const [verb, ...rest] = step.action.split(':');
    const arg = rest.join(':');
    const target = () => attachmentsNow().find((attachment) => attachment.id === arg)!;
    await act(async () => {
      const api = scenario.surface === 'task' ? taskApi.current! : projectApi.current!;
      const taskHook = taskApi.current;
      const projectHook = projectApi.current;
      switch (verb) {
        case 'addFile': await (taskHook ? taskHook.addFileAttachment() : projectHook!.addProjectFileAttachment()); break;
        case 'addImage': await taskHook!.addImageAttachment(); break;
        case 'openAddLink': taskHook ? taskHook.openAddLinkAttachment() : projectHook!.setLinkModalVisible(true); break;
        case 'editLink': taskHook!.editLinkAttachment(target()); break;
        case 'setLinkInput': api.setLinkInput(arg); break;
        case 'confirmLink': taskHook ? taskHook.confirmAddLink() : projectHook!.confirmAddProjectLink(); break;
        case 'closeLinkModal': taskHook!.closeLinkModal(); break;
        case 'remove': taskHook ? taskHook.removeAttachment(arg) : projectHook!.removeProjectAttachment(arg); break;
        case 'download': await api.downloadAttachment(target()); break;
        case 'open': await api.openAttachment(target()); break;
        default: throw new Error(`Unknown step ${step.action}`);
      }
      await settle();
    });
    const alerts = vi.mocked(Alert.alert).mock.calls.map((call) => ['alert', call[0], call[1]]);
    vi.mocked(Alert.alert).mockClear();
    const screen = scenario.surface === 'task'
      ? {
        linkModalVisible: taskApi.current!.linkModalVisible,
        linkInput: taskApi.current!.linkInput,
        linkInputTouched: taskApi.current!.linkInputTouched,
        editingLinkAttachmentId: taskApi.current!.editingLinkAttachmentId,
        imagePreview: taskApi.current!.imagePreviewAttachment?.id ?? null,
        audio: taskApi.current!.audioModalVisible ? taskApi.current!.audioAttachment?.id ?? null : null,
      }
      : {
        linkModalVisible: projectApi.current!.linkModalVisible,
        linkInput: projectApi.current!.linkInput,
        imagePreview: projectApi.current!.imagePreviewAttachment?.id ?? null,
        storedAttachments: (harness.state._allProjects as Project[])[0]?.attachments ?? [],
      };
    steps.push({ action: step.action, events: [...harness.log, ...alerts], attachments: attachmentsNow(), screen });
  }
  act(() => tree.unmount());
  return normalize(steps);
}

const normalize = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (_key, entry) => (
  entry === undefined ? '<undefined>' : entry
)));

const git = (...args: string[]) => execFileSync('git', args, { cwd: new URL('../../..', import.meta.url).pathname, encoding: 'utf8' });

function captureProvenance() {
  const head = git('rev-parse', 'HEAD').trim();
  const declared = process.env.MINDWTR_CAPTURE_ATTACHMENTS_COMMIT;
  if (declared !== head) throw new Error(`Recapture needs MINDWTR_CAPTURE_ATTACHMENTS_COMMIT=${head} (the current HEAD); got ${declared ?? 'nothing'}`);
  const allowed = new Set([
    'apps/mobile/tests/attachments.parity.test.tsx',
    'packages/core/src/attachments-parity.fixtures.json',
  ]);
  const changed = git('status', '--porcelain', '--untracked-files=all').split('\n').filter(Boolean)
    .map((line) => line.slice(3).replace(/^"|"$/g, '')).filter((path) => !allowed.has(path));
  if (changed.length > 0) throw new Error(`Recapture needs HEAD's code only; changed: ${changed.join(', ')}`);
  return {
    command: 'cd apps/mobile && MINDWTR_CAPTURE_ATTACHMENTS=1 MINDWTR_CAPTURE_ATTACHMENTS_COMMIT=$(git rev-parse HEAD) TZ=UTC bunx vitest run tests/attachments.parity.test.tsx',
    capturedAt: head,
    sourceState: 'Every file under apps/ and packages/ was at HEAD except this attachments parity harness and its fixture.',
    rendering: 'use-task-edit-attachments.ts (task task-1, visible, its draft in React state) and use-project-attachments.ts (project project-1, the selected project in React state, updateProject writing the store) mounted with react-test-renderer under a fake Date, English strings, request-ordered UUIDs (00000000-0000-4000-8000-<n>, from 1 per scenario) and Platform.OS web. The pickers, persistAttachmentLocally (copies to file:///data/files/attachments/<id><title extension>, or returns the attachment unchanged when unreadable), ensureAttachmentAvailableDetailed, Linking, Sharing, the Android viewer, the audio player, the log and Alert are replaced; the availability identity and patch rules are core\'s. Each step lists, in order, what the hook did, then the draft or project attachments and the screen state.',
  };
}

describe('React Native attachments parity fixture', () => {
  const originalTz = process.env.TZ;
  beforeAll(async () => {
    process.env.TZ = 'UTC';
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
    vi.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    strings = await loadTranslations('en') as Record<string, string>;
  });
  afterAll(() => {
    vi.useRealTimers();
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it('replays every scenario exactly as frozen', async () => {
    const captured: Record<string, unknown> = {};
    const selected = CAPTURE && CAPTURE_ONLY.length > 0 ? scenarios.filter(({ name }) => CAPTURE_ONLY.includes(name)) : scenarios;
    if (selected.length !== (CAPTURE && CAPTURE_ONLY.length > 0 ? CAPTURE_ONLY.length : scenarios.length)) {
      throw new Error(`Unknown scenario in MINDWTR_CAPTURE_ATTACHMENTS_SCENARIOS: ${CAPTURE_ONLY.join(' | ')}`);
    }
    for (const scenario of selected) captured[scenario.name] = await runScenario(scenario);
    const inputs = normalize({ timeZone: 'UTC', now: NOW, taskId: TASK_ID, projectId: PROJECT_ID, scenarios }) as Record<string, unknown>;
    if (CAPTURE) {
      const provenance = captureProvenance();
      if (CAPTURE_ONLY.length === 0) {
        writeFileSync(FIXTURE_PATH, `${JSON.stringify({ provenance, ...inputs, observations: captured }, null, 1)}\n`);
      } else {
        const reason = process.env.MINDWTR_CAPTURE_ATTACHMENTS_REASON;
        if (!reason) throw new Error('A partial recapture needs MINDWTR_CAPTURE_ATTACHMENTS_REASON');
        const previous = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
        writeFileSync(FIXTURE_PATH, `${JSON.stringify({
          provenance: {
            ...previous.provenance,
            recaptured: [...(previous.provenance.recaptured ?? []), { commit: provenance.capturedAt, reason, scenarios: CAPTURE_ONLY }],
          },
          ...inputs,
          observations: Object.fromEntries(scenarios.map(({ name }) => [
            name, CAPTURE_ONLY.includes(name) ? captured[name] : previous.observations[name],
          ])),
        }, null, 1)}\n`);
      }
    }
    const { observations, provenance: _provenance, ...frozenInputs } = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
    expect(frozenInputs).toEqual(inputs);
    for (const scenario of selected) {
      expect({ [scenario.name]: captured[scenario.name] }).toEqual({ [scenario.name]: observations[scenario.name] });
    }
  }, 60_000);
});
