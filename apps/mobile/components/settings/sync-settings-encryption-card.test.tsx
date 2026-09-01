import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Text, TextInput, TouchableOpacity } from 'react-native';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncEncryptionRemoteVersionUnavailableError, type AppData } from '@mindwtr/core';
import type { ThemeColors } from '@/hooks/use-theme-colors';

type EncryptionState = 'off' | 'enabled' | 'remote-encrypted-no-key' | 'remote-plaintext';
type TransitionOptions = { appData?: unknown; onProgress?: (progress: unknown) => void };

const encryptionMocks = vi.hoisted(() => ({
  changeSyncEncryptionPassphrase: vi.fn(
    async (_current: string, _next: string, _options?: TransitionOptions): Promise<void> => undefined,
  ),
  declineSyncEncryptionPassphrase: vi.fn(async (): Promise<void> => undefined),
  disableSyncEncryption: vi.fn(async (_options?: TransitionOptions): Promise<void> => undefined),
  enableSyncEncryption: vi.fn(
    async (_passphrase: string, _options?: TransitionOptions): Promise<void> => undefined,
  ),
  getSyncEncryptionStatus: vi.fn(async (): Promise<{ state: EncryptionState }> => ({ state: 'off' })),
  isSyncEncryptionBackendPending: vi.fn(async (): Promise<boolean> => false),
  provideSyncEncryptionPassphrase: vi.fn(
    async (_passphrase: string): Promise<'ok' | 'wrong-passphrase'> => 'ok',
  ),
  isSyncEncryptionCleanupDeferredError: (error: unknown) => (
    error instanceof Error && error.name === 'SyncEncryptionCleanupDeferredError'
  ),
}));

vi.mock('@/lib/sync-encryption-service', () => encryptionMocks);
vi.mock('@/lib/sync-crypto-native', () => ({
  mobileSyncCryptoPrimitives: {
    // Deterministic so the generated phrase is assertable; the real provider is
    // quick-crypto's OpenSSL RAND_bytes.
    randomBytes: (n: number) => new Uint8Array(n).fill(1),
  },
}));
vi.mock('@/lib/settings-utils', () => ({ logSettingsError: vi.fn() }));
// settings.shell (SettingsGuideLink) pulls in router/icon/inset modules the
// card itself never needs; mock them the way settings.shell.test does.
vi.mock('expo-router', () => ({
  useRouter: () => ({ back: vi.fn(), canGoBack: () => false }),
}));
vi.mock('lucide-react-native', async () => {
  const ReactModule = await vi.importActual<typeof import('react')>('react');
  const Icon = (props: Record<string, unknown>) => ReactModule.createElement('Icon', props);
  return { ChevronRight: Icon, ExternalLink: Icon };
});
vi.mock('@expo/vector-icons', async () => {
  const ReactModule = await vi.importActual<typeof import('react')>('react');
  return { Ionicons: (props: Record<string, unknown>) => ReactModule.createElement('Icon', props) };
});
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
vi.mock('@/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ text: '#f8fafc', secondaryText: '#94a3b8', tint: '#3b82f6', border: '#334155' }),
}));
vi.mock('@/contexts/language-context', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}));

import { SyncEncryptionCard } from './sync-settings-encryption-card';

const tc = {
  bg: '#0f172a',
  cardBg: '#111827',
  border: '#334155',
  inputBg: '#1e293b',
  text: '#f8fafc',
  secondaryText: '#94a3b8',
  tint: '#3b82f6',
  warning: '#8C5A00',
  danger: '#BA1A1A',
} as unknown as ThemeColors;

const findText = (tree: renderer.ReactTestRenderer, content: string) =>
  tree.root.findAllByType(Text).find((node) => node.props.children === content);

const flatStyle = (style: unknown): Record<string, unknown> => (
  Array.isArray(style) ? Object.assign({}, ...style.filter(Boolean)) : (style as Record<string, unknown>)
);

const t = (key: string) => key;

const appData = {
  tasks: [],
  projects: [],
  sections: [],
  areas: [],
  settings: {},
} as unknown as AppData;

const renderCard = async () => {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<SyncEncryptionCard appData={appData} t={t} tc={tc} />);
  });
  return tree;
};

const texts = (tree: renderer.ReactTestRenderer): string[] =>
  tree.root
    .findAllByType(Text)
    .map((node) => node.props.children)
    .filter((child): child is string => typeof child === 'string');

