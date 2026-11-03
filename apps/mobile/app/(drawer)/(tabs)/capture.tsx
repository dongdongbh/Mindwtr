import { useCallback } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { useRouter } from 'expo-router';
import { useTaskStore } from '@mindwtr/core';

import { useQuickCapture } from '../../../contexts/quick-capture-context';

export default function CaptureTab() {
  const { openQuickCapture } = useQuickCapture();
  const router = useRouter();
  const { settings } = useTaskStore();

  useFocusEffect(
    useCallback(() => {
      const defaultCapture = settings.gtd?.defaultCaptureMethod ?? 'text';
      const autoRecord = defaultCapture === 'audio';


      const timer = setTimeout(() => {
        openQuickCapture({ autoRecord });
        if (router.canGoBack()) {
          router.back();
        } else {
          router.replace('/inbox');
        }
      }, 0);

      return () => clearTimeout(timer);
    }, [openQuickCapture, router, settings.gtd?.defaultCaptureMethod])
  );

  return null;
}
