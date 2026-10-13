import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { applyTimings, mapStream } from "./lib/steps.mjs";

const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

// Both captures come from one real akt v1.0.1 deploy, workflow 98c9e12420a881c1, so the
// jsonl and the action log describe the same run and can be joined on step_name.
const V101_LOG = JSON.parse(readFileSync(fixture("v101.log.json"), "utf8"));

// akt flushed all seven lines at once, which is the whole reason timings cannot come from
// arrival order. These are the arrival times a burst produces.
const V101_ARRIVALS_MS = [29000, 29000, 29000, 29000, 29000, 29000, 29001];

function v101Events() {
  const text = readFileSync(fixture("v101.jsonl"), "utf8");
  const raw = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  assert.strictEqual(raw.length, 7, "v101.jsonl carries exactly 7 captured akt events");
  return raw.map((event, i) => ({ at: V101_ARRIVALS_MS[i], event }));
}

describe("mapStream, the real v101.jsonl capture", () => {
  const result = mapStream({ events: v101Events() });

  it("excludes display-result from the graded step list, leaving the 6 real lifecycle steps", () => {
    assert.deepStrictEqual(
      result.steps.map((s) => s.step),
      [
        "create-deployment",
        "wait-for-bids",
        "select-bid",
        "create-lease",
        "send-manifest",
        "wait-for-ready",
      ],
    );
    assert.ok(
      result.steps.every((s) => s.result === "completed"),
      "every graded step completed",
    );
  });

  it("carries txs only for the two steps that broadcast one", () => {
    const create = result.steps.find((s) => s.step === "create-deployment");
    const lease = result.steps.find((s) => s.step === "create-lease");
    assert.deepStrictEqual(create.txs, [
      { hash: "BCD73AA76918CF82599A2102E09D90C875E9D57DB90B68111AB7CA2EA3038CC0", code: 0 },
    ]);
    assert.deepStrictEqual(lease.txs, [
      { hash: "44BAA7A0F9F117A011967F6A1077014FE71DD594E621BC2EFB7AB120BFCB5BB6", code: 0 },
    ]);
    assert.ok(!("txs" in result.steps.find((s) => s.step === "wait-for-bids")));
  });

  it("harvests the exact lease facts from create-deployment, wait-for-bids and select-bid", () => {
    assert.deepStrictEqual(result.lease, {
      dseq: "5715077",
      bidCount: 1,
      provider: "akash1rk090a6mq9gvm0h6ljf8kz8mrxglwwxsk4srxh",
      providerAudited: true,
      providerRegion: "na-us-west",
      providerOrg: "overclock",
      price: { amount: "2.930853000000000000", denom: "uact" },
      uris: ["074o2mvcghcod7bnciqbtfq4c8.ingress.provider-01.sandbox-2.aksh.pw"],
    });
  });

  it("keeps display-result out of steps but mines its outputs verbatim", () => {
    assert.ok(!result.steps.some((s) => s.step === "display-result"));
    assert.ok("display-result" in result.outputs);
    assert.strictEqual(
      result.outputs["display-result"].text,
      "Deployment created!\n  DSEQ: 5715077",
    );
  });

  it("reports no unknown steps and no failure", () => {
    assert.deepStrictEqual(result.unknownSteps, []);
    assert.strictEqual(result.failedStep, null);
    assert.strictEqual(result.lastEventAtMs, 29001);
  });

  it("leaves timing alone, because arrival order cannot carry it", () => {
    assert.ok(result.steps.every((s) => !("durationMs" in s) && !("startedAt" in s)));
  });
});

