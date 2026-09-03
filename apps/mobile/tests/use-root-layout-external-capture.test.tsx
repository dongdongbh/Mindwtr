import React from 'react';
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useRootLayoutExternalCapture } from '@/hooks/root-layout/use-root-layout-external-capture';

vi.mock('@/lib/app-log', () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

const setHighlightTask = vi.hoisted(() => vi.fn());
const storeTasksById = vi.hoisted(() => new Map<string, any>());
const storeProjectsById = vi.hoisted(() => new Map<string, any>());
const storeAreasById = vi.hoisted(() => new Map<string, any>());

vi.mock('@mindwtr/core', async (importOriginal) => {
  const { mockCore } = await import('../test-support/mock-core');
  return mockCore(importOriginal, () => ({
    _tasksById: storeTasksById,
    _projectsById: storeProjectsById,
    _areasById: storeAreasById,
    setHighlightTask,
  }));
});

const syncAppSearchIndexingWithPreference = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@/lib/app-search-service', () => ({
  syncAppSearchIndexingWithPreference,
}));

const persistAttachmentLocallyDetailed = vi.hoisted(() => vi.fn());
vi.mock('@/lib/attachment-sync', () => ({
  persistAttachmentLocallyDetailed,
}));

vi.mock('expo-file-system', () => ({
  deleteAsync: vi.fn().mockResolvedValue(undefined),
}));

type RouterMock = {
  canGoBack: ReturnType<typeof vi.fn>;
  push: ReturnType<typeof vi.fn>;
  replace: ReturnType<typeof vi.fn>;
};

type SharedFile = {
  fileName?: string | null;
  mimeType?: string | null;
  path?: string | null;
  size?: number | null;
};

function TestHarness({
  hasShareIntent = false,
  incomingUrl,
  incomingUrlKey = incomingUrl ? 1 : 0,
  resetShareIntent = vi.fn(),
  router,
  shareFiles = null,
  shareSubject = null,
  shareText = null,
  shareWebUrl = null,
  showToast,
}: {
  hasShareIntent?: boolean;
  incomingUrl: string | null;
  incomingUrlKey?: number;
  resetShareIntent?: ReturnType<typeof vi.fn>;
  router: RouterMock;
  shareFiles?: SharedFile[] | null;
  shareSubject?: string | null;
  shareText?: string | null;
  shareWebUrl?: string | null;
  showToast: ReturnType<typeof vi.fn>;
}) {
  useRootLayoutExternalCapture({
    dataReady: true,
    hasShareIntent,
    incomingUrl,
    incomingUrlKey,
    resolveText: (_key: string, fallback: string) => fallback,
    resetShareIntent,
    router,
    shareFiles,
    shareSubject,
    shareText,
    shareWebUrl,
    showToast,
  });
  return null;
}

