import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Switch, Text } from 'react-native';
import { describe, expect, it, vi } from 'vitest';
import { buildDataSettingsModel, getTranslator } from '@mindwtr/core';

import type { ThemeColors } from '@/hooks/use-theme-colors';

import { SyncDiagnosticsCard } from './sync-settings-sections';

// The Encryption block comes with sync; this card is compared without it, as the native Data screen draws it.
vi.mock('@/lib/sync-encryption-state', () => ({
  getSyncEncryptionDiagnosticsLines: () => Promise.reject(new Error('no sync')),
  logSyncEncryptionDiagnosticsBlock: () => Promise.resolve(),
}));

const tc = { bg: '#0f172a', cardBg: '#111827', border: '#334155', text: '#f8fafc', secondaryText: '#94a3b8', tint: '#3b82f6' } as unknown as ThemeColors;
const noop = () => undefined;

/** RN's card as drawn: its texts in order and the switch's value. */
async function renderCard(language: 'en' | 'zh', loggingEnabled: boolean, analytics: 'none' | 'on' | 'optedOut' = 'none') {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(
      <SyncDiagnosticsCard
        analyticsHeartbeatAvailable={analytics !== 'none'}
        analyticsHeartbeatOptedOut={analytics === 'optedOut'}
        handleClearLog={noop}
        handleShareLog={noop}
        loggingEnabled={loggingEnabled}
        toggleAnalyticsHeartbeatOptOut={noop}
        t={getTranslator(language)}
        tc={tc}
        toggleDebugLogging={noop}
      />,
    );
  });
  const texts = tree.root.findAllByType(Text).map((node) => node.props.children).filter((child): child is string => typeof child === 'string');
  return { texts, switches: tree.root.findAllByType(Switch).map((node) => node.props.value as boolean) };
}

describe('Settings › Data › Diagnostics parity with core\'s model', () => {
  it.each([['en', false, 'none'], ['en', true, 'none'], ['zh', true, 'none'], ['en', false, 'on'], ['zh', true, 'optedOut']] as const)('%s with logging %s, analytics %s', async (language, loggingEnabled, analytics) => {
    const rn = await renderCard(language, loggingEnabled, analytics);
    const settings = { diagnostics: { loggingEnabled }, ...(analytics === 'optedOut' ? { analytics: { heartbeatEnabled: false } } : {}) };
    const { diagnostics } = buildDataSettingsModel(settings, getTranslator(language), analytics !== 'none');
    expect(rn.texts).toEqual([
      diagnostics.title,
      ...(diagnostics.analytics ? [diagnostics.analytics.label, diagnostics.analytics.description] : []),
      diagnostics.debugLogging.label,
      diagnostics.debugLogging.description,
      ...(diagnostics.shareLog ? [diagnostics.shareLog.label, diagnostics.shareLog.description] : []),
      ...(diagnostics.clearLog ? [diagnostics.clearLog.label] : []),
    ]);
    expect(rn.switches).toEqual([...(diagnostics.analytics ? [diagnostics.analytics.value] : []), diagnostics.debugLogging.value]);
  });
});
