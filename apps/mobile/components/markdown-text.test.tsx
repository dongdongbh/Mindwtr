import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Linking from 'expo-linking';

import { openProjectScreen, openTaskScreen } from '@/lib/task-meta-navigation';

import { MarkdownInlineText, MarkdownText } from './markdown-text';

const clipboardMocks = vi.hoisted(() => ({
  setStringAsync: vi.fn(async () => {}),
}));

const taskStoreMocks = vi.hoisted(() => ({
  state: {
    _allTasks: [] as any[],
    _allProjects: [] as any[],
    projects: [] as any[],
  },
}));

vi.mock('@mindwtr/core', async () => {
  const actual = await vi.importActual<typeof import('@mindwtr/core')>('@mindwtr/core');
  const useTaskStore = ((selector?: (state: typeof taskStoreMocks.state) => unknown) => (
    typeof selector === 'function' ? selector(taskStoreMocks.state) : taskStoreMocks.state
  )) as typeof actual.useTaskStore;

  return {
    ...actual,
    useTaskStore,
  };
});

vi.mock('@/contexts/language-context', () => ({
  useLanguage: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@/lib/task-meta-navigation', () => ({
  openProjectScreen: vi.fn(),
  openTaskScreen: vi.fn(),
}));

vi.mock('expo-linking', () => ({
  openURL: vi.fn(async () => undefined),
}));

vi.mock('@/lib/app-log', () => ({ logInfo: vi.fn(async () => null), logWarn: vi.fn(async () => null) }));

vi.mock('expo-clipboard', () => ({
  setStringAsync: clipboardMocks.setStringAsync,
}));

const flattenText = (
  value: renderer.ReactTestRendererNode | renderer.ReactTestRendererNode[] | null,
): string => {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((item) => flattenText(item)).join('');
  return flattenText(value.children);
};

const countByTestId = (
  value: renderer.ReactTestRendererNode | renderer.ReactTestRendererNode[] | null,
  testID: string,
): number => {
  if (value == null || typeof value === 'string') return 0;
  if (Array.isArray(value)) return value.reduce((total, item) => total + countByTestId(item, testID), 0);
  return (value.props?.testID === testID ? 1 : 0) + countByTestId(value.children, testID);
};

beforeEach(() => {
  taskStoreMocks.state._allTasks = [];
  taskStoreMocks.state._allProjects = [];
  taskStoreMocks.state.projects = [];
  vi.clearAllMocks();
});

const flattenStyle = (style: unknown): Record<string, unknown> => {
  if (Array.isArray(style)) {
    return Object.assign({}, ...style.map((item) => flattenStyle(item)));
  }
  return style && typeof style === 'object' ? style as Record<string, unknown> : {};
};

