#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function parseArgs(argv) {
  const args = { policy: resolve(repoRoot, "aur/trusted-packages.json") };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--output" || value === "--compare" || value === "--policy") {
      const next = argv[index + 1];
      if (!next) throw new Error(`${value} requires a path`);
      args[value.slice(2)] = resolve(next);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${value}`);
  }
  return args;
}

async function fetchJson(url) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { "user-agent": "Mindwtr-AUR-security-audit/1" },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < 3)
        await new Promise((resolveDelay) =>
          setTimeout(resolveDelay, attempt * 1000),
        );
    }
  }
  throw lastError;
}

function remoteHead(packageName) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const output = execFileSync(
        "git",
        [
          "ls-remote",
          `https://aur.archlinux.org/${packageName}.git`,
          "refs/heads/master",
        ],
        { encoding: "utf8" },
      ).trim();
      const [head, ref, ...extra] = output.split(/\s+/);
      if (
        !/^[0-9a-f]{40}$/.test(head ?? "") ||
        ref !== "refs/heads/master" ||
        extra.length > 0
      ) {
        throw new Error(
          `Could not resolve a single master head for ${packageName}`,
        );
      }
      return head;
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        Atomics.wait(
          new Int32Array(new SharedArrayBuffer(4)),
          0,
          0,
          attempt * 1000,
        );
      }
    }
  }
  throw lastError;
}

export async function captureAurState(policyPath) {
  const policy = JSON.parse(readFileSync(policyPath, "utf8"));
  const snapshot = { schemaVersion: 1, packages: {} };

  for (const [packageName, expected] of Object.entries(policy.packages)) {
    const rpc = await fetchJson(
      `https://aur.archlinux.org/rpc/v5/info/${packageName}`,
    );
    if (rpc.resultcount !== 1 || rpc.results?.length !== 1) {
      throw new Error(
        `AUR RPC returned ${rpc.resultcount ?? 0} results for ${packageName}`,
      );
    }
    const result = rpc.results[0];
    const coMaintainers = [...(result.CoMaintainers ?? [])].sort();
    const expectedCoMaintainers = [...expected.coMaintainers].sort();

    if (!result.Maintainer) throw new Error(`${packageName} is orphaned`);
    if (result.Maintainer !== expected.maintainer) {
      throw new Error(
        `${packageName} maintainer changed: expected ${expected.maintainer}, got ${result.Maintainer}`,
      );
    }
    if (
      JSON.stringify(coMaintainers) !== JSON.stringify(expectedCoMaintainers)
    ) {
      throw new Error(
        `${packageName} co-maintainers changed: expected ${expectedCoMaintainers.join(", ") || "none"}, got ${coMaintainers.join(", ") || "none"}`,
      );
    }
    if (result.URL !== policy.upstreamRepository) {
      throw new Error(
        `${packageName} upstream URL changed: ${result.URL ?? "missing"}`,
      );
    }

    snapshot.packages[packageName] = {
      maintainer: result.Maintainer,
      coMaintainers,
      upstreamUrl: result.URL,
      head: remoteHead(packageName),
    };
  }

  return snapshot;
}

export function compareAurState(actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      "AUR ownership or remote history changed after the proposal audit",
    );
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const snapshot = await captureAurState(args.policy);
  if (args.compare) {
    compareAurState(snapshot, JSON.parse(readFileSync(args.compare, "utf8")));
  }
  if (args.output)
    writeFileSync(args.output, `${JSON.stringify(snapshot, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
