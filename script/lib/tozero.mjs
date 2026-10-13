import * as realAkt from "./akt.mjs";

/**
 * toZero closes only deployments this project is known to have created. Everything
 * else on the account is foreign: reported, never touched.
 *
 * The earlier design closed everything it was not explicitly told to protect. Pointed
 * at a funded mainnet wallet it destroyed seven deployments that predated it. A rule
 * that depends on the operator having supplied a complete exclude list is not a
 * safeguard, so ownership is now proven rather than assumed.
 *
 * `own` comes from the committed run history, the claims the current run has already
 * written, and every dseq it has created so far. A run that retries past a provider
 * which did not bid creates several in sequence, so all of them have to stay in `own`
 * or I1 does not hold once the run ends. That history is also why ownership survives
 * an ephemeral CI runner that crashed mid-run.
 *
 * I1 (between runs): the account has no active deployment that this project created.
 * I2 (during a run): at most one such deployment is active at a time. A retrying run
 * cycles through created, closed, created again; what holds I2 is the retry loop
 * refusing to start the next attempt until the previous close has converged.
 */

const SETTLE_MS = 60000;
const POLL_MS = 3000;
// One block, so consecutive closes do not race the account sequence. Broadcasting
// back to back produced code 32 (sequence mismatch) and left escrow locked.
const BETWEEN_CLOSES_MS = 7000;
const SEQUENCE_RE = /sequence mismatch|code 32|incorrect account sequence/i;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export async function toZero(
  {
    bin,
    context,
    own = [],
    log = () => {},
    settleMs = SETTLE_MS,
    pollMs = POLL_MS,
    betweenClosesMs = BETWEEN_CLOSES_MS,
    sleep = wait,
  },
  akt = realAkt,
) {
  const ours = new Set(own);

  log(`listing active deployments for ${context}`);
  const firstList = await akt.activeDeployments(bin, context);

  const listed = [];
  const foreign = [];
  for (const d of firstList) {
    if (ours.has(d.dseq)) listed.push(d.dseq);
    else foreign.push(d.dseq);
  }
  if (foreign.length) {
    log(`leaving ${foreign.length} foreign deployment(s) alone: ${foreign.join(", ")}`);
  }

  const closed = [];
  const errors = [];
  const jsonlParts = [];
  const closeOutcomes = new Map();

  let first = true;
  for (const dseq of listed) {
    if (!first) await sleep(betweenClosesMs);
    first = false;
    log(`closing ${dseq}`);
    const attempts = [await akt.closeDeployment(bin, context, dseq)];
    if (!attempts[0].ok && (attempts[0].errors ?? []).some((e) => SEQUENCE_RE.test(String(e)))) {
      log(`sequence mismatch closing ${dseq}, retrying once`);
      await sleep(betweenClosesMs);
      attempts.push(await akt.closeDeployment(bin, context, dseq));
    }
    const result = attempts[attempts.length - 1];
    closeOutcomes.set(dseq, result);
    // Keep every attempt, not just the one that stuck. The discarded attempt is the
    // sequence-mismatch evidence someone would need to reconstruct an incident.
    for (const a of attempts) {
      if (typeof a.jsonl === "string" && a.jsonl.length > 0) {
        jsonlParts.push(a.jsonl.endsWith("\n") ? a.jsonl : `${a.jsonl}\n`);
      }
    }
    if (result.ok) {
      closed.push({ dseq, ...(result.txHash !== undefined ? { closeTxHash: result.txHash } : {}) });
      log(`closed ${dseq}`);
    } else {
      for (const e of result.errors ?? []) errors.push(e);
      log(`close failed for ${dseq}`);
    }
  }

  // akt broadcasts in sync mode, so close returns when the mempool accepts the tx, not
  // when the block commits. One immediate re-list would read block lag as a leak. Poll
  // instead, and never re-close: a second close burns gas and exits 1.
  let active = [];
  const deadline = Date.now() + (listed.length ? settleMs : 0);
  for (;;) {
    log(`re-listing active deployments for ${context} to confirm convergence`);
    active = (await akt.activeDeployments(bin, context)).filter((d) => ours.has(d.dseq));
    if (!active.some((d) => closeOutcomes.has(d.dseq))) break;
    if (Date.now() >= deadline) break;
    await sleep(pollMs);
  }

  const stillActive = active.map((d) => {
    const outcome = closeOutcomes.get(d.dseq);
    const reason = !outcome
      ? "active but was not targeted by this run"
      : outcome.ok
        ? "still active after close"
        : (outcome.errors?.[0] ?? "close failed, no error reported");
    return {
      dseq: d.dseq,
      reason,
      ...(d.depositUact !== undefined ? { depositUact: d.depositUact } : {}),
    };
  });

  return { listed, foreign, closed, stillActive, errors, jsonl: jsonlParts.join("") };
}
