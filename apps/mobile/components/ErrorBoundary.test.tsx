import React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import renderer from 'react-test-renderer';

import { ErrorBoundary } from './ErrorBoundary';

vi.mock('@/lib/app-log', () => ({
  logError: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/contexts/language-context', async () => {
  const React = await import('react');
  return {
    LanguageContext: React.createContext(undefined),
  };
});

vi.mock('@/contexts/theme-context', async () => {
  const React = await import('react');
  return {
    ThemeContext: React.createContext(undefined),
  };
});

vi.mock('@/hooks/use-theme-colors', () => ({
  resolveThemeColors: () => ({
    bg: '#000000',
    cardBg: '#111111',
    taskItemBg: '#111111',
    text: '#ffffff',
    secondaryText: '#999999',
    icon: '#999999',
    border: '#333333',
    tint: '#3b82f6',
    onTint: '#ffffff',
    tabIconDefault: '#999999',
    tabIconSelected: '#3b82f6',
    inputBg: '#111111',
    danger: '#ef4444',
    success: '#10b981',
    warning: '#f59e0b',
    filterBg: '#222222',
  }),
}));

function Boom(): React.ReactElement {
  throw new Error('boom');
}

describe('ErrorBoundary', () => {
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

  beforeEach(() => {
    consoleError.mockClear();
  });

  afterEach(() => {
    consoleError.mockClear();
  });

  it('renders a fallback even without theme or language providers', () => {
    let tree!: renderer.ReactTestRenderer;

    expect(() => {
      renderer.act(() => {
        tree = renderer.create(
          <ErrorBoundary>
            <Boom />
          </ErrorBoundary>
        );
      });
    }).not.toThrow();

    const output = tree.toJSON();
    expect(JSON.stringify(output)).toContain('Something went wrong');
    expect(JSON.stringify(output)).toContain('boom');
  });
});
