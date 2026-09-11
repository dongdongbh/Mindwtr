import React from 'react';
import { Text, View } from 'react-native';
import { tFallback, type Task } from '@mindwtr/core';

import { styles } from '../inbox-processing-modal.styles';
import type { ThemeColors } from '@/hooks/use-theme-colors';

type Props = {
  t: (key: string) => string;
  tc: ThemeColors;
  tasks: readonly Task[];
  projectTitles: ReadonlyMap<string, string>;
};

/** A quiet, read-only warning that a capture may already exist. */
export function SimilarTasksHint({ t, tc, tasks, projectTitles }: Props) {
  if (tasks.length === 0) return null;

  const heading = t('process.similarTasks');

  return (
    <View style={styles.similarTasksSection} accessibilityLabel={heading}>
      <Text style={[styles.similarTasksHeading, { color: tc.secondaryText }]}>
        {heading}
      </Text>
      {tasks.map((task) => {
        const status = tFallback(t, `status.${task.status}`, task.status);
        const projectTitle = task.projectId ? projectTitles.get(task.projectId) : undefined;

        return (
          <View key={task.id} style={styles.similarTaskRow}>
            <Text style={[styles.similarTaskTitle, { color: tc.text }]}>
              {task.title}
            </Text>
            <Text style={[styles.similarTaskMeta, { color: tc.secondaryText }]}>
              {projectTitle ? `${status} • ${projectTitle}` : status}
            </Text>
          </View>
        );
      })}
    </View>
  );
}
