import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  accountAddress,
  balances,
  activeDeployments,
  contexts,
  sdlValidate,
  version,
} from "./akt.mjs";
import { AKT_VERSION_PIN, BALANCE_MARGIN, depositPlan, loadConfig } from "./config.mjs";
import { ownedDseqs } from "./owned.mjs";
import { LIFECYCLE } from "./steps.mjs";
import { parse as parseYaml } from "yaml";

const GAS_FLOOR_UAKT = 100000n;

function depositDenoms(config) {
  const denoms = new Set();
  for (const sc of config.scenarios.values()) {
    const sdl = parseYaml(readFileSync(sc.sdlPath, "utf8"));
    for (const placement of Object.values(sdl.profiles?.placement ?? {})) {
      for (const service of Object.values(placement.pricing ?? {})) {
        if (service.denom) denoms.add(service.denom);
      }
    }
  }
  return [...denoms];
}

function unknownStepsOnDisk(outRoot) {
  const seen = new Set();
  if (!existsSync(outRoot)) return [];
  for (const scenario of readdirSync(outRoot)) {
    const d = join(outRoot, scenario);
    if (!statSync(d).isDirectory()) continue;
    for (const entry of readdirSync(d)) {
      const f = join(d, entry, "run.json");
      if (!existsSync(f)) continue;
      for (const s of JSON.parse(readFileSync(f, "utf8")).steps ?? []) {
        if (!LIFECYCLE.includes(s.step)) seen.add(s.step);
      }
    }
  }
  return [...seen];
}

// A directory with a claims.jsonl but no run.json is a deployment whose run died
// between the claim and the seal (a SIGKILL, a reclaimed CI runner). The claim is
// still ownership proof, so this is worth flagging, never failing: the next reap
// closes it using exactly that proof.
function crashedRunsOnDisk(outRoot) {
  const found = [];
  if (!existsSync(outRoot)) return found;
  for (const scenario of readdirSync(outRoot)) {
    const d = join(outRoot, scenario);
    if (!statSync(d).isDirectory()) continue;
    for (const entry of readdirSync(d)) {
      if (existsSync(join(d, entry, "run.json"))) continue;
      const claimsPath = join(d, entry, "claims.jsonl");
      if (!existsSync(claimsPath)) continue;
      const dseqs = new Set();
      for (const line of readFileSync(claimsPath, "utf8").split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const claim = JSON.parse(trimmed);
          if (claim?.dseq !== undefined && claim.dseq !== null) dseqs.add(String(claim.dseq));
        } catch {
          // A torn final line from a hard kill must not hide the intact claims before it.
        }
      }
      if (dseqs.size) found.push({ run: `${scenario}/${entry}`, dseqs: [...dseqs] });
    }
  }
  return found;
}

export async function doctor({ bin, contextName, repoRoot, outRoot, log = console.log }) {
  const checks = [];
  const add = (grade, name, detail) => checks.push({ grade, name, detail });

  const installed = await version(bin).catch((e) => `unavailable: ${e.message}`);
  add(
    installed === AKT_VERSION_PIN ? "ok" : "fail",
    "akt version",
    `${installed}, pinned to ${AKT_VERSION_PIN}`,
  );

  const config = loadConfig(repoRoot);
  const ctx = (await contexts(bin)).find((c) => c.name === contextName);
  if (!ctx) {
    add("fail", "context", `akt has no context named ${contextName}`);
    return report(checks, log);
  }
  add("ok", "context", `${ctx.name} on chain ${ctx.chain_id}`);

  let address;
  try {
    address = await accountAddress(bin, contextName);
    add("ok", "account", address);
  } catch (e) {
    add("fail", "account", e.message);
    return report(checks, log);
  }

  const held = Object.fromEntries(
    (await balances(bin, contextName, address)).map((b) => [b.denom, BigInt(b.amount)]),
  );
  const plan = depositPlan(config, contextName);
  const summed = plan.scenarios.map((s) => `${s.id} ${s.uact}`).join(", ");
  for (const denom of depositDenoms(config)) {
    const have = held[denom] ?? 0n;
    add(
      have >= plan.floor ? "ok" : "fail",
      `balance ${denom}`,
      `${have}, needs ${plan.floor} to fund every scenario's deposit ${BALANCE_MARGIN}x over (${summed})`,
    );
  }
  const gas = held.uakt ?? 0n;
  add(
    gas >= GAS_FLOOR_UAKT ? "ok" : "fail",
    "balance uakt",
    `${gas} for gas, needs ${GAS_FLOOR_UAKT}`,
  );

  const own = ownedDseqs(outRoot);
  const active = await activeDeployments(bin, contextName);
  const ours = active.filter((d) => own.has(d.dseq));
  const foreign = active.filter((d) => !own.has(d.dseq));
  add(
    ours.length === 0 ? "ok" : "warn",
    "active deployments",
    ours.length === 0
      ? `none of ours, invariant I1 holds, ${own.size} dseq(s) in the run history`
      : `${ours.length} of ours (${ours.map((d) => d.dseq).join(", ")}), the next run's reap will close them`,
  );
  add(
    "ok",
    "foreign deployments",
    foreign.length === 0
      ? "none on this account"
      : `${foreign.length} (${foreign.map((d) => d.dseq).join(", ")}), not ours and never closed by this project`,
  );

  for (const sc of config.scenarios.values()) {
    const r = await sdlValidate(bin, sc.sdlPath);
    add(r.ok ? "ok" : "fail", `sdl ${sc.id}`, r.output.trim().split("\n").at(-1) ?? "");
  }

  const unknown = unknownStepsOnDisk(outRoot);
  if (unknown.length) {
    add(
      "warn",
      "akt vocabulary",
      `akt emitted a step this runner does not know: ${unknown.join(", ")}`,
    );
  }

  const crashed = crashedRunsOnDisk(outRoot);
  if (crashed.length) {
    add(
      "warn",
      "crashed runs",
      `${crashed.length} run(s) created a deployment and never sealed: ${crashed
        .map((c) => `${c.run} (${c.dseqs.join(", ")})`)
        .join(", ")}; the claim proves ownership, so the next reap will close them`,
    );
  }

  return report(checks, log);
}

function report(checks, log) {
  const width = Math.max(...checks.map((c) => c.name.length));
  for (const c of checks) {
    log(`${c.grade.toUpperCase().padEnd(4)} ${c.name.padEnd(width)}  ${c.detail}`);
  }
  const failed = checks.filter((c) => c.grade === "fail").length;
  log(`${checks.length} checks, ${failed} failed`);
  return failed === 0;
}
