// The store's save retry waits (250, 500, 1000, 2000 ms) are skipped in tests: the schedule is unchanged and
// asserted where it matters (native-host-contract-archive-task-delete.test.ts), but hundreds of failed-save tests
// otherwise sleep 3.75 s each, which put some at their 5 s budget under a loaded suite. A flag, not an import of the
// store: importing it here would load modules before a test file's vi.mock could replace them.
(globalThis as { __mindwtrSkipSaveRetryWait?: boolean }).__mindwtrSkipSaveRetryWait = true;