const press = async (tree: renderer.ReactTestRenderer, label: string) => {
  const target = tree.root
    .findAllByType(TouchableOpacity)
    .find((node) => node.findAllByType(Text).some((child) => child.props.children === label));
  if (!target) throw new Error(`No pressable containing "${label}"`);
  await act(async () => {
    target.props.onPress();
  });
};

const typeInto = async (tree: renderer.ReactTestRenderer, label: string, value: string) => {
  const input = tree.root
    .findAllByType(TextInput)
    .find((node) => node.props.accessibilityLabel === label);
  if (!input) throw new Error(`No input labelled "${label}"`);
  await act(async () => {
    input.props.onChangeText(value);
  });
};

const inputLabels = (tree: renderer.ReactTestRenderer): string[] =>
  tree.root.findAllByType(TextInput).map((node) => node.props.accessibilityLabel as string);

describe('SyncEncryptionCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    encryptionMocks.getSyncEncryptionStatus.mockResolvedValue({ state: 'off' });
    encryptionMocks.provideSyncEncryptionPassphrase.mockResolvedValue('ok');
    encryptionMocks.isSyncEncryptionBackendPending.mockResolvedValue(false);
  });

  it('shows both warnings before anything can be enabled', async () => {
    const tree = await renderCard();
    expect(texts(tree)).not.toContain('settings.syncEncryptionWarningLost');

    await press(tree, 'settings.syncEncryptionEnable');

    expect(texts(tree)).toContain('settings.syncEncryptionWarningLost');
    expect(texts(tree)).toContain('settings.syncEncryptionWarningDevices');
  });

  it('swaps to the pre-first-sync copy while no durable backend exists', async () => {
    encryptionMocks.isSyncEncryptionBackendPending.mockResolvedValue(true);
    encryptionMocks.getSyncEncryptionStatus.mockResolvedValue({ state: 'enabled' });
    const tree = await renderCard();

    await press(tree, 'settings.syncEncryptionDisable');

    expect(texts(tree)).toContain('settings.syncEncryptionDisableWarningNoBackend');
    expect(texts(tree)).not.toContain('settings.syncEncryptionDisableWarning');
  });

  it('shows the first-sync-encrypted hint when enabling before sync is set up', async () => {
    encryptionMocks.isSyncEncryptionBackendPending.mockResolvedValue(true);
    const tree = await renderCard();

    await press(tree, 'settings.syncEncryptionEnable');

    expect(texts(tree)).toContain('settings.syncEncryptionEnableBeforeFirstSyncHint');
  });

  it('enables with the typed passphrase and the local document', async () => {
    const tree = await renderCard();
    await press(tree, 'settings.syncEncryptionEnable');
    await typeInto(tree, 'settings.syncEncryptionPassphrase', 'first swimmer bagpipe');
    await typeInto(tree, 'settings.syncEncryptionPassphraseConfirm', 'first swimmer bagpipe');
    await press(tree, 'settings.syncEncryptionEnable');

    expect(encryptionMocks.enableSyncEncryption).toHaveBeenCalledTimes(1);
    const [passphrase, options] = encryptionMocks.enableSyncEncryption.mock.calls[0];
    expect(passphrase).toBe('first swimmer bagpipe');
    // Without appData the transition silently leaves every attachment in plaintext.
    expect(options?.appData).toBe(appData);
  });

  it('blocks a mismatch client-side and never calls the API', async () => {
    const tree = await renderCard();
    await press(tree, 'settings.syncEncryptionEnable');
    await typeInto(tree, 'settings.syncEncryptionPassphrase', 'first swimmer bagpipe');
    await typeInto(tree, 'settings.syncEncryptionPassphraseConfirm', 'first swimmer bagpipa');
    await press(tree, 'settings.syncEncryptionEnable');

    expect(encryptionMocks.enableSyncEncryption).not.toHaveBeenCalled();
    expect(texts(tree)).toContain('settings.syncEncryptionErrorMismatch');
  });

  it('keeps the submit row disabled while either field is empty', async () => {
    const tree = await renderCard();
    await press(tree, 'settings.syncEncryptionEnable');

    const submitRow = () => tree.root
      .findAllByType(TouchableOpacity)
      .filter((node) => node.findAllByType(Text)
        .some((child) => child.props.children === 'settings.syncEncryptionEnable'))
      .at(-1)!;
    expect(submitRow().props.disabled).toBe(true);

    await typeInto(tree, 'settings.syncEncryptionPassphrase', 'only one side');
    expect(submitRow().props.disabled).toBe(true);

    await typeInto(tree, 'settings.syncEncryptionPassphraseConfirm', 'only one side');
    expect(submitRow().props.disabled).toBe(false);
  });

  it('fills both fields from the generator', async () => {
    const tree = await renderCard();
    await press(tree, 'settings.syncEncryptionEnable');
    await press(tree, 'settings.syncEncryptionGenerate');
    expect(texts(tree)).toContain('settings.syncEncryptionGeneratedHint');

    await press(tree, 'settings.syncEncryptionEnable');
    const [passphrase] = encryptionMocks.enableSyncEncryption.mock.calls[0];
    expect(passphrase.split(' ')).toHaveLength(6);
  });

  it('passes both values through when changing the passphrase', async () => {
    encryptionMocks.getSyncEncryptionStatus.mockResolvedValue({ state: 'enabled' });
    const tree = await renderCard();
    expect(texts(tree)).toContain('settings.syncEncryptionStatusOn');

    await press(tree, 'settings.syncEncryptionChange');
    await typeInto(tree, 'settings.syncEncryptionCurrentPassphrase', 'old phrase');
    await typeInto(tree, 'settings.syncEncryptionNewPassphrase', 'new phrase');
    await typeInto(tree, 'settings.syncEncryptionPassphraseConfirm', 'new phrase');
    await press(tree, 'settings.syncEncryptionChange');

    expect(encryptionMocks.changeSyncEncryptionPassphrase).toHaveBeenCalledWith(
      'old phrase',
      'new phrase',
      expect.objectContaining({ appData }),
    );
  });

  it('re-warns before turning encryption off, then disables', async () => {
    encryptionMocks.getSyncEncryptionStatus.mockResolvedValue({ state: 'enabled' });
    const tree = await renderCard();

    await press(tree, 'settings.syncEncryptionDisable');
    expect(texts(tree)).toContain('settings.syncEncryptionDisableWarning');

    await press(tree, 'settings.syncEncryptionDisable');
    expect(encryptionMocks.disableSyncEncryption).toHaveBeenCalled();
  });

  it('points a wedged disable at the passphrase change that has to finish first', async () => {
    encryptionMocks.getSyncEncryptionStatus.mockResolvedValue({ state: 'enabled' });
    encryptionMocks.disableSyncEncryption.mockRejectedValueOnce(
      new Error('SYNC_ENCRYPTION_TERMINAL: wrong passphrase or corrupted data'),
    );
    const tree = await renderCard();

    await press(tree, 'settings.syncEncryptionDisable');
    await press(tree, 'settings.syncEncryptionDisable');

    expect(texts(tree)).toContain('settings.syncEncryptionErrorRotationFirst');
  });

  it('explains how to resume a transition whose remote version could not be verified', async () => {
    encryptionMocks.getSyncEncryptionStatus.mockResolvedValue({ state: 'enabled' });
    encryptionMocks.disableSyncEncryption.mockRejectedValueOnce(
      new SyncEncryptionRemoteVersionUnavailableError('data.json has no strong ETag'),
    );
    const tree = await renderCard();

    await press(tree, 'settings.syncEncryptionDisable');
    await press(tree, 'settings.syncEncryptionDisable');

    const error = findText(tree, 'settings.syncEncryptionErrorTransitionIncomplete');
    expect(error?.props.accessibilityRole).toBe('alert');
    expect(error?.props.accessibilityLiveRegion).toBe('assertive');
    expect(texts(tree)).not.toContain('settings.syncEncryptionErrorRotationFirst');
  });

  it('closes a committed transition and shows a non-retry cleanup warning', async () => {
    encryptionMocks.getSyncEncryptionStatus
      .mockResolvedValueOnce({ state: 'off' })
      .mockResolvedValue({ state: 'enabled' });
    const cleanupError = Object.assign(new Error('SYNC_ENCRYPTION_COMMITTED_CLEANUP_DEFERRED'), {
      name: 'SyncEncryptionCleanupDeferredError',
      outcome: undefined,
      cleanupCause: new Error('release failed'),
      retryAfterMs: 12_000,
    });
    encryptionMocks.enableSyncEncryption.mockRejectedValueOnce(cleanupError);
    const tree = await renderCard();

    await press(tree, 'settings.syncEncryptionEnable');
    await typeInto(tree, 'settings.syncEncryptionPassphrase', 'correct horse battery');
    await typeInto(tree, 'settings.syncEncryptionPassphraseConfirm', 'correct horse battery');
    await press(tree, 'settings.syncEncryptionEnable');

    const warning = findText(tree, 'settings.syncEncryptionCleanupDeferred');
    expect(warning?.props.accessibilityRole).not.toBe('alert');
    expect(warning?.props.accessibilityLiveRegion).toBe('polite');
    expect(texts(tree)).not.toContain('settings.syncEncryptionErrorGeneric');
    expect(inputLabels(tree)).not.toContain('settings.syncEncryptionPassphrase');
  });

  it('closes committed File Sync encryption and tells the user to restart instead of retrying it', async () => {
    encryptionMocks.getSyncEncryptionStatus
      .mockResolvedValueOnce({ state: 'off' })
      .mockResolvedValue({ state: 'enabled' });
    const cleanupError = Object.assign(new Error('SYNC_ENCRYPTION_COMMITTED_CLEANUP_DEFERRED'), {
      name: 'SyncEncryptionCleanupDeferredError',
      outcome: undefined,
      cleanupCause: new Error('File Sync release failed'),
      cleanupKind: 'file-lock',
      retryAfterMs: 0,
    });
    encryptionMocks.enableSyncEncryption.mockRejectedValueOnce(cleanupError);
    const tree = await renderCard();

    await press(tree, 'settings.syncEncryptionEnable');
    await typeInto(tree, 'settings.syncEncryptionPassphrase', 'correct horse battery');
    await typeInto(tree, 'settings.syncEncryptionPassphraseConfirm', 'correct horse battery');
    await press(tree, 'settings.syncEncryptionEnable');

    expect(texts(tree)).toContain('settings.syncEncryptionFileCleanupDeferred');
    expect(texts(tree)).not.toContain('settings.syncEncryptionErrorGeneric');
    expect(inputLabels(tree)).not.toContain('settings.syncEncryptionPassphrase');
  });

  it('re-prompts inline when the entered passphrase is wrong', async () => {
    encryptionMocks.getSyncEncryptionStatus.mockResolvedValue({ state: 'remote-encrypted-no-key' });
    encryptionMocks.provideSyncEncryptionPassphrase.mockResolvedValue('wrong-passphrase');
    const tree = await renderCard();
    expect(texts(tree)).toContain('settings.syncEncryptionLockedTitle');

    await press(tree, 'settings.syncEncryptionUnlock');
    await typeInto(tree, 'settings.syncEncryptionPassphrase', 'not the right one');
    await press(tree, 'settings.syncEncryptionUnlock');

    expect(encryptionMocks.provideSyncEncryptionPassphrase).toHaveBeenCalledWith('not the right one');
    const error = findText(tree, 'settings.syncEncryptionErrorWrongPassphrase');
    expect(error?.props.accessibilityRole).toBe('alert');
    expect(error?.props.accessibilityLiveRegion).toBe('assertive');
    // Still open for another attempt, and nothing suggests the data is damaged.
    expect(inputLabels(tree)).toContain('settings.syncEncryptionPassphrase');
  });

  it('declines through the persisted API and says sync stays paused', async () => {
    encryptionMocks.getSyncEncryptionStatus.mockResolvedValue({ state: 'remote-encrypted-no-key' });
    const tree = await renderCard();

    await press(tree, 'settings.syncEncryptionUnlock');
    await press(tree, 'settings.syncEncryptionDecline');

    expect(encryptionMocks.declineSyncEncryptionPassphrase).toHaveBeenCalled();
    expect(texts(tree)).toContain('settings.syncEncryptionPausedDesc');
    expect(inputLabels(tree)).not.toContain('settings.syncEncryptionPassphrase');
  });

  it('surfaces a peer-disabled sync location with the disable remedy and no passphrase change', async () => {
    encryptionMocks.getSyncEncryptionStatus.mockResolvedValue({ state: 'remote-plaintext' });
    const tree = await renderCard();

    expect(texts(tree)).toContain('settings.syncEncryptionRemotePlaintextDesc');
    // Rotating a passphrase against a location that no longer holds ciphertext is not a remedy.
    expect(texts(tree)).not.toContain('settings.syncEncryptionChange');

    await press(tree, 'settings.syncEncryptionDisable');
    await press(tree, 'settings.syncEncryptionDisable');
    expect(encryptionMocks.disableSyncEncryption).toHaveBeenCalled();
  });

  it('renders nothing until the first status read resolves', () => {
    // Never resolves: the card must not guess a state it has not read.
    encryptionMocks.getSyncEncryptionStatus.mockReturnValue(new Promise(() => undefined));
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<SyncEncryptionCard appData={appData} t={t} tc={tc} />);
    });
    expect(tree.root.findAllByType(Text)).toHaveLength(0);
    act(() => {
      tree.unmount();
    });
  });

  it('shows recovery and retries when the status read fails without claiming encryption is off', async () => {
    // 'off' offers "Enable encryption" — for a location that may already be
    // encrypted, that is the one answer a failed read must not give.
    encryptionMocks.getSyncEncryptionStatus
      .mockRejectedValueOnce(new Error('keyring unavailable'))
      .mockResolvedValue({ state: 'off' });
    const tree = await renderCard();
    expect(texts(tree)).toContain('settings.syncEncryptionStateUnavailable');
    expect(texts(tree)).not.toContain('settings.syncEncryptionEnable');

    await press(tree, 'settings.syncEncryptionRetry');
    expect(texts(tree)).toContain('settings.syncEncryptionEnable');
  });

  it('draws warnings and errors from the theme tokens, not hardcoded hexes', async () => {
    const tree = await renderCard();
    await press(tree, 'settings.syncEncryptionEnable');
    expect(flatStyle(findText(tree, 'settings.syncEncryptionWarningLost')?.props.style).color)
      .toBe(tc.warning);
    expect(flatStyle(findText(tree, 'settings.syncEncryptionWarningDevices')?.props.style).color)
      .toBe(tc.warning);

    await typeInto(tree, 'settings.syncEncryptionPassphrase', 'correct horse');
    await typeInto(tree, 'settings.syncEncryptionPassphraseConfirm', 'battery staple');
    await press(tree, 'settings.syncEncryptionEnable');
    const error = findText(tree, 'settings.syncEncryptionErrorMismatch');
    expect(flatStyle(error?.props.style).color).toBe(tc.danger);
    // Errors arrive without focus moving, so they have to be announced.
    expect(error?.props.accessibilityRole).toBe('alert');
    expect(error?.props.accessibilityLiveRegion).toBe('assertive');
  });

  it('announces the passphrase reveal as a switch', async () => {
    const tree = await renderCard();
    await press(tree, 'settings.syncEncryptionEnable');
    const toggle = tree.root
      .findAllByType(TouchableOpacity)
      .find((node) => node.findAllByType(Text)
        .some((child) => child.props.children === 'settings.syncEncryptionShowPassphrase'));
    // accessibilityState.checked is only announced for switch/checkbox roles.
    expect(toggle?.props.accessibilityRole).toBe('switch');
    expect(toggle?.props.accessibilityState).toEqual({ checked: false });
  });
});

describe('SyncEncryptionCard transport refresh (#1001)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    encryptionMocks.getSyncEncryptionStatus.mockResolvedValue({ state: 'off' });
    encryptionMocks.isSyncEncryptionBackendPending.mockResolvedValue(false);
  });

  it('re-reads encryption state when a transport action finishes', async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SyncEncryptionCard appData={appData} t={t} tc={tc} transportBusy />);
    });
    expect(texts(tree)).not.toContain('settings.syncEncryptionLockedTitle');

    // The activation probe discovered an encrypted folder and persisted the
    // no-key state; when the action ends, the card must flip to the unlock UI
    // without the user first failing an enable.
    encryptionMocks.getSyncEncryptionStatus.mockResolvedValue({ state: 'remote-encrypted-no-key' });
    await act(async () => {
      tree.update(<SyncEncryptionCard appData={appData} t={t} tc={tc} transportBusy={false} />);
    });
    expect(texts(tree)).toContain('settings.syncEncryptionLockedTitle');
  });
});
