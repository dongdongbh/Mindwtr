# Performance and stability

Start with the [session handoff](stability-handoff.md): completed work, findings,
rejected experiments, remaining coverage, and the prioritized improvement plan.

- [Baselines and profiling](baselines.md): reproducible commands, measurement
  boundaries, device/build identity, isolation, and artifact requirements.
- [Performance budgets](budgets.md): existing fast CI regression gates.

## Investigation reports

Reports retain the evidence and limitations of each experiment. Read later
follow-ups before acting on an older report's next-step recommendation.

### Desktop and shared core

- [Desktop Settings loading](desktop-settings-2026-09.md)
- [Full-merge allocation](merge-allocation-2026-09.md)
- [Native desktop interactions and Android scrolling](native-interactions-2026-09.md)
- [Native snapshot statement reuse](native-snapshot-save-2026-09.md)
- [Native save-queue boundaries](native-save-idle-2026-09.md)
- [Append-only snapshot captures](native-append-capture-2026-09.md)
- [Native capture sampling](native-capture-sampling-2026-09.md)
- [Save-baseline structural equality](storage-baseline-equality-2026-09.md)
- [Shared serialization property ordering](watcher-property-order-2026-09.md)
- [Fixed-viewport comparisons](fixed-viewport-2026-09.md)

### Android

- [Settings navigation and scrolling](mobile-navigation-2026-09.md)
- [Capture focus and rejected presentation experiments](capture-focus-2026-09.md)
- [Profiling-cache isolation](profiling-cache-2026-09.md)
- [Capture context rendering and native frame findings](capture-context-2026-09.md)

Raw traces, builds, maps, and synthetic databases stay outside Git. The
[diagnostics ledger](../release-notes/diagnostics-ledger.md) remains the source of
truth for release markers and what a tester's log can prove.
