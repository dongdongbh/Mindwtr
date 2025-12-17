
import { Stack } from 'expo-router';

import { useLanguage } from '../../contexts/language-context';
import { useTheme } from '../../contexts/theme-context';

export default function AppLayout() {
  const { isDark } = useTheme();
  const { t } = useLanguage();

  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: isDark ? '#1F2937' : '#FFFFFF' },
        headerTintColor: isDark ? '#F9FAFB' : '#111827',
        headerTitleAlign: 'center',
        headerShadowVisible: false,
      }}
    >
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="board" options={{ title: t('nav.board') }} />
      <Stack.Screen name="calendar" options={{ title: t('nav.calendar') }} />
      <Stack.Screen name="review" options={{ title: t('nav.review') }} />
      <Stack.Screen name="contexts" options={{ title: t('contexts.title') }} />
      <Stack.Screen name="waiting" options={{ title: t('waiting.title') }} />
      <Stack.Screen name="someday" options={{ title: t('someday.title') }} />
      <Stack.Screen name="projects-screen" options={{ title: t('projects.title') }} />
      <Stack.Screen name="archived" options={{ title: t('archived.title') || 'Archived' }} />
      <Stack.Screen name="settings" options={{ title: t('settings.title') }} />
      <Stack.Screen name="saved-search/[id]" options={{ title: t('search.title') }} />
    </Stack>
  );
}
