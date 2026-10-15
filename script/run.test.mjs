import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { attestationFailure, basicStamp, probeTarget, retryDecision, sealRun } from "./lib/run.mjs";
import { check } from "./validate-runs.mjs";

const T0 = Date.parse("2026-10-12T03:00:00.000Z");

const step = (name, result, offsetMs, extra = {}) => ({
  step: name,
  result,
  startedAt: new Date(T0 + offsetMs).toISOString(),
  durationMs: 1000,
  ...extra,
});

const lifecycleOk = [
  step("create-deployment", "completed", 0, { txs: [{ hash: "A".repeat(64), code: 0 }] }),
  step("wait-for-bids", "completed", 1000),
  step("select-bid", "completed", 2000),
  step("create-lease", "completed", 3000, { txs: [{ hash: "B".repeat(64), code: 0 }] }),
  step("send-manifest", "completed", 4000),
  step("wait-for-ready", "completed", 5000),
];

const lease = {
  dseq: "5715077",
  provider: "akash1rk090a6mq9gvm0h6ljf8kz8mrxglwwxsk4srxh",
  providerAudited: true,
  providerRegion: "na-us-west",
  providerOrg: "overclock",
  price: { amount: "2.930853000000000000", denom: "uact" },
  bidCount: 1,
  uris: ["074o2mvcghcod7bnciqbtfq4c8.ingress.provider-01.sandbox-2.aksh.pw"],
};

const servedProbe = {
  servedBy: "http",
  url: "http://host/",
  attempts: [
    {
      scheme: "https",
      url: "https://host/",
      at: new Date(T0).toISOString(),
      durationMs: 380,
      error: "connection refused",
    },
    {
      scheme: "http",
      url: "http://host/",
      at: new Date(T0).toISOString(),
      durationMs: 468,
      status: 200,
      bodyMatched: true,
    },
  ],
};

const base = (over = {}) => ({
  scenarioId: "web",
  network: { name: "sandbox-2", chainId: "sandbox-2" },
  startedAtMs: T0,
  finishedAtMs: T0 + 30000,
  steps: lifecycleOk,
  lease,
  probe: undefined,
  reap: { closedDseqs: [] },
  epilogue: null,
  aktVersion: "1.0.1",
  env: {},
  ...over,
});

describe("basicStamp", () => {
  it("is ISO 8601 basic UTC, filesystem safe and lexicographically sortable", () => {
    assert.equal(basicStamp(T0), "20261012T030000Z");
    assert.ok(basicStamp(T0) < basicStamp(T0 + 1000));
  });
});

describe("probeTarget", () => {
  const cases = [
    {
      name: "uri target returns the uris untouched and ignores the status entirely",
      target: "uri",
      uris: ["ingress.provider-01.sandbox-2.aksh.pw"],
      status: { error: "akt is unreachable" },
      expect: (r) => assert.deepEqual(r, { hosts: ["ingress.provider-01.sandbox-2.aksh.pw"] }),
    },
    {
      name: "ip target with an allocated ip returns its host:externalPort",
      target: "ip",
      uris: ["ingress.provider-01.sandbox-2.aksh.pw"],
      status: { ips: [{ ip: "1.2.3.4", port: 80, externalPort: 80, protocol: "TCP" }] },
      expect: (r) => assert.deepEqual(r, { hosts: ["1.2.3.4:80"] }),
    },
    {
      name: "ip target with no allocated ip errors naming the shared ingress hostname, with no hosts to probe",
      target: "ip",
      uris: ["ingress.provider-01.sandbox-2.aksh.pw"],
      status: { ips: [] },
      expect: (r) => {
        assert.equal(r.hosts, undefined);
        assert.match(r.error, /shared ingress/);
      },
    },
    {
      name: "ip target with a lease-status error carries akt's own message verbatim",
      target: "ip",
      uris: ["ingress.provider-01.sandbox-2.aksh.pw"],
      status: { error: "rpc error: lease not found" },
      expect: (r) => {
        assert.equal(r.hosts, undefined);
        assert.match(r.error, /rpc error: lease not found/);
      },
    },
  ];

  for (const c of cases) {
    it(c.name, () => c.expect(probeTarget(c.target, c.uris, c.status)));
  }
});

