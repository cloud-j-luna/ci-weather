import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { loadConfig } from "./lib/config.mjs";

const repoRoot = new URL("..", import.meta.url).pathname;

describe("the CI matrix and the scenario registry", () => {
  it("list the same scenarios", () => {
    const workflow = readFileSync(join(repoRoot, ".github/workflows/canary.yml"), "utf8");
    const line = workflow.split("\n").find((l) => l.includes("scenario:"));
    assert.ok(line, "canary.yml has no scenario matrix line");

    const quoted = [...line.matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]);

    const registry = [...loadConfig(repoRoot).scenarios.keys()];
    for (const id of registry) {
      assert.ok(
        quoted.includes(id),
        `scenario "${id}" is in scenarios.yaml but not in the canary.yml matrix, so it would never run`,
      );
    }
    for (const id of quoted) {
      assert.ok(
        registry.includes(id),
        `the canary.yml matrix names "${id}", which is not a scenario in scenarios.yaml`,
      );
    }
  });

  it("gives the CI job more wall clock than the runner's own budget, with room for the reap", () => {
    const workflow = readFileSync(join(repoRoot, ".github/workflows/canary.yml"), "utf8");
    const line = workflow.split("\n").find((l) => l.includes("timeout-minutes:"));
    assert.ok(line, "canary.yml has no timeout-minutes line");

    const jobMs = Number(line.split(":")[1].trim()) * 60000;
    const runMs = loadConfig(repoRoot).budgets.totalRunTimeoutMs;
    const headroomMs = 8 * 60000;

    assert.ok(
      jobMs - runMs >= headroomMs,
      `the job gets ${jobMs / 60000}m against a runner budget of ${runMs / 60000}m, which leaves under ${headroomMs / 60000}m for checkout, npm ci, the akt install, doctor and the always() reap. Too little and the job timeout kills the reap step, which strands a lease holding escrow until the next scheduled run.`,
    );
  });

  it("every scenario's gpuCheck path names a file its own SDL actually writes", () => {
    const config = loadConfig(repoRoot);
    for (const sc of config.scenarios.values()) {
      if (!sc.gpuCheck) continue;
      const sdl = parseYaml(readFileSync(sc.sdlPath, "utf8"));
      const args = sdl.services.app.args.join("\n");
      const written = `/srv${sc.gpuCheck.path}`;
      assert.ok(
        args.includes(written),
        `scenario "${sc.id}" points gpuCheck at ${sc.gpuCheck.path}, but its SDL never writes ${written}, so every run would 404`,
      );
    }
  });
});
