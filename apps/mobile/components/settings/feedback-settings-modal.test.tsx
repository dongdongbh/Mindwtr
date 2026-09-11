import React from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, TouchableOpacity } from 'react-native';
import { act, create } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FeedbackSettingsModal } from './feedback-settings-modal';
import { styles } from './settings.styles';

vi.mock('lucide-react-native', () => ({
  Bug: () => null,
  Lightbulb: () => null,
  MessageSquare: () => null,
  X: () => null,
}));

vi.mock('@/hooks/use-theme-tokens', () => ({
  useThemeTokens: () => ({ isMaterial: false, roles: null, shape: { large: 16 } }),
}));

vi.mock('@/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    bg: '#0f172a',
    cardBg: '#111827',
    border: '#334155',
    danger: '#ef4444',
    onTint: '#ffffff',
    secondaryText: '#94a3b8',
    success: '#22c55e',
    text: '#f8fafc',
    tint: '#3b82f6',
  }),
}));

const originalPlatformOs = Platform.OS;

const setPlatform = (os: typeof Platform.OS) => {
  Object.defineProperty(Platform, 'OS', {
    configurable: true,
    value: os,
  });
};

const tr = (key: string) => ({
  'common.cancel': 'Cancel',
  'common.close': 'Close',
  'settings.feedback': 'Send feedback',
  'settings.feedbackCategory': 'Category',
  'settings.feedbackCategoryBug': 'Bug report',
  'settings.feedbackCategoryFeature': 'Feature request',
  'settings.feedbackCategoryOther': 'Other',
  'settings.feedbackDesc': 'Report a bug or suggest a feature. No account needed.',
  'settings.feedbackEmail': 'Reply email (optional)',
  'settings.feedbackEmailPlaceholder': 'you@example.com',
  'settings.feedbackFailed': 'Feedback failed',
  'settings.feedbackIncludeDiagnostics': 'Include recent diagnostics',
  'settings.feedbackIncludeDiagnosticsDesc': 'Adds recent sanitized app logs.',
  'settings.feedbackInvalidEmail': 'Enter a valid email.',
  'settings.feedbackMessage': 'Message',
  'settings.feedbackMessagePlaceholder': 'Tell us what happened or what would help.',
  'settings.feedbackMessagePlaceholderBug': 'What did you expect, and what happened instead?',
  'settings.feedbackMessagePlaceholderFeature': 'What are you trying to do, and what would help?',
  'settings.feedbackMessagePlaceholderOther': 'Tell us what is on your mind.',
  'settings.feedbackWhere': 'Where did this happen?',
  'settings.feedbackWhereMessagePrefix': 'Where',
  'settings.feedbackWhereInbox': 'Inbox',
  'settings.feedbackWhereFocus': 'Focus',
  'settings.feedbackWhereProjects': 'Projects',
  'settings.feedbackWhereReview': 'Review',
  'settings.feedbackWhereSettings': 'Settings',
  'settings.feedbackWhereSync': 'Sync',
  'settings.feedbackWhereImportExport': 'Import or export',
  'settings.feedbackWhereNotifications': 'Notifications',
  'settings.feedbackWhereOther': 'Other',
  'settings.feedbackPrivacy': 'Task content is not attached.',
  'settings.feedbackRequired': 'Enter a message.',
  'settings.feedbackSending': 'Sending...',
  'settings.feedbackSent': 'Thanks for the feedback.',
  'settings.feedbackSubmit': 'Send feedback',
  'settings.feedbackUnavailable': 'Feedback is not configured in this build.',
  'settings.feedbackUnavailableDesc': 'Use GitHub issue templates instead.',
  'settings.feedbackOpenGitHubIssue': 'Open GitHub issue',
  'settings.feedbackOpenGitHubDiscussion': 'Open GitHub discussion',
  'settings.feedbackGitHubDesc': 'GitHub is recommended for feedback. Posts are public.',
}[key] ?? key);

const findTouchableByText = (tree: ReturnType<typeof create>, label: string) => {
  const match = tree.root.findAllByType(TouchableOpacity).find((node) =>
    node.findAllByType(Text).some((textNode) => textNode.props.children === label)
  );
  if (!match) throw new Error(`Touchable not found: ${label}`);
  return match;
};

