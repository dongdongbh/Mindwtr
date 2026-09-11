import React from 'react';
import { Alert, Pressable, View, Text, StyleSheet, type StyleProp, type TextStyle } from 'react-native';
import * as Linking from 'expo-linking';
import * as Clipboard from 'expo-clipboard';
import { Ionicons } from '@expo/vector-icons';

import type { ThemeColors } from '@/hooks/use-theme-colors';
import { isSandboxMode, parseInlineMarkdown, parseMarkdownReferenceHref, shallow, tFallback, useTaskStore, type Project, type Task } from '@mindwtr/core';
import { useLanguage } from '@/contexts/language-context';
import { openProjectScreen, openTaskScreen } from '@/lib/task-meta-navigation';

const TASK_LIST_RE = /^(\s*)(?:[-*+]\s+)?\[( |x|X)\]\s+(.+)$/;
const BULLET_LIST_RE = /^(\s*)[-*+]\s+(.+)$/;
const ORDERED_LIST_RE = /^(\s*)(\d+)([.)])\s+(.+)$/;
const HEADING_RE = /^(#{1,3})\s+(.+)$/;
const HORIZONTAL_RULE_RE = /^(?:-{3,}|\*{3,}|_{3,})$/;
const FENCED_CODE_RE = /^```.*$/;
const INLINE_CODE_EDGE_SPACE = '\u2006';

const writeClipboardText = (text: string) => {
  void Clipboard.setStringAsync(text).catch(() => undefined);
};

function isBlockBoundary(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('```')) return true;
  if (HEADING_RE.test(trimmed)) return true;
  if (HORIZONTAL_RULE_RE.test(trimmed)) return true;
  if (TASK_LIST_RE.test(line)) return true;
  if (BULLET_LIST_RE.test(line)) return true;
  if (ORDERED_LIST_RE.test(line)) return true;
  return false;
}

const getListIndentDepth = (indent: string): number => {
  const width = indent.replace(/\t/g, '    ').length;
  return Math.max(0, Math.floor(width / 2));
};

const getBulletMarker = (depth: number): string => ['•', '◦', '▪'][Math.min(depth, 2)] ?? '•';

function isSafeLink(href: string): boolean {
  return /^https?:\/\//i.test(href) || /^mailto:/i.test(href) || /^tel:/i.test(href);
}

type MarkdownRenderOptions = {
  resolveTask: (id: string) => { title: string; projectId?: string } | null;
  resolveProject: (id: string) => { title: string } | null;
  deletedTaskLabel: string;
  deletedProjectLabel: string;
  copyCodeLabel: string;
  openExternalLink: (href: string) => void;
};

type MarkdownLinkLookup = {
  tasksById: Map<string, Task>;
  projectsById: Map<string, Project>;
};

function createMarkdownLinkLookup(tasks: readonly Task[], projects: readonly Project[]): MarkdownLinkLookup {
  const tasksById = new Map<string, Task>();
  const projectsById = new Map<string, Project>();

  tasks.forEach((task) => {
    if (!task.deletedAt) tasksById.set(task.id, task);
  });
  projects.forEach((project) => {
    if (!project.deletedAt) projectsById.set(project.id, project);
  });

  return { tasksById, projectsById };
}

function useMarkdownRenderOptions(): MarkdownRenderOptions {
  const { t } = useLanguage();
  const { tasks, projects } = useTaskStore((state) => ({
    tasks: state._allTasks,
    projects: state._allProjects,
  }), shallow);
  const { tasksById, projectsById } = React.useMemo(
    () => createMarkdownLinkLookup(tasks, projects),
    [tasks, projects],
  );
  const deletedTaskLabel = tFallback(t, 'markdown.referenceDeletedTask', 'deleted task');
  const deletedProjectLabel = tFallback(t, 'markdown.referenceDeletedProject', 'deleted project');
  const copyCodeLabel = tFallback(t, 'markdown.copyCode', 'Copy code');
  const openExternalLink = React.useCallback((href: string) => {
    if (isSandboxMode()) {
      Alert.alert(t('common.notice'), t('sandbox.unavailable'));
      return;
    }
    void Linking.openURL(href);
  }, [t]);
  const resolveTask = React.useCallback((id: string) => {
    const task = tasksById.get(id);
    if (!task) return null;
    return {
      title: task.title,
      projectId: task.projectId,
    };
  }, [tasksById]);
  const resolveProject = React.useCallback((id: string) => {
    const project = projectsById.get(id);
    if (!project) return null;
    return {
      title: project.title,
    };
  }, [projectsById]);

  return {
    resolveTask,
    resolveProject,
    deletedTaskLabel,
    deletedProjectLabel,
    copyCodeLabel,
    openExternalLink,
  };
}

