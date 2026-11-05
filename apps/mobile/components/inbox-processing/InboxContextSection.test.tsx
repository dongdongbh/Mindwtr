import React from 'react';
import { Text } from 'react-native';
import { act, create } from 'react-test-renderer';
import { loadTranslations } from '@mindwtr/core';
import { describe, expect, it, vi } from 'vitest';
import { FALLBACK_THEME_COLORS } from '@/hooks/use-theme-colors';
import { InboxContextSection } from './InboxContextSection';

const renderTitle = (translations: Record<string, string>, showContextsField: boolean, showTagsField: boolean) => {
  let tree!: ReturnType<typeof create>;
  act(() => {
    tree = create(<InboxContextSection
      t={(key) => translations[key] ?? key}
      tc={FALLBACK_THEME_COLORS}
      show showContextsField={showContextsField} showTagsField={showTagsField}
      selectedContexts={[]} selectedTags={[]} toggleContext={vi.fn()} toggleTag={vi.fn()}
      newContext="" setNewContext={vi.fn()} addCustomContextMobile={vi.fn()}
      tokenSuggestions={[]} applyTokenSuggestion={vi.fn()}
      contextCopilotSuggestions={[]} tagCopilotSuggestions={[]}
    />);
  });
  const children = tree.root.findAllByType(Text)[0].props.children;
  return (Array.isArray(children) ? children : [children]).join('');
};

describe('InboxContextSection', () => {
  it.each(['zh', 'zh-Hant'] as const)('titles the step with one %s word for contexts', async (language) => {
    const translations = await loadTranslations(language);

    expect(renderTitle(translations, true, true).startsWith(translations['filters.contexts'])).toBe(true);
    expect(renderTitle(translations, true, false)).toBe(translations['contexts.title']);
    expect(renderTitle(translations, false, true)).toBe(translations['taskEdit.tagsLabel']);
  });
});
