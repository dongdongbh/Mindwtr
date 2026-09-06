require('./polyfills');

// Background task modules import Expo packages at module scope. Load Metro's
// runtime first so React Native installs globals like FormData before Expo
// patches them.
require('@expo/metro-runtime');

const startupProfiler = require('./lib/startup-profiler');
startupProfiler?.markStartupPhase?.('js.index.polyfills_loaded');
startupProfiler?.markStartupPhase?.('js.index.metro_runtime_require:loaded');

require('./lib/background-sync-task');
require('./lib/context-automation-headless-task');

const installKeepAwakeActivationGuard = () => {
  try {
    if (process.env.NODE_ENV === 'production') {
      return;
    }

    const { Platform } = require('react-native');
    if (Platform.OS !== 'android') {
      return;
    }

    const { requireNativeModule } = require('expo-modules-core');
    const keepAwakeModule = requireNativeModule?.('ExpoKeepAwake');
    if (!keepAwakeModule || typeof keepAwakeModule.activate !== 'function') {
      return;
    }

    if (keepAwakeModule.__mindwtrActivateWrapped) {
      return;
    }

    const originalActivate = keepAwakeModule.activate.bind(keepAwakeModule);
    keepAwakeModule.activate = async (...args) => {
      try {
        return await originalActivate(...args);
      } catch (error) {
        const details = error instanceof Error ? (error.stack || error.message) : String(error);
        if (details.includes('Unable to activate keep awake')) {
          startupProfiler?.markStartupPhase?.('js.index.keep_awake_activate_ignored');
          console.warn('[MindwtrStartup] keep-awake activation skipped until activity is ready');
          return;
        }
        throw error;
      }
    };
    keepAwakeModule.__mindwtrActivateWrapped = true;
    startupProfiler?.markStartupPhase?.('js.index.keep_awake_activate_guard_installed');
  } catch (error) {
    const details = error instanceof Error ? (error.stack || error.message) : String(error);
    startupProfiler?.markStartupPhase?.('js.index.keep_awake_activate_guard_failed');
    console.warn(`[MindwtrStartup] keep-awake guard install failed: ${details}`);
  }
};

installKeepAwakeActivationGuard();

const loadExpoRouterEntry = () => {
  startupProfiler?.markStartupPhase?.('js.index.router_qualified_entry_require:start');
  const { App } = require('expo-router/build/qualified-entry');
  startupProfiler?.markStartupPhase?.('js.index.router_qualified_entry_require:loaded');

  startupProfiler?.markStartupPhase?.('js.index.router_render_root_require:start');
  const { renderRootComponent } = require('expo-router/build/renderRootComponent');
  startupProfiler?.markStartupPhase?.('js.index.router_render_root_require:loaded');

  startupProfiler?.markStartupPhase?.('js.index.router_render_root_component:start');
  renderRootComponent(App);
  startupProfiler?.markStartupPhase?.('js.index.router_render_root_component:loaded');
};

startupProfiler?.markStartupPhase?.('js.index.expo_router_entry_require:start');
try {
  loadExpoRouterEntry();
  startupProfiler?.markStartupPhase?.('js.index.expo_router_entry_loaded');
} catch (error) {
  const details = error instanceof Error ? (error.stack || error.message) : String(error);
  startupProfiler?.markStartupPhase?.('js.index.expo_router_entry_failed');
  console.error(`[MindwtrStartup] phase=js.index.expo_router_entry_failed_error details=${details}`);
  throw error;
}