function renderInline(
  text: string,
  tc: ThemeColors,
  keyPrefix: string,
  options: MarkdownRenderOptions,
): React.ReactNode[] {
  const nodes: (string | React.ReactElement | null)[] = parseInlineMarkdown(text).map((token, index) => {
    if (token.type === 'text') return token.text;
    if (token.type === 'code') {
      const paddedText = token.text ? `${INLINE_CODE_EDGE_SPACE}${token.text}${INLINE_CODE_EDGE_SPACE}` : token.text;
      return (
        <Text
          key={`${keyPrefix}-code-${index}`}
          testID="markdown-inline-code"
          style={[styles.code, { backgroundColor: tc.cardBg, color: tc.text }]}
        >
          {paddedText}
        </Text>
      );
    }
    if (token.type === 'bold') {
      return (
        <Text key={`${keyPrefix}-bold-${index}`} style={styles.bold}>
          {token.text}
        </Text>
      );
    }
    if (token.type === 'italic') {
      return (
        <Text key={`${keyPrefix}-italic-${index}`} style={styles.italic}>
          {token.text}
        </Text>
      );
    }
    if (token.type === 'strike') {
      return (
        <Text key={`${keyPrefix}-strike-${index}`} style={styles.struckText}>
          {token.text}
        </Text>
      );
    }
    if (token.type === 'link') {
      const reference = parseMarkdownReferenceHref(token.href);
      if (reference?.entityType === 'project') {
        const project = options.resolveProject(reference.id);
        if (!project) {
          return (
            <Text key={`${keyPrefix}-deleted-project-${index}`} style={[styles.deletedLink, { color: tc.secondaryText }]}>
              <Text style={styles.struckText}>{token.text}</Text>
              <Text>{` (${options.deletedProjectLabel})`}</Text>
            </Text>
          );
        }
        return (
          <Text
            key={`${keyPrefix}-project-${index}`}
            style={[styles.link, { color: tc.tint }]}
            onPress={() => openProjectScreen(reference.id)}
          >
            {token.text}
          </Text>
        );
      }
      if (reference?.entityType === 'task') {
        const task = options.resolveTask(reference.id);
        if (!task) {
          return (
            <Text key={`${keyPrefix}-deleted-task-${index}`} style={[styles.deletedLink, { color: tc.secondaryText }]}>
              <Text style={styles.struckText}>{token.text}</Text>
              <Text>{` (${options.deletedTaskLabel})`}</Text>
            </Text>
          );
        }
        return (
          <Text
            key={`${keyPrefix}-task-${index}`}
            style={[styles.link, { color: tc.tint }]}
            onPress={() => openTaskScreen(reference.id, task.projectId)}
          >
            {token.text}
          </Text>
        );
      }
      if (isSafeLink(token.href)) {
        return (
          <Text
            key={`${keyPrefix}-link-${index}`}
            style={[styles.link, { color: tc.tint }]}
            onPress={() => options.openExternalLink(token.href)}
          >
            {token.text}
          </Text>
        );
      }
      return token.text;
    }
    return null;
  });
  return nodes.filter((node): node is string | React.ReactElement => node !== null);
}

export function MarkdownInlineText({
  markdown,
  tc,
  direction,
  style,
  numberOfLines,
}: {
  markdown: string;
  tc: ThemeColors;
  direction?: 'ltr' | 'rtl';
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
}) {
  const renderOptions = useMarkdownRenderOptions();
  const directionStyle: TextStyle | undefined = direction
    ? { writingDirection: direction, textAlign: direction === 'rtl' ? 'right' : 'left' }
    : undefined;

  return (
    <Text style={[style, directionStyle]} numberOfLines={numberOfLines}>
      {renderInline(markdown || '', tc, 'inline', renderOptions)}
    </Text>
  );
}

