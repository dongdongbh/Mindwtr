import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("CI executes the production-path large-store performance budgets", () => {
  const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
  const rootPackage = JSON.parse(readFileSync("package.json", "utf8"));
  const corePackage = JSON.parse(readFileSync("packages/core/package.json", "utf8"));
  const timelineSuite = readFileSync("apps/desktop/src/components/views/TimelineView.performance.test.tsx", "utf8");
  const mobileSuite = readFileSync("apps/mobile/tests/large-store-performance.test.tsx", "utf8");

  expect(corePackage.scripts["test:perf"]).toContain("performance-large-store.test.ts");
  expect(rootPackage.scripts["test:perf"]).toContain("--filter @mindwtr/core test:perf");
  expect(rootPackage.scripts["test:perf"]).toContain("ListView.performance.test.tsx");
  expect(rootPackage.scripts["test:perf"]).toContain("TimelineView.performance.test.tsx");
  expect(rootPackage.scripts["test:perf"]).toContain("tests/large-store-performance.test.tsx");
  expect(timelineSuite).toContain("<TimelineView");
  expect(timelineSuite).toContain("LARGE_TASK_COUNT = 5_000");
  expect(mobileSuite).toContain("<TaskList");
  expect(mobileSuite).toContain("<ProjectDetailModal");
  expect(workflow).toContain("name: Performance Budgets");
  expect(workflow.match(/run: bun run test:perf(?=\s|$)/g)).toHaveLength(1);
  expect(workflow).not.toContain("bun run --filter @mindwtr/core test:perf");
  expect(workflow).not.toContain("scripts/audit-performance.ts");
});

test("production baselines are scheduled release-UI reports, not noisy PR timing gates", () => {
  const workflow = readFileSync(".github/workflows/performance-baselines.yml", "utf8");
  expect(workflow).toContain("schedule:");
  expect(workflow).toContain("workflow_dispatch:");
  expect(workflow).not.toContain("pull_request:");
  expect(workflow).toContain("VITE_STARTUP_PROFILING: '1'");
  expect(workflow).toContain("RUNS: '30'");
  expect(workflow).toContain("run: bun run desktop:web:build");
  expect(workflow).toContain("run: bun run perf:web");
  expect(workflow).toContain("if: always()");
  expect(workflow).not.toContain("continue-on-error: true");
});
