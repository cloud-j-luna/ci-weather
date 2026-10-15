import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { check } from "../validate-runs.mjs";
import {
  accountAddress,
  balances,
  contexts,
  deployStream,
  leaseAttestation,
  leaseStatus,
  version as aktVersion,
  workflowLog,
} from "./akt.mjs";
import { LIFECYCLE, SUPPLY_STEPS, applyTimings, mapStream } from "./steps.mjs";
import { probe } from "./probe.mjs";
import { fetchGpuReport, gpuFailure } from "./gpu.mjs";
import { toZero } from "./tozero.mjs";
import { bidSelectFor, loadConfig, scenario as findScenario } from "./config.mjs";
import { ownedDseqs } from "./owned.mjs";

const PROBE_STEP = "http-probe";
const ATTESTATION_STEP = "attestation";
const GPU_CHECK_STEP = "gpu-check";

// On top of the bid and ready timeouts a retry has to cover: the three transactions an
// attempt broadcasts, and the settle poll of the close that follows it. Enough that a
// retry the runner chooses to start can actually finish inside the wall-clock budget.
const RETRY_MARGIN_MS = 120000;

const iso = (ms) => new Date(ms).toISOString();

function abortableSleep(ms, signal) {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

export function basicStamp(ms) {
  return new Date(ms)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

function ciBlock(env) {
  if (!env.GITHUB_RUN_ID || !env.GITHUB_REPOSITORY) return undefined;
  const server = env.GITHUB_SERVER_URL ?? "https://github.com";
  const out = { runUrl: `${server}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` };
  if (env.GITHUB_SHA) out.sha = env.GITHUB_SHA;
  const attempt = Number.parseInt(env.GITHUB_RUN_ATTEMPT ?? "", 10);
  if (Number.isInteger(attempt) && attempt >= 1) out.attempt = attempt;
  return out;
}

function probeFailure(state) {
  if (state.probeError) return state.probeError;
  const attempts = state.probe?.attempts ?? [];
  if (!attempts.length) return "no URI to probe";

  // Every attempt listed verbatim produced the same two outcomes repeated seventeen
  // times each, which buries the one fact a reader needs. Group by what happened and
  // count, so the message says how the workload failed rather than how often we asked.
  const tally = new Map();
  for (const a of attempts) {
    const what = a.error ? `${a.scheme} ${a.error}` : `${a.scheme} returned ${a.status}`;
    tally.set(what, (tally.get(what) ?? 0) + 1);
  }
  const parts = [...tally].map(([what, n]) => (n > 1 ? `${what} (x${n})` : what));
  const spanMs = attempts.at(-1)?.durationMs !== undefined ? attemptSpanMs(attempts) : undefined;
  const over = spanMs === undefined ? "" : ` over ${Math.round(spanMs / 1000)}s`;
  return `no scheme served the workload after ${attempts.length} attempts${over}: ${parts.join("; ")}`;
}

function attemptSpanMs(attempts) {
  const times = attempts.map((a) => Date.parse(a.at)).filter((n) => Number.isFinite(n));
  if (times.length < 2) return undefined;
  return Math.max(...times) - Math.min(...times) + (attempts.at(-1).durationMs ?? 0);
}

const ATTESTATION_CHECKS = [
  {
    bad: (a) => !a,
    message: () => "akt returned no attestation report",
  },
  {
    bad: (a) => a.mockReport !== false,
    message: () =>
      "the provider returned a mock attestation report, which echoes the nonce with no TEE hardware behind it",
  },
  {
    bad: (a) => a.nonceVerified !== true,
    message: () =>
      "the attestation report did not echo akt's challenge nonce, so it cannot be tied to this request",
  },
  {
    bad: (a, expect) => a.teeType !== expect,
    message: (a, expect) =>
      `expected a ${expect} attestation report, got ${JSON.stringify(a.teeType)}`,
  },
];

/**
 * A mock report echoes the nonce with no TEE hardware behind it, so mockReport and
 * nonceVerified are checked with !== false / !== true: an absent or non-boolean field
 * must fail, never be read as false.
 */
export function attestationFailure(attestation, expectTeeType) {
  for (const check of ATTESTATION_CHECKS) {
    if (check.bad(attestation, expectTeeType)) return check.message(attestation, expectTeeType);
  }
  return null;
}

/**
 * Whether to deploy again after a failed attempt, and if not, what to tell the reader.
 * Pure so every rule can be table-tested without a chain, a provider or a clock.
 *
 * Rule 4 is not paranoia. Reaching a wait-for-bids or select-bid failure means
 * create-deployment already completed, so a deployment exists on chain and we merely
 * failed to harvest its dseq. Retrying would add a second one nobody can close.
 */
export function retryDecision({ failure, dseq, attemptsMade, maxAttempts, remainingMs, needMs }) {
  const stop = (stoppedBecause) => ({ retry: false, stoppedBecause });
  if (!failure || !SUPPLY_STEPS.has(failure.step)) return stop(null);
  if (attemptsMade >= maxAttempts) return stop("attempts-exhausted");
  if (remainingMs < needMs) return stop("time-budget");
  if (!dseq) return stop("cleanup-not-proven");
  return { retry: true, stoppedBecause: null };
}

export function probeTarget(target, uris, status) {
  if (target !== "ip") return { hosts: uris };
  if (status.error !== undefined) {
    return {
      error: `the lease status that reports the dedicated IP could not be read: ${status.error}`,
    };
  }
  if (status.ips.length === 0) {
    return {
      error:
        "the lease reported no dedicated IP, so there was nothing to probe but the provider's shared ingress hostname, which answers for every deployment",
    };
  }
  return { hosts: status.ips.map((e) => `${e.ip}:${e.externalPort}`) };
}

/**
 * The verdict is computed once, here, and never recomputed by a reader. Pure so every
 * sealing rule can be table-tested without a chain, a provider or a clock.
 */
export function sealRun(state) {
  const steps = state.steps.map((s) => ({ ...s }));

  if (state.attestationStartedAtMs !== undefined) {
    const failure =
      state.attestationError ?? attestationFailure(state.attestation, state.attestationExpect);
    const step = {
      step: ATTESTATION_STEP,
      result: failure ? "failed" : "completed",
      startedAt: iso(state.attestationStartedAtMs),
      durationMs: Math.max(
        0,
        Math.round(state.attestationFinishedAtMs - state.attestationStartedAtMs),
      ),
      durationSource: "runner",
    };
    if (failure) step.errors = [failure];
    steps.push(step);
  }

  if (state.probe !== undefined) {
    const ok = Boolean(state.probe?.servedBy);
    const step = {
      step: PROBE_STEP,
      result: ok ? "completed" : "failed",
      startedAt: iso(state.probeStartedAtMs),
      durationMs: Math.max(0, Math.round(state.probeFinishedAtMs - state.probeStartedAtMs)),
      durationSource: "runner",
    };
    if (!ok) step.errors = [probeFailure(state)];
    steps.push(step);
  }

  if (state.gpuCheckStartedAtMs !== undefined) {
    const failure = gpuFailure(state.gpu);
    const step = {
      step: GPU_CHECK_STEP,
      result: failure ? "failed" : "completed",
      startedAt: iso(state.gpuCheckStartedAtMs),
      durationMs: Math.max(0, Math.round(state.gpuCheckFinishedAtMs - state.gpuCheckStartedAtMs)),
      durationSource: "runner",
    };
    if (failure) step.errors = [failure];
    steps.push(step);
  }

  if (state.abortReason) {
    const seen = new Set(steps.map((s) => s.step));
    for (const name of LIFECYCLE) {
      if (seen.has(name)) continue;
      // A cancelled web run never planned to attest or gpu-check, so recording a skipped
      // step for either here would put a step in the file that was never part of its
      // lifecycle.
      if (name === ATTESTATION_STEP && state.attestationExpect === undefined) continue;
      if (name === GPU_CHECK_STEP && state.gpuCheckPath === undefined) continue;
      steps.push({
        step: name,
        result: "skipped",
        startedAt: iso(state.finishedAtMs),
        durationMs: 0,
        durationSource: "runner",
      });
    }
  }

  const failed = steps.find((s) => s.result === "failed");
  let outcome;
  if (state.abortReason) outcome = { kind: "aborted", reason: state.abortReason };
  else if (failed) {
    // akt has reported a failed step with an empty errors list. Leaving message
    // undefined fails the schema, and writeRun throws, which loses the entire run
    // file including the dseq. A thin message beats no record.
    const message =
      (failed.errors ?? [])[0] ?? `akt reported ${failed.step} failed without an error message`;
    outcome = { kind: "failed", atStep: failed.step, message };
  } else outcome = { kind: "passed" };

  const closed = [];
  const addClosed = (c) => {
    if (!closed.some((x) => x.dseq === c.dseq)) closed.push({ ...c });
  };
  for (const c of state.closedBetweenAttempts ?? []) addClosed(c);
  for (const c of state.epilogue?.closed ?? []) addClosed(c);
  const stillActive = (state.epilogue?.stillActive ?? []).map((s) => ({ ...s }));

  // A deployment we created that is neither closed by us nor still listed was closed by
  // something else. The escrow is back either way, so recording it as closed is the truth.
  // Every attempt is checked rather than only the last, because a retrying run funds a
  // deposit per attempt: one the chain reclaimed on its own would otherwise appear in
  // neither list, which the contract reads as a deposit this run walked away from.
  const createdDseqs = state.createdDseqs ?? (state.lease?.dseq ? [state.lease.dseq] : []);
  for (const dseq of createdDseqs) {
    if (!closed.some((c) => c.dseq === dseq) && !stillActive.some((s) => s.dseq === dseq)) {
      closed.push({ dseq });
    }
  }

  const escrow = {
    kind: stillActive.length ? "leaked" : closed.length ? "returned" : "nothing-created",
  };
  if (closed.length) escrow.closed = closed;
  if (stillActive.length) escrow.stillActive = stillActive;

  const doc = {
    schemaVersion: 1,
    scenario: state.scenarioId,
    network: state.network,
    startedAt: iso(state.startedAtMs),
    finishedAt: iso(state.finishedAtMs),
    outcome,
    escrow,
    steps,
    lease: state.lease?.dseq ? { ...state.lease, probe: state.probe ?? null } : null,
    reap: state.reap,
  };

  // count stays 0 only if the run died between arming the counter and starting the first
  // attempt. Emitting that would fail the contract and cost the run its file entirely.
  if (state.attempts?.count > 0) {
    const attempts = { count: state.attempts.count };
    if (state.attempts.earlier?.length) {
      attempts.earlier = state.attempts.earlier.map((a) => ({ ...a }));
    }
    if (state.attempts.stoppedBecause) attempts.stoppedBecause = state.attempts.stoppedBecause;
    doc.attempts = attempts;
  }

  const ci = ciBlock(state.env ?? {});
  if (ci) doc.ci = ci;
  doc.akt = { version: state.aktVersion };
  if (state.cost) {
    doc.cost = {
      delta: Object.entries(state.cost).map(([denom, amount]) => ({ denom, amount })),
    };
  }

  return doc;
}

function writeRun(dir, doc, sidecars) {
  const problems = check(doc);
  if (problems.length) {
    throw new Error(
      `the runner built a run document that violates the contract:\n    ${problems.join("\n    ")}\n${JSON.stringify(doc, null, 2)}`,
    );
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "run.json"), `${JSON.stringify(doc, null, 2)}\n`);
  for (const [name, body] of Object.entries(sidecars)) {
    if (body === undefined || body === null) continue;
    writeFileSync(join(dir, name), body);
  }
}

function delta(before, after) {
  const by = (list) => Object.fromEntries((list ?? []).map((b) => [b.denom, BigInt(b.amount)]));
  const a = by(before);
  const b = by(after);
  const out = {};
  for (const denom of new Set([...Object.keys(a), ...Object.keys(b)])) {
    out[denom] = String((b[denom] ?? 0n) - (a[denom] ?? 0n));
  }
  return out;
}

function synthesizedFailure(steps, code, stderr) {
  const done = new Set(steps.map((s) => s.step));
  const next = LIFECYCLE.find((n) => !done.has(n)) ?? LIFECYCLE[0];
  const tail = stderr.trim().split("\n").filter(Boolean).at(-1);
  return {
    step: next,
    result: "failed",
    startedAt: iso(Date.now()),
    durationMs: 0,
    durationSource: "derived",
    errors: [tail || `akt exited ${code} without reporting a failing step`],
  };
}

export async function runScenario({
  bin,
  contextName,
  scenarioId,
  repoRoot,
  outRoot,
  adopt = [],
  env = process.env,
  log = () => {},
}) {
  const config = loadConfig(repoRoot);
  const sc = findScenario(config, scenarioId);
  const budgets = config.budgets;
  const own = new Set([...ownedDseqs(outRoot), ...adopt]);
  const ownNow = () => [...own, ...(state.lease?.dseq ? [state.lease.dseq] : [])];

  const ctx = (await contexts(bin)).find((c) => c.name === contextName);
  if (!ctx) throw new Error(`akt has no context named ${contextName}`);
  const address = await accountAddress(bin, contextName);
  const installed = await aktVersion(bin);

  const startedAtMs = Date.now();
  const dir = join(outRoot, sc.id, basicStamp(startedAtMs));

  const ac = new AbortController();
  let abortReason = null;
  const abortNow = (reason) => {
    if (abortReason) return;
    abortReason = reason;
    log(`abort: ${reason}`);
    ac.abort();
  };
  const onSigint = () => abortNow("job cancelled (SIGINT)");
  const onSigterm = () => abortNow("job cancelled (SIGTERM)");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  const deadline = setTimeout(
    () => abortNow(`wall-clock budget of ${budgets.totalRunTimeout} exhausted`),
    budgets.totalRunTimeoutMs,
  );

  const state = {
    scenarioId: sc.id,
    network: { name: ctx.name, chainId: ctx.chain_id },
    startedAtMs,
    steps: [],
    lease: null,
    probe: undefined,
    attestationExpect: sc.attestation?.teeType,
    gpuCheckPath: sc.gpuCheck?.path,
    reap: { closedDseqs: [] },
    epilogue: null,
    aktVersion: installed,
    env,
  };
  const sidecars = {};
  let closeJsonl = "";

  const claimedDseqs = new Set();
  // Fires the instant akt reports a dseq, before anything else about the deployment is
  // known. A SIGKILL right after this still leaves proof of ownership on disk, so the
  // next run's reaper can close it instead of refusing to touch it forever. mkdirSync
  // runs here because the run directory does not otherwise exist until writeRun at seal
  // time, and this must never throw: it runs inside a readline "line" listener with no
  // try/catch above it, so an uncaught error here would kill the stream and leak the
  // deployment it was meant to protect.
  const recordClaim = (dseq) => {
    if (claimedDseqs.has(dseq)) return;
    claimedDseqs.add(dseq);
    try {
      mkdirSync(dir, { recursive: true });
      const line = JSON.stringify({
        dseq,
        scenario: sc.id,
        network: state.network,
        claimedAt: iso(Date.now()),
      });
      appendFileSync(join(dir, "claims.jsonl"), `${line}\n`);
    } catch (e) {
      log(`failed to record ownership claim for ${dseq}, continuing: ${e.message}`);
    }
  };

  const seal = (reason) => {
    state.abortReason = reason ?? null;
    state.finishedAtMs = Date.now();
    const doc = sealRun(state);
    writeRun(dir, doc, { ...sidecars, "close.jsonl": closeJsonl || undefined });
    log(`wrote ${join(dir, "run.json")}`);
    return doc;
  };

  try {
    log(`reap on ${contextName}, ${own.size} deployment(s) known to be ours`);
    const prologue = await toZero({ bin, context: contextName, own: [...own], log });
    closeJsonl += prologue.jsonl;
    state.reap = { closedDseqs: prologue.closed.map((c) => c.dseq) };
    if (prologue.errors.length) state.reap.errors = prologue.errors;

    if (prologue.stillActive.length) {
      state.epilogue = prologue;
      const names = prologue.stillActive.map((s) => s.dseq).join(", ");
      return seal(`reap did not converge, still active: ${names}`);
    }
    if (abortReason) return seal(abortReason);

    const balanceBefore = await balances(bin, contextName, address);

    const args = [
      "deploy",
      sc.sdlPath,
      "--context",
      contextName,
      "--bid-select",
      bidSelectFor(sc, contextName),
      "--bid-timeout",
      budgets.bidTimeout,
      "--ready-timeout",
      budgets.leaseReadyTimeout,
      "--deposit",
      sc.deposit,
      "--yes",
      "-o",
      "jsonl",
    ];
    log(`deploy ${sc.id}`);

    // These live on state and are mutated in place rather than assigned after the loop.
    // An ordinary exception inside the loop unwinds past any post-loop assignment, and the
    // catch block below still seals a document; reaching it with the dseqs dropped would
    // under-report every deposit the earlier attempts funded.
    state.createdDseqs = [];
    state.closedBetweenAttempts = [];
    state.attempts = { count: 0, earlier: [], stoppedBecause: null };

    const deployJsonl = [];
    const deployStderr = [];
    let heldDseq = null;
    let previous = null;
    let mapped;
    let deployExitedAtMs;

    // A retry has to reserve the whole remaining lifecycle, not just the bid. An attempt
    // that wins the bid still needs create-lease, send-manifest, wait-for-ready and the
    // probe, and running out of clock there seals the run "aborted", which scenarios.yaml
    // excludes from both sides of the pass rate. That trades an honest failure for no data.
    const needMs =
      budgets.bidRetryDelayMs +
      budgets.bidTimeoutMs +
      budgets.leaseReadyTimeoutMs +
      (sc.probeTimeoutMs ?? budgets.probeTimeoutMs) +
      RETRY_MARGIN_MS;

    for (;;) {
      // An attempt becomes "earlier" only once a successor is actually under way. That is
      // what keeps count and earlier from disagreeing when an abort lands in the delay.
      if (previous) state.attempts.earlier.push(previous);
      previous = null;
      state.attempts.count += 1;
      if (state.attempts.count > 1) log(`deploy ${sc.id}, attempt ${state.attempts.count}`);

      const events = [];
      const stdout = [];
      const stderr = [];
      const deployStartedAtMs = Date.now();
      const result = await deployStream(bin, args, {
        signal: ac.signal,
        onEvent: (e) => {
          events.push(e);
          if (e.event?.step) log(`  ${e.event.step} ${e.event.result}`);
          if (e.event?.step === "create-deployment" && e.event.outputs?.dseq !== undefined) {
            recordClaim(String(e.event.outputs.dseq));
          }
        },
        onStdoutChunk: (c) => stdout.push(c),
        onStderrChunk: (c) => stderr.push(c),
      });
      deployExitedAtMs = Date.now();
      deployJsonl.push(Buffer.concat(stdout));
      deployStderr.push(Buffer.concat(stderr));
      sidecars["deploy.jsonl"] = Buffer.concat(deployJsonl);
      sidecars["deploy.stderr.log"] = Buffer.concat(deployStderr);

      mapped = mapStream({ events });
      const workflowId = events.find((e) => e.event?.id)?.event.id;
      const aktLog = workflowId ? await workflowLog(bin, contextName, workflowId) : [];
      // deploy.jsonl accumulates across attempts because jsonl appends, but the action log
      // is one document per akt invocation and steps is timed from the final attempt's.
      if (workflowId) sidecars["deploy.log.json"] = `${JSON.stringify(aktLog, null, 2)}\n`;
      state.steps = applyTimings({
        steps: mapped.steps,
        log: aktLog,
        startedAtMs: deployStartedAtMs,
        exitAtMs: deployExitedAtMs,
      });
      state.lease = mapped.lease.dseq ? mapped.lease : null;
      if (state.lease) {
        state.createdDseqs.push(state.lease.dseq);
        own.add(state.lease.dseq);
        heldDseq = state.lease.dseq;
      }

      if (!abortReason && result.code !== 0 && !mapped.failedStep) {
        state.steps.push(
          synthesizedFailure(state.steps, result.code, Buffer.concat(stderr).toString()),
        );
      }
      if (abortReason) break;

      const decision = retryDecision({
        failure: mapped.failedStep,
        dseq: state.lease?.dseq,
        attemptsMade: state.attempts.count,
        maxAttempts: sc.bidAttempts,
        remainingMs: startedAtMs + budgets.totalRunTimeoutMs - Date.now(),
        needMs,
      });
      if (!decision.retry) {
        state.attempts.stoppedBecause = decision.stoppedBecause;
        break;
      }

      log(`  ${mapped.failedStep.step} was a supply failure, closing ${heldDseq} before retrying`);
      // Deliberately not abortable. A close must finish even past the wall-clock budget,
      // and the CI job timeout is set above that budget to absorb the overrun.
      const cleanup = await toZero({ bin, context: contextName, own: ownNow(), log });
      closeJsonl += cleanup.jsonl;
      for (const c of cleanup.closed) state.closedBetweenAttempts.push(c);
      // tozero's I2: at most one of our deployments is active at a time. Deploying again
      // before this close converged would break it and put a second deposit at risk.
      if (cleanup.stillActive.length) {
        state.attempts.stoppedBecause = "cleanup-not-proven";
        break;
      }
      heldDseq = null;
      if (abortReason) break;

      // This delay is also the account-sequence settle: the close above and the next
      // create-deployment are consecutive broadcasts from one account, which is what
      // tozero's BETWEEN_CLOSES_MS exists to space out.
      await abortableSleep(budgets.bidRetryDelayMs, ac.signal);
      if (abortReason) break;

      previous = {
        atStep: mapped.failedStep.step,
        message:
          mapped.failedStep.errors[0] ??
          `akt reported ${mapped.failedStep.step} failed with no error text`,
        startedAt: iso(deployStartedAtMs),
        durationMs: Math.max(0, Math.round(deployExitedAtMs - deployStartedAtMs)),
        dseq: state.createdDseqs[state.createdDseqs.length - 1],
        ...(mapped.lease.bidCount !== undefined ? { bidCount: mapped.lease.bidCount } : {}),
      };
    }

    if (!abortReason && state.lease && !state.steps.some((s) => s.result === "failed")) {
      let attestationOk = true;

      if (sc.attestation && !abortReason) {
        state.attestationStartedAtMs = deployExitedAtMs;
        try {
          const record = await leaseAttestation(bin, contextName, state.lease.dseq);
          state.attestation = record;
          state.lease.attestation = record;
        } catch (e) {
          state.attestationError = `akt could not attest the lease: ${e.message}`;
        }
        state.attestationFinishedAtMs = Date.now();
        const failure =
          state.attestationError ?? attestationFailure(state.attestation, state.attestationExpect);
        attestationOk = !failure;
        log(`  attestation ${failure ?? `${state.attestation.teeType} report verified`}`);
      }

      if (!abortReason && attestationOk) {
        const status = await leaseStatus(bin, contextName, state.lease.dseq).catch((e) => ({
          error: e.message,
        }));
        if (status.ips?.length) state.lease.ips = status.ips;

        const target = probeTarget(sc.probe.target, state.lease.uris ?? [], status);
        state.probeStartedAtMs = state.attestationFinishedAtMs ?? deployExitedAtMs;
        if (target.error !== undefined) {
          state.probeError = target.error;
          state.probe = { attempts: [] };
        } else {
          // probe reports "no address to probe" as an error field, which lease.probe has
          // no room for. Left attached it fails the contract, and then writeRun throws and
          // the run loses its file entirely. It belongs on the same axis as target.error.
          const { error, ...outcome } = await probe({
            uris: target.hosts,
            path: sc.probe.path,
            expectStatus: sc.probe.expectStatus,
            expectBodyContains: sc.probe.expectBodyContains,
            budgetMs: sc.probeTimeoutMs ?? budgets.probeTimeoutMs,
          });
          if (error !== undefined) state.probeError = error;
          state.probe = outcome;
        }
        state.probeFinishedAtMs = Date.now();
        log(`  http-probe ${state.probeError ?? state.probe.servedBy ?? "no scheme answered"}`);

        // Gated on state.probe?.servedBy: when the probe never found a working scheme
        // there is no origin to reuse, and the run already failed at http-probe.
        if (sc.gpuCheck && !abortReason && state.probe?.servedBy) {
          state.gpuCheckStartedAtMs = state.probeFinishedAtMs;
          // new URL(path, state.probe.url) reuses the probe's scheme, host AND port rather
          // than re-deriving them: for an ip target the host carries an external port that
          // only probe.url has baked in.
          const { body, lines, ...rest } = await fetchGpuReport({
            url: new URL(sc.gpuCheck.path, state.probe.url).toString(),
          });
          // Assigned before the verdict is computed, so no future early return can skip
          // the bytes a human needs precisely when the body did not parse.
          sidecars["gpu-check.csv"] = body;
          state.gpu = { ...rest, lines };
          if (rest.status !== undefined) {
            state.lease.gpu = {
              url: rest.url,
              deviceCount: rest.devices.length,
              devices: rest.devices,
            };
          }
          state.gpuCheckFinishedAtMs = Date.now();
          const failure = gpuFailure(state.gpu);
          log(`  gpu-check ${failure ?? `${rest.devices.length} device(s) reported`}`);
        }
      }
    }

    if (abortReason) {
      // The file write is milliseconds and needs no network, so it always lands inside a
      // cancellation grace period. The close needs the network and may be killed, so it
      // goes second and the file is re-sealed only if it survives to converge.
      // heldDseq, not state.lease: an attempt whose close already converged between
      // retries is provably gone, and naming it here would report a false leak.
      state.epilogue = heldDseq
        ? {
            closed: [],
            stillActive: [{ dseq: heldDseq, reason: "run cancelled before close could broadcast" }],
          }
        : null;
      seal(abortReason);
      const salvage = await toZero({ bin, context: contextName, own: ownNow(), log }).catch(
        (e) => ({ closed: [], stillActive: [], errors: [String(e)], jsonl: "" }),
      );
      closeJsonl += salvage.jsonl;
      state.epilogue = salvage;
      return seal(abortReason);
    }

    const epilogue = await toZero({ bin, context: contextName, own: ownNow(), log });
    closeJsonl += epilogue.jsonl;
    state.epilogue = epilogue;

    const balanceAfter = await balances(bin, contextName, address);
    state.cost = delta(balanceBefore, balanceAfter);
    sidecars["cost.json"] = `${JSON.stringify(
      {
        account: address,
        before: balanceBefore,
        after: balanceAfter,
        delta: delta(balanceBefore, balanceAfter),
      },
      null,
      2,
    )}\n`;

    const doc = seal(null);
    if (mapped.unknownSteps.length) {
      log(`akt emitted a step this runner does not know: ${mapped.unknownSteps.join(", ")}`);
    }
    return doc;
  } catch (e) {
    if (state.steps.length) {
      try {
        seal(`runner error: ${e.message}`);
      } catch {}
    }
    throw e;
  } finally {
    clearTimeout(deadline);
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  }
}