describe("attestationFailure", () => {
  const clean = { teeType: "snp-gpu", nonceVerified: true, mockReport: false };

  const cases = [
    { name: "a clean record passes", attestation: clean, expect: "snp-gpu", want: null },
    {
      name: "mock true fails even with a verified nonce",
      attestation: { ...clean, mockReport: true },
      expect: "snp-gpu",
      want: /mock attestation report/,
    },
    {
      name: "nonceVerified false fails",
      attestation: { ...clean, nonceVerified: false },
      expect: "snp-gpu",
      want: /did not echo akt's challenge nonce/,
    },
    {
      name: "a teeType mismatch fails naming both the expected and the actual type",
      attestation: { ...clean, teeType: "snp" },
      expect: "snp-gpu",
      want: /expected a snp-gpu attestation report, got "snp"/,
    },
    {
      name: "mockReport absent fails rather than being read as a pass",
      attestation: { teeType: "snp-gpu", nonceVerified: true },
      expect: "snp-gpu",
      want: /mock attestation report/,
    },
    {
      name: 'mockReport: "false" the string fails rather than being read as a pass',
      attestation: { teeType: "snp-gpu", nonceVerified: true, mockReport: "false" },
      expect: "snp-gpu",
      want: /mock attestation report/,
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const got = attestationFailure(c.attestation, c.expect);
      if (c.want === null) assert.equal(got, null);
      else assert.match(got, c.want);
    });
  }
});

