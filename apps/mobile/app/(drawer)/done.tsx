import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Redirect, usePathname } from 'expo-router';
import { View, StyleSheet, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { getStatusListScreenText } from '@mindwtr/core';
import { workspaceSessionStorage as AsyncStorage } from '@/lib/workspace-session-storage';

import { TaskList } from '../../components/task-list';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { useLanguage } from '../../contexts/language-context';
import {
  DEFAULT_DONE_LIST_VIEW_STATE,
  DONE_LIST_VIEW_STATE_STORAGE_KEY,
  readDoneListViewState,
  serializeDoneListViewState,
  type DoneListViewState,
} from '@/lib/view-state/done-list-view-state';

export default function DoneScreen() {
  const pathname = usePathname();
  const tc = useThemeColors();
  const insets = useSafeAreaInsets();
  const { t } = useLanguage();
  const [viewState, setViewState] = useState<DoneListViewState>(DEFAULT_DONE_LIST_VIEW_STATE);
  const viewStateTouchedRef = useRef(false);

  const { title, emptyText, emptyHint } = getStatusListScreenText('done', t);
  const navBarInset = Platform.OS === 'android' && insets.bottom >= 24 ? insets.bottom : 0;
  useEffect(() => {
    let active = true;
    void AsyncStorage.getItem(DONE_LIST_VIEW_STATE_STORAGE_KEY).then((raw) => {
      if (active && !viewStateTouchedRef.current) {
        setViewState(readDoneListViewState(raw));
      }
    }).catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  const updateViewState = useCallback((updates: Partial<DoneListViewState>) => {
    viewStateTouchedRef.current = true;
    setViewState((current) => {
      const next = { ...current, ...updates };
      void AsyncStorage.setItem(DONE_LIST_VIEW_STATE_STORAGE_KEY, serializeDoneListViewState(next))
        .catch(() => undefined);
      return next;
    });
  }, []);

  if (pathname === '/done') {
    return <Redirect href={{ pathname: '/history', params: { tab: 'done' } } as never} />;
  }

  return (
    <View style={[styles.container, { backgroundColor: tc.bg }]}>
      <TaskList
        statusFilter="done"
        title={title}
        overflowPlacement="navigation"
        showHeader={false}
        emptyText={emptyText}
        emptyHint={emptyHint}
        showTimeEstimateFilters={false}
        groupBy={viewState.groupBy}
        onChangeGroupBy={(groupBy) => updateViewState({ groupBy: groupBy as DoneListViewState['groupBy'] })}
        viewSortBy={viewState.sortBy}
        onChangeViewSortBy={(sortBy) => updateViewState({ sortBy })}
        defaultEditTab="view"
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
