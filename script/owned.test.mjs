import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownedDseqs } from "./lib/owned.mjs";

let root;

before(() => {
  root = mkdtempSync(join(tmpdir(), "owned-"));
});

function writeRun(runsRoot, scenario, runId, doc) {
  const runDir = join(runsRoot, scenario, runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "run.json"), JSON.stringify(doc));
}

function writeFlatRun(runsRoot, scenario, runId, doc) {
  const scenarioDir = join(runsRoot, scenario);
  mkdirSync(scenarioDir, { recursive: true });
  writeFileSync(join(scenarioDir, `${runId}.json`), JSON.stringify(doc));
}

describe("ownedDseqs", () => {
  it("collects a dseq out of every shape it claims to read: lease, escrow.closed, escrow.stillActive, and reap.closedDseqs", () => {
    const runsRoot = join(root, "all-shapes");
    writeRun(runsRoot, "web", "run-1", {
      lease: { dseq: "5715801" },
      escrow: {
        closed: [
          { dseq: "5715802", closeTxHash: "A".repeat(64) },
          { dseq: "5715803", closeTxHash: "B".repeat(64) },
        ],
        stillActive: [
          { dseq: "5715804", reason: "close tx not yet confirmed" },
          { dseq: "5715805", reason: "close tx not yet confirmed" },
        ],
      },
      reap: { closedDseqs: ["5715806", "5715807"] },
    });

    const result = ownedDseqs(runsRoot);

    assert.deepEqual(
      result,
      new Set(["5715801", "5715802", "5715803", "5715804", "5715805", "5715806", "5715807"]),
      "a missed branch here leaves the reaper unable to prove it owns that dseq, so a real deployment leaks and keeps burning escrow",
    );
  });

  it("collects the exact dseq set across multiple scenarios and multiple runs per scenario", () => {
    const runsRoot = join(root, "multi-scenario");
    writeRun(runsRoot, "web", "run-1", { lease: { dseq: "1000001" } });
    writeRun(runsRoot, "web", "run-2", { lease: { dseq: "1000002" } });
    writeRun(runsRoot, "gpu", "run-1", { lease: { dseq: "2000001" } });
    writeRun(runsRoot, "gpu", "run-2", { lease: { dseq: "2000002" } });

    const result = ownedDseqs(runsRoot);

    assert.deepEqual(
      result,
      new Set(["1000001", "1000002", "2000001", "2000002"]),
      "under-collecting leaks a deployment the reaper created, over-collecting hands it licence to close one it didn't: either is the original incident again",
    );
  });

  it("tolerates a run.json that is not JSON, and still collects its sibling runs and other scenarios", () => {
    const runsRoot = join(root, "malformed");
    writeRun(runsRoot, "web", "run-1", { lease: { dseq: "3000001" } });
    const brokenDir = join(runsRoot, "web", "run-2");
    mkdirSync(brokenDir, { recursive: true });
    writeFileSync(join(brokenDir, "run.json"), "not json {{{");
    writeRun(runsRoot, "gpu", "run-1", { lease: { dseq: "3000002" } });

    const result = ownedDseqs(runsRoot);

    assert.deepEqual(
      result,
      new Set(["3000001", "3000002"]),
      "one corrupt run.json must not crash the canary, and it must not take the rest of the tree's dseqs down with it",
    );
  });

  it("tolerates a run directory with no run.json at all", () => {
    const runsRoot = join(root, "missing-run-json");
    writeRun(runsRoot, "web", "run-1", { lease: { dseq: "4000001" } });
    mkdirSync(join(runsRoot, "web", "run-2"), { recursive: true });

    const result = ownedDseqs(runsRoot);

    assert.deepEqual(result, new Set(["4000001"]));
  });

  it("tolerates a run.json path that is itself a directory", () => {
    const runsRoot = join(root, "run-json-is-dir");
    writeRun(runsRoot, "web", "run-1", { lease: { dseq: "5000001" } });
    mkdirSync(join(runsRoot, "web", "run-2", "run.json"), { recursive: true });

    const result = ownedDseqs(runsRoot);

    assert.deepEqual(result, new Set(["5000001"]));
  });

  it("returns an empty set, not a throw, when runsRoot does not exist", () => {
    const result = ownedDseqs(join(root, "nonexistent"));

    assert.deepEqual(
      result,
      new Set(),
      "a throw here kills the whole canary run instead of just finding no owned dseqs to reap",
    );
  });

  it("skips a stray non-directory file sitting at the scenario level of runsRoot", () => {
    const runsRoot = join(root, "stray-file");
    mkdirSync(runsRoot, { recursive: true });
    writeFileSync(join(runsRoot, "README.md"), "not a scenario");
    writeRun(runsRoot, "web", "run-1", { lease: { dseq: "6000001" } });

    const result = ownedDseqs(runsRoot);

    assert.deepEqual(result, new Set(["6000001"]));
  });

  it("reads the flat <scenario>/<runId>.json layout used by testdata/runs", () => {
    const runsRoot = join(root, "flat-layout");
    writeFlatRun(runsRoot, "web", "20261012T155308Z", { lease: { dseq: "7000001" } });

    const result = ownedDseqs(runsRoot);

    assert.deepEqual(
      result,
      new Set(["7000001"]),
      "missing this layout leaves every flat testdata run invisible to ownership, and its dseq would read as unowned",
    );
  });

  it("normalises a numeric dseq to a string", () => {
    const runsRoot = join(root, "numeric-dseq");
    writeRun(runsRoot, "web", "run-1", { lease: { dseq: 123 } });

    const result = ownedDseqs(runsRoot);

    assert.ok(
      result.has("123"),
      "akt reports dseqs as strings; a Number sitting in the set would never match and the deployment would leak",
    );
    assert.ok(!result.has(123));
  });

  it("returns a Set", () => {
    const runsRoot = join(root, "return-type");
    writeRun(runsRoot, "web", "run-1", { lease: { dseq: "8000001" } });

    assert.ok(ownedDseqs(runsRoot) instanceof Set);
  });

  it("collects a dseq that exists only as a claim, with no run.json beside it", () => {
    const runsRoot = join(root, "claim-only");
    const claimDir = join(runsRoot, "web", "20261012T030000Z");
    mkdirSync(claimDir, { recursive: true });
    writeFileSync(
      join(claimDir, "claims.jsonl"),
      `${JSON.stringify({
        dseq: "9000001",
        scenario: "web",
        network: { name: "sandbox-2", chainId: "sandbox-2" },
        claimedAt: "2026-10-12T03:00:00.000Z",
      })}\n`,
    );

    const result = ownedDseqs(runsRoot);

    assert.deepEqual(
      result,
      new Set(["9000001"]),
      "a dseq claimed before a SIGKILL and never sealed must still be ownership evidence, or the reaper refuses to touch it forever",
    );
  });

  it("tolerates a claims.jsonl whose last line is truncated mid-JSON, keeping the intact lines", () => {
    const runsRoot = join(root, "claim-torn");
    const claimDir = join(runsRoot, "web", "20261012T030000Z");
    mkdirSync(claimDir, { recursive: true });
    const good = JSON.stringify({ dseq: "9000002", scenario: "web" });
    writeFileSync(join(claimDir, "claims.jsonl"), `${good}\n{"dseq": "9000003", "scen`);

    const result = ownedDseqs(runsRoot);

    assert.deepEqual(
      result,
      new Set(["9000002"]),
      "a SIGKILL mid-append must not cost the dseqs claimed earlier in the same file",
    );
  });

  it("contributes nothing for a run with none of the owned fields, or empty escrow/reap and a null lease", () => {
    const runsRoot = join(root, "empty-shapes");
    writeRun(runsRoot, "web", "run-1", {});
    writeRun(runsRoot, "web", "run-2", { escrow: {}, reap: {}, lease: null });

    const result = ownedDseqs(runsRoot);

    assert.deepEqual(result, new Set());
  });
});