describe("sealRun", () => {
  const cases = [
    {
      name: "a served probe seals passed and returned",
      state: base({
        probe: servedProbe,
        probeStartedAtMs: T0 + 6000,
        probeFinishedAtMs: T0 + 7000,
        epilogue: { closed: [{ dseq: "5715077", closeTxHash: "C".repeat(64) }], stillActive: [] },
      }),
      expect: (doc) => {
        assert.deepEqual(doc.outcome, { kind: "passed" });
        assert.equal(doc.escrow.kind, "returned");
        assert.equal(doc.steps.at(-1).step, "http-probe");
        assert.equal(doc.steps.at(-1).result, "completed");
        assert.equal(doc.lease.probe.servedBy, "http");
      },
    },
    {
      name: "a probe nothing answered fails at http-probe with its own attempts as the message",
      state: base({
        probe: {
          attempts: [
            {
              scheme: "https",
              url: "https://h/",
              at: new Date(T0).toISOString(),
              durationMs: 1,
              error: "connection refused",
            },
          ],
        },
        probeStartedAtMs: T0 + 6000,
        probeFinishedAtMs: T0 + 7000,
        epilogue: { closed: [{ dseq: "5715077" }], stillActive: [] },
      }),
      expect: (doc) => {
        assert.equal(doc.outcome.kind, "failed");
        assert.equal(doc.outcome.atStep, "http-probe");
        assert.equal(doc.outcome.message, doc.steps.at(-1).errors[0]);
        assert.match(doc.outcome.message, /connection refused/);
      },
    },
    {
      name: "a failed lifecycle step carries akt's own error verbatim into the verdict",
      state: base({
        steps: [
          ...lifecycleOk.slice(0, 5),
          step("wait-for-ready", "failed", 5000, {
            errors: ["services did not become ready within 2m0s: web 0/1 available"],
          }),
        ],
        epilogue: { closed: [{ dseq: "5715077", closeTxHash: "D".repeat(64) }], stillActive: [] },
      }),
      expect: (doc) => {
        assert.equal(doc.outcome.kind, "failed");
        assert.equal(doc.outcome.atStep, "wait-for-ready");
        assert.equal(
          doc.outcome.message,
          "services did not become ready within 2m0s: web 0/1 available",
        );
        assert.equal(doc.lease.probe, null);
        assert.equal(doc.escrow.kind, "returned");
      },
    },
    {
      name: "an abort is never a network failure, and names every step it never reached",
      state: base({
        abortReason: "wall-clock budget of 20m exhausted",
        epilogue: {
          closed: [],
          stillActive: [{ dseq: "5715077", reason: "run cancelled before close could broadcast" }],
        },
      }),
      expect: (doc) => {
        assert.equal(doc.outcome.kind, "aborted");
        assert.equal(doc.outcome.reason, "wall-clock budget of 20m exhausted");
        assert.equal(doc.escrow.kind, "leaked");
        assert.deepEqual(
          doc.steps.filter((s) => s.result === "skipped").map((s) => s.step),
          ["http-probe"],
        );
      },
    },
    {
      name: "an aborted run that planned to attest names attestation among the steps it never reached",
      state: base({
        scenarioId: "tee-snp-gpu",
        attestationExpect: "snp-gpu",
        abortReason: "wall-clock budget of 25m exhausted",
        epilogue: { closed: [{ dseq: "5715077" }], stillActive: [] },
      }),
      expect: (doc) => {
        assert.deepEqual(
          doc.steps.filter((s) => s.result === "skipped").map((s) => s.step),
          ["attestation", "http-probe"],
        );
      },
    },
    {
      name: "an abort before any lifecycle step skips the whole lifecycle and creates no escrow",
      state: base({
        steps: [],
        lease: null,
        abortReason: "job cancelled (SIGTERM)",
      }),
      expect: (doc) => {
        assert.equal(doc.outcome.kind, "aborted");
        assert.equal(doc.escrow.kind, "nothing-created");
        assert.equal(doc.lease, null);
        assert.equal(doc.steps.length, 7);
        assert.ok(doc.steps.every((s) => s.result === "skipped"));
      },
    },
    {
      name: "an abort that the salvage close converged seals returned, not a false leak alarm",
      state: base({
        abortReason: "job cancelled (SIGINT)",
        epilogue: { closed: [{ dseq: "5715077", closeTxHash: "E".repeat(64) }], stillActive: [] },
      }),
      expect: (doc) => {
        assert.equal(doc.outcome.kind, "aborted");
        assert.equal(doc.escrow.kind, "returned");
      },
    },
    {
      name: "a deployment closed by something else still counts as returned",
      state: base({
        probe: servedProbe,
        probeStartedAtMs: T0 + 6000,
        probeFinishedAtMs: T0 + 7000,
        epilogue: { closed: [], stillActive: [] },
      }),
      expect: (doc) => {
        assert.equal(doc.escrow.kind, "returned");
        assert.deepEqual(doc.escrow.closed, [{ dseq: "5715077" }]);
      },
    },
    {
      name: "a run that never created a deployment reports nothing-created",
      state: base({
        steps: [step("create-deployment", "failed", 0, { errors: ["insufficient funds"] })],
        lease: null,
        epilogue: { closed: [], stillActive: [] },
      }),
      expect: (doc) => {
        assert.equal(doc.escrow.kind, "nothing-created");
        assert.equal(doc.outcome.message, "insufficient funds");
      },
    },
    {
      name: "an orphan the prologue reaped is surfaced on the reap axis, not as a lifecycle step",
      state: base({
        probe: servedProbe,
        probeStartedAtMs: T0 + 6000,
        probeFinishedAtMs: T0 + 7000,
        reap: { closedDseqs: ["5554999"] },
        epilogue: { closed: [{ dseq: "5715077", closeTxHash: "F".repeat(64) }], stillActive: [] },
      }),
      expect: (doc) => {
        assert.deepEqual(doc.reap.closedDseqs, ["5554999"]);
        assert.ok(!doc.steps.some((s) => s.step === "reap" || s.step === "close"));
      },
    },
    {
      name: "a CI environment fills the provenance block the dashboard links to",
      state: base({
        probe: servedProbe,
        probeStartedAtMs: T0 + 6000,
        probeFinishedAtMs: T0 + 7000,
        epilogue: { closed: [{ dseq: "5715077" }], stillActive: [] },
        env: {
          GITHUB_SERVER_URL: "https://github.com",
          GITHUB_REPOSITORY: "cloud-j-luna/ci-weather",
          GITHUB_RUN_ID: "42",
          GITHUB_SHA: "deadbeef",
          GITHUB_RUN_ATTEMPT: "2",
        },
      }),
      expect: (doc) => {
        assert.deepEqual(doc.ci, {
          runUrl: "https://github.com/cloud-j-luna/ci-weather/actions/runs/42",
          sha: "deadbeef",
          attempt: 2,
        });
      },
    },
    {
      name: "a probeError fails at http-probe with no attempts, carrying the reason verbatim",
      state: base({
        probe: { attempts: [] },
        probeError:
          "the lease reported no dedicated IP, so there was nothing to probe but the provider's shared ingress hostname, which answers for every deployment",
        probeStartedAtMs: T0 + 6000,
        probeFinishedAtMs: T0 + 6100,
        epilogue: { closed: [{ dseq: "5715077", closeTxHash: "G".repeat(64) }], stillActive: [] },
      }),
      expect: (doc) => {
        assert.equal(doc.outcome.kind, "failed");
        assert.equal(doc.outcome.atStep, "http-probe");
        assert.equal(
          doc.outcome.message,
          "the lease reported no dedicated IP, so there was nothing to probe but the provider's shared ingress hostname, which answers for every deployment",
        );
        assert.deepEqual(doc.lease.probe.attempts, []);
      },
    },
    {
      name: "a step akt invented is recorded under its real name and does not gate the run",
      state: base({
        steps: [...lifecycleOk, step("verify-attestation", "completed", 6000)],
        probe: servedProbe,
        probeStartedAtMs: T0 + 7000,
        probeFinishedAtMs: T0 + 8000,
        epilogue: { closed: [{ dseq: "5715077" }], stillActive: [] },
      }),
      expect: (doc) => {
        assert.equal(doc.outcome.kind, "passed");
        assert.ok(doc.steps.some((s) => s.step === "verify-attestation"));
      },
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const doc = sealRun(c.state);
      assert.deepEqual(check(doc), [], `sealed document violates the contract: ${check(doc)}`);
      c.expect(doc);
    });
  }

  it("seals no document the contract would reject", () => {
    for (const c of cases) assert.deepEqual(check(sealRun(c.state)), []);
  });
});

