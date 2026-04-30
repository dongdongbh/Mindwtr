import React from 'react';
import { View, Text, StyleSheet, type TextStyle } from 'react-native';
import * as Linking from 'expo-linking';

import type { ThemeColors } from '@/hooks/use-theme-colors';
import { parseInlineMarkdown, parseMarkdownReferenceHref, shallow, tFallback, useTaskStore } from '@mindwtr/core';
import { useLanguage } from '@/contexts/language-context';
import { openProjectScreen, openTaskScreen } from '@/lib/task-meta-navigation';

const TASK_LIST_RE = /^\s{0,3}(?:[-*+]\s+)?\[( |x|X)\]\s+(.+)$/;
const BULLET_LIST_RE = /^\s{0,3}[-*+]\s+(.+)$/;
const HEADING_RE = /^(#{1,3})\s+(.+)$/;
const HORIZONTAL_RULE_RE = /^(?:-{3,}|\*{3,}|_{3,})$/;
const FENCED_CODE_RE = /^```.*$/;

function isBlockBoundary(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('```')) return true;
  if (HEADING_RE.test(trimmed)) return true;
  if (HORIZONTAL_RULE_RE.test(trimmed)) return true;
  if (TASK_LIST_RE.test(line)) return true;
  if (BULLET_LIST_RE.test(line)) return true;
  return false;
}

function isSafeLink(href: string): boolean {
  return /^https?:\/\//i.test(href) || /^mailto:/i.test(href) || /^tel:/i.test(href);
}

function renderInline(
  text: string,
  tc: ThemeColors,
  keyPrefix: string,
  options: {
    resolveTask: (id: string) => { title: string; projectId?: string } | null;
    resolveProject: (id: string) => { title: string } | null;
    deletedTaskLabel: string;
    deletedProjectLabel: string;
  },
): React.ReactNode[] {
  const nodes: (string | React.ReactElement | null)[] = parseInlineMarkdown(text).map((token, index) => {
    if (token.type === 'text') return token.text;
    if (token.type === 'code') {
      return (
        <Text key={`${keyPrefix}-code-${index}`} style={[styles.code, { backgroundColor: tc.filterBg, color: tc.text }]}>
          {token.text}
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
            onPress={() => Linking.openURL(token.href)}
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

export function MarkdownText({
  markdown,
  tc,
  direction,
}: {
  markdown: string;
  tc: ThemeColors;
  direction?: 'ltr' | 'rtl';
}) {
  const { t } = useLanguage();
  const { tasks, projects } = useTaskStore((state) => ({
    tasks: state._allTasks,
    projects: state.projects,
  }), shallow);
  const source = (markdown || '').replace(/\r\n/g, '\n');
  const lines = source.split('\n');
  const directionStyle: TextStyle | undefined = direction
    ? { writingDirection: direction, textAlign: direction === 'rtl' ? 'right' : 'left' }
    : undefined;
  const deletedTaskLabel = tFallback(t, 'markdown.referenceDeletedTask', 'deleted task');
  const deletedProjectLabel = tFallback(t, 'markdown.referenceDeletedProject', 'deleted project');
  const resolveTask = React.useCallback((id: string) => {
    const task = tasks.find((candidate) => candidate.id === id && !candidate.deletedAt);
    if (!task) return null;
    return {
      title: task.title,
      projectId: task.projectId,
    };
  }, [tasks]);
  const resolveProject = React.useCallback((id: string) => {
    const project = projects.find((candidate) => candidate.id === id && !candidate.deletedAt);
    if (!project) return null;
    return {
      title: project.title,
    };
  }, [projects]);

  const blocks: React.ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
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
          style={[
            styles.heading,
            { color: tc.text, fontSize: level === 1 ? 16 : level === 2 ? 15 : 14 },
            directionStyle,
          ]}
        >
          {renderInline(text, tc, `h-${i}`, { resolveTask, resolveProject, deletedTaskLabel, deletedProjectLabel })}
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
      blocks.push(
        <View
          key={`code-${start}`}
          style={[styles.codeBlock, { backgroundColor: tc.filterBg, borderColor: tc.border }]}
        >
          <Text style={[styles.codeBlockText, { color: tc.text }, directionStyle]}>
            {codeLines.join('\n')}
          </Text>
        </View>
      );
      continue;
    }

    const taskListMatch = TASK_LIST_RE.exec(line);
    if (taskListMatch) {
      const items: { checked: boolean; text: string }[] = [];
      const start = i;
      while (i < lines.length) {
        const m = TASK_LIST_RE.exec(lines[i]);
        if (!m) break;
        items.push({ checked: m[1].toLowerCase() === 'x', text: m[2] });
        i += 1;
      }
      blocks.push(
        <View key={`task-ul-${start}`} style={styles.list}>
          {items.map((item, idx) => (
            <View key={idx} style={styles.taskListRow}>
              <Text style={[styles.taskListMarker, { color: tc.secondaryText }]}>
                {item.checked ? '☑' : '☐'}
              </Text>
              <Text style={[styles.paragraph, styles.taskListText, { color: tc.text }, directionStyle]}>
                {renderInline(item.text, tc, `task-li-${start}-${idx}`, { resolveTask, resolveProject, deletedTaskLabel, deletedProjectLabel })}
              </Text>
            </View>
          ))}
        </View>
      );
      continue;
    }

    const listMatch = BULLET_LIST_RE.exec(line);
    if (listMatch) {
      const items: string[] = [];
      const start = i;
      while (i < lines.length) {
        const m = BULLET_LIST_RE.exec(lines[i]);
        if (!m) break;
        items.push(m[1]);
        i += 1;
      }
      blocks.push(
        <View key={`ul-${start}`} style={styles.list}>
          {items.map((item, idx) => (
            <Text key={idx} style={[styles.paragraph, { color: tc.text }, directionStyle]}>
              • {renderInline(item, tc, `li-${start}-${idx}`, { resolveTask, resolveProject, deletedTaskLabel, deletedProjectLabel })}
            </Text>
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
    const text = paragraph.join(' ').trim();
    if (text) {
      blocks.push(
        <Text key={`p-${i}`} style={[styles.paragraph, { color: tc.text }, directionStyle]}>
          {renderInline(text, tc, `p-${i}`, { resolveTask, resolveProject, deletedTaskLabel, deletedProjectLabel })}
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
  heading: {
    fontWeight: '700',
    lineHeight: 20,
  },
  list: {
    gap: 4,
    paddingLeft: 6,
  },
  taskListRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
  },
  taskListMarker: {
    fontSize: 13,
    lineHeight: 18,
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
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 4,
  },
  codeBlock: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
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