export function MarkdownText({
  markdown,
  tc,
  direction,
  selectable = false,
}: {
  markdown: string;
  tc: ThemeColors;
  direction?: 'ltr' | 'rtl';
  selectable?: boolean;
}) {
  const renderOptions = useMarkdownRenderOptions();
  const source = (markdown || '').replace(/\r\n/g, '\n');
  const lines = source.split('\n');
  const directionStyle: TextStyle | undefined = direction
    ? { writingDirection: direction, textAlign: direction === 'rtl' ? 'right' : 'left' }
    : undefined;
  const { copyCodeLabel } = renderOptions;

  const blocks: React.ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      blocks.push(
        <View
          key={`blank-${i}`}
          testID="markdown-blank-line"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={styles.blankLine}
        />
      );
      i += 1;
      continue;
    }

    const headingMatch = HEADING_RE.exec(line.trim());
    if (headingMatch) {
      const level = headingMatch[1].length;
      const text = headingMatch[2];
      blocks.push(
        <Text
          key={`h-${i}`}
          selectable={selectable}
          style={[
            styles.heading,
            { color: tc.text, fontSize: level === 1 ? 16 : level === 2 ? 15 : 14 },
            directionStyle,
          ]}
        >
          {renderInline(text, tc, `h-${i}`, renderOptions)}
        </Text>
      );
      i += 1;
      continue;
    }

    if (HORIZONTAL_RULE_RE.test(line.trim())) {
      blocks.push(
        <View key={`hr-${i}`} style={[styles.separator, { backgroundColor: tc.border }]} />
      );
      i += 1;
      continue;
    }

    if (FENCED_CODE_RE.test(line.trim())) {
      const start = i;
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !FENCED_CODE_RE.test(lines[i].trim())) {
        codeLines.push(lines[i]);
        i += 1;
      }
      if (i < lines.length && FENCED_CODE_RE.test(lines[i].trim())) {
        i += 1;
      }
      const codeText = codeLines.join('\n');
      blocks.push(
        <View
          key={`code-${start}`}
          style={[styles.codeBlock, { backgroundColor: tc.filterBg, borderColor: tc.border }]}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={copyCodeLabel}
            hitSlop={8}
            onPress={() => writeClipboardText(codeText)}
            style={({ pressed }) => [
              styles.codeCopyButton,
              {
                backgroundColor: pressed ? tc.border : tc.filterBg,
                borderColor: tc.border,
              },
            ]}
          >
            <Ionicons name="copy-outline" size={15} color={tc.secondaryText} />
          </Pressable>
          <Text selectable={selectable} style={[styles.codeBlockText, { color: tc.text }, directionStyle]}>
            {codeText}
          </Text>
        </View>
      );
      continue;
    }

    const taskListMatch = TASK_LIST_RE.exec(line);
    if (taskListMatch) {
      const items: { checked: boolean; depth: number; text: string }[] = [];
      const start = i;
      while (i < lines.length) {
        const m = TASK_LIST_RE.exec(lines[i]);
        if (!m) break;
        items.push({ checked: m[2].toLowerCase() === 'x', depth: getListIndentDepth(m[1]), text: m[3] });
        i += 1;
      }
      blocks.push(
        <View key={`task-ul-${start}`} style={styles.list}>
          {items.map((item, idx) => (
            <View key={idx} testID="markdown-list-item" style={[styles.listRow, { marginLeft: item.depth * 14 }]}>
              <Text style={[styles.taskListMarker, { color: tc.secondaryText }]}>
                {item.checked ? '☑' : '☐'}
              </Text>
              <Text selectable={selectable} style={[styles.paragraph, styles.taskListText, { color: tc.text }, directionStyle]}>
                {renderInline(item.text, tc, `task-li-${start}-${idx}`, renderOptions)}
              </Text>
            </View>
          ))}
        </View>
      );
      continue;
    }

    const listMatch = BULLET_LIST_RE.exec(line);
    if (listMatch) {
      const items: { depth: number; marker: string; text: string }[] = [];
      const start = i;
      while (i < lines.length) {
        const m = BULLET_LIST_RE.exec(lines[i]);
        if (!m) break;
        const depth = getListIndentDepth(m[1]);
        items.push({ depth, marker: getBulletMarker(depth), text: m[2] });
        i += 1;
      }
      blocks.push(
        <View key={`ul-${start}`} style={styles.list}>
          {items.map((item, idx) => (
            <View key={idx} testID="markdown-list-item" style={[styles.listRow, { marginLeft: item.depth * 14 }]}>
              <Text style={[styles.listMarker, { color: tc.secondaryText }]}>
                {item.marker}
              </Text>
              <Text selectable={selectable} style={[styles.paragraph, styles.listItemText, { color: tc.text }, directionStyle]}>
                {renderInline(item.text, tc, `li-${start}-${idx}`, renderOptions)}
              </Text>
            </View>
          ))}
        </View>
      );
      continue;
    }

    const orderedListMatch = ORDERED_LIST_RE.exec(line);
    if (orderedListMatch) {
      const items: { depth: number; marker: string; text: string }[] = [];
      const start = i;
      while (i < lines.length) {
        const m = ORDERED_LIST_RE.exec(lines[i]);
        if (!m) break;
        items.push({ depth: getListIndentDepth(m[1]), marker: `${m[2]}${m[3]}`, text: m[4] });
        i += 1;
      }
      blocks.push(
        <View key={`ol-${start}`} style={styles.list}>
          {items.map((item, idx) => (
            <View key={idx} testID="markdown-list-item" style={[styles.listRow, { marginLeft: item.depth * 14 }]}>
              <Text style={[styles.orderedListMarker, { color: tc.secondaryText }]}>
                {item.marker}
              </Text>
              <Text selectable={selectable} style={[styles.paragraph, styles.listItemText, { color: tc.text }, directionStyle]}>
                {renderInline(item.text, tc, `oli-${start}-${idx}`, renderOptions)}
              </Text>
            </View>
          ))}
        </View>
      );
      continue;
    }

    const paragraph: string[] = [];
    while (i < lines.length && lines[i].trim() && !isBlockBoundary(lines[i])) {
      paragraph.push(lines[i]);
      i += 1;
    }
    const text = paragraph.join('\n').trim();
    if (text) {
      blocks.push(
        <Text key={`p-${i}`} selectable={selectable} style={[styles.paragraph, { color: tc.text }, directionStyle]}>
          {renderInline(text, tc, `p-${i}`, renderOptions)}
        </Text>
      );
    }
  }

  return <View style={styles.container}>{blocks}</View>;
}