describe('useRootLayoutExternalCapture', () => {
  let router: RouterMock;
  let showToast: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    storeTasksById.clear();
    storeProjectsById.clear();
    storeAreasById.clear();
    router = {
      canGoBack: vi.fn(() => false),
      push: vi.fn(),
      replace: vi.fn(),
    };
    showToast = vi.fn();
  });

  it('opens shared text capture with the shared text as the task title', () => {
    const resetShareIntent = vi.fn();

    act(() => {
      create(
        <TestHarness
          hasShareIntent
          incomingUrl={null}
          resetShareIntent={resetShareIntent}
          router={router}
          shareText="The paragraph I selected in another app"
          showToast={showToast}
        />
      );
    });

    expect(router.replace).toHaveBeenCalledWith({
      pathname: '/capture-modal',
      params: {
        initialValue: 'The%20paragraph%20I%20selected%20in%20another%20app',
      },
    });
    const params = router.replace.mock.calls[0][0].params;
    expect(params.text).toBeUndefined();
    expect(params.initialProps).toBeUndefined();
    expect(resetShareIntent).toHaveBeenCalledTimes(1);
  });

  it('uses shared text as the task title and preserves a distinct URL in the note', () => {
    act(() => {
      create(
        <TestHarness
          hasShareIntent
          incomingUrl={null}
          router={router}
          shareText="Read this before the project review"
          shareWebUrl="https://example.com/review-notes"
          showToast={showToast}
        />
      );
    });

    const params = router.replace.mock.calls[0][0].params;
    expect(params.initialValue).toBe('Read%20this%20before%20the%20project%20review');
    expect(JSON.parse(decodeURIComponent(params.initialProps))).toEqual({
      description: 'https://example.com/review-notes',
    });
  });

  it('uses a shared URL as the task title when no text is available', () => {
    act(() => {
      create(
        <TestHarness
          hasShareIntent
          incomingUrl={null}
          router={router}
          shareWebUrl="https://example.com/review-notes"
          showToast={showToast}
        />
      );
    });

    expect(router.replace).toHaveBeenCalledWith({
      pathname: '/capture-modal',
      params: {
        initialValue: 'https%3A%2F%2Fexample.com%2Freview-notes',
      },
    });
  });

  it('uses the email subject as the title and the body as the description', () => {
    act(() => {
      create(
        <TestHarness
          hasShareIntent
          incomingUrl={null}
          router={router}
          shareSubject="Quarterly budget review"
          shareText="Please review the attached numbers before Friday."
          showToast={showToast}
        />
      );
    });

    const params = router.replace.mock.calls[0][0].params;
    expect(decodeURIComponent(params.initialValue)).toBe('Quarterly budget review');
    expect(JSON.parse(decodeURIComponent(params.initialProps))).toEqual({
      description: 'Please review the attached numbers before Friday.',
    });
  });

  it('appends a distinct shared URL under the subject-derived title and body', () => {
    act(() => {
      create(
        <TestHarness
          hasShareIntent
          incomingUrl={null}
          router={router}
          shareSubject="Read this article"
          shareText="Thought you'd find this useful."
          shareWebUrl="https://example.com/article"
          showToast={showToast}
        />
      );
    });

    const params = router.replace.mock.calls[0][0].params;
    expect(decodeURIComponent(params.initialValue)).toBe('Read this article');
    expect(JSON.parse(decodeURIComponent(params.initialProps))).toEqual({
      description: "Thought you'd find this useful.\nhttps://example.com/article",
    });
  });

  it('leaves non-email shares unchanged when no subject is present', () => {
    act(() => {
      create(
        <TestHarness
          hasShareIntent
          incomingUrl={null}
          router={router}
          shareText="The paragraph I selected in another app"
          showToast={showToast}
        />
      );
    });

    const params = router.replace.mock.calls[0][0].params;
    expect(decodeURIComponent(params.initialValue)).toBe('The paragraph I selected in another app');
    expect(params.initialProps).toBeUndefined();
  });

  it('copies a shared file into attachments and opens capture with it attached', async () => {
    const resetShareIntent = vi.fn();
    persistAttachmentLocallyDetailed.mockImplementation(async (attachment: { uri: string }) => ({
      attachment: { ...attachment, uri: 'file:///data/mindwtr/attachments/copied.pdf' },
      status: 'copied',
    }));

    await act(async () => {
      create(
        <TestHarness
          hasShareIntent
          incomingUrl={null}
          resetShareIntent={resetShareIntent}
          router={router}
          shareFiles={[{ fileName: 'Invoice March.pdf', mimeType: 'application/pdf', path: '/share/tmp/Invoice March.pdf', size: 1024 }]}
          showToast={showToast}
        />
      );
    });

    expect(persistAttachmentLocallyDetailed).toHaveBeenCalledTimes(1);
    expect(persistAttachmentLocallyDetailed.mock.calls[0][0]).toMatchObject({
      kind: 'file',
      title: 'Invoice March.pdf',
      mimeType: 'application/pdf',
      uri: 'file:///share/tmp/Invoice March.pdf',
      size: 1024,
    });
    expect(router.replace).toHaveBeenCalledTimes(1);
    const params = router.replace.mock.calls[0][0].params;
    expect(decodeURIComponent(params.initialValue)).toBe('Invoice March');
    const props = JSON.parse(decodeURIComponent(params.initialProps));
    expect(props.attachments).toHaveLength(1);
    expect(props.attachments[0]).toMatchObject({
      kind: 'file',
      title: 'Invoice March.pdf',
      uri: 'file:///data/mindwtr/attachments/copied.pdf',
    });
    expect(showToast).not.toHaveBeenCalled();
    expect(resetShareIntent).toHaveBeenCalledTimes(1);
  });

  it('prefers the email subject as the title over the filename for file shares', async () => {
    const resetShareIntent = vi.fn();
    persistAttachmentLocallyDetailed.mockImplementation(async (attachment: { uri: string }) => ({
      attachment: { ...attachment, uri: 'file:///data/mindwtr/attachments/copied.pdf' },
      status: 'copied',
    }));

    await act(async () => {
      create(
        <TestHarness
          hasShareIntent
          incomingUrl={null}
          resetShareIntent={resetShareIntent}
          router={router}
          shareFiles={[{ fileName: 'Invoice March.pdf', mimeType: 'application/pdf', path: '/share/tmp/Invoice March.pdf', size: 1024 }]}
          shareSubject="Invoice for last month"
          shareText="See attached."
          showToast={showToast}
        />
      );
    });

    expect(router.replace).toHaveBeenCalledTimes(1);
    const params = router.replace.mock.calls[0][0].params;
    expect(decodeURIComponent(params.initialValue)).toBe('Invoice for last month');
    const props = JSON.parse(decodeURIComponent(params.initialProps));
    expect(props.description).toBe('See attached.');
    expect(props.attachments).toHaveLength(1);
  });

  it('falls back to shared text capture and reports the skipped file when the copy fails', async () => {
    persistAttachmentLocallyDetailed.mockImplementation(async (attachment: { uri: string }) => ({
      attachment,
      status: 'failed',
    }));

    await act(async () => {
      create(
        <TestHarness
          hasShareIntent
          incomingUrl={null}
          router={router}
          shareFiles={[{ fileName: 'photo.jpg', mimeType: 'image/jpeg', path: '/share/tmp/photo.jpg', size: 10 }]}
          shareText="Look at this"
          showToast={showToast}
        />
      );
    });

    expect(router.replace).toHaveBeenCalledTimes(1);
    const params = router.replace.mock.calls[0][0].params;
    expect(decodeURIComponent(params.initialValue)).toBe('Look at this');
    expect(params.initialProps).toBeUndefined();
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast.mock.calls[0][0].message).toContain('1 shared file');
  });

  it('skips blocked file types even when the share reports no size', async () => {
    persistAttachmentLocallyDetailed.mockImplementation(async (attachment: { uri: string }) => ({
      attachment: { ...attachment, uri: 'file:///data/mindwtr/attachments/copied.bin' },
      status: 'copied',
    }));

    await act(async () => {
      create(
        <TestHarness
          hasShareIntent
          incomingUrl={null}
          router={router}
          shareFiles={[{ fileName: 'setup.exe', mimeType: 'application/x-msdownload', path: '/share/tmp/setup.exe', size: null }]}
          shareText="Install this"
          showToast={showToast}
        />
      );
    });

    // The blocklist rejects the file before any copy happens.
    expect(persistAttachmentLocallyDetailed).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledTimes(1);
    const params = router.replace.mock.calls[0][0].params;
    expect(decodeURIComponent(params.initialValue)).toBe('Install this');
    expect(params.initialProps).toBeUndefined();
  });

  it('handles a share intent once even when hook dependencies change mid-copy', async () => {
    const resetShareIntent = vi.fn();
    let resolveCopy!: (value: { uri: string }) => void;
    persistAttachmentLocallyDetailed.mockImplementation((attachment: { uri: string }) => new Promise((resolve) => {
      resolveCopy = () => resolve({
        attachment: { ...attachment, uri: 'file:///data/mindwtr/attachments/copied.pdf' },
        status: 'copied',
      });
    }));

    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(
        <TestHarness
          hasShareIntent
          incomingUrl={null}
          resetShareIntent={resetShareIntent}
          router={router}
          shareFiles={[{ fileName: 'doc.pdf', mimeType: 'application/pdf', path: '/share/tmp/doc.pdf', size: 64 }]}
          showToast={showToast}
        />
      );
    });

    // Let validation finish so the copy is genuinely in flight.
    await act(async () => {
      await Promise.resolve();
    });
    expect(persistAttachmentLocallyDetailed).toHaveBeenCalledTimes(1);

    // A re-render with a new showToast identity while the copy is pending
    // re-runs the effect; the in-flight guard must not start a second copy.
    act(() => {
      tree.update(
        <TestHarness
          hasShareIntent
          incomingUrl={null}
          resetShareIntent={resetShareIntent}
          router={router}
          shareFiles={[{ fileName: 'doc.pdf', mimeType: 'application/pdf', path: '/share/tmp/doc.pdf', size: 64 }]}
          showToast={vi.fn()}
        />
      );
    });

    await act(async () => {
      resolveCopy({ uri: 'unused' });
      await Promise.resolve();
    });

    expect(persistAttachmentLocallyDetailed).toHaveBeenCalledTimes(1);
    expect(router.replace).toHaveBeenCalledTimes(1);
    expect(resetShareIntent).toHaveBeenCalledTimes(1);
  });

  it('opens a confirmation modal for App Actions capture links', () => {
    act(() => {
      create(
        <TestHarness
          incomingUrl="mindwtr:///capture?title=Call%20dentist&note=Tomorrow&tags=phone&project=Home"
          router={router}
          showToast={showToast}
        />
      );
    });

    expect(router.replace).toHaveBeenCalledWith({
      pathname: '/capture-modal',
      params: {
        initialValue: 'Call%20dentist',
        initialProps: expect.any(String),
        project: 'Home',
      },
    });
    const params = router.replace.mock.calls[0][0].params;
    expect(JSON.parse(decodeURIComponent(params.initialProps))).toEqual({
      description: 'Tomorrow',
      tags: ['#phone'],
    });
  });

  it('opens the capture sheet again when the same shortcut link is delivered a second time', () => {
    // An Action Button shortcut that opens a fixed mindwtr://capture link
    // worked once per app session: the second delivery carried the same
    // string and was treated as already handled (in-app report, iOS 26).
    let tree!: ReturnType<typeof create>;
    const url = 'mindwtr:///capture?title=Call%20dentist';

    act(() => {
      tree = create(<TestHarness incomingUrl={url} incomingUrlKey={1} router={router} showToast={showToast} />);
    });
    act(() => {
      tree.update(<TestHarness incomingUrl={url} incomingUrlKey={2} router={router} showToast={showToast} />);
    });

    expect(router.replace).toHaveBeenCalledTimes(2);
  });

  it('does not reopen the capture sheet on a re-render that carries no new delivery', () => {
    let tree!: ReturnType<typeof create>;
    const url = 'mindwtr:///capture?title=Call%20dentist';

    act(() => {
      tree = create(<TestHarness incomingUrl={url} incomingUrlKey={1} router={router} showToast={showToast} />);
    });
    act(() => {
      tree.update(<TestHarness incomingUrl={url} incomingUrlKey={1} router={router} showToast={vi.fn()} />);
    });

    expect(router.replace).toHaveBeenCalledTimes(1);
  });

  it('handles repeated App Actions captures when the request id changes', () => {
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(
        <TestHarness
          incomingUrl="mindwtr:///capture?title=Call%20dentist&requestId=first"
          incomingUrlKey={1}
          router={router}
          showToast={showToast}
        />
      );
    });

    act(() => {
      tree.update(
        <TestHarness
          incomingUrl="mindwtr:///capture?title=Call%20dentist&requestId=second"
          incomingUrlKey={2}
          router={router}
          showToast={showToast}
        />
      );
    });

    expect(router.replace).toHaveBeenCalledTimes(2);
    expect(router.replace).toHaveBeenNthCalledWith(1, {
      pathname: '/capture-modal',
      params: {
        initialValue: 'Call%20dentist',
      },
    });
    expect(router.replace).toHaveBeenNthCalledWith(2, {
      pathname: '/capture-modal',
      params: {
        initialValue: 'Call%20dentist',
      },
    });
  });

  it('leaves the capture-quick widget link to Expo Router (#1066)', () => {
    act(() => {
      create(
        <TestHarness
          incomingUrl="mindwtr:///capture-quick?mode=text"
          router={router}
          showToast={showToast}
        />
      );
    });

    expect(router.replace).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });

  it('routes App Actions feature links through the feature inventory map', () => {
    act(() => {
      create(
        <TestHarness
          incomingUrl="mindwtr:///open-feature?feature=focus"
          router={router}
          showToast={showToast}
        />
      );
    });

    expect(router.replace).toHaveBeenCalledWith('/focus');
    expect(router.push).not.toHaveBeenCalled();
  });

  it('arms the AppSearch index once on mount (#1017)', () => {
    act(() => {
      create(<TestHarness incomingUrl={null} router={router} showToast={showToast} />);
    });
    expect(syncAppSearchIndexingWithPreference).toHaveBeenCalledTimes(1);
  });

  it('opens the matching task for a valid entity-open task link (#1017)', () => {
    storeTasksById.set('task-1', { id: 'task-1', title: 'Buy milk' });

    act(() => {
      create(
        <TestHarness
          incomingUrl="mindwtr://open?task=task-1"
          router={router}
          showToast={showToast}
        />
      );
    });

    expect(setHighlightTask).toHaveBeenCalledWith('task-1');
    expect(router.replace).toHaveBeenCalledWith({
      pathname: '/focus',
      params: expect.objectContaining({ taskId: 'task-1', taskTab: 'view' }),
    });
  });

  it('opens the matching project for a valid entity-open project link (#1017)', () => {
    storeProjectsById.set('proj-1', { id: 'proj-1', title: 'Kitchen' });

    act(() => {
      create(
        <TestHarness
          incomingUrl="mindwtr:///open?project=proj-1"
          router={router}
          showToast={showToast}
        />
      );
    });

    expect(router.replace).toHaveBeenCalledWith({
      pathname: '/projects-screen',
      params: { projectId: 'proj-1' },
    });
  });

  it('opens Projects (the closest existing view) for a valid entity-open area link (#1017)', () => {
    storeAreasById.set('area-1', { id: 'area-1', name: 'Home' });

    act(() => {
      create(
        <TestHarness
          incomingUrl="mindwtr://open?area=area-1"
          router={router}
          showToast={showToast}
        />
      );
    });

    expect(router.replace).toHaveBeenCalledWith({ pathname: '/projects-screen' });
  });

  it('falls back to Inbox for an unknown or deleted entity id (#1017)', () => {
    storeTasksById.set('task-deleted', { id: 'task-deleted', title: 'Gone', deletedAt: '2026-01-01T00:00:00.000Z' });

    act(() => {
      create(
        <TestHarness
          incomingUrl="mindwtr://open?task=task-unknown"
          router={router}
          showToast={showToast}
        />
      );
    });
    expect(router.replace).toHaveBeenCalledWith('/inbox');
    router.replace.mockClear();

    act(() => {
      create(
        <TestHarness
          incomingUrl="mindwtr://open?task=task-deleted"
          router={router}
          showToast={showToast}
        />
      );
    });
    expect(router.replace).toHaveBeenCalledWith('/inbox');
  });

  it('falls back to Inbox for a malformed entity-open link', () => {
    act(() => {
      create(
        <TestHarness
          incomingUrl="mindwtr://open?bogus=1"
          router={router}
          showToast={showToast}
        />
      );
    });
    expect(router.replace).toHaveBeenCalledWith('/inbox');
  });
});