describe('MarkdownText', () => {
  const renderMarkdown = (markdown: string) => {
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <MarkdownText
          markdown={markdown}
          tc={{
            text: '#fff',
            secondaryText: '#aaa',
            tint: '#3b82f6',
            border: '#334155',
            cardBg: '#1f2937',
            filterBg: '#111827',
          } as any}
          direction="ltr"
        />
      );
    });
    return tree;
  };

  it('renders fenced code blocks without stalling on the opening fence', () => {
    const markdown = [
      '## Setup commands',
      '```bash',
      'npx create-next-app@latest client-site --typescript',
      'cd client-site',
      'npm install tailwindcss @shadcn/ui',
      '```',
      '',
      '## Folder structure',
      '```',
      'src/',
      '  app/',
      '    page.tsx',
      '    layout.tsx',
      '  components/',
      '    ui/',
      '    sections/',
      '```',
    ].join('\n');

    const tree = renderMarkdown(markdown);

    const rendered = flattenText(tree.toJSON());
    expect(rendered).toContain('Setup commands');
    expect(rendered).toContain('npx create-next-app@latest client-site --typescript');
    expect(rendered).toContain('Folder structure');
    expect(rendered).toContain('page.tsx');
  });

  it('keeps soft line breaks inside paragraphs', () => {
    const tree = renderMarkdown('line 1\nline 2');

    expect(flattenText(tree.toJSON())).toContain('line 1\nline 2');
  });

  it('preserves intentional blank lines between blocks', () => {
    const tree = renderMarkdown('line 1\n\nline 2');

    expect(countByTestId(tree.toJSON(), 'markdown-blank-line')).toBe(1);
  });

  it('renders nested unordered list items with indentation', () => {
    const tree = renderMarkdown('- Parent\n  - Child\n    - Grandchild');

    const rows = tree.root.findAll((node) => (
      String(node.type) === 'View' && node.props.testID === 'markdown-list-item'
    ));
    expect(rows).toHaveLength(3);
    expect(flattenStyle(rows[0].props.style).marginLeft ?? 0).toBe(0);
    expect(flattenStyle(rows[1].props.style).marginLeft).toBe(14);
    expect(flattenStyle(rows[2].props.style).marginLeft).toBe(28);
    expect(flattenText(tree.toJSON())).toContain('Parent');
    expect(flattenText(tree.toJSON())).toContain('Child');
    expect(flattenText(tree.toJSON())).toContain('Grandchild');
  });

  it('renders ordered list markers in preview', () => {
    const tree = renderMarkdown('1. First\n2. Second');

    expect(flattenText(tree.toJSON())).toContain('1.');
    expect(flattenText(tree.toJSON())).toContain('First');
    expect(flattenText(tree.toJSON())).toContain('2.');
    expect(flattenText(tree.toJSON())).toContain('Second');
  });

  it('renders single-backtick inline code spans', () => {
    const tree = renderMarkdown('Run `bun test` before release.');
    const inlineCode = tree.root.findAll((node) => (
      node.props.testID === 'markdown-inline-code'
      && flattenStyle(node.props.style).backgroundColor === '#1f2937'
    ))[0];

    expect(flattenText(tree.toJSON()).replace(/\u2006/g, '')).toContain('Run bun test before release.');
    expect(inlineCode).toBeTruthy();
    expect(flattenText(inlineCode.children as renderer.ReactTestRendererNode[])).toBe('\u2006bun test\u2006');
    expect(flattenStyle(inlineCode.props.style).backgroundColor).toBe('#1f2937');
  });

  it('adds an accessible copy button to fenced code blocks', () => {
    const tree = renderMarkdown('```ts\nconst value = 1;\n```');

    expect(tree.root.findByProps({ accessibilityLabel: 'Copy code' })).toBeTruthy();
  });

  it('copies fenced code block text with the supported clipboard API', () => {
    const tree = renderMarkdown('```ts\nconst value = 1;\n```');
    const copyButton = tree.root.findByProps({ accessibilityLabel: 'Copy code' });

    renderer.act(() => {
      copyButton.props.onPress();
    });

    expect(clipboardMocks.setStringAsync).toHaveBeenCalledWith('const value = 1;');
  });

  it('renders inline markdown without raw markers for compact checklist rows', () => {
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <MarkdownInlineText
          markdown={'✓ **Draft** [spec](https://example.com)'}
          tc={{
            text: '#fff',
            secondaryText: '#aaa',
            tint: '#3b82f6',
            border: '#334155',
            cardBg: '#1f2937',
            filterBg: '#111827',
          } as any}
        />
      );
    });

    const rendered = flattenText(tree.toJSON());
    expect(rendered).toContain('✓ Draft spec');
    expect(rendered).not.toContain('**');
    expect(rendered).not.toContain('](');
  });

  it('resolves internal links from indexed store maps without per-link scans', () => {
    const now = '2026-06-11T00:00:00.000Z';
    const taskFind = vi.fn(() => {
      throw new Error('Task links should use the indexed lookup map');
    });
    const projectFind = vi.fn(() => {
      throw new Error('Project links should use the indexed lookup map');
    });
    taskStoreMocks.state._allTasks = Object.assign([
      {
        id: 'task-1',
        title: 'Indexed task',
        status: 'next',
        tags: [],
        contexts: [],
        projectId: 'project-1',
        createdAt: now,
        updatedAt: now,
      },
    ], { find: taskFind });
    taskStoreMocks.state._allProjects = Object.assign([
      {
        id: 'project-1',
        title: 'Indexed project',
        status: 'active',
        color: '#2563eb',
        order: 0,
        createdAt: now,
        updatedAt: now,
      },
    ], { find: projectFind });

    const tree = renderMarkdown('[Task link](mindwtr://task/task-1) [Project link](mindwtr://project/project-1)');

    expect(taskFind).not.toHaveBeenCalled();
    expect(projectFind).not.toHaveBeenCalled();
    expect(flattenText(tree.toJSON())).toContain('Task link Project link');

    const taskLink = tree.root.findAll((node) => (
      typeof node.props.onPress === 'function'
      && flattenText(node.children as renderer.ReactTestRendererNode[]) === 'Task link'
    ))[0];
    const projectLink = tree.root.findAll((node) => (
      typeof node.props.onPress === 'function'
      && flattenText(node.children as renderer.ReactTestRendererNode[]) === 'Project link'
    ))[0];

    renderer.act(() => {
      taskLink.props.onPress();
      projectLink.props.onPress();
    });

    expect(openTaskScreen).toHaveBeenCalledWith('task-1', 'project-1');
    expect(openProjectScreen).toHaveBeenCalledWith('project-1');
  });

  it('opens raw URL links from task descriptions', () => {
    const tree = renderMarkdown('Read https://example.com/docs.');
    const link = tree.root.findAll((node) => (
      typeof node.props.onPress === 'function'
      && flattenText(node.children as renderer.ReactTestRendererNode[]) === 'https://example.com/docs'
    ))[0];

    expect(link).toBeTruthy();

    renderer.act(() => {
      link.props.onPress();
    });

    expect(Linking.openURL).toHaveBeenCalledWith('https://example.com/docs');
  });

  it.each(['upnote://x-callback-url/openNote?noteId=Note%2FCase%2520&new_window=true', 'obsidian://open?vault=Obsidian%20Vault&file=Folder%2FNote%2520&heading=Section%20One'])('opens explicit app links only after a tap, preserving the URI: %s', async (uri) => {
    const tree = renderMarkdown(`[My note](${uri})`);
    expect(Linking.openURL).not.toHaveBeenCalled();
    const link = tree.root.findAll((node) => typeof node.props.onPress === 'function'
      && flattenText(node.children as renderer.ReactTestRendererNode[]) === 'My note')[0];
    expect(link).toBeTruthy();
    await renderer.act(async () => { link.props.onPress(); });
    expect(Linking.openURL).toHaveBeenCalledWith(uri);
  });

  it('keeps blocked schemes and unrelated custom protocols noninteractive', () => {
    const tree = renderMarkdown('[Script](javascript:evil) [Data](data:text/plain,test) [Other](custom://open)');
    expect(tree.root.findAll((node) => typeof node.props.onPress === 'function')).toHaveLength(0);
    expect(Linking.openURL).not.toHaveBeenCalled();
  });
});