describe("retryDecision", () => {
  const ok = {
    failure: { step: "wait-for-bids", errors: ["no bids received"] },
    dseq: "5715077",
    attemptsMade: 1,
    maxAttempts: 3,
    remainingMs: 20 * 60000,
    needMs: 15 * 60000,
  };

  const cases = [
    {
      name: "a run that did not fail is never retried, and owes the reader no explanation",
      over: { failure: null },
      want: { retry: false, stoppedBecause: null },
    },
    {
      name: "a send-manifest failure is a real result about Akash and is never retried",
      over: { failure: { step: "send-manifest", errors: ["provider refused the manifest"] } },
      want: { retry: false, stoppedBecause: null },
    },
    {
      name: "wait-for-bids, nobody bid, is retried",
      over: {},
      want: { retry: true, stoppedBecause: null },
    },
    {
      name: "select-bid, somebody bid but not the pinned provider, is retried",
      over: { failure: { step: "select-bid", errors: ["no item selected"] } },
      want: { retry: true, stoppedBecause: null },
    },
    {
      name: "the configured attempt count is a hard stop",
      over: { attemptsMade: 3 },
      want: { retry: false, stoppedBecause: "attempts-exhausted" },
    },
    {
      name: "an attempt that cannot plausibly finish is not started, so the run fails honestly rather than aborting",
      over: { remainingMs: 15 * 60000 - 1 },
      want: { retry: false, stoppedBecause: "time-budget" },
    },
    {
      name: "a failed attempt whose dseq we never harvested is not retried, because a deployment exists on chain that we cannot close",
      over: { dseq: undefined },
      want: { retry: false, stoppedBecause: "cleanup-not-proven" },
    },
    {
      name: "with both the count and the clock exhausted, the configured count is the reason reported",
      over: { attemptsMade: 3, remainingMs: 0 },
      want: { retry: false, stoppedBecause: "attempts-exhausted" },
    },
  ];

  for (const c of cases) {
    it(c.name, () => assert.deepEqual(retryDecision({ ...ok, ...c.over }), c.want));
  }
});