describe("applyTimings, joining the capture to akt's own action log", () => {
  const spawnedAtMs = Date.parse("2026-10-12T14:46:29.700000Z");
  const exitedAtMs = Date.parse("2026-10-12T14:46:49.300000Z");
  const timed = applyTimings({
    steps: mapStream({ events: v101Events() }).steps,
    log: V101_LOG,
    startedAtMs: spawnedAtMs,
    exitAtMs: exitedAtMs,
  });
  const by = Object.fromEntries(timed.map((s) => [s.step, s]));

  it("puts the ten seconds on wait-for-bids, not on create-deployment", () => {
    assert.strictEqual(by["wait-for-bids"].durationMs, 10530);
    assert.strictEqual(by["create-deployment"].durationMs, 1310);
    assert.ok(
      by["wait-for-bids"].durationMs > by["create-deployment"].durationMs * 5,
      "arrival-order timing attributed the whole wait to create-deployment instead",
    );
  });

  it("keeps a sub-millisecond local bid choice at zero rather than inventing time for it", () => {
    assert.strictEqual(by["select-bid"].durationMs, 0);
    assert.strictEqual(by["create-lease"].durationMs, 240);
    assert.strictEqual(by["send-manifest"].durationMs, 6866);
  });

  it("labels every duration with where it came from", () => {
    for (const name of [
      "create-deployment",
      "wait-for-bids",
      "select-bid",
      "create-lease",
      "send-manifest",
    ]) {
      assert.strictEqual(by[name].durationSource, "akt-log", name);
    }
    assert.strictEqual(by["wait-for-ready"].durationSource, "derived");
  });

  it("derives wait-for-ready from the last logged step to akt exiting, since the log never reaches it", () => {
    assert.ok(!V101_LOG.some((e) => e.step_name === "wait-for-ready"));
    assert.strictEqual(by["wait-for-ready"].startedAt, "2026-10-12T14:46:48.646Z");
    assert.strictEqual(by["wait-for-ready"].durationMs, 654);
  });

  it("chains each step to the previous one so the timeline has no holes", () => {
    for (let i = 1; i < timed.length; i += 1) {
      const prevEnd = Date.parse(timed[i - 1].startedAt) + timed[i - 1].durationMs;
      assert.ok(
        Math.abs(prevEnd - Date.parse(timed[i].startedAt)) <= 1,
        `${timed[i].step} does not start where ${timed[i - 1].step} ended`,
      );
    }
  });

  it("falls back to a labelled derivation when the action log is missing entirely", () => {
    const blind = applyTimings({
      steps: mapStream({ events: v101Events() }).steps,
      log: [],
      startedAtMs: spawnedAtMs,
      exitAtMs: exitedAtMs,
    });
    assert.ok(blind.every((s) => s.durationSource === "derived"));
    assert.strictEqual(blind.at(-1).durationMs, exitedAtMs - spawnedAtMs);
  });
});

describe("mapStream, synthetic streams", () => {
  const cases = [
    {
      name: "an error result mid-stream truncates the step list there",
      events: [
        {
          at: 1000,
          event: { step: "create-deployment", result: "completed", errors: [], txs: [] },
        },
        { at: 2000, event: { step: "wait-for-bids", result: "error", errors: ["boom"], txs: [] } },
        { at: 3000, event: { step: "select-bid", result: "completed", errors: [], txs: [] } },
      ],
      check: (result) => {
        assert.deepStrictEqual(
          result.steps.map((s) => s.step),
          ["create-deployment", "wait-for-bids"],
        );
        assert.strictEqual(result.steps[1].result, "failed");
        assert.deepStrictEqual(result.steps[1].errors, ["boom"]);
        assert.deepStrictEqual(result.failedStep, { step: "wait-for-bids", errors: ["boom"] });
      },
    },
    {
      name: "an unknown step name is recorded under its real name and does not fail the run",
      events: [
        { at: 1000, event: { step: "resolve-dseq", result: "completed", errors: [], txs: [] } },
      ],
      check: (result) => {
        assert.deepStrictEqual(
          result.steps.map((s) => s.step),
          ["resolve-dseq"],
        );
        assert.strictEqual(result.steps[0].result, "completed");
        assert.deepStrictEqual(result.unknownSteps, ["resolve-dseq"]);
        assert.strictEqual(result.failedStep, null);
      },
    },
    {
      name: "an empty stream maps to the documented empty shape",
      events: [],
      check: (result) => {
        assert.deepStrictEqual(result, {
          steps: [],
          lease: {},
          outputs: {},
          unknownSteps: [],
          failedStep: null,
          lastEventAtMs: null,
        });
      },
    },
  ];

  for (const { name, events, check } of cases) {
    it(name, () => {
      check(mapStream({ events }));
    });
  }
});
