import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Every dseq this project is known to have created, read back from the run files it
 * committed, plus every dseq claimed in a claims.jsonl beside a run that never
 * finished sealing. That history is the proof of ownership: it survives an ephemeral
 * CI runner, so a run killed mid-flight is still cleaned up by the next one without
 * giving the reaper licence to close anything else on the account.
 */
export function ownedDseqs(runsRoot) {
  const found = new Set();
  let scenarios;
  try {
    scenarios = readdirSync(runsRoot);
  } catch {
    return found;
  }

  for (const scenario of scenarios) {
    const dir = join(runsRoot, scenario);
    let entries;
    try {
      if (!statSync(dir).isDirectory()) continue;
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const isFlat = entry.endsWith(".json");
      const path = isFlat ? join(dir, entry) : join(dir, entry, "run.json");
      try {
        collect(JSON.parse(readFileSync(path, "utf8")), found);
      } catch {
        // No sealed run yet, or it is corrupt; a claims.jsonl beside it can still prove ownership.
      }
      if (!isFlat) collectClaims(join(dir, entry, "claims.jsonl"), found);
    }
  }
  return found;
}

// Dropping a dseq we own is the same failure class as the incident this guard exists
// for, so presence is tested rather than truthiness: a dseq of 0 is a real dseq.
const keep = (v) => v !== undefined && v !== null && v !== "";

// Parsed line by line so a torn final line from a hard kill cannot poison the claims
// recorded before it.
function collectClaims(path, into) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let claim;
    try {
      claim = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (keep(claim?.dseq)) into.add(String(claim.dseq));
  }
}

function collect(run, into) {
  if (keep(run?.lease?.dseq)) into.add(String(run.lease.dseq));
  for (const c of run?.escrow?.closed ?? []) if (keep(c?.dseq)) into.add(String(c.dseq));
  for (const a of run?.escrow?.stillActive ?? []) if (keep(a?.dseq)) into.add(String(a.dseq));
  for (const d of run?.reap?.closedDseqs ?? []) if (keep(d)) into.add(String(d));
}