describe('FeedbackSettingsModal', () => {
  afterEach(() => {
    Object.defineProperty(Platform, 'OS', {
      configurable: true,
      value: originalPlatformOs,
    });
  });

  it('keeps Android modal scrolling under app control', () => {
    setPlatform('android');
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(
        <FeedbackSettingsModal
          visible
          isConfigured
          tr={tr}
          onClose={vi.fn()}
          onSubmit={vi.fn()}
        />,
      );
    });

    expect(tree.root.findByType(KeyboardAvoidingView).props.behavior).toBe('height');
    expect(tree.root.findByType(ScrollView).props.keyboardDismissMode).toBe('on-drag');
    expect(tree.root.findByType(ScrollView).props.scrollsChildToFocus).toBe(false);
    expect(tree.root.findByType(ScrollView).props.nestedScrollEnabled).toBe(true);

    const backdropPressables = tree.root.findAllByType(Pressable);
    expect(backdropPressables).toHaveLength(1);
    expect(backdropPressables[0].props.style).toBe(styles.feedbackModalBackdropPressable);
  });

  it('uses category-specific placeholders and hides bug location outside bug reports', () => {
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(
        <FeedbackSettingsModal
          visible
          isConfigured
          tr={tr}
          onClose={vi.fn()}
          onSubmit={vi.fn()}
        />,
      );
    });

    expect(tree.root.findAllByType(TextInput)[0].props.placeholder).toBe(
      'What did you expect, and what happened instead?',
    );
    expect(tree.root.findAllByType(Text).some((node) => node.props.children === 'Sync')).toBe(true);

    act(() => {
      findTouchableByText(tree, 'Feature request').props.onPress();
    });

    expect(tree.root.findAllByType(TextInput)[0].props.placeholder).toBe(
      'What are you trying to do, and what would help?',
    );
    expect(tree.root.findAllByType(Text).some((node) => node.props.children === 'Sync')).toBe(false);
  });

  it('includes selected bug location when submitting', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(
        <FeedbackSettingsModal
          visible
          isConfigured
          tr={tr}
          onClose={vi.fn()}
          onSubmit={onSubmit}
        />,
      );
    });

    act(() => {
      findTouchableByText(tree, 'Sync').props.onPress();
      tree.root.findAllByType(TextInput)[0].props.onChangeText('CloudKit sync failed');
    });
    await act(async () => {
      findTouchableByText(tree, 'Send feedback').props.onPress();
      await Promise.resolve();
    });

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      category: 'bug',
      message: 'Where: Sync\n\nCloudKit sync failed',
    }));
  });

  it.each([
    ['bug', 'Bug report', 'Open GitHub issue'],
    ['feature', 'Feature request', 'Open GitHub issue'],
    ['other', 'Other', 'Open GitHub discussion'],
  ])('opens GitHub for %s without submitting or clearing the draft', (category, categoryLabel, linkLabel) => {
    const onOpenGitHub = vi.fn();
    const onClose = vi.fn();
    const onSubmit = vi.fn();
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<FeedbackSettingsModal visible isConfigured tr={tr} onClose={onClose} onOpenGitHub={onOpenGitHub} onSubmit={onSubmit} />);
    });
    act(() => {
      tree.root.findAllByType(TextInput)[0].props.onChangeText('Keep this draft');
    });
    act(() => {
      findTouchableByText(tree, categoryLabel).props.onPress();
    });
    act(() => {
      const link = findTouchableByText(tree, linkLabel);
      expect(link.props.accessibilityRole).toBe('link');
      link.props.onPress();
    });

    expect(onOpenGitHub).toHaveBeenCalledExactlyOnceWith(category);
    expect(onClose).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(tree.root.findAllByType(TextInput)[0].props.value).toBe('Keep this draft');
  });

  it('routes unconfigured builds to GitHub issues', () => {
    const onOpenGitHub = vi.fn();
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(
        <FeedbackSettingsModal
          visible
          isConfigured={false}
          tr={tr}
          onClose={vi.fn()}
          onOpenGitHub={onOpenGitHub}
          onSubmit={vi.fn()}
        />,
      );
    });

    act(() => {
      expect(findTouchableByText(tree, 'Send feedback').props.disabled).toBe(true);
      findTouchableByText(tree, 'Open GitHub issue').props.onPress();
    });

    expect(onOpenGitHub).toHaveBeenCalled();
  });
});
