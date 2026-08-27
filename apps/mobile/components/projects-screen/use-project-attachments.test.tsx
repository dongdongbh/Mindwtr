import React from 'react';
import { Alert } from 'react-native';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Attachment, type Project } from '@mindwtr/core';

import { useProjectAttachments } from './use-project-attachments';

const availabilityMock = vi.hoisted(() => ({
  ensureAttachmentAvailableDetailed: vi.fn(),
}));
const coreStoreState = vi.hoisted(() => ({ _allProjects: [] as Project[] }));

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
vi.mock('../../lib/app-log', () => ({ logWarn: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../lib/open-file-externally', () => ({
  tryOpenWithAndroidViewer: vi.fn().mockResolvedValue(false),
}));

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

const makeProject = (attachment: Attachment, overrides: Partial<Project> = {}): Project => ({
  id: 'project-1',
  title: 'Current project title',
  status: 'active',
  color: '#3b82f6',
  order: 0,
  tagIds: [],
  attachments: [attachment],
  createdAt: '2026-08-27T00:00:00.000Z',
  updatedAt: '2026-08-27T00:00:00.000Z',
  ...overrides,
});

type HarnessApi = {
  selectedProject: Project | null;
  downloadAttachment: ReturnType<typeof useProjectAttachments>['downloadAttachment'];
  replaceProject: (project: Project) => void;
};

function Harness({ expose, initial }: {
  expose: React.MutableRefObject<HarnessApi | null>;
  initial: Project;
}) {
  const [selectedProject, setSelectedProject] = React.useState<Project | null>(initial);
  const updateProject = React.useCallback((id: string, updates: Partial<Project>) => {
    coreStoreState._allProjects = coreStoreState._allProjects.map((project) => (
      project.id === id ? { ...project, ...updates } : project
    ));
  }, []);
  const hook = useProjectAttachments({
    selectedProject,
    setSelectedProject,
    updateProject,
    t: (key) => key,
    logProjectError: vi.fn(),
  });
  expose.current = {
    selectedProject,
    downloadAttachment: hook.downloadAttachment,
    replaceProject: (project) => {
      coreStoreState._allProjects = [project];
      setSelectedProject(project);
    },
  };
  return null;
}

