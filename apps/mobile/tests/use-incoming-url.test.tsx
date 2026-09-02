import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useIncomingUrl, type IncomingUrl } from '@/hooks/use-incoming-url';

const linking = vi.hoisted(() => ({
  listeners: [] as Array<(event: { url: string }) => void>,
  initialUrl: null as string | null,
}));

vi.mock('expo-linking', () => ({
  getInitialURL: vi.fn(async () => linking.initialUrl),
  addEventListener: vi.fn((_type: string, listener: (event: { url: string }) => void) => {
    linking.listeners.push(listener);
    return { remove: () => { linking.listeners = linking.listeners.filter((entry) => entry !== listener); } };
  }),
}));

function Host({ onValue }: { onValue: (value: IncomingUrl) => void }) {
  onValue(useIncomingUrl());
  return null;
}

const deliver = (url: string) => {
  act(() => {
    linking.listeners.forEach((listener) => listener({ url }));
  });
};

describe('useIncomingUrl', () => {
  let latest: IncomingUrl;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-02T12:00:00.000Z'));
    linking.listeners = [];
    linking.initialUrl = null;
    latest = { url: null, key: 0 };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('bumps the key for every delivery, including the same link twice', async () => {
    await act(async () => {
      create(<Host onValue={(value) => { latest = value; }} />);
      await Promise.resolve();
    });
    expect(latest).toEqual({ url: null, key: 0 });

    deliver('mindwtr:///capture?title=Milk');
    expect(latest).toEqual({ url: 'mindwtr:///capture?title=Milk', key: 1 });

    act(() => { vi.advanceTimersByTime(5_000); });
    deliver('mindwtr:///capture?title=Milk');
    expect(latest).toEqual({ url: 'mindwtr:///capture?title=Milk', key: 2 });
  });

  it('treats an immediate echo of the launch URL as one delivery', async () => {
    linking.initialUrl = 'mindwtr:///capture?title=Milk';
    await act(async () => {
      create(<Host onValue={(value) => { latest = value; }} />);
      await Promise.resolve();
    });
    expect(latest).toEqual({ url: 'mindwtr:///capture?title=Milk', key: 1 });

    deliver('mindwtr:///capture?title=Milk');
    expect(latest.key).toBe(1);

    act(() => { vi.advanceTimersByTime(1_500); });
    deliver('mindwtr:///capture?title=Milk');
    expect(latest.key).toBe(2);
  });
});
