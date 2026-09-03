import React from 'react';
import { Alert } from 'react-native';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTaskStore, type Attachment, type Project, type Task } from '@mindwtr/core';

import { useTaskEditAttachments } from './use-task-edit-attachments';

const availabilityMock = vi.hoisted(() => ({
  ensureAttachmentAvailableDetailed: vi.fn(),
}));
const speechMocks = vi.hoisted(() => ({
  buildTaskUpdatesFromSpeechResult: vi.fn(),
  ensureWhisperModelPathForConfigAsync: vi.fn(),
  processAudioCapture: vi.fn(),
  resolveSpeechToTextRuntimeSettings: vi.fn(),
}));
const draftFieldMock = vi.hoisted(() => ({ setDraftField: vi.fn() }));
const coreStoreState = vi.hoisted(() => ({
  tasks: [] as Task[],
  _allTasks: [] as Task[],
  projects: [] as Project[],
  _allProjects: [] as Project[],
  settings: {} as Record<string, any>,
  addProject: vi.fn(),
  updateTask: vi.fn(),
}));

vi.mock('@mindwtr/core', async (importOriginal) => {
  const { mockCore } = await import('../../test-support/mock-core');
  return mockCore(importOriginal, () => coreStoreState, {
    buildTaskUpdatesFromSpeechResult: speechMocks.buildTaskUpdatesFromSpeechResult,
  });
});

vi.mock('../../lib/attachment-sync-availability', () => ({
  ensureAttachmentAvailableDetailed: availabilityMock.ensureAttachmentAvailableDetailed,
  getAttachmentDownloadIdentity: (attachment: Attachment) => JSON.stringify([
    attachment.id,
    attachment.cloudKey ?? null,
    attachment.fileHash ?? null,
    attachment.contentRev ?? 0,
  ]),
  hasAttachmentDownloadIdentity: (attachment: Attachment | undefined, identity: string) => Boolean(
    attachment
    && JSON.stringify([
      attachment.id,
      attachment.cloudKey ?? null,
      attachment.fileHash ?? null,
      attachment.contentRev ?? 0,
    ]) === identity
  ),
  getAttachmentAvailabilityPatch: (current: Attachment, resolved: Attachment) => ({
    uri: resolved.uri,
    localStatus: resolved.localStatus,
    ...(!current.fileHash && resolved.fileHash ? { fileHash: resolved.fileHash } : {}),
  }),
  getAttachmentUnrecoverablePatch: (resolved: Attachment) => ({
    cloudKey: resolved.cloudKey,
    fileHash: resolved.fileHash,
    localStatus: resolved.localStatus,
    deletedAt: resolved.deletedAt,
    updatedAt: resolved.updatedAt,
  }),
}));

vi.mock('../../lib/attachment-sync', () => ({
  deleteManagedAttachmentFile: vi.fn().mockResolvedValue(undefined),
  persistAttachmentLocally: vi.fn(async (attachment: Attachment) => attachment),
}));

