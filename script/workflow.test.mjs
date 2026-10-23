import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { loadConfig } from "./lib/config.mjs";

const repoRoot = new URL("..", import.meta.url).pathname;

// The service the probe reaches is the one with a global route; the others are only
// reachable from inside the lease.
function probedService(sdl, scenarioId) {
  const entry = Object.entries(sdl.services).find(([, s]) =>
    (s.expose ?? []).some((e) => (e.to ?? []).some((t) => t.global)),
  );
  if (!entry) throw new Error(`scenario "${scenarioId}" exposes no service globally`);
  return entry;
}

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
      const [name, service] = probedService(parseYaml(readFileSync(sc.sdlPath, "utf8")), sc.id);
      const written = `/srv${sc.gpuCheck.path}`;
      assert.ok(
        (service.args ?? []).join("\n").includes(written),
        `scenario "${sc.id}" points gpuCheck at ${sc.gpuCheck.path}, but service "${name}" never writes ${written}, so every run would 404`,
      );
    }
  });

  // A scenario whose workload serves files it writes itself can have its probe path and
  // its SDL drift apart silently. The row then 404s every day and reads as Akash being
  // broken, which is the one thing this canary must never report falsely.
  it("every scenario that serves files it writes itself writes the one the probe asks for", () => {
    const config = loadConfig(repoRoot);
    for (const sc of config.scenarios.values()) {
      const [name, service] = probedService(parseYaml(readFileSync(sc.sdlPath, "utf8")), sc.id);
      if (!service.args) continue;
      const written = `/srv${sc.probe.path === "/" ? "/index.html" : sc.probe.path}`;
      assert.ok(
        service.args.join("\n").includes(written),
        `scenario "${sc.id}" probes ${sc.probe.path}, but service "${name}" never writes ${written}`,
      );
    }
  });
});