describe("sealRun across several attempts", () => {
  const retried = (over = {}) =>
    base({
      probe: servedProbe,
      probeStartedAtMs: T0 + 6000,
      probeFinishedAtMs: T0 + 7000,
      createdDseqs: ["5715001", "5715002", "5715077"],
      closedBetweenAttempts: [{ dseq: "5715001" }, { dseq: "5715002" }],
      epilogue: { closed: [{ dseq: "5715077" }], stillActive: [] },
      attempts: {
        count: 3,
        earlier: [
          {
            atStep: "wait-for-bids",
            message: "no bids received (at least 1 required); timed out after 5m0s",
            startedAt: new Date(T0).toISOString(),
            durationMs: 310000,
            dseq: "5715001",
            bidCount: 0,
          },
          {
            atStep: "select-bid",
            message: "no item selected",
            startedAt: new Date(T0 + 1000).toISOString(),
            durationMs: 26000,
            dseq: "5715002",
            bidCount: 2,
          },
        ],
        stoppedBecause: null,
      },
      ...over,
    });

  it("records every attempt's deposit as returned, which is the proof the retries did not leak", () => {
    const doc = sealRun(retried());
    assert.deepEqual(check(doc), [], JSON.stringify(check(doc)));
    assert.equal(doc.escrow.kind, "returned");
    assert.deepEqual(
      doc.escrow.closed.map((c) => c.dseq),
      ["5715001", "5715002", "5715077"],
      "a retried attempt whose deposit is missing from escrow is exactly the leak this feature risks",
    );
    assert.equal(doc.attempts.count, 3);
    assert.equal(doc.attempts.earlier.length, 2);
  });

  it("counts an earlier attempt the chain closed by itself as returned rather than failing the contract", () => {
    const doc = sealRun(
      retried({ closedBetweenAttempts: [], epilogue: { closed: [], stillActive: [] } }),
    );
    assert.deepEqual(
      check(doc),
      [],
      "without compensating every created dseq the document fails validation and the run loses its file entirely",
    );
    assert.deepEqual(
      doc.escrow.closed.map((c) => c.dseq),
      ["5715001", "5715002", "5715077"],
    );
  });

  it("records a dseq once even when the inter-attempt close and the epilogue both report it", () => {
    const doc = sealRun(
      retried({
        epilogue: { closed: [{ dseq: "5715001" }, { dseq: "5715077" }], stillActive: [] },
      }),
    );
    assert.deepEqual(check(doc), []);
    assert.equal(doc.escrow.closed.filter((c) => c.dseq === "5715001").length, 1);
  });

  it("leaves the steps array describing the final attempt only", () => {
    const doc = sealRun(retried());
    assert.equal(doc.steps.filter((s) => s.step === "wait-for-bids").length, 1);
    assert.ok(doc.steps.every((s) => s.result !== "failed"));
  });

  it("omits the attempts block entirely for a run that never started an attempt", () => {
    const doc = sealRun(base({ attempts: { count: 0, earlier: [], stoppedBecause: null } }));
    assert.equal(
      doc.attempts,
      undefined,
      "count 0 would fail the contract and cost the run its file",
    );
  });

  it("names why it stopped retrying while the failure was still a bidding failure", () => {
    const doc = sealRun(
      retried({
        steps: [
          ...lifecycleOk.slice(0, 1),
          step("wait-for-bids", "failed", 1000, { errors: ["no bids received"] }),
        ],
        probe: undefined,
        attempts: { ...retried().attempts, stoppedBecause: "attempts-exhausted" },
      }),
    );
    assert.deepEqual(check(doc), [], JSON.stringify(check(doc)));
    assert.equal(doc.outcome.atStep, "wait-for-bids");
    assert.equal(doc.attempts.stoppedBecause, "attempts-exhausted");
  });
});