vi.mock('expo-document-picker', () => ({
  getDocumentAsync: vi.fn().mockResolvedValue({ canceled: true, assets: [] }),
}));
vi.mock('expo-linking', () => ({ openURL: vi.fn().mockResolvedValue(undefined) }));
vi.mock('expo-sharing', () => ({
  isAvailableAsync: vi.fn().mockResolvedValue(false),
  shareAsync: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('expo-audio', () => ({
  setAudioModeAsync: vi.fn().mockResolvedValue(undefined),
  useAudioPlayer: () => ({
    pause: vi.fn(),
    play: vi.fn(),
    replace: vi.fn(),
    seekTo: vi.fn(),
  }),
  useAudioPlayerStatus: () => ({ isLoaded: false }),
}));
vi.mock('expo-file-system', () => ({ Paths: { cache: { uri: 'file://cache/' } } }));
vi.mock('../../lib/ai-config', () => ({ loadAIKey: vi.fn().mockResolvedValue('') }));
vi.mock('../../lib/open-file-externally', () => ({
  tryOpenWithAndroidViewer: vi.fn().mockResolvedValue(false),
}));
vi.mock('../../lib/speech-to-text', () => ({
  ensureWhisperModelPathForConfigAsync: speechMocks.ensureWhisperModelPathForConfigAsync,
  processAudioCapture: speechMocks.processAudioCapture,
  resolveSpeechToTextRuntimeSettings: speechMocks.resolveSpeechToTextRuntimeSettings,
}));
vi.mock('../../lib/speech-to-text.helpers', () => ({ normalizeAudioUri: (value: string) => value }));

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
};

const makeAttachment = (contentRev: number, overrides: Partial<Attachment> = {}): Attachment => ({
  id: 'attachment-1',
  kind: 'file',
  title: `Generation ${contentRev}.pdf`,
  mimeType: 'application/pdf',
  uri: '',
  cloudKey: `attachments/attachment-1-r${contentRev}.pdf`,
  fileHash: contentRev === 1 ? '1'.repeat(64) : '2'.repeat(64),
  contentRev,
  localStatus: 'missing',
  createdAt: '2026-08-27T00:00:00.000Z',
  updatedAt: `2026-08-27T00:00:0${contentRev}.000Z`,
  ...overrides,
});

const makeTask = (attachment: Attachment): Task => ({
  id: 'task-1',
  title: 'Task',
  status: 'inbox',
  tags: [],
  contexts: [],
  attachments: [attachment],
  createdAt: '2026-08-27T00:00:00.000Z',
  updatedAt: '2026-08-27T00:00:00.000Z',
});

type HarnessApi = {
  attachments: Attachment[];
  audioAttachment: Attachment | null;
  audioModalVisible: boolean;
  downloadAttachment: ReturnType<typeof useTaskEditAttachments>['downloadAttachment'];
  openAttachment: ReturnType<typeof useTaskEditAttachments>['openAttachment'];
  replaceAttachment: (attachment: Attachment) => void;
  retryAudioTranscription: ReturnType<typeof useTaskEditAttachments>['retryAudioTranscription'];
};

function Harness({ expose, initial, taskId = 'task-1', canMutate = () => true }: {
  expose: React.MutableRefObject<HarnessApi | null>;
  initial: Attachment;
  taskId?: string;
  canMutate?: () => boolean;
}) {
  const [attachments, setAttachmentState] = React.useState<Attachment[]>([initial]);
  const setAttachments = React.useCallback((
    value: Attachment[] | undefined | ((current: Attachment[] | undefined) => Attachment[] | undefined),
  ) => {
    setAttachmentState((current) => (
      (typeof value === 'function' ? value(current) : value) || []
    ));
  }, []);
  const hook = useTaskEditAttachments({
    attachments,
    setAttachments,
    setDraftField: draftFieldMock.setDraftField,
    taskId,
    t: (key) => key,
    visible: true,
    canMutate,
  });
  expose.current = {
    attachments,
    audioAttachment: hook.audioAttachment,
    audioModalVisible: hook.audioModalVisible,
    downloadAttachment: hook.downloadAttachment,
    openAttachment: hook.openAttachment,
    replaceAttachment: (attachment) => setAttachmentState([attachment]),
    retryAudioTranscription: hook.retryAudioTranscription,
  };
  return null;
}

describe('useTaskEditAttachments download settlement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  });

  afterEach(() => {
    useTaskStore.setState({ _allTasks: [] });
  });

  it('explains a desktop file link instead of handing another device\'s path to the OS', async () => {
    // "Link to file…" on the desktop stores that computer's path; Android used
    // to call Linking.openURL('D:\\Documents\\x.docx') and fail silently (#1001).
    const Linking = await import('expo-linking');
    const attachment = { ...makeAttachment(1), kind: 'link' as const, uri: 'D:\\Documents\\Document.docx', mimeType: undefined };
    useTaskStore.setState({ _allTasks: [makeTask(attachment)] });
    availabilityMock.ensureAttachmentAvailableDetailed.mockResolvedValue({ status: 'available', attachment });
    const expose = React.createRef<HarnessApi | null>();
    let tree!: ReturnType<typeof create>;
    act(() => { tree = create(<Harness expose={expose} initial={attachment} />); });

    await act(async () => { await expose.current!.openAttachment(attachment); });

    expect(Linking.openURL).not.toHaveBeenCalled();
    expect(Alert.alert).toHaveBeenCalledWith('attachments.title', expect.stringContaining('another device'));
    act(() => tree.unmount());
  });

  it('still opens a web link and reports a link the OS refuses', async () => {
    const Linking = await import('expo-linking');
    const attachment = { ...makeAttachment(1), kind: 'link' as const, uri: 'https://example.com/doc', mimeType: undefined };
    useTaskStore.setState({ _allTasks: [makeTask(attachment)] });
    availabilityMock.ensureAttachmentAvailableDetailed.mockResolvedValue({ status: 'available', attachment });
    vi.mocked(Linking.openURL).mockRejectedValueOnce(new Error('No Activity found to handle Intent'));
    const expose = React.createRef<HarnessApi | null>();
    let tree!: ReturnType<typeof create>;
    act(() => { tree = create(<Harness expose={expose} initial={attachment} />); });

    await act(async () => { await expose.current!.openAttachment(attachment); });
    await act(async () => { await Promise.resolve(); });

    expect(Linking.openURL).toHaveBeenCalledWith('https://example.com/doc');
    expect(Alert.alert).toHaveBeenCalledWith('attachments.title', expect.stringContaining('Could not open this link'));
    act(() => tree.unmount());
  });

  it('restores missing state and shows localized conflict guidance without changing metadata', async () => {
    const attachment = makeAttachment(1);
    useTaskStore.setState({ _allTasks: [makeTask(attachment)] });
    availabilityMock.ensureAttachmentAvailableDetailed.mockResolvedValue({ status: 'generation-conflict' });
    const expose = React.createRef<HarnessApi | null>();
    let tree!: ReturnType<typeof create>;
    act(() => { tree = create(<Harness expose={expose} initial={attachment} />); });

    expect(expose.current!.attachments[0]).toEqual(attachment);
    expect(useTaskStore.getState()._allTasks[0]?.attachments?.[0]).toEqual(attachment);

    await act(async () => { await expose.current!.downloadAttachment(attachment); });

    expect(expose.current!.attachments[0]).toEqual(attachment);
    expect(Alert.alert).toHaveBeenCalledWith('attachments.title', 'attachments.downloadConflict');
    act(() => tree.unmount());
  });

  it('keeps retryable unavailability distinct from terminal absence', async () => {
    const attachment = makeAttachment(1);
    useTaskStore.setState({ _allTasks: [makeTask(attachment)] });
    availabilityMock.ensureAttachmentAvailableDetailed.mockResolvedValue({ status: 'unavailable' });
    const expose = React.createRef<HarnessApi | null>();
    let tree!: ReturnType<typeof create>;
    act(() => { tree = create(<Harness expose={expose} initial={attachment} />); });

    await act(async () => { await expose.current!.downloadAttachment(attachment); });

    expect(expose.current!.attachments[0]).toEqual(attachment);
    expect(Alert.alert).toHaveBeenCalledWith('attachments.title', 'attachments.missing');
    act(() => tree.unmount());
  });

  it('persists a current terminal absence without replacing descriptive metadata', async () => {
    const attachment = makeAttachment(1, { title: 'Current title.pdf' });
    const terminalAt = '2026-08-27T00:01:00.000Z';
    useTaskStore.setState({ _allTasks: [makeTask(attachment)] });
    availabilityMock.ensureAttachmentAvailableDetailed.mockResolvedValue({
      status: 'unrecoverable',
      attachment: {
        ...attachment,
        title: 'Stale captured title.pdf',
        cloudKey: undefined,
        fileHash: undefined,
        localStatus: 'missing',
        deletedAt: terminalAt,
        updatedAt: terminalAt,
      },
    });
    const expose = React.createRef<HarnessApi | null>();
    let tree!: ReturnType<typeof create>;
    act(() => { tree = create(<Harness expose={expose} initial={attachment} />); });

    await act(async () => { await expose.current!.downloadAttachment(attachment); });

    expect(expose.current!.attachments[0]).toEqual({
      ...attachment,
      cloudKey: undefined,
      fileHash: undefined,
      localStatus: 'missing',
      deletedAt: terminalAt,
      updatedAt: terminalAt,
    });
    // Task edit owns a draft until Save; terminal state must not mutate the persisted task eagerly.
    expect(useTaskStore.getState()._allTasks[0]?.attachments?.[0]).toEqual(attachment);
    expect(Alert.alert).toHaveBeenCalledWith('attachments.title', 'attachments.unrecoverable');
    act(() => tree.unmount());
  });

  it('ignores a stale H1 terminal outcome and applies only H2 local availability fields', async () => {
    const h1 = makeAttachment(1);
    const h2 = makeAttachment(2, { title: 'Current H2 title.pdf', mimeType: 'application/pdf' });
    const first = deferred<any>();
    const second = deferred<any>();
    availabilityMock.ensureAttachmentAvailableDetailed
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    useTaskStore.setState({ _allTasks: [makeTask(h1)] });
    const expose = React.createRef<HarnessApi | null>();
    let tree!: ReturnType<typeof create>;
    act(() => { tree = create(<Harness expose={expose} initial={h1} />); });

    expect(expose.current!.attachments[0]).toEqual(h1);
    expect(useTaskStore.getState()._allTasks[0]?.attachments?.[0]).toEqual(h1);

    let firstRun!: Promise<void>;
    act(() => { firstRun = expose.current!.downloadAttachment(h1); });
    act(() => {
      useTaskStore.setState({ _allTasks: [makeTask(h2)] });
      expose.current!.replaceAttachment(h2);
    });
    let secondRun!: Promise<void>;
    act(() => { secondRun = expose.current!.downloadAttachment(h2); });
    expect(availabilityMock.ensureAttachmentAvailableDetailed).toHaveBeenCalledTimes(2);

    await act(async () => {
      first.resolve({
        status: 'unrecoverable',
        attachment: {
          ...h1,
          cloudKey: undefined,
          fileHash: undefined,
          localStatus: 'missing',
          deletedAt: '2026-08-27T00:01:00.000Z',
          updatedAt: '2026-08-27T00:01:00.000Z',
        },
      });
      await firstRun;
    });
    expect(expose.current!.attachments[0]).toMatchObject({
      contentRev: 2,
      title: 'Current H2 title.pdf',
      localStatus: 'downloading',
    });

    await act(async () => {
      second.resolve({
        status: 'available',
        attachment: {
          ...h2,
          title: 'Captured H2 title.pdf',
          mimeType: 'application/x-stale',
          uri: 'file://attachments/h2.pdf',
          localStatus: 'available',
        },
      });
      await secondRun;
    });
    expect(expose.current!.attachments[0]).toEqual({
      ...h2,
      uri: 'file://attachments/h2.pdf',
      localStatus: 'available',
    });
    expect(Alert.alert).not.toHaveBeenCalled();
    act(() => tree.unmount());
  });
});

describe('useTaskEditAttachments transcription ownership', () => {
  const activeProject: Project = {
    id: 'project-1',
    title: 'Active project',
    status: 'active',
    color: '#3b82f6',
    order: 0,
    tagIds: [],
    createdAt: '2026-08-27T00:00:00.000Z',
    updatedAt: '2026-08-27T00:00:00.000Z',
  };

  const makeAudioAttachment = (id: string): Attachment => ({
    id,
    kind: 'file',
    title: `${id}.m4a`,
    mimeType: 'audio/m4a',
    uri: `file://${id}.m4a`,
    localStatus: 'available',
    createdAt: '2026-08-27T00:00:00.000Z',
    updatedAt: '2026-08-27T00:00:00.000Z',
  });

  const makeAudioTask = (id: string, attachment: Attachment, projectId = activeProject.id): Task => ({
    id,
    title: `Task ${id}`,
    status: 'next',
    projectId,
    tags: [],
    contexts: [],
    attachments: [attachment],
    createdAt: '2026-08-27T00:00:00.000Z',
    updatedAt: '2026-08-27T00:00:00.000Z',
  });

  beforeEach(() => {
    vi.clearAllMocks();
    draftFieldMock.setDraftField.mockReset();
    coreStoreState.tasks = [];
    coreStoreState._allTasks = [];
    coreStoreState.projects = [activeProject];
    coreStoreState._allProjects = [activeProject];
    coreStoreState.settings = { ai: { speechToText: { enabled: true } } };
    coreStoreState.addProject.mockReset();
    coreStoreState.updateTask.mockReset();
    coreStoreState.updateTask.mockResolvedValue({ success: true });
    speechMocks.resolveSpeechToTextRuntimeSettings.mockReturnValue({
      enabled: true,
      provider: 'openai',
      baseUrl: 'https://speech.example.test/v1',
      model: 'whisper-1',
      mode: 'task',
      fieldStrategy: 'replace',
      isFossBuild: false,
    });
    speechMocks.buildTaskUpdatesFromSpeechResult.mockReturnValue({
      updates: { title: 'Transcribed title' },
      suggestedProjectTitle: undefined,
    });
    availabilityMock.ensureAttachmentAvailableDetailed.mockImplementation(async (attachment: Attachment) => ({
      status: 'available',
      attachment,
    }));
  });

  it('drops a retry result when the owning project archives while transcription is in flight', async () => {
    const audio = makeAudioAttachment('audio-archive');
    const task = makeAudioTask('task-1', audio);
    const transcription = deferred<any>();
    speechMocks.processAudioCapture.mockReturnValue(transcription.promise);
    coreStoreState.tasks = [task];
    coreStoreState._allTasks = [task];
    const expose = React.createRef<HarnessApi | null>();
    let tree!: ReturnType<typeof create>;
    act(() => { tree = create(<Harness expose={expose} initial={audio} taskId={task.id} />); });

    await act(async () => { await expose.current!.openAttachment(audio); });
    let retry!: Promise<void>;
    act(() => { retry = expose.current!.retryAudioTranscription(); });
    await act(async () => { await Promise.resolve(); });
    expect(speechMocks.processAudioCapture).toHaveBeenCalledTimes(1);

    coreStoreState.projects = [{ ...activeProject, status: 'archived' }];
    coreStoreState._allProjects = coreStoreState.projects;
    await act(async () => {
      transcription.resolve({ text: 'Transcribed title' });
      await retry;
    });

    expect(coreStoreState.updateTask).not.toHaveBeenCalled();
    expect(draftFieldMock.setDraftField).not.toHaveBeenCalled();
    expect(expose.current!.attachments).toEqual([audio]);
    act(() => tree.unmount());
  });

  it('cannot settle an old retry into a different task modal', async () => {
    const firstAudio = makeAudioAttachment('audio-first');
    const secondAudio = makeAudioAttachment('audio-second');
    const firstTask = makeAudioTask('task-1', firstAudio);
    const secondTask = makeAudioTask('task-2', secondAudio);
    const transcription = deferred<any>();
    speechMocks.processAudioCapture.mockReturnValue(transcription.promise);
    coreStoreState.tasks = [firstTask, secondTask];
    coreStoreState._allTasks = [firstTask, secondTask];
    const expose = React.createRef<HarnessApi | null>();
    let tree!: ReturnType<typeof create>;
    act(() => { tree = create(<Harness expose={expose} initial={firstAudio} taskId={firstTask.id} />); });

    await act(async () => { await expose.current!.openAttachment(firstAudio); });
    let retry!: Promise<void>;
    act(() => { retry = expose.current!.retryAudioTranscription(); });

    act(() => {
      tree.update(<Harness expose={expose} initial={secondAudio} taskId={secondTask.id} />);
      expose.current!.replaceAttachment(secondAudio);
    });
    await act(async () => { await expose.current!.openAttachment(secondAudio); });
    expect(expose.current!.audioAttachment?.id).toBe(secondAudio.id);
    expect(expose.current!.audioModalVisible).toBe(true);

    await act(async () => {
      transcription.resolve({ text: 'Stale first result' });
      await retry;
    });

    expect(coreStoreState.updateTask).not.toHaveBeenCalled();
    expect(draftFieldMock.setDraftField).not.toHaveBeenCalled();
    expect(expose.current!.audioAttachment?.id).toBe(secondAudio.id);
    expect(expose.current!.audioModalVisible).toBe(true);
    act(() => tree.unmount());
  });
});
