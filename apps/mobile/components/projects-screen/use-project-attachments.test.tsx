import React from 'react';
import { Alert } from 'react-native';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runStoreCommand, runSyncStoreSave, type Attachment, type Project } from '@mindwtr/core';
import * as DocumentPicker from 'expo-document-picker';

import { useProjectAttachments } from './use-project-attachments';

const availabilityMock = vi.hoisted(() => ({
  ensureAttachmentAvailableDetailed: vi.fn(),
}));
const attachmentPersistenceMock = vi.hoisted(() => ({
  persistAttachmentLocally: vi.fn(),
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
  persistAttachmentLocally: attachmentPersistenceMock.persistAttachmentLocally,
}));
vi.mock('expo-document-picker', () => ({
  getDocumentAsync: vi.fn().mockResolvedValue({ canceled: true, assets: [] }),
}));
vi.mock('expo-linking', () => ({ openURL: vi.fn().mockResolvedValue(undefined) }));
vi.mock('expo-sharing', () => ({
  isAvailableAsync: vi.fn().mockResolvedValue(false),
  shareAsync: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../lib/app-log', () => ({ logInfo: vi.fn().mockResolvedValue(undefined), logWarn: vi.fn().mockResolvedValue(undefined) }));
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
  linkInput: string;
  setLinkInput: ReturnType<typeof useProjectAttachments>['setLinkInput'];
  confirmAddProjectLink: ReturnType<typeof useProjectAttachments>['confirmAddProjectLink'];
  addProjectFileAttachment: ReturnType<typeof useProjectAttachments>['addProjectFileAttachment'];
  downloadAttachment: ReturnType<typeof useProjectAttachments>['downloadAttachment'];
  openAttachment: ReturnType<typeof useProjectAttachments>['openAttachment'];
  removeProjectAttachment: ReturnType<typeof useProjectAttachments>['removeProjectAttachment'];
  replaceProject: (project: Project) => void;
};

function Harness({ expose, initial, gated = false }: {
  expose: React.MutableRefObject<HarnessApi | null>;
  initial: Project;
  /** updateProject as the store runs it: a command behind the write gate (store-write-gate.ts). */
  gated?: boolean;
}) {
  const [selectedProject, setSelectedProject] = React.useState<Project | null>(initial);
  const updateProject = React.useCallback((id: string, updates: Partial<Project>) => {
    const apply = () => {
      coreStoreState._allProjects = coreStoreState._allProjects.map((project) => (
        project.id === id ? { ...project, ...updates } : project
      ));
    };
    return gated ? runStoreCommand(async () => apply()) : apply();
  }, [gated]);
  const hook = useProjectAttachments({
    selectedProject,
    setSelectedProject,
    updateProject,
    t: (key) => key,
    logProjectError: vi.fn(),
  });
  expose.current = {
    selectedProject,
    linkInput: hook.linkInput,
    setLinkInput: hook.setLinkInput,
    confirmAddProjectLink: hook.confirmAddProjectLink,
    addProjectFileAttachment: hook.addProjectFileAttachment,
    downloadAttachment: hook.downloadAttachment,
    openAttachment: hook.openAttachment,
    removeProjectAttachment: hook.removeProjectAttachment,
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
    attachmentPersistenceMock.persistAttachmentLocally.mockImplementation(async (attachment: Attachment) => ({
      ...attachment,
      uri: `file:///managed/${attachment.id}`,
    }));
  });

  afterEach(() => {
    coreStoreState._allProjects = [];
    vi.restoreAllMocks();
  });

  it('adds two project links in one update and leaves an invalid batch untouched', () => {
    const project = makeProject(makeAttachment(1));
    coreStoreState._allProjects = [project];
    const expose = React.createRef<HarnessApi | null>();
    let tree!: ReturnType<typeof create>;
    act(() => { tree = create(<Harness expose={expose} initial={project} />); });
    act(() => { expose.current!.setLinkInput('https://one.example\nTwo | https://two.example'); });
    act(() => { expose.current!.confirmAddProjectLink(); });
    expect(expose.current!.selectedProject?.attachments?.map((item) => item.uri)).toEqual([
      '', 'https://one.example', 'https://two.example',
    ]);
    act(() => { expose.current!.setLinkInput('https://three.example\ninvalid line'); });
    act(() => { expose.current!.confirmAddProjectLink(); });
    expect(expose.current!.selectedProject?.attachments).toHaveLength(3);
    expect(expose.current!.linkInput).toBe('https://three.example\ninvalid line');
    act(() => tree.unmount());
  });

  it('adds all UpNote input forms without opening and preserves project data after a missing app failure', async () => {
    const Linking = await import('expo-linking');
    const Clipboard = await import('expo-clipboard');
    const uri = 'upnote://x-callback-url/openNote?noteId=Note%2FCase%2520&new_window=true';
    const project = makeProject(makeAttachment(1));
    coreStoreState._allProjects = [project];
    const expose = React.createRef<HarnessApi | null>();
    let tree!: ReturnType<typeof create>;
    act(() => { tree = create(<Harness expose={expose} initial={project} />); });
    act(() => { expose.current!.setLinkInput(`${uri}\nNote | ${uri}\n[My note](${uri})`); });
    act(() => { expose.current!.confirmAddProjectLink(); });
    const saved = expose.current!.selectedProject!;
    const added = saved.attachments!.slice(1);
    expect(added.map((attachment) => attachment.uri)).toEqual([uri, uri, uri]);
    expect(Linking.openURL).not.toHaveBeenCalled();
    vi.mocked(Linking.openURL).mockRejectedValueOnce(new Error('Missing app'));
    await act(async () => { await expose.current!.openAttachment(added[0]); });
    expect(Linking.openURL).toHaveBeenCalledWith(uri);
    expect(expose.current!.selectedProject).toEqual(saved);
    expect(coreStoreState._allProjects[0]).toEqual(saved);
    vi.mocked(Alert.alert).mock.calls.at(-1)![2]!.find((button) => button.text === 'Copy link')!.onPress!();
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith(uri);
    act(() => tree.unmount());
  });

  it('keeps a sibling a sync save published while the download waited, when the completion lands behind that save', async () => {
    const attachment = makeAttachment(1);
    const project = makeProject(attachment);
    coreStoreState._allProjects = [project];
    const download = deferred<{ status: 'available'; attachment: Attachment }>();
    availabilityMock.ensureAttachmentAvailableDetailed.mockReturnValue(download.promise);
    const expose = React.createRef<HarnessApi | null>();
    let tree!: ReturnType<typeof create>;
    act(() => { tree = create(<Harness expose={expose} initial={project} gated />); });

    let pending!: Promise<void>;
    await act(async () => { pending = expose.current!.downloadAttachment(attachment); });
    await vi.waitFor(() => expect(availabilityMock.ensureAttachmentAvailableDetailed).toHaveBeenCalled());
    const sibling = makeAttachment(1, { id: 'attachment-2', title: 'Other device.pdf', cloudKey: 'attachments/attachment-2.pdf' });
    const releaseSave = deferred<void>();
    // Another device's sibling: the sync save holds the gate, then publishes revision 3 [A, B].
    const save = runSyncStoreSave(async () => {
      await releaseSave.promise;
      coreStoreState._allProjects = [{ ...coreStoreState._allProjects[0], rev: 3, attachments: [...coreStoreState._allProjects[0].attachments!, sibling] }];
    });
    download.resolve({ status: 'available', attachment: { ...attachment, uri: 'file:///managed/attachment-1', localStatus: 'available' } });
    for (let tick = 0; tick < 5; tick += 1) await Promise.resolve();
    releaseSave.resolve();
    await act(async () => { await save; await pending; });

    expect(coreStoreState._allProjects[0].attachments!.map((item) => [item.id, item.localStatus])).toEqual([
      ['attachment-1', 'available'], ['attachment-2', 'missing'],
    ]);
    act(() => tree.unmount());
  });

  it('keeps a sibling a sync save published while an added link or a removal waited behind it', async () => {
    const attachment = makeAttachment(1);
    const project = makeProject(attachment);
    const sibling = (id: string) => makeAttachment(1, { id, title: 'Other device.pdf', cloudKey: `attachments/${id}.pdf` });
    const expose = React.createRef<HarnessApi | null>();
    let tree!: ReturnType<typeof create>;
    coreStoreState._allProjects = [project];
    act(() => { tree = create(<Harness expose={expose} initial={project} gated />); });
    // Each write is issued while a sync save holds the gate; the save then publishes another device's sibling.
    const behindSyncSave = async (siblingId: string, write: () => void) => {
      const releaseSave = deferred<void>();
      const save = runSyncStoreSave(async () => {
        await releaseSave.promise;
        const [stored] = coreStoreState._allProjects;
        coreStoreState._allProjects = [{ ...stored, rev: (stored.rev ?? 1) + 1, attachments: [...stored.attachments!, sibling(siblingId)] }];
      });
      act(() => write());
      releaseSave.resolve();
      await act(async () => {
        await save;
        await runStoreCommand(async () => undefined);
      });
    };

    act(() => { expose.current!.setLinkInput('https://one.example'); });
    await behindSyncSave('attachment-2', () => expose.current!.confirmAddProjectLink());
    expect(coreStoreState._allProjects[0].attachments!.map((item) => item.title)).toEqual([
      'Generation 1.pdf', 'Other device.pdf', 'one.example',
    ]);
    expect(expose.current!.selectedProject?.attachments).toEqual(coreStoreState._allProjects[0].attachments);

    coreStoreState._allProjects = [{ ...coreStoreState._allProjects[0], attachments: [attachment] }];
    await behindSyncSave('attachment-3', () => expose.current!.removeProjectAttachment('attachment-1'));
    expect(coreStoreState._allProjects[0].attachments!.map((item) => [item.id, Boolean(item.deletedAt)])).toEqual([
      ['attachment-1', true], ['attachment-3', false],
    ]);
    act(() => tree.unmount());
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

  it('names another device\'s file path literally, even with $ replacement patterns', async () => {
    const attachment = makeAttachment(1, { kind: 'link', uri: 'D:\\Docs\\a$&b$$.docx', mimeType: undefined, cloudKey: undefined });
    const project = makeProject(attachment);
    coreStoreState._allProjects = [project];
    const expose = React.createRef<HarnessApi | null>();
    let tree!: ReturnType<typeof create>;
    act(() => { tree = create(<Harness expose={expose} initial={project} />); });

    await act(async () => { await expose.current!.openAttachment(attachment); });

    expect(Alert.alert).toHaveBeenCalledWith('attachments.title', expect.stringContaining('another device: D:\\Docs\\a$&b$$.docx.'));
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

  it('opens a project file already on this device without rewriting the project', async () => {
    // Every write bumps the project's revision; an Open that changes nothing must not sync one.
    const attachment = makeAttachment(1, { uri: 'file:///managed/attachment-1.pdf', localStatus: 'available' });
    const project = makeProject(attachment);
    coreStoreState._allProjects = [project];
    availabilityMock.ensureAttachmentAvailableDetailed.mockResolvedValue({ status: 'available', attachment });
    const expose = React.createRef<HarnessApi | null>();
    let tree!: ReturnType<typeof create>;
    act(() => { tree = create(<Harness expose={expose} initial={project} />); });

    await act(async () => { await expose.current!.openAttachment(attachment); });

    expect(coreStoreState._allProjects[0]).toBe(project);
    expect(expose.current!.selectedProject).toBe(project);
    act(() => tree.unmount());
  });

  it('does not attach a picked file after the project becomes archived', async () => {
    const originalAttachment = makeAttachment(1);
    const activeProject = makeProject(originalAttachment, { attachments: [] });
    const archivedProject = { ...activeProject, status: 'archived' as const };
    const picker = deferred<any>();
    vi.mocked(DocumentPicker.getDocumentAsync).mockReturnValueOnce(picker.promise);
    coreStoreState._allProjects = [activeProject];
    const expose = React.createRef<HarnessApi | null>();
    let tree!: ReturnType<typeof create>;
    act(() => { tree = create(<Harness expose={expose} initial={activeProject} />); });

    let addRun!: Promise<void>;
    act(() => { addRun = expose.current!.addProjectFileAttachment(); });
    act(() => { expose.current!.replaceProject(archivedProject); });

    await act(async () => {
      picker.resolve({
        canceled: false,
        assets: [{ name: 'history.pdf', uri: 'file:///picked/history.pdf', mimeType: 'application/pdf' }],
      });
      await addRun;
    });

    expect(expose.current!.selectedProject).toEqual(archivedProject);
    expect(coreStoreState._allProjects).toEqual([archivedProject]);
    act(() => tree.unmount());
  });
});
