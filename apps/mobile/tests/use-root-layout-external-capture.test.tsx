import React from 'react';
import { Platform } from 'react-native';
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import { useRootLayoutExternalCapture } from '@/hooks/root-layout/use-root-layout-external-capture';
import { redirectSystemPath } from '@/app/+native-intent';
import { logError, logInfo, logWarn } from '@/lib/app-log';

vi.mock('@/lib/app-log', () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
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
  canGoBack: Mock<() => boolean>;
  push: Mock<(...args: any[]) => void>;
  replace: Mock<(...args: any[]) => void>;
};

type ExternalCaptureOptions = Parameters<typeof useRootLayoutExternalCapture>[0];
type ShowToast = ExternalCaptureOptions['showToast'];

type SharedFile = {
  fileName?: string | null;
  mimeType?: string | null;
  path?: string | null;
  size?: number | null;
};

function TestHarness({
  canonicalDataReady = true,
  dataReady = true,
  disabled = false,
  hasShareIntent = false,
  incomingUrl,
  incomingUrlKey = incomingUrl ? 1 : 0,
  locked = false,
  providerReady = true,
  resetShareIntent = vi.fn(),
  router,
  shareError = null,
  shareFiles = null,
  shareSubject = null,
  shareText = null,
  shareWebUrl = null,
  showToast,
}: {
  canonicalDataReady?: boolean;
  dataReady?: boolean;
  disabled?: boolean;
  hasShareIntent?: boolean;
  incomingUrl: string | null;
  incomingUrlKey?: number;
  locked?: boolean;
  providerReady?: boolean;
  resetShareIntent?: () => void;
  router: RouterMock;
  shareError?: string | null;
  shareFiles?: SharedFile[] | null;
  shareSubject?: string | null;
  shareText?: string | null;
  shareWebUrl?: string | null;
  showToast: ShowToast;
}) {
  useRootLayoutExternalCapture({
    canonicalDataReady,
    dataReady,
    disabled,
    hasShareIntent,
    incomingUrl,
    incomingUrlKey,
    locked,
    providerReady,
    resolveText: (_key: string, fallback: string) => fallback,
    resetShareIntent,
    router,
    shareError,
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
  let showToast = vi.fn<ShowToast>();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(logError).mockReset();
    vi.mocked(logInfo).mockReset().mockResolvedValue(null);
    vi.mocked(logWarn).mockReset();
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
    storeTasksById.clear();
    storeProjectsById.clear();
    storeAreasById.clear();
    router = {
      canGoBack: vi.fn(() => false),
      push: vi.fn(),
      replace: vi.fn(),
    };
    showToast = vi.fn<ShowToast>();
  });

  it.each(['note', 'body', 'thingDescription', 'itemListDescription'])(
    'keeps private %s content out of invalid shortcut diagnostics', (alias) => {
      const secret = 'private-shortcut-note';
      let tree!: ReturnType<typeof create>;
      act(() => {
        tree = create(<TestHarness
          incomingUrl={`mindwtr://capture?${alias}=${secret}&project=private-project&tags=private-tag`}
          router={router} showToast={showToast}
        />);
      });
      expect(showToast).toHaveBeenCalled();
      expect(router.replace).not.toHaveBeenCalled();
      expect(logWarn).toHaveBeenCalledWith('Invalid shortcut capture URL', {
        scope: 'shortcuts',
        extra: { releaseCheck: 'v1.3.1/shortcut-failure-privacy', stage: 'invalid-payload' },
      });
      expect(JSON.stringify([vi.mocked(logWarn).mock.calls, vi.mocked(logError).mock.calls])).not.toContain('private-');
      act(() => tree.unmount());
    },
  );

  it.each(['title', 'text', 'name', 'thingName', 'itemListElementName', 'itemListName'])(
    'keeps private %s content and router errors out of failed shortcut diagnostics', (alias) => {
      const incomingUrl = `mindwtr://capture?${alias}=private-title&body=private-note&project=private-project&tags=private-tag`;
      router.replace.mockImplementation(() => { throw new Error(`Cannot navigate to ${incomingUrl}`); });
      let tree!: ReturnType<typeof create>;
      act(() => {
        tree = create(<TestHarness incomingUrl={incomingUrl} router={router} showToast={showToast} />);
      });
      expect(router.replace).toHaveBeenCalledTimes(1);
      expect(logWarn).toHaveBeenCalledWith('Shortcut capture confirmation failed', {
        scope: 'shortcuts',
        extra: { releaseCheck: 'v1.3.1/shortcut-failure-privacy', stage: 'navigation' },
      });
      expect(logError).not.toHaveBeenCalled();
      expect(JSON.stringify(vi.mocked(logWarn).mock.calls)).not.toContain('private-');
      // The failed delivery remains retryable once navigation is available.
      router.replace.mockReset();
      act(() => { tree.update(<TestHarness incomingUrl={incomingUrl} router={router} showToast={showToast} />); });
      expect(router.replace).toHaveBeenCalledTimes(1);
      act(() => tree.unmount());
    },
  );

  it.each([true, false])('returns from shortcut confirmation without a blank capture route (initial=%s)', (initial) => {
    const url = 'mindwtr:///capture?title=Call%20dentist&note=Tomorrow&tags=phone&project=Home';
    const stack: unknown[] = [redirectSystemPath({ path: url, initial })];
    router.canGoBack.mockReturnValue(true);
    router.push.mockImplementation((route) => { stack.push(route); });
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<TestHarness incomingUrl={url} router={router} showToast={showToast} />);
    });
    expect(stack[1]).toEqual({
      pathname: '/capture-modal',
      params: {
        initialValue: encodeURIComponent('Call dentist'),
        initialProps: encodeURIComponent(JSON.stringify({ description: 'Tomorrow', tags: ['#phone'] })),
        project: 'Home',
      },
    });
    // Closing confirmation (Save with Add another off, or Cancel) goes back.
    stack.pop();
    act(() => {
      tree.update(<TestHarness incomingUrl={url} router={router} showToast={showToast} />);
    });
    expect(stack).toEqual(['/inbox']);
    expect(router.push).toHaveBeenCalledTimes(1);
    act(() => tree.unmount());
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

  it.each([true, false])('preserves the share payload and opens once per delivery after route interception (initial=%s)', async (initial) => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
    const incomingUrl = 'mindwtr://dataUrl=mindwtrShareKey/';
    const shareWebUrl = 'https://example.com/private-article';
    const resetShareIntent = vi.fn();
    let currentRoute: unknown = '/focus';
    const routeHandoff = (cold: boolean) => {
      const route = redirectSystemPath({ path: incomingUrl, initial: cold });
      // Matches Expo Router's subscription: an empty result skips navigation.
      if (route) currentRoute = route;
    };
    routeHandoff(initial);
    await vi.dynamicImportSettled();
    expect(currentRoute).toBe(initial ? '/inbox' : '/focus');
    router.replace.mockImplementation((route) => { currentRoute = route; });
    let tree!: ReturnType<typeof create>;
    const render = (hasShareIntent: boolean, canonicalDataReady: boolean, delivery = 1) => (
      <TestHarness
        canonicalDataReady={canonicalDataReady} hasShareIntent={hasShareIntent}
        incomingUrl={incomingUrl} incomingUrlKey={delivery}
        resetShareIntent={resetShareIntent} router={router}
        shareWebUrl={hasShareIntent ? shareWebUrl : null} showToast={showToast}
      />
    );
    act(() => { tree = create(render(true, false)); });
    expect(router.replace).not.toHaveBeenCalled();
    act(() => { tree.update(render(true, true)); });
    const captureRoute = {
      pathname: '/capture-modal',
      params: { initialValue: encodeURIComponent(shareWebUrl), origin: 'share' },
    };
    expect(currentRoute).toEqual(captureRoute);
    expect(router.replace).toHaveBeenCalledOnce();
    expect(resetShareIntent).toHaveBeenCalledOnce();
    act(() => { tree.update(render(false, true)); });
    act(() => { tree.update(render(false, true)); });
    expect(router.replace).toHaveBeenCalledOnce();

    // A delayed Router callback must not overwrite the populated modal.
    routeHandoff(false);
    expect(currentRoute).toEqual(captureRoute);
    // Sharing the same URL again is a new payload, not a suppressed duplicate.
    act(() => { tree.update(render(true, true, 2)); });
    act(() => { tree.update(render(false, true, 2)); });
    expect(router.replace).toHaveBeenCalledTimes(2);
    expect(resetShareIntent).toHaveBeenCalledTimes(2);
    expect(currentRoute).toEqual(captureRoute);
    expect(showToast).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(vi.mocked(logInfo).mock.calls.filter(
      ([message]) => message === 'Share handoff routed',
    )).toHaveLength(2));
    expect(JSON.stringify(vi.mocked(logInfo).mock.calls)).not.toContain('private-article');
    act(() => tree.unmount());
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

  it('traces cold and warm iOS host receipt once per delivery without recording the URL', () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
    const url = 'mindwtr://dataUrl=/private/secret-file#weburl';
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<TestHarness incomingUrl={url} incomingUrlKey={1} router={router} showToast={showToast} />);
    });
    act(() => {
      tree.update(<TestHarness incomingUrl={url} incomingUrlKey={1} router={router} showToast={vi.fn()} />);
      tree.update(<TestHarness incomingUrl={url} incomingUrlKey={2} router={router} showToast={showToast} />);
    });

    const receipts = vi.mocked(logInfo).mock.calls.filter(([, context]) => context?.extra?.stage === 'host-url-received');
    expect(receipts).toHaveLength(2);
    expect(receipts[0]?.[1]?.extra).toMatchObject({ type: 'weburl', providerReady: true });
    expect(JSON.stringify(receipts)).not.toContain('secret-file');
  });

  it('traces data readiness deferral then navigates and resets once without rerender duplicates', () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
    const resetShareIntent = vi.fn();
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(
        <TestHarness
          canonicalDataReady={false}
          hasShareIntent
          incomingUrl={null}
          providerReady={false}
          resetShareIntent={resetShareIntent}
          router={router}
          shareText="private selected text"
          showToast={showToast}
        />
      );
    });
    expect(router.replace).not.toHaveBeenCalled();
    act(() => {
      tree.update(
        <TestHarness
          canonicalDataReady
          hasShareIntent
          incomingUrl={null}
          providerReady
          resetShareIntent={resetShareIntent}
          router={router}
          shareText="private selected text"
          showToast={showToast}
        />
      );
    });

    const stages = vi.mocked(logInfo).mock.calls.map(([, context]) => context?.extra?.stage);
    const providerStatuses = vi.mocked(logInfo).mock.calls
      .filter(([, context]) => context?.extra?.stage === 'provider-status')
      .map(([, context]) => context?.extra?.providerReady);
    expect(providerStatuses).toEqual([false, true]);
    expect(stages.filter((stage) => stage === 'payload-seen')).toHaveLength(1);
    expect(stages).toEqual(expect.arrayContaining([
      'waiting',
      'processing-started',
      'navigation-requested',
      'navigation-returned',
      'reset-requested',
      'reset-returned',
    ]));
    expect(router.replace).toHaveBeenCalledWith({
      pathname: '/capture-modal',
      params: { initialValue: 'private%20selected%20text', origin: 'share' },
    });
    expect(resetShareIntent).toHaveBeenCalledOnce();
    expect(JSON.stringify([...vi.mocked(logInfo).mock.calls, ...vi.mocked(logWarn).mock.calls])).not.toContain('private selected text');
  });

  it('observes an iOS payload while capture handling is disabled without processing it', () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
    act(() => {
      create(
        <TestHarness
          disabled
          hasShareIntent
          incomingUrl={null}
          providerReady
          router={router}
          shareText="private disabled share"
          showToast={showToast}
        />
      );
    });

    const events = vi.mocked(logInfo).mock.calls.map(([, context]) => context?.extra);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: 'payload-seen', disabled: true }),
      expect.objectContaining({ stage: 'waiting', outcome: 'disabled' }),
    ]));
    expect(events).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: 'processing-started' }),
    ]));
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('traces an empty payload and an iOS native error without retaining sensitive error text', () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
    const resetShareIntent = vi.fn();
    act(() => {
      create(
        <TestHarness
          hasShareIntent
          incomingUrl={null}
          resetShareIntent={resetShareIntent}
          router={router}
          shareError="Cannot read https://private.example/token"
          shareText="   "
          showToast={showToast}
        />
      );
    });

    const warnings = vi.mocked(logWarn).mock.calls;
    expect(warnings.map(([, context]) => context?.extra?.stage)).toEqual(expect.arrayContaining(['native-error', 'payload-missing']));
    expect(JSON.stringify(warnings)).not.toContain('private.example');
    expect(logError).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('private.example') }),
      expect.anything(),
    );
    expect(resetShareIntent).toHaveBeenCalledOnce();
  });

  it('logs the same iOS native error for a later share delivery while preserving toast deduplication', () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
    const error = 'Cannot read https://private.example/repeated-token';
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(
        <TestHarness
          incomingUrl="mindwtr://dataUrl=/private/first#weburl"
          incomingUrlKey={1}
          router={router}
          shareError={error}
          showToast={showToast}
        />
      );
    });
    act(() => {
      tree.update(
        <TestHarness
          incomingUrl="mindwtr:///capture-quick?mode=text"
          incomingUrlKey={2}
          router={router}
          shareError={error}
          showToast={showToast}
        />
      );
    });
    expect(vi.mocked(logWarn).mock.calls.filter(([, context]) => context?.extra?.stage === 'native-error')).toHaveLength(1);

    act(() => {
      tree.update(
        <TestHarness
          incomingUrl="mindwtr:///capture-quick?mode=text"
          incomingUrlKey={2}
          router={router}
          shareError={null}
          showToast={showToast}
        />
      );
      tree.update(
        <TestHarness
          incomingUrl="mindwtr://dataUrl=/private/second#weburl"
          incomingUrlKey={3}
          router={router}
          shareError={error}
          showToast={showToast}
        />
      );
    });

    const nativeErrors = vi.mocked(logWarn).mock.calls.filter(([, context]) => context?.extra?.stage === 'native-error');
    expect(nativeErrors).toHaveLength(2);
    expect(showToast).toHaveBeenCalledOnce();
    expect(JSON.stringify(nativeErrors)).not.toContain('private.example');

    // Commit the cleared error separately so React does not batch it away.
    // A repeated error without another URL delivery must still be observable.
    act(() => {
      tree.update(
        <TestHarness
          incomingUrl="mindwtr://dataUrl=/private/second#weburl"
          incomingUrlKey={3}
          router={router}
          shareError={null}
          showToast={showToast}
        />
      );
    });
    act(() => {
      tree.update(
        <TestHarness
          incomingUrl="mindwtr://dataUrl=/private/second#weburl"
          incomingUrlKey={3}
          router={router}
          shareError={error}
          showToast={showToast}
        />
      );
    });
    expect(vi.mocked(logWarn).mock.calls.filter(([, context]) => context?.extra?.stage === 'native-error')).toHaveLength(3);
    expect(showToast).toHaveBeenCalledOnce();
  });

  it('keeps routing when the diagnostic logger throws and does not log on Android without a share', () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
    vi.mocked(logInfo).mockImplementation(() => { throw new Error('logger unavailable'); });
    expect(() => {
      act(() => {
        create(
          <TestHarness
            hasShareIntent
            incomingUrl={null}
            router={router}
            shareText="still routes"
            showToast={showToast}
          />
        );
      });
    }).not.toThrow();
    expect(router.replace).toHaveBeenCalledOnce();

    vi.clearAllMocks();
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
    act(() => {
      create(<TestHarness incomingUrl={null} router={router} showToast={showToast} />);
    });
    expect(logInfo).not.toHaveBeenCalled();
    expect(logWarn).not.toHaveBeenCalled();
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
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
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
    expect(vi.mocked(logInfo).mock.calls).toContainEqual([
      'iOS incoming share diagnostic',
      expect.objectContaining({
        extra: expect.objectContaining({
          stage: 'files-prepared',
          candidateCount: 1,
          attachedCount: 1,
          skippedCount: 0,
        }),
      }),
    ]);
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

  // The capture sheet and entity links read tasks and projects from the store,
  // and the startup snapshot can lag SQLite. The link waits for canonical data.
  it('holds a capture link until canonical data is ready, then opens the sheet once', () => {
    let tree!: ReturnType<typeof create>;
    const url = 'mindwtr:///capture?title=Call%20dentist';

    act(() => {
      tree = create(<TestHarness canonicalDataReady={false} incomingUrl={url} router={router} showToast={showToast} />);
    });
    expect(router.replace).not.toHaveBeenCalled();

    act(() => {
      tree.update(<TestHarness incomingUrl={url} router={router} showToast={showToast} />);
    });
    act(() => {
      tree.update(<TestHarness incomingUrl={url} router={router} showToast={vi.fn()} />);
    });

    expect(router.replace).toHaveBeenCalledTimes(1);
    expect(router.replace).toHaveBeenCalledWith({
      pathname: '/capture-modal',
      params: { initialValue: 'Call%20dentist' },
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

  // A widget task tap while the app lock was on (#1475): the replace ran while the lock had unmounted the
  // app's navigator, so Expo Router replaced its own root route, which remounted the root layout (lock
  // included) and replayed the link, over and over. The link now waits for the unlock, then opens once.
  it('holds a task link while the app is locked and opens it once after the unlock (#1475)', () => {
    storeTasksById.set('task-1', { id: 'task-1', title: 'Buy milk' });
    const url = 'mindwtr://open?task=task-1';
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<TestHarness incomingUrl={url} locked router={router} showToast={showToast} />);
    });
    act(() => {
      tree.update(<TestHarness incomingUrl={url} locked router={router} showToast={showToast} />);
    });

    expect(router.replace).not.toHaveBeenCalled();
    expect(setHighlightTask).not.toHaveBeenCalled();
    const held = vi.mocked(logInfo).mock.calls.filter(([message]) => message === 'Incoming link held until unlock');
    expect(held).toEqual([['Incoming link held until unlock', {
      scope: 'routing',
      extra: { releaseCheck: 'v1.3.8/app-lock-link-hold', kind: 'task' },
      force: true,
    }]]);

    act(() => {
      tree.update(<TestHarness incomingUrl={url} router={router} showToast={showToast} />);
    });
    act(() => {
      tree.update(<TestHarness incomingUrl={url} router={router} showToast={showToast} />);
    });

    expect(router.replace).toHaveBeenCalledTimes(1);
    expect(router.replace).toHaveBeenCalledWith({
      pathname: '/focus',
      params: expect.objectContaining({ taskId: 'task-1', taskTab: 'view' }),
    });
  });

  it('holds a share while the app is locked (#1475)', () => {
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<TestHarness hasShareIntent incomingUrl={null} locked router={router} shareText="Shared note" showToast={showToast} />);
    });
    expect(router.replace).not.toHaveBeenCalled();

    act(() => {
      tree.update(<TestHarness hasShareIntent incomingUrl={null} router={router} shareText="Shared note" showToast={showToast} />);
    });
    expect(router.replace).toHaveBeenCalledTimes(1);
    expect(router.replace).toHaveBeenCalledWith(expect.objectContaining({ pathname: '/capture-modal' }));
  });

  // A cold widget tap used to sit on the Inbox until canonical data loaded (#1310).
  it('opens a task link from the startup snapshot before canonical data is ready', () => {
    storeTasksById.set('task-1', { id: 'task-1', title: 'Buy milk' });

    act(() => {
      create(
        <TestHarness
          canonicalDataReady={false}
          incomingUrl="mindwtr://open?task=task-1"
          router={router}
          showToast={showToast}
        />
      );
    });

    expect(router.replace).toHaveBeenCalledTimes(1);
    expect(router.replace).toHaveBeenCalledWith({
      pathname: '/focus',
      params: expect.objectContaining({ taskId: 'task-1', taskTab: 'view' }),
    });
  });

  it('holds a task link the snapshot lacks until canonical data is ready', () => {
    let tree!: ReturnType<typeof create>;
    const url = 'mindwtr://open?task=task-late';

    act(() => {
      tree = create(<TestHarness dataReady={false} canonicalDataReady={false} incomingUrl={url} router={router} showToast={showToast} />);
    });
    act(() => {
      tree.update(<TestHarness canonicalDataReady={false} incomingUrl={url} router={router} showToast={showToast} />);
    });
    expect(router.replace).not.toHaveBeenCalled();

    storeTasksById.set('task-late', { id: 'task-late', title: 'Synced later' });
    act(() => {
      tree.update(<TestHarness incomingUrl={url} router={router} showToast={showToast} />);
    });

    expect(router.replace).toHaveBeenCalledTimes(1);
    expect(router.replace).toHaveBeenCalledWith({
      pathname: '/focus',
      params: expect.objectContaining({ taskId: 'task-late' }),
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
    expect(showToast).toHaveBeenCalledWith({
      message: 'This task is not in this library. It may have been deleted or not synced to this device.', tone: 'error',
    });
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