const styles = StyleSheet.create({
  container: {
    gap: 6,
  },
  paragraph: {
    fontSize: 13,
    lineHeight: 18,
  },
  blankLine: {
    height: 12,
  },
  heading: {
    fontWeight: '700',
    lineHeight: 20,
  },
  list: {
    gap: 4,
    paddingLeft: 6,
  },
  listRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
  },
  listMarker: {
    fontSize: 13,
    lineHeight: 18,
    width: 14,
  },
  orderedListMarker: {
    fontSize: 13,
    lineHeight: 18,
    minWidth: 22,
  },
  taskListMarker: {
    fontSize: 13,
    lineHeight: 18,
    width: 14,
  },
  listItemText: {
    flexShrink: 1,
  },
  taskListText: {
    flexShrink: 1,
  },
  bold: {
    fontWeight: '700',
  },
  italic: {
    fontStyle: 'italic',
  },
  code: {
    fontFamily: 'monospace',
    fontSize: 13,
    lineHeight: 18,
    includeFontPadding: false,
    paddingHorizontal: 4,
    paddingVertical: 0,
    borderRadius: 4,
  },
  codeBlock: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    paddingRight: 38,
  },
  codeCopyButton: {
    position: 'absolute',
    top: 6,
    right: 6,
    zIndex: 1,
    width: 28,
    height: 28,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 7,
    alignItems: 'center',
    justifyContent: 'center',
  },
  codeBlockText: {
    fontFamily: 'monospace',
    fontSize: 12,
    lineHeight: 18,
  },
  link: {
    textDecorationLine: 'underline',
  },
  deletedLink: {
    textDecorationLine: 'none',
  },
  struckText: {
    textDecorationLine: 'line-through',
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    marginVertical: 4,
  },
});
