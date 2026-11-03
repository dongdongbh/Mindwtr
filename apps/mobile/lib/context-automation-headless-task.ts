import { AppRegistry, Platform } from 'react-native';

import {
  parseContextAutomationHeadlessTaskData,
  type ContextAutomationHeadlessTaskData,
} from '@mindwtr/core';

export const CONTEXT_AUTOMATION_HEADLESS_TASK_NAME = 'MindwtrContextAutomation';


export { parseContextAutomationHeadlessTaskData };

export async function runContextAutomationHeadlessTask(data: ContextAutomationHeadlessTaskData): Promise<void> {
  if (Platform.OS !== 'android') return;

  const payload = parseContextAutomationHeadlessTaskData(data);
  if (!payload) return;

  const [
    { setStorageAdapter, useTaskStore },
    {
      defaultContextAutomationText,
      handleContextAutomationPayload,
      wasContextAutomationRecentlyHandled,
    },
    { mobileStorage, quiesceMobileStorage },
  ] = await Promise.all([
    import('@mindwtr/core'),
    import('./context-automation-handler'),
    import('./storage-adapter'),
  ]);

  if (wasContextAutomationRecentlyHandled(payload)) return;

  setStorageAdapter(mobileStorage);
  try {
    await useTaskStore.getState().fetchData({ silent: true });
    await handleContextAutomationPayload(payload, defaultContextAutomationText);
  } finally {


    await quiesceMobileStorage();
  }
}

AppRegistry.registerHeadlessTask(CONTEXT_AUTOMATION_HEADLESS_TASK_NAME, () => runContextAutomationHeadlessTask);
