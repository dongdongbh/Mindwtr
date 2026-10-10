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
  'settings.feedbackDesc': 'Report a bug or suggest a feature.',
  'settings.feedbackEmail': 'Reply email (optional, recommended)',
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
  'settings.feedbackOpenGitHubIssue': 'GitHub Issues',
  'settings.feedbackOpenGitHubDiscussion': 'GitHub Discussions',
  'settings.feedbackGitHubDesc': 'If you have a GitHub account, we recommend {channel} for easy follow-up.',
}[key] ?? key);

const findTouchableByText = (tree: ReturnType<typeof create>, label: string) => {
  const match = tree.root.findAllByType(TouchableOpacity).find((node) =>
    node.findAllByType(Text).some((textNode) => textNode.props.children === label)
  );
  if (!match) throw new Error(`Touchable not found: ${label}`);
  return match;
};

const renderedText = (children: React.ReactNode): string => React.Children.toArray(children).map((child) => (
  React.isValidElement<{ children?: React.ReactNode }>(child)
    ? renderedText(child.props.children)
    : String(child)
)).join('');

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
      email: undefined,
      includeDiagnostics: false,
    }));
  });

  it.each([
    ['bug', 'Bug report', 'GitHub Issues'],
    ['feature', 'Feature request', 'GitHub Issues'],
    ['other', 'Other', 'GitHub Discussions'],
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
      const link = tree.root.findByProps({ accessibilityRole: 'link', children: linkLabel });
      expect(link.props.accessibilityRole).toBe('link');
      link.props.onPress();
    });

    expect(onOpenGitHub).toHaveBeenCalledExactlyOnceWith(category);
    expect(onClose).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(tree.root.findAllByType(TextInput)[0].props.value).toBe('Keep this draft');
    const text = tree.root.findAllByType(Text).map((node) => node.props.children);
    const subtitle = tree.root.findAllByType(Text).find((node) => (
      Array.isArray(node.props.style) && node.props.style.includes(styles.feedbackModalSubtitle)
    ));
    expect(subtitle).toBeDefined();
    expect(renderedText(subtitle!.props.children)).toBe(
      `If you have a GitHub account, we recommend ${linkLabel} for easy follow-up.`,
    );
    expect(subtitle!.findByProps({ accessibilityRole: 'link' }).props.children).toBe(linkLabel);
    expect(tree.root.findByType(ScrollView).findAllByProps({ accessibilityRole: 'link' })).toHaveLength(0);
    expect(text).toContain('Reply email (optional, recommended)');
    expect(text).not.toContain(tr('settings.feedbackPrivacy'));
  });

  it('shortens the message field by the place that will lead it, so a full message still sends', () => {
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<FeedbackSettingsModal visible isConfigured tr={tr} onClose={vi.fn()} onSubmit={vi.fn()} />);
    });
    const messageInput = () => tree.root.findAllByType(TextInput).find((node) => node.props.multiline)!;
    expect(messageInput().props.maxLength).toBe(4000);
    act(() => {
      findTouchableByText(tree, 'Sync').props.onPress();
    });
    expect(messageInput().props.maxLength).toBe(4000 - 'Where: Sync\n\n'.length);
  });

  it('a send that ends after the modal closed and opened again leaves the new draft alone', async () => {
    let finish!: () => void;
    const onSubmit = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const render = (visible: boolean) => (
      <FeedbackSettingsModal visible={visible} isConfigured tr={tr} onClose={vi.fn()} onSubmit={onSubmit} />
    );
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(render(true));
    });
    act(() => {
      tree.root.findAllByType(TextInput)[0].props.onChangeText('First report');
    });
    await act(async () => {
      findTouchableByText(tree, 'Send feedback').props.onPress();
      await Promise.resolve();
    });
    act(() => tree.update(render(false)));
    act(() => tree.update(render(true)));
    act(() => {
      tree.root.findAllByType(TextInput)[0].props.onChangeText('Second report');
    });
    await act(async () => {
      finish();
      await Promise.resolve();
    });
    expect(tree.root.findAllByType(TextInput)[0].props.value).toBe('Second report');
    expect(tree.root.findAllByType(Text).map((node) => node.props.children)).not.toContain('Thanks for the feedback.');
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
      tree.root.findByProps({ accessibilityRole: 'link', children: 'GitHub Issues' }).props.onPress();
    });

    expect(onOpenGitHub).toHaveBeenCalled();
  });
});
