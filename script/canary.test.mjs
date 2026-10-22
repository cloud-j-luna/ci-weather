import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { stringify as stringifyYaml } from "yaml";
import { check } from "./validate-runs.mjs";
import { runScenario } from "./lib/run.mjs";
import { fakeAkt, verbs } from "./fixtures/fake-akt.mjs";

const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

describe("canary run, end to end against a fake akt and a real server", () => {
  let server;
  let dir;
  let uri;

  before(async () => {
    server = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><body><h1>Welcome to nginx!</h1></body></html>");
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    uri = `127.0.0.1:${server.address().port}`;
    dir = mkdtempSync(join(tmpdir(), "canary-"));
  });

  after(() => server.close());

  const build = (name, opts) => {
    const bin = join(dir, `${name}-akt.mjs`);
    writeFileSync(
      bin,
      fakeAkt({
        statePath: join(dir, `${name}-state.json`),
        argvLog: join(dir, `${name}-argv.log`),
        uri,
        ...opts,
      }),
    );
    chmodSync(bin, 0o755);
    return bin;
  };

  const canary = (args) =>
    run("node", [join(repoRoot, "script/canary.mjs"), ...args], { cwd: repoRoot }).catch((e) => e);

  const onlyRun = (out, scenario) => {
    const dirs = readdirSync(join(out, scenario));
    assert.equal(dirs.length, 1, "a run writes exactly one directory");
    const runDir = join(out, scenario, dirs[0]);
    return { runDir, doc: JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")) };
  };

  const seedOwnership = (out, scenario, runId, doc) => {
    mkdirSync(join(out, scenario, runId), { recursive: true });
    writeFileSync(join(out, scenario, runId, "run.json"), `${JSON.stringify(doc, null, 2)}\n`);
  };

  const aktArgv = (name) =>
    readFileSync(join(dir, `${name}-argv.log`), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));

  const aktCalls = (name) =>
    aktArgv(name).map((a) => (a[0] === "close" ? `close ${a[1]}` : a.slice(0, 3).join(" ")));

  const closedByAkt = (name) =>
    aktArgv(name)
      .filter((a) => a[0] === "close")
      .map((a) => a[1]);

  const activeOnChain = (name) =>
    JSON.parse(readFileSync(join(dir, `${name}-state.json`), "utf8")).active;

  it("deploys, probes over http after https refuses, closes, and writes a valid run", async () => {
    const bin = build("happy", {});
    const out = join(dir, "happy-runs");
    const r = await canary(["run", "--scenario", "web", "--akt", bin, "--out", out]);
    assert.equal(r.code ?? 0, 0, r.stderr ?? "");

    const { runDir, doc } = onlyRun(out, "web");
    assert.deepEqual(check(doc), [], JSON.stringify(check(doc)));
    assert.equal(doc.outcome.kind, "passed");
    assert.equal(doc.escrow.kind, "returned");
    assert.equal(doc.lease.probe.servedBy, "http");
    assert.equal(doc.lease.bidCount, 3);
    assert.equal(doc.lease.providerRegion, "na-us-west");
    assert.equal(doc.akt.version, "1.0.1");
    assert.ok(!doc.steps.some((s) => s.step === "display-result"));
    assert.ok(doc.steps.every((s) => s.durationMs >= 0));
    const bids = doc.steps.find((s) => s.step === "wait-for-bids");
    const create = doc.steps.find((s) => s.step === "create-deployment");
    assert.equal(bids.durationSource, "akt-log");
    assert.ok(
      bids.durationMs > create.durationMs,
      "the slow step must carry the time, not the first one",
    );
    assert.equal(doc.steps.find((s) => s.step === "wait-for-ready").durationSource, "derived");
    assert.equal(doc.steps.at(-1).durationSource, "runner");

    for (const f of ["deploy.jsonl", "deploy.stderr.log", "close.jsonl", "cost.json"]) {
      assert.ok(existsSync(join(runDir, f)), `${f} sidecar is missing`);
    }
    assert.equal(readFileSync(join(runDir, "deploy.jsonl"), "utf8").trim().split("\n").length, 7);

    const argv = readFileSync(join(dir, "happy-argv.log"), "utf8");
    assert.match(argv, /"--bid-select","(cheapest|provider=akash1[a-z0-9]{38})"/);
    assert.doesNotMatch(argv, /"--bid-select","interactive"/, "akt must never block on stdin");
    assert.match(argv, /"--context","sandbox-2"/, "every akt call names its context");
    assert.match(
      argv,
      /"--deposit","1000000uact"/,
      "the deposit akt is handed is the one the scenario config resolved, never akt's own default",
    );
  });

  it("the claim lands on disk before the probe ever dials the deployment", async () => {
    const out = join(dir, "claim-timing-runs");
    let claimedBeforeProbe = false;
    const probeServer = createServer((req, res) => {
      claimedBeforeProbe =
        existsSync(join(out, "web")) &&
        readdirSync(join(out, "web")).some((runId) =>
          existsSync(join(out, "web", runId, "claims.jsonl")),
        );
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><body><h1>Welcome to nginx!</h1></body></html>");
    });
    await new Promise((r) => probeServer.listen(0, "127.0.0.1", r));
    try {
      const probeUri = `127.0.0.1:${probeServer.address().port}`;
      const bin = build("claim-timing", { uri: probeUri });
      const r = await canary(["run", "--scenario", "web", "--akt", bin, "--out", out]);
      assert.equal(r.code ?? 0, 0, r.stderr ?? "");
    } finally {
      probeServer.close();
    }

    assert.ok(
      claimedBeforeProbe,
      "claims.jsonl must already be on disk by the time the probe dials the deployment, so a kill during the probe still leaves ownership proven",
    );
  });

  it("--scenario ip-lease fails at http-probe when no dedicated IP was allocated, and never dials the shared ingress", async () => {
    const bin = build("ip-none", {});
    const out = join(dir, "ip-none-runs");
    const r = await canary(["run", "--scenario", "ip-lease", "--akt", bin, "--out", out]);
    assert.equal(r.code, 1, r.stderr ?? "");

    const { doc } = onlyRun(out, "ip-lease");
    assert.deepEqual(check(doc), [], JSON.stringify(check(doc)));
    assert.equal(doc.outcome.kind, "failed");
    assert.equal(doc.outcome.atStep, "http-probe");
    assert.match(doc.outcome.message, /no dedicated IP/);
    assert.equal(doc.lease.ips, undefined);
    assert.deepEqual(doc.lease.probe.attempts, []);

    const argv = aktArgv("ip-none");
    assert.ok(
      argv.some(
        (a) =>
          a[0] === "provider" &&
          a[1] === "lease-status" &&
          a[2] === doc.lease.dseq &&
          a.includes("--context"),
      ),
      "provider lease-status must be invoked with the dseq positionally",
    );
  });

  it("--scenario ip-lease passes when a dedicated IP was allocated, probing it instead of the shared ingress", async () => {
    const bin = build("ip-real", {
      handlers: {
        "provider lease-status": verbs.leaseStatus({ ip: true }),
        deploy: verbs.deploy({ ingress: "ingress.invalid.test" }),
      },
    });
    const out = join(dir, "ip-real-runs");
    const r = await canary(["run", "--scenario", "ip-lease", "--akt", bin, "--out", out]);
    assert.equal(r.code ?? 0, 0, r.stderr ?? "");

    const { doc } = onlyRun(out, "ip-lease");
    assert.deepEqual(check(doc), [], JSON.stringify(check(doc)));
    assert.equal(doc.outcome.kind, "passed");
    assert.deepEqual(doc.lease.ips, [
      { ip: "127.0.0.1", port: 80, externalPort: Number(uri.split(":")[1]), protocol: "TCP" },
    ]);
    assert.deepEqual(
      doc.lease.uris,
      ["ingress.invalid.test"],
      "the shared ingress hostname this run must not dial does not resolve, so a pass can only mean the IP was probed",
    );
    assert.doesNotMatch(doc.lease.probe.url, /ingress\.invalid\.test/);
    assert.equal(doc.lease.probe.url, `http://${uri}/`);
  });

  it("--scenario tee-snp-gpu passes when the attestation report verifies, recorded on the lease with an attestation step before http-probe", async () => {
    const bin = build("tee-ok", {});
    const out = join(dir, "tee-ok-runs");
    const r = await canary(["run", "--scenario", "tee-snp-gpu", "--akt", bin, "--out", out]);
    assert.equal(r.code ?? 0, 0, r.stderr ?? "");

    const { doc } = onlyRun(out, "tee-snp-gpu");
    assert.deepEqual(check(doc), [], JSON.stringify(check(doc)));
    assert.equal(doc.outcome.kind, "passed");
    assert.deepEqual(doc.lease.attestation, {
      teeType: "snp-gpu",
      nonceVerified: true,
      mockReport: false,
      certChainPresent: false,
      gpuReportCount: 1,
      reportSizeBytes: 1184,
    });
    assert.deepEqual(doc.steps.map((s) => s.step).slice(-2), ["attestation", "http-probe"]);
    assert.equal(doc.steps.at(-1).result, "completed");
  });

  it("--scenario tee-snp-gpu records a completed attestation and fails at http-probe when the attestation verifies but the workload never serves", async () => {
    const bin = build("tee-dead-ingress", {
      handlers: { deploy: verbs.deploy({ ingress: "ingress.invalid.test" }) },
    });
    const out = join(dir, "tee-dead-ingress-runs");
    // --probe-timeout 1s: the hostname does not resolve, so the probe can only ever
    // exhaust its budget, and tee-snp-gpu's real budget is 3m. Left at the registry
    // value this one test spent 182s of the suite's 247s waiting for DNS to keep
    // failing, which proves nothing this assertion does not already prove in a second.
    const r = await canary([
      "run",
      "--scenario",
      "tee-snp-gpu",
      "--akt",
      bin,
      "--out",
      out,
      "--probe-timeout",
      "1s",
    ]);
    assert.equal(r.code, 1, r.stderr ?? "");

    const { doc } = onlyRun(out, "tee-snp-gpu");
    assert.deepEqual(check(doc), [], JSON.stringify(check(doc)));
    assert.equal(doc.outcome.kind, "failed");
    assert.equal(doc.outcome.atStep, "http-probe");
    // The flag reached the probe. Asserted on recorded attempts rather than on elapsed
    // time: a budget silently ignored shows up here as the ~150 attempts 3m produces.
    assert.ok(
      doc.lease.probe.attempts.length < 20,
      `--probe-timeout was ignored, the probe made ${doc.lease.probe.attempts.length} attempts`,
    );
    const attestationStep = doc.steps.find((s) => s.step === "attestation");
    assert.equal(attestationStep.result, "completed");
    assert.deepEqual(doc.lease.attestation, {
      teeType: "snp-gpu",
      nonceVerified: true,
      mockReport: false,
      certChainPresent: false,
      gpuReportCount: 1,
      reportSizeBytes: 1184,
    });
  });

  it("--scenario tee-snp-gpu fails at attestation when mock_report is true, naming the mock and still recording the report", async () => {
    const bin = build("tee-mock", {
      handlers: { "provider lease-attestation": verbs.leaseAttestation({ mockReport: true }) },
    });
    const out = join(dir, "tee-mock-runs");
    const r = await canary(["run", "--scenario", "tee-snp-gpu", "--akt", bin, "--out", out]);
    assert.equal(r.code, 1, r.stderr ?? "");

    const { doc } = onlyRun(out, "tee-snp-gpu");
    assert.deepEqual(check(doc), [], JSON.stringify(check(doc)));
    assert.equal(doc.outcome.kind, "failed");
    assert.equal(doc.outcome.atStep, "attestation");
    assert.match(doc.outcome.message, /mock attestation report/);
    assert.equal(doc.lease.attestation.mockReport, true);
  });

  it("--scenario tee-snp-gpu fails at attestation when nonce_verified is false", async () => {
    const bin = build("tee-nonce", {
      handlers: { "provider lease-attestation": verbs.leaseAttestation({ nonceVerified: false }) },
    });
    const out = join(dir, "tee-nonce-runs");
    const r = await canary(["run", "--scenario", "tee-snp-gpu", "--akt", bin, "--out", out]);
    assert.equal(r.code, 1, r.stderr ?? "");

    const { doc } = onlyRun(out, "tee-snp-gpu");
    assert.deepEqual(check(doc), [], JSON.stringify(check(doc)));
    assert.equal(doc.outcome.kind, "failed");
    assert.equal(doc.outcome.atStep, "attestation");
    assert.match(doc.outcome.message, /did not echo akt's challenge nonce/);
  });

  it("--scenario tee-snp-gpu fails at attestation when the platform is snp against the expected snp-gpu, naming both", async () => {
    const bin = build("tee-platform", {
      handlers: { "provider lease-attestation": verbs.leaseAttestation({ platform: "snp" }) },
    });
    const out = join(dir, "tee-platform-runs");
    const r = await canary(["run", "--scenario", "tee-snp-gpu", "--akt", bin, "--out", out]);
    assert.equal(r.code, 1, r.stderr ?? "");

    const { doc } = onlyRun(out, "tee-snp-gpu");
    assert.deepEqual(check(doc), [], JSON.stringify(check(doc)));
    assert.equal(doc.outcome.kind, "failed");
    assert.equal(doc.outcome.atStep, "attestation");
    assert.match(doc.outcome.message, /expected a snp-gpu attestation report, got "snp"/);
  });

  it("--scenario tee-snp-gpu fails at attestation carrying akt's own stderr text verbatim when the command exits non-zero", async () => {
    const bin = build("tee-exit", {
      handlers: { "provider lease-attestation": verbs.leaseAttestation({ fail: true }) },
    });
    const out = join(dir, "tee-exit-runs");
    const r = await canary(["run", "--scenario", "tee-snp-gpu", "--akt", bin, "--out", out]);
    assert.equal(r.code, 1, r.stderr ?? "");

    const { doc } = onlyRun(out, "tee-snp-gpu");
    assert.deepEqual(check(doc), [], JSON.stringify(check(doc)));
    assert.equal(doc.outcome.kind, "failed");
    assert.equal(doc.outcome.atStep, "attestation");
    assert.match(doc.outcome.message, /attestation sidecar unreachable/);
  });

  it("the web scenario never invokes provider lease-attestation, and its run carries no attestation step or lease.attestation", async () => {
    const bin = build("web-no-attest", {});
    const out = join(dir, "web-no-attest-runs");
    const r = await canary(["run", "--scenario", "web", "--akt", bin, "--out", out]);
    assert.equal(r.code ?? 0, 0, r.stderr ?? "");

    const { doc } = onlyRun(out, "web");
    assert.deepEqual(check(doc), [], JSON.stringify(check(doc)));
    assert.ok(
      !aktArgv("web-no-attest").some((a) => a[0] === "provider" && a[1] === "lease-attestation"),
      "a scenario with no attestation block must never run provider lease-attestation",
    );
    assert.ok(!doc.steps.some((s) => s.step === "attestation"));
    assert.equal(doc.lease.attestation, undefined);
  });

  it("the per-scenario deposit override reaches akt's deploy argv", async () => {
    const webBin = build("deposit-web", {});
    const teeBin = build("deposit-tee", {});
    await canary([
      "run",
      "--scenario",
      "web",
      "--akt",
      webBin,
      "--out",
      join(dir, "deposit-web-runs"),
    ]);
    await canary([
      "run",
      "--scenario",
      "tee-snp-gpu",
      "--akt",
      teeBin,
      "--out",
      join(dir, "deposit-tee-runs"),
    ]);

    assert.match(
      readFileSync(join(dir, "deposit-web-argv.log"), "utf8"),
      /"--deposit","1000000uact"/,
    );
    assert.match(
      readFileSync(join(dir, "deposit-tee-argv.log"), "utf8"),
      /"--deposit","2000000uact"/,
    );
  });

  it("attributes a failure to akt's own step and error, never to the exit code", async () => {
    const bin = build("sad", { handlers: { deploy: verbs.deploy({ failAt: "send-manifest" }) } });
    const out = join(dir, "sad-runs");
    await canary(["run", "--scenario", "web", "--akt", bin, "--out", out]);

    const { doc } = onlyRun(out, "web");
    assert.deepEqual(check(doc), []);
    assert.equal(doc.outcome.kind, "failed");
    assert.equal(doc.outcome.atStep, "send-manifest");
    assert.equal(doc.outcome.message, "the fake provider refused the manifest");
    assert.equal(doc.escrow.kind, "returned", "a failed run still gets its deposit back");
    assert.equal(doc.lease.probe, null);
  });

  it("reaps the orphan its run history proves is ours, and leaves the foreign one running", async () => {
    const bin = build("orphan", {});
    writeFileSync(
      join(dir, "orphan-state.json"),
      JSON.stringify({ active: ["5554813", "8888888"], next: 9000001 }),
    );
    const out = join(dir, "orphan-runs");
    seedOwnership(out, "gpu", "20261001T000000Z", {
      schemaVersion: 1,
      scenario: "gpu",
      outcome: { kind: "aborted", reason: "job cancelled (SIGTERM)" },
      escrow: {
        kind: "leaked",
        stillActive: [{ dseq: "8888888", reason: "run cancelled before close could broadcast" }],
      },
      lease: { dseq: "8888888" },
      reap: { closedDseqs: [] },
    });

    await canary(["run", "--scenario", "web", "--akt", bin, "--out", out]);

    const { doc } = onlyRun(out, "web");
    assert.deepEqual(check(doc), []);
    assert.deepEqual(
      doc.reap.closedDseqs,
      ["8888888"],
      "a dseq a committed run leaked is ours across scenarios, and the next run reaps it",
    );
    assert.equal(doc.outcome.kind, "passed");
    assert.ok(
      !closedByAkt("orphan").includes("5554813"),
      "a deployment with no ownership record is foreign, and closing it is the loss this contract exists to prevent",
    );
    assert.deepEqual(
      activeOnChain("orphan"),
      ["5554813"],
      "the foreign deployment is still running on the account after the canary has been and gone",
    );
  });

  it("a run killed after the claim and before the seal leaves a directory the next reap can act on", async () => {
    const bin = build("kill-after-claim", {});
    writeFileSync(
      join(dir, "kill-after-claim-state.json"),
      JSON.stringify({ active: ["5554321"], next: 9000001 }),
    );
    const out = join(dir, "kill-after-claim-runs");
    const claimDir = join(out, "web", "20261012T030000Z");
    mkdirSync(claimDir, { recursive: true });
    writeFileSync(
      join(claimDir, "claims.jsonl"),
      `${JSON.stringify({
        dseq: "5554321",
        scenario: "web",
        network: { name: "sandbox-2", chainId: "sandbox-2" },
        claimedAt: "2026-10-12T03:00:00.000Z",
      })}\n`,
    );

    const r = await canary(["reap", "--akt", bin, "--out", out]);
    assert.equal(r.code ?? 0, 0, r.stderr ?? "");

    assert.deepEqual(
      closedByAkt("kill-after-claim"),
      ["5554321"],
      "the claim alone must be enough ownership evidence for the next reap to close it",
    );
    assert.deepEqual(
      activeOnChain("kill-after-claim"),
      [],
      "nothing is left open on chain once the claim-only directory is reaped",
    );
  });

  it("reap with an empty ownership record closes nothing, however much the account has active", async () => {
    const bin = build("reap", {});
    writeFileSync(
      join(dir, "reap-state.json"),
      JSON.stringify({ active: ["111", "222", "333"], next: 9000001 }),
    );
    const out = join(dir, "reap-runs");
    mkdirSync(out, { recursive: true });

    const r = await canary(["reap", "--akt", bin, "--out", out]);
    assert.equal(r.code ?? 0, 0, r.stderr ?? "");

    assert.deepEqual(aktCalls("reap"), ["query deployment active", "query deployment active"]);
    assert.deepEqual(
      activeOnChain("reap"),
      ["111", "222", "333"],
      "nothing proves these are ours, so reap reports them and walks away",
    );
    assert.match(
      r.stdout,
      /foreign left alone 3/,
      "the operator's report has to name what reap decided not to touch",
    );
  });

  it("reap closes exactly what --adopt names, listing before and after", async () => {
    const bin = build("adopt", {});
    writeFileSync(
      join(dir, "adopt-state.json"),
      JSON.stringify({ active: ["111", "222"], next: 9000001 }),
    );
    const out = join(dir, "adopt-runs");
    mkdirSync(out, { recursive: true });

    const r = await canary(["reap", "--akt", bin, "--out", out, "--adopt", "111"]);
    assert.equal(r.code ?? 0, 0, r.stderr ?? "");

    assert.deepEqual(aktCalls("adopt"), [
      "query deployment active",
      "close 111",
      "query deployment active",
    ]);
    assert.deepEqual(
      activeOnChain("adopt"),
      ["222"],
      "--adopt admits one dseq to the owned set, it does not hand over the rest of the account",
    );
  });

  it("doctor counts what is ours and what is foreign, and closes nothing", async () => {
    const bin = build("doctor", {});
    writeFileSync(
      join(dir, "doctor-state.json"),
      JSON.stringify({ active: ["7777777", "5554813"], next: 9000001 }),
    );
    const out = join(dir, "doctor-runs");
    seedOwnership(out, "web", "20261001T000000Z", {
      schemaVersion: 1,
      scenario: "web",
      outcome: { kind: "passed" },
      escrow: { kind: "returned", closed: [{ dseq: "7777777" }] },
      lease: { dseq: "7777777" },
      reap: { closedDseqs: [] },
    });

    const r = await canary(["doctor", "--akt", bin, "--out", out]);

    assert.equal(r.code ?? 0, 0, "a foreign deployment is somebody else's business, not a failure");
    assert.match(r.stdout, /WARN active deployments\s+1 of ours \(7777777\)/);
    assert.match(
      r.stdout,
      /OK\s+foreign deployments\s+1 \(5554813\), not ours and never closed by this project/,
    );
    assert.deepEqual(closedByAkt("doctor"), [], "doctor only ever reads");
  });

  it("doctor warns about a run that created a deployment and never sealed, naming its dseq", async () => {
    const bin = build("crashed", {});
    writeFileSync(
      join(dir, "crashed-state.json"),
      JSON.stringify({ active: ["6666666"], next: 9000001 }),
    );
    const out = join(dir, "crashed-runs");
    mkdirSync(join(out, "web", "20261012T000000Z"), { recursive: true });
    writeFileSync(
      join(out, "web", "20261012T000000Z", "claims.jsonl"),
      `${JSON.stringify({
        dseq: "6666666",
        scenario: "web",
        network: { name: "sandbox-2", chainId: "sandbox-2" },
        claimedAt: "2026-10-12T00:00:00.000Z",
      })}\n`,
    );

    const r = await canary(["doctor", "--akt", bin, "--out", out]);

    assert.equal(r.code ?? 0, 0, "a recoverable crashed run is not a reason to block the next run");
    assert.match(r.stdout, /WARN crashed runs/);
    assert.match(r.stdout, /web\/20261012T000000Z \(6666666\)/);
    assert.deepEqual(closedByAkt("crashed"), [], "doctor only ever reads");
  });

  it("doctor fails the balance check when the account cannot fund every scenario's deposit", async () => {
    const bin = build("thin", { handlers: { "query bank": verbs.bank({ uact: "1000000" }) } });
    const out = join(dir, "thin-runs");
    mkdirSync(out, { recursive: true });

    const r = await canary(["doctor", "--akt", bin, "--out", out]);

    assert.equal(r.code, 1, r.stdout);
    const failLine = r.stdout.split("\n").find((l) => /^FAIL\s+balance uact/.test(l));
    assert.ok(failLine, `no "FAIL balance uact" line in:\n${r.stdout}`);
    for (const id of ["web", "gpu", "persistent-storage", "ip-lease", "tee-snp-gpu"]) {
      assert.match(failLine, new RegExp(id));
    }
  });
});

describe("retrying a scenario whose pinned provider did not bid", () => {
  let dir;
  let server;
  let uri;

  before(async () => {
    server = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><body><h1>Welcome to nginx!</h1></body></html>");
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    uri = `127.0.0.1:${server.address().port}`;
    dir = mkdtempSync(join(tmpdir(), "retry-"));
  });

  after(() => server.close());

  // A temporary repo so the delay can be 0s. Against the real registry every retry would
  // sit out the 30s account-sequence settle, which is correct in production and useless
  // in a test suite.
  const makeRepo = (budgets = {}) => {
    const root = mkdtempSync(join(dir, "repo-"));
    mkdirSync(join(root, "scenarios", "sdl"), { recursive: true });
    writeFileSync(join(root, "scenarios", "sdl", "web.yaml"), "");
    writeFileSync(
      join(root, "scenarios", "scenarios.yaml"),
      stringifyYaml({
        budgets: {
          bidTimeout: "1s",
          leaseReadyTimeout: "1s",
          probeTimeout: "1s",
          totalRunTimeout: "30m",
          deposit: "1000000uact",
          bidAttempts: 3,
          bidRetryDelay: "0s",
          ...budgets,
        },
        scenarios: [
          {
            id: "web",
            title: "Web service",
            sdl: "sdl/web.yaml",
            probe: { path: "/", expectStatus: 200, expectBodyContains: "Welcome to nginx!" },
          },
        ],
      }),
    );
    return root;
  };

  const build = (name, opts) => {
    const bin = join(dir, `${name}-akt.mjs`);
    writeFileSync(
      bin,
      fakeAkt({
        statePath: join(dir, `${name}-state.json`),
        argvLog: join(dir, `${name}-argv.log`),
        uri,
        ...opts,
      }),
    );
    chmodSync(bin, 0o755);
    return bin;
  };

  const deploy = async (name, { budgets = {}, ...opts } = {}) => {
    const bin = build(name, opts);
    const outRoot = join(dir, `${name}-runs`);
    const doc = await runScenario({
      bin,
      contextName: "sandbox-2",
      scenarioId: "web",
      repoRoot: makeRepo(budgets),
      outRoot,
      env: {},
    });
    const closes = readFileSync(join(dir, `${name}-argv.log`), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .filter((a) => a[0] === "close")
      .map((a) => a[1]);
    const active = JSON.parse(readFileSync(join(dir, `${name}-state.json`), "utf8")).active;
    const runDir = join(outRoot, "web", readdirSync(join(outRoot, "web"))[0]);
    return { doc, closes, active, runDir };
  };

  it("closes the deployment of every failed attempt, so three attempts leak nothing", async () => {
    const { doc, closes, active, runDir } = await deploy("three", {
      handlers: { deploy: verbs.deploy({ bidFailures: 9 }) },
    });

    assert.deepEqual(check(doc), [], JSON.stringify(check(doc)));
    assert.equal(closes.length, 3, "one close per attempt, or a deposit is abandoned on chain");
    assert.equal(new Set(closes).size, 3, "each attempt created its own deployment");
    assert.deepEqual(active, [], "nothing of ours may be left holding escrow");
    assert.deepEqual(doc.escrow.closed.map((c) => c.dseq).sort(), [...closes].sort());
    assert.equal(doc.escrow.kind, "returned");

    assert.equal(doc.attempts.count, 3);
    assert.equal(doc.attempts.earlier.length, 2);
    assert.equal(doc.attempts.stoppedBecause, "attempts-exhausted");
    assert.equal(doc.outcome.atStep, "wait-for-bids");

    const claims = readFileSync(join(runDir, "claims.jsonl"), "utf8").trim().split("\n");
    assert.equal(claims.length, 3, "every attempt claims its dseq before anything else happens");
    assert.deepEqual(
      claims.map((l) => JSON.parse(l).dseq).sort(),
      [...closes].sort(),
      "a claimed dseq that was never closed is the leak this whole feature risks",
    );
  });

  it("passes on the second attempt and still accounts for the first attempt's deposit", async () => {
    const { doc, closes, active } = await deploy("second", {
      handlers: { deploy: verbs.deploy({ bidFailures: 1 }) },
    });

    assert.deepEqual(check(doc), [], JSON.stringify(check(doc)));
    assert.equal(doc.outcome.kind, "passed");
    assert.equal(doc.attempts.count, 2);
    assert.equal(doc.attempts.stoppedBecause, undefined);
    assert.equal(doc.attempts.earlier.length, 1);
    assert.equal(doc.attempts.earlier[0].atStep, "wait-for-bids");
    assert.equal(doc.attempts.earlier[0].bidCount, 0, "nobody bid is the supply signal itself");
    assert.ok(doc.escrow.closed.some((c) => c.dseq === doc.attempts.earlier[0].dseq));
    assert.equal(closes.length, 2);
    assert.deepEqual(active, []);
  });

  it("retries a select-bid failure, where others bid but the pinned provider did not", async () => {
    const { doc } = await deploy("select", {
      handlers: { deploy: verbs.deploy({ bidFailures: 1, bidFailStep: "select-bid" }) },
    });

    assert.deepEqual(check(doc), [], JSON.stringify(check(doc)));
    assert.equal(doc.outcome.kind, "passed");
    assert.equal(doc.attempts.earlier[0].atStep, "select-bid");
    assert.equal(
      doc.attempts.earlier[0].bidCount,
      2,
      "the depth others bid at is the difference between a full provider and an empty market",
    );
  });

  it("never retries a failure that is a real result about Akash rather than about supply", async () => {
    const { doc, closes, active } = await deploy("manifest", {
      handlers: { deploy: verbs.deploy({ failAt: "send-manifest" }) },
    });

    assert.deepEqual(check(doc), [], JSON.stringify(check(doc)));
    assert.equal(doc.outcome.atStep, "send-manifest");
    assert.equal(doc.attempts.count, 1);
    assert.equal(doc.attempts.earlier, undefined);
    assert.equal(doc.attempts.stoppedBecause, undefined);
    assert.equal(closes.length, 1);
    assert.deepEqual(active, []);
  });

  it("does not start an attempt the wall clock cannot finish, reporting an honest failure instead of an abort", async () => {
    const { doc, closes, active } = await deploy("clock", {
      handlers: { deploy: verbs.deploy({ bidFailures: 9 }) },
      budgets: { totalRunTimeout: "2m" },
    });

    assert.deepEqual(check(doc), [], JSON.stringify(check(doc)));
    assert.equal(doc.attempts.count, 1, "the reservation covers the whole remaining lifecycle");
    assert.equal(doc.attempts.stoppedBecause, "time-budget");
    assert.equal(
      doc.outcome.kind,
      "failed",
      "an abort is excluded from both sides of the pass rate, so it is worse than an honest failure",
    );
    assert.equal(closes.length, 1);
    assert.deepEqual(active, []);
  });

  it("honours a per-scenario bidAttempts of 1 by never retrying", async () => {
    const { doc, closes } = await deploy("once", {
      handlers: { deploy: verbs.deploy({ bidFailures: 9 }) },
      budgets: { bidAttempts: 1 },
    });

    assert.deepEqual(check(doc), [], JSON.stringify(check(doc)));
    assert.equal(doc.attempts.count, 1);
    assert.equal(doc.attempts.stoppedBecause, "attempts-exhausted");
    assert.equal(closes.length, 1);
  });
});

describe("the gpu-check step", () => {
  let dir;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "gpu-check-"));
  });

  const makeRepo = ({ gpuCheck } = {}) => {
    const root = mkdtempSync(join(dir, "repo-"));
    mkdirSync(join(root, "scenarios", "sdl"), { recursive: true });
    writeFileSync(join(root, "scenarios", "sdl", "web.yaml"), "");
    const scenario = {
      id: "web",
      title: "Web service",
      sdl: "sdl/web.yaml",
      probe: { path: "/", expectStatus: 200, expectBodyContains: "Welcome to nginx!" },
    };
    if (gpuCheck !== undefined) scenario.gpuCheck = gpuCheck;
    writeFileSync(
      join(root, "scenarios", "scenarios.yaml"),
      stringifyYaml({
        budgets: {
          bidTimeout: "1s",
          leaseReadyTimeout: "1s",
          probeTimeout: "1s",
          totalRunTimeout: "30m",
          deposit: "1000000uact",
        },
        scenarios: [scenario],
      }),
    );
    return root;
  };

  const routingServer = (gpu = {}) => {
    const requests = [];
    const server = createServer((req, res) => {
      requests.push(req.url);
      if (req.url === "/gpu.csv") {
        res.writeHead(gpu.status ?? 200, { "content-type": "text/plain" });
        res.end(gpu.body ?? "");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><body><h1>Welcome to nginx!</h1></body></html>");
    });
    return { server, requests };
  };

  const deploy = async (name, { gpuCheck, gpu, ...opts } = {}) => {
    const { server, requests } = routingServer(gpu);
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    try {
      const uri = `127.0.0.1:${server.address().port}`;
      const bin = join(dir, `${name}-akt.mjs`);
      writeFileSync(
        bin,
        fakeAkt({
          statePath: join(dir, `${name}-state.json`),
          argvLog: join(dir, `${name}-argv.log`),
          uri,
          ...opts,
        }),
      );
      chmodSync(bin, 0o755);
      const outRoot = join(dir, `${name}-runs`);
      const doc = await runScenario({
        bin,
        contextName: "sandbox-2",
        scenarioId: "web",
        repoRoot: makeRepo({ gpuCheck }),
        outRoot,
        env: {},
      });
      const runDir = join(outRoot, "web", readdirSync(join(outRoot, "web"))[0]);
      return { doc, runDir, requests };
    } finally {
      server.close();
    }
  };

  const twoDeviceCsv = [
    "NVIDIA A100-SXM4-80GB, 535.183.01, 81920 MiB, 8.0",
    "NVIDIA A100-SXM4-80GB, 535.183.01, 81920 MiB, 8.0",
  ].join("\n");

  it("a clean two-device CSV passes, records both devices on lease.gpu with deviceCount 2, and the gpu-check step is last and completed", async () => {
    const { doc } = await deploy("clean", {
      gpuCheck: { path: "/gpu.csv" },
      gpu: { body: twoDeviceCsv },
    });

    assert.deepEqual(check(doc), [], JSON.stringify(check(doc)));
    assert.equal(doc.outcome.kind, "passed");
    assert.equal(doc.lease.gpu.deviceCount, 2);
    assert.equal(doc.lease.gpu.devices.length, 2);
    assert.equal(doc.steps.at(-1).step, "gpu-check");
    assert.equal(doc.steps.at(-1).result, "completed");
  });

  it("the gpu-check.csv sidecar exists in the run directory and holds the raw body verbatim", async () => {
    const { runDir } = await deploy("sidecar", {
      gpuCheck: { path: "/gpu.csv" },
      gpu: { body: twoDeviceCsv },
    });

    assert.equal(readFileSync(join(runDir, "gpu-check.csv"), "utf8"), twoDeviceCsv);
  });

  it("run.json contains no raw CSV anywhere", async () => {
    const { runDir } = await deploy("noraw", {
      gpuCheck: { path: "/gpu.csv" },
      gpu: { body: twoDeviceCsv },
    });

    const raw = readFileSync(join(runDir, "run.json"), "utf8");
    // driverVersion, name and computeCapability are intentionally kept verbatim in the
    // parsed record, so they are not a useful raw-vs-parsed marker. The MiB unit suffix
    // is: nvidia-smi writes it in the raw line, but the schema carries memoryTotalMiB as
    // a bare integer, so "81920 MiB" can only have come from the raw body.
    assert.ok(!raw.includes(twoDeviceCsv), "the raw CSV body must never be embedded verbatim");
    assert.doesNotMatch(raw, /81920 MiB/);
  });

  it("a 404 on /gpu.csv fails the run at gpu-check", async () => {
    const { doc } = await deploy("notfound", {
      gpuCheck: { path: "/gpu.csv" },
      gpu: { status: 404, body: "not found" },
    });

    assert.deepEqual(check(doc), [], JSON.stringify(check(doc)));
    assert.equal(doc.outcome.kind, "failed");
    assert.equal(doc.outcome.atStep, "gpu-check");
    assert.match(doc.outcome.message, /answered 404, not 200/);
  });

  it("a body that is not CSV fails at gpu-check with that text quoted in outcome.message", async () => {
    const { doc } = await deploy("notcsv", {
      gpuCheck: { path: "/gpu.csv" },
      gpu: { body: "sh: nvidia-smi: command not found" },
    });

    assert.deepEqual(check(doc), [], JSON.stringify(check(doc)));
    assert.equal(doc.outcome.kind, "failed");
    assert.equal(doc.outcome.atStep, "gpu-check");
    assert.match(doc.outcome.message, /command not found/);
  });

  it("a header-row-only body fails at gpu-check, the false green", async () => {
    const { doc } = await deploy("header", {
      gpuCheck: { path: "/gpu.csv" },
      gpu: { body: "name, driver_version, memory.total [MiB], compute_cap" },
    });

    assert.deepEqual(check(doc), [], JSON.stringify(check(doc)));
    assert.equal(doc.outcome.kind, "failed");
    assert.equal(doc.outcome.atStep, "gpu-check");
  });

  it("an empty body fails at gpu-check", async () => {
    const { doc } = await deploy("empty", {
      gpuCheck: { path: "/gpu.csv" },
      gpu: { body: "" },
    });

    assert.deepEqual(check(doc), [], JSON.stringify(check(doc)));
    assert.equal(doc.outcome.kind, "failed");
    assert.equal(doc.outcome.atStep, "gpu-check");
    assert.match(doc.outcome.message, /is empty/);
  });

  it("a scenario with no gpuCheck block never requests /gpu.csv, and its run has no gpu-check step and no lease.gpu", async () => {
    const { doc, requests } = await deploy("nogpu", {});

    assert.deepEqual(check(doc), [], JSON.stringify(check(doc)));
    assert.ok(!requests.includes("/gpu.csv"));
    assert.ok(!doc.steps.some((s) => s.step === "gpu-check"));
    assert.equal(doc.lease.gpu, undefined);
  });

  it("the real gpu scenario's own gpuCheck wiring in scenarios.yaml reaches the fetch", async () => {
    const requests = [];
    const server = createServer((req, res) => {
      requests.push(req.url);
      if (req.url === "/gpu.csv") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("NVIDIA A100-SXM4-80GB, 535.183.01, 81920 MiB, 8.0");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end("cuda True NVIDIA A100-SXM4-80GB");
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    try {
      const uri = `127.0.0.1:${server.address().port}`;
      const bin = join(dir, "real-gpu-akt.mjs");
      writeFileSync(
        bin,
        fakeAkt({
          statePath: join(dir, "real-gpu-state.json"),
          argvLog: join(dir, "real-gpu-argv.log"),
          uri,
        }),
      );
      chmodSync(bin, 0o755);
      const outRoot = join(dir, "real-gpu-runs");
      const doc = await runScenario({
        bin,
        contextName: "sandbox-2",
        scenarioId: "gpu",
        repoRoot,
        outRoot,
        env: {},
      });

      assert.deepEqual(check(doc), [], JSON.stringify(check(doc)));
      assert.equal(doc.outcome.kind, "passed");
      assert.equal(doc.lease.gpu.deviceCount, 1);
      assert.ok(
        requests.includes("/gpu.csv"),
        "scenarios.yaml's own gpuCheck.path must reach the fetch",
      );
    } finally {
      server.close();
    }
  });
});
