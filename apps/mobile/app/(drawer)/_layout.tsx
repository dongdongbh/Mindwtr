
import { Drawer } from 'expo-router/drawer';
import { Link, useRouter } from 'expo-router';
import { TouchableOpacity, View, Text } from 'react-native';
import { DrawerContentScrollView, DrawerItemList, DrawerItem } from '@react-navigation/drawer';
import { Search } from 'lucide-react-native';
import { useTheme } from '../../contexts/theme-context';
import { useLanguage } from '../../contexts/language-context';
import { useTaskStore } from '@mindwtr/core';

function CustomDrawerContent(props: any) {
  const { isDark } = useTheme();
  const { t } = useLanguage();
  const { settings } = useTaskStore();
  const router = useRouter();

  const savedSearches = settings?.savedSearches || [];
  const secondaryText = isDark ? '#9CA3AF' : '#6B7280';

  return (
    <DrawerContentScrollView {...props} contentContainerStyle={{ flexGrow: 1 }}>
      <DrawerItemList {...props} />
      {savedSearches.length > 0 && (
        <View style={{ marginTop: 12, paddingHorizontal: 16 }}>
          <Text style={{ color: secondaryText, fontSize: 12, marginBottom: 8 }}>
            {t('search.savedSearches')}
          </Text>
          {savedSearches.map((search) => (
            <DrawerItem
              key={search.id}
              label={search.name}
              onPress={() => router.push(`/saved-search/${search.id}`)}
              activeTintColor="#3B82F6"
              inactiveTintColor={isDark ? '#F9FAFB' : '#111827'}
              labelStyle={{ fontSize: 14 }}
            />
          ))}
        </View>
      )}
    </DrawerContentScrollView>
  );
}

export default function DrawerLayout() {
  const { isDark } = useTheme();
  const { t } = useLanguage();
  const { settings } = useTaskStore();
  const accentColor = settings?.accentColor || '#3B82F6';

  return (
    <Drawer
      screenOptions={{
        drawerActiveTintColor: accentColor,
        drawerInactiveTintColor: '#6B7280',
        headerShown: true,
        drawerStyle: {
          backgroundColor: isDark ? '#1F2937' : '#FFFFFF',
        },
        headerStyle: {
          backgroundColor: isDark ? '#1F2937' : '#FFFFFF',
        },
        headerTintColor: isDark ? '#F9FAFB' : '#111827',
        drawerLabelStyle: {
          color: isDark ? '#F9FAFB' : '#111827',
        },
        headerRight: () => (
          <Link href="/global-search" asChild>
            <TouchableOpacity style={{ marginRight: 16 }}>
              <Search size={24} color={isDark ? '#F9FAFB' : '#111827'} />
            </TouchableOpacity>
          </Link>
        ),
      }}
      drawerContent={(props) => <CustomDrawerContent {...props} />}
    >
      <Drawer.Screen
        name="(tabs)"
        options={{
          drawerLabel: t('nav.main'),
          title: t('app.name'),
          headerShown: true,
        }}
      />
      <Drawer.Screen
        name="board"
        options={{
          drawerLabel: t('nav.board'),
          title: t('board.title'),
        }}
      />
      <Drawer.Screen
        name="calendar"
        options={{
          drawerLabel: t('nav.calendar'),
          title: t('calendar.title'),
        }}
      />
      <Drawer.Screen
        name="contexts"
        options={{
          drawerLabel: t('nav.contexts'),
          title: t('contexts.title'),
        }}
      />
      <Drawer.Screen
        name="waiting"
        options={{
          drawerLabel: t('nav.waiting'),
          title: t('waiting.title'),
        }}
      />
      <Drawer.Screen
        name="someday"
        options={{
          drawerLabel: t('nav.someday'),
          title: t('someday.title'),
        }}
      />

      <Drawer.Screen
        name="projects-screen"
        options={{
          drawerLabel: t('nav.projects'),
          title: t('projects.title'),
        }}
      />

      <Drawer.Screen
        name="archived"
        options={{
          drawerLabel: t('nav.archived') || 'Archived',
          title: t('archived.title') || 'Archived',
        }}
      />

      <Drawer.Screen
        name="settings"
        options={{
          drawerLabel: t('nav.settings'),
          title: t('settings.title'),
        }}
      />

      {/* Hide dynamic saved-search route from drawer list */}
      <Drawer.Screen
        name="saved-search/[id]"
        options={{
          drawerLabel: () => null,
          drawerItemStyle: { height: 0 },
          title: t('search.savedSearches'),
        }}
      />
    </Drawer>
  );
}
