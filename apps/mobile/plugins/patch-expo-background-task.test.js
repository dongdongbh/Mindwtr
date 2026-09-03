import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const plugin = require('./patch-expo-background-task');

const {
  APPLIED_MARKER,
  WORK_INFO_MARKER,
  applyRunningWorkerGuard,
  getSchedulerCandidates,
  patchSchedulerSource,
} = plugin.__testables;

// The real vendored file. It may already carry the patch from an earlier prebuild, so the
// anchor-level assertions run against a pristine fixture and this one checks the end state.
const vendoredSchedulerPath = [process.cwd(), path.join(process.cwd(), 'apps', 'mobile')]
  .flatMap((root) => getSchedulerCandidates(root))
  .find((candidate) => fs.existsSync(candidate));

const readVendoredScheduler = () => {
  if (!vendoredSchedulerPath) {
    throw new Error('expo-background-task is not installed - cannot verify the patch.');
  }
  return fs.readFileSync(vendoredSchedulerPath, 'utf8');
};

// The two upstream regions the patch anchors on, verbatim from expo-background-task 1.0.10.
const PRISTINE_SOURCE = `object BackgroundTaskScheduler {
  private suspend fun scheduleWorker(context: Context, appScopeKey: String, cancelExisting: Boolean = true, overriddenIntervalMinutes: Long = intervalMinutes): Boolean {
    if (numberOfRegisteredTasksOfThisType == 0) {
      return false
    }

    // Stop the current worker (if any)
    if (cancelExisting) {
      stopWorker(context)
    }

    return true
  }

  private suspend fun getWorkerInfo(context: Context): WorkInfo? {
    val workManager = WorkManager.getInstance(context)

    return try {
      val workInfos = workManager.getWorkInfosForUniqueWork(WORKER_IDENTIFIER).await()
      return workInfos.firstOrNull()
    } catch (e: Exception) {
      return null
    }
  }
}
`;

const tempRoots = [];

const makeProjectRoot = (source) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bgtask-patch-'));
  tempRoots.push(root);
  const target = getSchedulerCandidates(root)[0];
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, source);
  return { root, target };
};

afterEach(() => {
  while (tempRoots.length) {
    fs.rmSync(tempRoots.pop(), { force: true, recursive: true });
  }
});

describe('patch-expo-background-task plugin', () => {
  it('returns early on a running worker before scheduleWorker cancels it', () => {
    const patched = applyRunningWorkerGuard(PRISTINE_SOURCE);

    expect(patched).toContain(
      'if (cancelExisting && getWorkerInfo(context)?.state == WorkInfo.State.RUNNING)'
    );
    expect(patched).toContain(APPLIED_MARKER);
    // The guard must sit above the cancel, otherwise the running worker still dies.
    expect(patched.indexOf(APPLIED_MARKER)).toBeLessThan(
      patched.indexOf('// Stop the current worker (if any)')
    );
    expect(patched).toContain('      return true\n    }');
  });

  it('makes a RUNNING work info win the unique-work lookup', () => {
    const patched = applyRunningWorkerGuard(PRISTINE_SOURCE);

    // An APPEND chain holds several work infos; firstOrNull() can return an ENQUEUED sibling
    // while another is RUNNING, and cancelUniqueWork would then cancel the running one too.
    expect(patched).toContain(`return ${WORK_INFO_MARKER} ?: workInfos.firstOrNull()`);
    expect(patched).not.toMatch(/return workInfos\.firstOrNull\(\)\n/);
  });

  it('leaves the cancel-and-re-enqueue path intact for a worker that is not running', () => {
    const patched = applyRunningWorkerGuard(PRISTINE_SOURCE);

    expect(patched).toContain('    // Stop the current worker (if any)\n'
      + '    if (cancelExisting) {\n'
      + '      stopWorker(context)\n'
      + '    }');
  });

  it('is idempotent', () => {
    const once = applyRunningWorkerGuard(PRISTINE_SOURCE);

    expect(applyRunningWorkerGuard(once)).toBe(once);
  });

  it('still finds both anchors in the vendored expo-background-task source', () => {
    // Fails loudly if an upstream bump moves either anchor, instead of shipping an inert patch.
    const patched = applyRunningWorkerGuard(readVendoredScheduler());

    expect(patched).toContain(APPLIED_MARKER);
    expect(patched).toContain(WORK_INFO_MARKER);
  });

  it('writes both edits through patchSchedulerSource and does not rewrite them', () => {
    const { root, target } = makeProjectRoot(PRISTINE_SOURCE);

    expect(patchSchedulerSource(root)).toBe(true);
    const afterFirst = fs.readFileSync(target, 'utf8');
    expect(afterFirst).toContain(APPLIED_MARKER);
    expect(afterFirst).toContain(WORK_INFO_MARKER);

    expect(patchSchedulerSource(root)).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe(afterFirst);
  });

  it('throws when an anchor is gone so an inert patch cannot ship silently', () => {
    const { root } = makeProjectRoot('object BackgroundTaskScheduler {\n}\n');

    expect(() => patchSchedulerSource(root)).toThrow(/did not apply/);
  });

  it('throws when only one of the two anchors survives upstream', () => {
    const halfSource = PRISTINE_SOURCE.replace('      return workInfos.firstOrNull()', '      return null');
    const { root } = makeProjectRoot(halfSource);

    expect(() => patchSchedulerSource(root)).toThrow(/did not apply/);
  });
});
