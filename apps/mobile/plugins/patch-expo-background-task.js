const fs = require('fs');
const path = require('path');
const { withDangerousMod } = require('@expo/config-plugins');

// expo-background-task 1.0.10 cancels its own running worker at cold start.
//
// When WorkManager wakes a dead process, expo-task-manager restores the persisted task during
// native bootstrap and calls the consumer's didRegister, which calls
// BackgroundTaskScheduler.registerTask -> scheduleWorker(cancelExisting = true) -> stopWorker.
// stopWorker cancels the unique work even when it is in state RUNNING, i.e. the very worker that
// woke the process, and enqueues a replacement a full interval later. The job is then released
// while the JS task is still running, Android freezes the cached process seconds later, and a
// scheduled background sync dispatched onto a dead process never finishes.
//
// The fix keeps a RUNNING worker instead of cancelling it. That worker already enqueues the next
// run itself when runTasks completes (scheduleWorker with cancelExisting = false), and
// registerTask has already stored the new intervalMinutes, so a changed interval still applies to
// that next enqueue. An ENQUEUED (not running) worker keeps the upstream cancel-and-re-enqueue
// behaviour, so changing the interval from the UI still takes effect immediately.
//
// Delivered as a prebuild patch rather than a bun patch because FOSS builds install with
// `npm ci`, which ignores bun patchedDependencies. Note this is inert on its own: expo-* packages
// ship a prebuilt AAR, so `expo.autolinking.android.buildFromSource` in apps/mobile/package.json
// must list expo-background-task for the patched source to be compiled.

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

// Also the grep target that proves the patched class shipped in a built APK.
const APPLIED_MARKER = 'is already running - keeping it.';

// Second edit: getWorkerInfo returns workInfos.firstOrNull(), but the unique work is re-enqueued
// with ExistingWorkPolicy.APPEND, so the name can hold several WorkInfos at once. Observed on
// device: the first entry was an ENQUEUED sibling while another was RUNNING, the guard above
// missed it, and stopWorker ran — and cancelUniqueWork cancels every WorkInfo under the name,
// including the running one. A RUNNING entry has to win the lookup.
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
