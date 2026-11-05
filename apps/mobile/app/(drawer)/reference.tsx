import React, { useEffect, useRef, useState } from 'react';
import { View, StyleSheet, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { getStatusListScreenText, REFERENCE_LIST_DEFAULT_GROUP_BY, TASK_LIST_GROUP_OPTIONS } from '@mindwtr/core';
import { workspaceSessionStorage } from '@/lib/workspace-session-storage';

import { TaskList, type TaskListGroupBy } from '../../components/task-list';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { useLanguage } from '../../contexts/language-context';

const GROUP_BY_STORAGE_KEY = 'mindwtr:view:reference:groupBy:v1';

export default function ReferenceScreen() {
  const tc = useThemeColors();
  const insets = useSafeAreaInsets();
  const { t } = useLanguage();
  const [groupBy, setGroupBy] = useState<TaskListGroupBy>(REFERENCE_LIST_DEFAULT_GROUP_BY);
  const groupByTouched = useRef(false);
  useEffect(() => {
    let active = true;
    void workspaceSessionStorage.getItem(GROUP_BY_STORAGE_KEY).then((saved) => {
      if (active && !groupByTouched.current && TASK_LIST_GROUP_OPTIONS.some((option) => option === saved)) {
        setGroupBy(saved as TaskListGroupBy);
      }
    }).catch(() => undefined);
    return () => { active = false; };
  }, []);
  const changeGroupBy = (next: TaskListGroupBy) => {
    groupByTouched.current = true;
    setGroupBy(next);
    void workspaceSessionStorage.setItem(GROUP_BY_STORAGE_KEY, next).catch(() => undefined);
  };

  const { title, emptyText, emptyHint } = getStatusListScreenText('reference', t);
  const navBarInset = Platform.OS === 'android' && insets.bottom >= 24 ? insets.bottom : 0;

  return (
    <View style={[styles.container, { backgroundColor: tc.bg }]}>
      <TaskList
        statusFilter="reference"
        title={title}
        overflowPlacement="navigation"
        showHeader={false}
        emptyText={emptyText}
        emptyHint={emptyHint}
        showTimeEstimateFilters={false}
        groupBy={groupBy}
        onChangeGroupBy={changeGroupBy}
        contentPaddingBottom={navBarInset}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});
