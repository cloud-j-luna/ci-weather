import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const root = new URL("..", import.meta.url).pathname;
const schema = JSON.parse(readFileSync(join(root, "schema/run.schema.json"), "utf8"));

const ajv = new Ajv({ allErrors: true, strict: true });
addFormats(ajv);
const checkSchema = ajv.compile(schema);

// An unknown step sorts last rather than failing the run, so an akt upgrade
// that adds a step cannot take the dashboard dark.
const LIFECYCLE = schema.$defs.step.examples;
const rank = (s) => {
  const i = LIFECYCLE.indexOf(s);
  return i === -1 ? Number.MAX_SAFE_INTEGER : i;
};

// Relationships JSON Schema cannot express.
function invariants(run) {
  const bad = [];
  const steps = run.steps ?? [];

  const known = steps.filter((s) => LIFECYCLE.includes(s.step)).map((s) => rank(s.step));
  if (known.some((v, i) => i > 0 && v <= known[i - 1])) {
    bad.push("known steps are not in canonical lifecycle order");
  }
  if (steps.some((s) => s.step === "reap" || s.step === "close")) {
    bad.push("reap and close are not lifecycle steps; they belong on the reap and escrow axes");
  }

  if (new Date(run.finishedAt) < new Date(run.startedAt)) {
    bad.push("finishedAt precedes startedAt");
  }

  const failed = steps.filter((s) => s.result === "failed");
  if (failed.length > 1) bad.push(`${failed.length} failed steps, at most one is meaningful`);

  if (run.outcome.kind === "failed") {
    if (failed.length !== 1) {
      bad.push("outcome is failed but the timeline shows no single failed step");
    } else {
      const f = failed[0];
      if (f.step !== run.outcome.atStep) {
        bad.push(`outcome.atStep is ${run.outcome.atStep} but the timeline failed at ${f.step}`);
      }
      // akt can fail a step carrying no error text at all. The runner then stands in a
      // message of its own, because a document with no message fails the schema, writeRun
      // throws, and the run loses its whole file including the dseq it created. Where akt
      // did give text, it must still be reproduced verbatim.
      const reported = (f.errors ?? [])[0];
      if (reported !== undefined && run.outcome.message !== reported) {
        bad.push("outcome.message is not the failing step's own error, verbatim");
      }
    }
  }

  if (run.outcome.kind === "passed") {
    if (failed.length) bad.push("outcome is passed but a step failed");
    if (steps.some((s) => s.result === "skipped")) {
      bad.push("outcome is passed but steps were skipped");
    }
    if (!run.lease?.probe?.servedBy) {
      bad.push("outcome is passed but no scheme ever served the workload");
    }
    const attestation = run.lease?.attestation;
    if (attestation) {
      if (attestation.mockReport !== false) {
        bad.push("outcome is passed but the attestation report is a mock");
      }
      if (attestation.nonceVerified !== true) {
        bad.push("outcome is passed but the attestation nonce was never verified");
      }
    }
  }

  const cut = steps.findIndex((s) => s.result === "failed");
  if (cut >= 0) {
    if (steps.slice(0, cut).some((s) => s.result !== "completed")) {
      bad.push("a step before the failure is not completed");
    }
    if (steps.slice(cut + 1).some((s) => s.result !== "skipped")) {
      bad.push("a step after the failure is not skipped");
    }
  }

  const e = run.escrow;
  if (e) {
    const stranded = (e.stillActive ?? []).length;
    if ((e.kind === "leaked") !== stranded > 0) {
      bad.push("escrow.kind disagrees with whether deployments are still active");
    }
    const closedIds = new Set((e.closed ?? []).map((c) => c.dseq));
    if ((e.stillActive ?? []).some((a) => closedIds.has(a.dseq))) {
      bad.push("a dseq is recorded as both closed and still active");
    }
    if (e.kind === "returned" && (e.closed ?? []).length === 0) {
      bad.push("escrow claims returned but closed nothing");
    }
    const created = steps.find((s) => s.step === "create-deployment");
    if (e.kind === "nothing-created" && created?.result === "completed") {
      bad.push("escrow claims nothing-created but create-deployment completed");
    }
  }

  const a = run.attempts;
  if (a) {
    const earlier = a.earlier ?? [];
    if (a.count !== earlier.length + 1) {
      bad.push(
        `attempts.count is ${a.count} but ${earlier.length} earlier attempt(s) are recorded, and the final attempt is the one steps describes`,
      );
    }
    // Every retried attempt created a deployment. If escrow cannot account for it, this
    // run abandoned a deposit on chain, which is the exact failure retrying introduces.
    const accounted = new Set([
      ...(run.escrow?.closed ?? []).map((c) => c.dseq),
      ...(run.escrow?.stillActive ?? []).map((s) => s.dseq),
    ]);
    for (const att of earlier) {
      if (!accounted.has(att.dseq)) {
        bad.push(
          `attempts.earlier names dseq ${att.dseq} but escrow neither closed it nor lists it as still active, so a deposit is unexplained`,
        );
      }
    }
  }

  return bad;
}

export function check(doc) {
  if (!checkSchema(doc)) {
    return checkSchema.errors.map((e) => `${e.instancePath || "/"} ${e.message}`);
  }
  return invariants(doc);
}

function runFiles(dir) {
  const out = [];
  for (const scenario of readdirSync(dir)) {
    const d = join(dir, scenario);
    if (!statSync(d).isDirectory()) continue;
    for (const f of readdirSync(d)) {
      const entry = join(d, f);
      if (f.endsWith(".json")) out.push(entry);
      else if (statSync(entry).isDirectory()) out.push(join(entry, "run.json"));
    }
  }
  return out.filter((f) => existsSync(f)).sort();
}

function main() {
  const dirs = process.argv.slice(2);
  if (dirs.length === 0) dirs.push(join(root, "data/runs"), join(root, "testdata/runs"));

  let checked = 0;
  let bad = 0;
  for (const dir of dirs) {
    let files;
    try {
      files = runFiles(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      checked++;
      const problems = check(JSON.parse(readFileSync(f, "utf8")));
      if (problems.length) {
        bad++;
        console.error(`INVALID ${f.replace(root, "")}`);
        for (const p of problems) console.error(`    ${p}`);
      }
    }
  }

  const base = JSON.parse(
    readFileSync(join(root, "testdata/runs/web/2026-10-03T03-00-00Z.json"), "utf8"),
  );
  const cases = JSON.parse(readFileSync(join(root, "testdata/invalid/cases.json"), "utf8"));

  let accepted = 0;
  for (const c of cases) {
    const doc = structuredClone(base);
    for (const k of c.remove ?? []) delete doc[k];
    Object.assign(doc, c.mutate ?? {});
    if (check(doc).length === 0) {
      accepted++;
      console.error(`CONTRACT TOO LOOSE, accepted: ${c.why}`);
    }
  }

  console.log(`${checked} run files checked, ${bad} invalid`);
  console.log(`${cases.length} illegal shapes checked, ${accepted} wrongly accepted`);
  process.exit(bad === 0 && accepted === 0 ? 0 : 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
