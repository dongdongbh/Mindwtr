import { useCallback } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { useTaskStore } from '@mindwtr/core';

import { useQuickCapture } from '../../../contexts/quick-capture-context';

export default function CaptureQuickScreen() {
  const { openQuickCapture } = useQuickCapture();
  const router = useRouter();
  const params = useLocalSearchParams<{ mode?: string; autoRecord?: string }>();
  const { settings } = useTaskStore();

  useFocusEffect(
    useCallback(() => {
      const defaultCapture = settings.gtd?.defaultCaptureMethod ?? 'text';
      const mode = typeof params.mode === 'string' ? params.mode : undefined;
      const autoParam = typeof params.autoRecord === 'string' ? params.autoRecord : undefined;
      const autoRecord = mode
        ? mode === 'audio'
        : autoParam
          ? autoParam === '1' || autoParam.toLowerCase() === 'true'
          : defaultCapture === 'audio';


      const timer = setTimeout(() => {
        openQuickCapture({ autoRecord, preserveDraft: true });
        router.replace('/inbox');
      }, 0);

      return () => clearTimeout(timer);
    }, [openQuickCapture, params.autoRecord, params.mode, router, settings.gtd?.defaultCaptureMethod])
  );

  return null;
}
