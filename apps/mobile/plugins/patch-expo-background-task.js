const fs = require('fs');
const path = require('path');
const { withDangerousMod } = require('@expo/config-plugins');


const SCHEDULER_RELATIVE_PATH = path.join(
  'expo-background-task',
  'android',
  'src',
  'main',
  'java',
  'expo',
  'modules',
  'backgroundtask',
  'BackgroundTaskScheduler.kt'
);

const getSchedulerCandidates = (projectRoot) => [
  path.join(projectRoot, 'node_modules', SCHEDULER_RELATIVE_PATH),
  path.join(projectRoot, '..', '..', 'node_modules', SCHEDULER_RELATIVE_PATH),
];


const APPLIED_MARKER = 'is already running - keeping it.';


const WORK_INFO_ANCHOR = `      val workInfos = workManager.getWorkInfosForUniqueWork(WORKER_IDENTIFIER).await()
      return workInfos.firstOrNull()`;

const WORK_INFO_MARKER = 'workInfos.firstOrNull { it.state == WorkInfo.State.RUNNING }';

const WORK_INFO_PATCHED = `      val workInfos = workManager.getWorkInfosForUniqueWork(WORKER_IDENTIFIER).await()
      // The unique work is re-enqueued with APPEND, so the name can hold several WorkInfos. A
      // RUNNING one must win: cancelUniqueWork cancels every entry under the name, so returning
      // an ENQUEUED sibling here lets the cancel path kill the worker that woke this process.
      return ${WORK_INFO_MARKER} ?: workInfos.firstOrNull()`;

const STOP_ANCHOR = `    // Stop the current worker (if any)
    if (cancelExisting) {
      stopWorker(context)
    }`;

const RUNNING_GUARD = `    // Keep a worker that is already RUNNING - it is the one that woke this process up. Cancelling
    // it here (task restore at cold start calls registerTask) kills the run in flight and enqueues
    // a replacement a full interval later. The running worker enqueues the next run itself when its
    // tasks finish, using the intervalMinutes registerTask just stored.
    if (cancelExisting && getWorkerInfo(context)?.state == WorkInfo.State.RUNNING) {
      Log.d(TAG, "Worker with identifier $WORKER_IDENTIFIER ${APPLIED_MARKER}")
      return true
    }

`;

const applyRunningWorkerGuard = (original) => {
  let next = original;
  if (!next.includes(APPLIED_MARKER) && next.includes(STOP_ANCHOR)) {
    next = next.replace(STOP_ANCHOR, `${RUNNING_GUARD}${STOP_ANCHOR}`);
  }
  if (!next.includes(WORK_INFO_MARKER) && next.includes(WORK_INFO_ANCHOR)) {
    next = next.replace(WORK_INFO_ANCHOR, WORK_INFO_PATCHED);
  }
  return next;
};

const isFullyPatched = (source) =>
  source.includes(APPLIED_MARKER) && source.includes(WORK_INFO_MARKER);

const patchSchedulerSource = (projectRoot) => {
  let satisfied = false;
  for (const candidate of getSchedulerCandidates(projectRoot)) {
    if (!fs.existsSync(candidate)) continue;
    const original = fs.readFileSync(candidate, 'utf8');
    const next = applyRunningWorkerGuard(original);
    if (!isFullyPatched(next)) continue;
    if (next !== original) {
      fs.writeFileSync(candidate, next);
      console.log(`[patch-expo-background-task] patched ${candidate}`);
    }
    satisfied = true;
  }
  if (!satisfied) {
    throw new Error(
      'patch-expo-background-task did not apply and its marker was not found. '
      + 'BackgroundTaskScheduler.kt likely changed upstream - recheck the anchor in '
      + 'plugins/patch-expo-background-task.js.'
    );
  }
  return satisfied;
};

const withExpoBackgroundTaskPatch = (config) =>
  withDangerousMod(config, [
    'android',
    async (cfg) => {
      patchSchedulerSource(cfg.modRequest.projectRoot);
      return cfg;
    },
  ]);

module.exports = withExpoBackgroundTaskPatch;
module.exports.__testables = {
  APPLIED_MARKER,
  WORK_INFO_MARKER,
  applyRunningWorkerGuard,
  getSchedulerCandidates,
  patchSchedulerSource,
};