describe('useProjectAttachments download settlement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  });

  afterEach(() => {
    coreStoreState._allProjects = [];
    vi.restoreAllMocks();
  });

  it('restores missing state and shows localized conflict guidance without changing project metadata', async () => {
    const attachment = makeAttachment(1);
    const project = makeProject(attachment);
    coreStoreState._allProjects = [project];
    availabilityMock.ensureAttachmentAvailableDetailed.mockResolvedValue({ status: 'generation-conflict' });
    const expose = React.createRef<HarnessApi | null>();
    let tree!: ReturnType<typeof create>;
    act(() => { tree = create(<Harness expose={expose} initial={project} />); });

    await act(async () => { await expose.current!.downloadAttachment(attachment); });

    expect(expose.current!.selectedProject).toEqual(project);
    expect(coreStoreState._allProjects[0]).toEqual(project);
    expect(Alert.alert).toHaveBeenCalledWith('attachments.title', 'attachments.downloadConflict');
    act(() => tree.unmount());
  });

  it('keeps retryable unavailability distinct from terminal absence', async () => {
    const attachment = makeAttachment(1);
    const project = makeProject(attachment);
    coreStoreState._allProjects = [project];
    availabilityMock.ensureAttachmentAvailableDetailed.mockResolvedValue({ status: 'unavailable' });
    const expose = React.createRef<HarnessApi | null>();
    let tree!: ReturnType<typeof create>;
    act(() => { tree = create(<Harness expose={expose} initial={project} />); });

    await act(async () => { await expose.current!.downloadAttachment(attachment); });

    expect(expose.current!.selectedProject).toEqual(project);
    expect(Alert.alert).toHaveBeenCalledWith('attachments.title', 'attachments.missing');
    act(() => tree.unmount());
  });

  it('persists a current terminal absence without replacing project attachment metadata', async () => {
    const attachment = makeAttachment(1, { title: 'Current title.pdf' });
    const project = makeProject(attachment);
    const terminalAt = '2026-08-27T00:01:00.000Z';
    coreStoreState._allProjects = [project];
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
    act(() => { tree = create(<Harness expose={expose} initial={project} />); });

    await act(async () => { await expose.current!.downloadAttachment(attachment); });

    const expectedAttachment = {
      ...attachment,
      cloudKey: undefined,
      fileHash: undefined,
      localStatus: 'missing' as const,
      deletedAt: terminalAt,
      updatedAt: terminalAt,
    };
    expect(expose.current!.selectedProject).toEqual({
      ...project,
      attachments: [expectedAttachment],
    });
    expect(coreStoreState._allProjects[0]).toEqual(expose.current!.selectedProject);
    expect(Alert.alert).toHaveBeenCalledWith('attachments.title', 'attachments.unrecoverable');
    act(() => tree.unmount());
  });

  it('ignores a stale H1 terminal outcome and applies only H2 local availability fields to the latest project', async () => {
    const h1 = makeAttachment(1);
    const h2 = makeAttachment(2, { title: 'Current H2 title.pdf', mimeType: 'application/pdf' });
    const p1 = makeProject(h1, { title: 'Original project title' });
    const p2 = makeProject(h2, { title: 'Latest project title' });
    const first = deferred<any>();
    const second = deferred<any>();
    availabilityMock.ensureAttachmentAvailableDetailed
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    coreStoreState._allProjects = [p1];
    const expose = React.createRef<HarnessApi | null>();
    let tree!: ReturnType<typeof create>;
    act(() => { tree = create(<Harness expose={expose} initial={p1} />); });

    let firstRun!: Promise<void>;
    act(() => { firstRun = expose.current!.downloadAttachment(h1); });
    act(() => { expose.current!.replaceProject(p2); });
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
    expect(expose.current!.selectedProject).toMatchObject({
      title: 'Latest project title',
      attachments: [{ contentRev: 2, title: 'Current H2 title.pdf', localStatus: 'downloading' }],
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
    expect(expose.current!.selectedProject).toEqual({
      ...p2,
      attachments: [{ ...h2, uri: 'file://attachments/h2.pdf', localStatus: 'available' }],
    });
    expect(coreStoreState._allProjects[0]).toEqual(expose.current!.selectedProject);
    expect(Alert.alert).not.toHaveBeenCalled();
    act(() => tree.unmount());
  });

  it('updates the selected project when a verified download fills a legacy missing hash', async () => {
    const attachment = makeAttachment(3, {
      title: 'Legacy attachment.pdf',
      fileHash: undefined,
    });
    const verifiedHash = '3'.repeat(64);
    const project = makeProject(attachment);
    coreStoreState._allProjects = [project];
    availabilityMock.ensureAttachmentAvailableDetailed.mockResolvedValue({
      status: 'available',
      attachment: {
        ...attachment,
        title: 'Stale remote title.pdf',
        mimeType: 'application/x-stale',
        uri: 'file://attachments/legacy.pdf',
        localStatus: 'available',
        fileHash: verifiedHash,
      },
    });
    const expose = React.createRef<HarnessApi | null>();
    let tree!: ReturnType<typeof create>;
    act(() => { tree = create(<Harness expose={expose} initial={project} />); });

    await act(async () => { await expose.current!.downloadAttachment(attachment); });

    expect(expose.current!.selectedProject).toEqual({
      ...project,
      attachments: [{
        ...attachment,
        uri: 'file://attachments/legacy.pdf',
        localStatus: 'available',
        fileHash: verifiedHash,
      }],
    });
    expect(coreStoreState._allProjects[0]).toEqual(expose.current!.selectedProject);
    act(() => tree.unmount());
  });
});
