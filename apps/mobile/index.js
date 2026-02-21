require('./polyfills');
const startupProfiler = require('./lib/startup-profiler');
startupProfiler?.markStartupPhase?.('js.index.polyfills_loaded');
const skipWidgetHandlerInit = process.env.EXPO_PUBLIC_SKIP_WIDGET_HANDLER_INIT === '1';
const loadWidgetHandler = () => {
  startupProfiler?.markStartupPhase?.('js.index.widget_handler_require:start');
  try {
    require('./widget-task-handler');
    startupProfiler?.markStartupPhase?.('js.index.widget_handler_loaded');
  } catch (error) {
    const details = error instanceof Error ? (error.stack || error.message) : String(error);
    startupProfiler?.markStartupPhase?.('js.index.widget_handler_failed');
    console.error(`[MindwtrStartup] phase=js.index.widget_handler_failed_error details=${details}`);
  }
};

const loadExpoRouterEntry = () => {
  startupProfiler?.markStartupPhase?.('js.index.metro_runtime_require:start');
  require('@expo/metro-runtime');
  startupProfiler?.markStartupPhase?.('js.index.metro_runtime_require:loaded');

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

if (skipWidgetHandlerInit) {
  startupProfiler?.markStartupPhase?.('js.index.widget_handler_skipped');
} else {
  startupProfiler?.markStartupPhase?.('js.index.widget_handler_deferred_scheduled');
  if (typeof setImmediate === 'function') {
    setImmediate(loadWidgetHandler);
  } else {
    setTimeout(loadWidgetHandler, 0);
  }
}

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
