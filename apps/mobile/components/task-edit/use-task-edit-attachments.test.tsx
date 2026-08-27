import React from 'react';
import { Alert } from 'react-native';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTaskStore, type Attachment, type Task } from '@mindwtr/core';

import { useTaskEditAttachments } from './use-task-edit-attachments';

const availabilityMock = vi.hoisted(() => ({
  ensureAttachmentAvailableDetailed: vi.fn(),
}));
const coreStoreState = vi.hoisted(() => ({ _allTasks: [] as Task[] }));

vi.mock('@mindwtr/core', async (importOriginal) => {
  const { mockCore } = await import('../../test-support/mock-core');
  return mockCore(importOriginal, () => coreStoreState);
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
  ensureWhisperModelPathForConfigAsync: vi.fn(),
  processAudioCapture: vi.fn(),
  resolveSpeechToTextRuntimeSettings: vi.fn(),
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
  downloadAttachment: ReturnType<typeof useTaskEditAttachments>['downloadAttachment'];
  replaceAttachment: (attachment: Attachment) => void;
};

function Harness({ expose, initial }: {
  expose: React.MutableRefObject<HarnessApi | null>;
  initial: Attachment;
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
    setDraftField: vi.fn(),
    taskId: 'task-1',
    t: (key) => key,
    visible: true,
  });
  expose.current = {
    attachments,
    downloadAttachment: hook.downloadAttachment,
    replaceAttachment: (attachment) => setAttachmentState([attachment]),
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
    expect(Alert.alert).toHaveBeenCalledWith('attachments.title', 'attachments.missing');
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
