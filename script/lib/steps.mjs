import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const schemaPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "schema",
  "run.schema.json",
);
const schema = JSON.parse(readFileSync(schemaPath, "utf8"));

export const LIFECYCLE = Object.freeze(schema.$defs.step.examples);
export const COSMETIC = new Set(["display-result"]);

// wait-for-bids failing means nobody bid at all; select-bid failing means somebody bid
// but not the provider this scenario is pinned to. Both are a statement about one
// provider's spare capacity, not about Akash. Everything else failing is a real result.
export const SUPPLY_STEPS = Object.freeze(new Set(["wait-for-bids", "select-bid"]));

const LIFECYCLE_SET = new Set(LIFECYCLE);

function flattenUris(uris) {
  return Object.values(uris).flat();
}

function harvestLease(events) {
  const lease = {};
  let providerMetadata;

  for (const { event } of events) {
    if (!event?.step) continue;
    const out = event.outputs;
    if (!out) continue;

    if (event.step === "create-deployment" && out.dseq !== undefined) {
      lease.dseq = out.dseq;
    }

    if (event.step === "wait-for-bids") {
      const total = out.pagination?.total;
      if (total !== undefined) lease.bidCount = parseInt(total, 10);
      if (out.provider_metadata !== undefined) providerMetadata = out.provider_metadata;
    }

    if (event.step === "select-bid") {
      if (out.provider !== undefined) lease.provider = out.provider;
      const selectedPrice = out.selected?.bid?.price;
      if (selectedPrice?.amount !== undefined && selectedPrice?.denom !== undefined) {
        lease.price = { amount: selectedPrice.amount, denom: selectedPrice.denom };
      } else if (typeof out.price === "string") {
        const match = /^([0-9.]+)([a-zA-Z]+)$/.exec(out.price);
        if (match) lease.price = { amount: match[1], denom: match[2] };
      }
    }

    if (out.uris !== undefined) lease.uris = flattenUris(out.uris);
  }

  const metadata = providerMetadata?.[lease.provider];
  if (metadata !== undefined) {
    if (metadata.audited !== undefined) lease.providerAudited = metadata.audited;
    const region = metadata.attributes?.["location-region"];
    if (region !== undefined) lease.providerRegion = region;
    const org = metadata.attributes?.organization;
    if (org !== undefined) lease.providerOrg = org;
  }

  return lease;
}

export function mapStream({ events }) {
  if (events.length === 0) {
    return {
      steps: [],
      lease: {},
      outputs: {},
      unknownSteps: [],
      failedStep: null,
      lastEventAtMs: null,
    };
  }

  const outputs = {};
  for (const { event } of events) {
    if (event?.step && event.outputs !== undefined) outputs[event.step] = event.outputs;
  }

  const lease = harvestLease(events);
  const graded = events.filter(({ event }) => event?.step && !COSMETIC.has(event.step));

  const steps = [];
  const unknownSeen = new Set();
  const unknownSteps = [];
  let failedStep = null;

  for (let i = 0; i < graded.length; i += 1) {
    const { event } = graded[i];
    const result = event.result === "completed" ? "completed" : "failed";

    const stepResult = { step: event.step, result };
    if (Array.isArray(event.errors) && event.errors.length > 0) stepResult.errors = event.errors;
    if (Array.isArray(event.txs) && event.txs.length > 0) {
      stepResult.txs = event.txs.map((tx) => ({ hash: tx.hash, code: tx.code }));
    }
    steps.push(stepResult);

    if (!LIFECYCLE_SET.has(event.step) && !unknownSeen.has(event.step)) {
      unknownSeen.add(event.step);
      unknownSteps.push(event.step);
    }

    if (result === "failed") {
      failedStep = { step: event.step, errors: event.errors ?? [] };
      break;
    }
  }

  return {
    steps,
    lease,
    outputs,
    unknownSteps,
    failedStep,
    lastEventAtMs: events[events.length - 1].at,
  };
}

const isoAt = (ms) => new Date(ms).toISOString();
const span = (fromMs, toMs) => Math.max(0, Math.round(toMs - fromMs));

function timed(step, startMs, endMs, durationSource) {
  const out = {
    step: step.step,
    result: step.result,
    startedAt: isoAt(startMs),
    durationMs: span(startMs, endMs),
    durationSource,
  };
  if (step.errors) out.errors = step.errors;
  if (step.txs) out.txs = step.txs;
  return out;
}

/**
 * akt flushes its jsonl events in bursts, so the time a line arrives says nothing about
 * when its step ran: a 15s bid wait and a sub-millisecond local bid choice land in the
 * same millisecond. akt's own action log carries a real completion timestamp per step,
 * and differencing consecutive entries is the only accurate measurement available.
 */
export function applyTimings({ steps, log = [], startedAtMs, exitAtMs }) {
  const logged = log
    .filter((e) => e?.type === "workflow" && typeof e.step_name === "string" && e.ts)
    .sort((a, b) => a.step - b.step);

  const windows = new Map();
  let boundary = startedAtMs;
  for (const entry of logged) {
    const end = Date.parse(entry.ts);
    if (Number.isNaN(end)) continue;
    windows.set(entry.step_name, { start: boundary, end });
    boundary = end;
  }

  return steps.map((step, i) => {
    const hit = windows.get(step.step);
    if (hit) return timed(step, hit.start, hit.end, "akt-log");
    // The action log stops at display-result, so wait-for-ready has no entry of its own
    // and the only boundary left for it is akt's process exit.
    const end = i === steps.length - 1 ? exitAtMs : boundary;
    return timed(step, boundary, end, "derived");
  });
}
