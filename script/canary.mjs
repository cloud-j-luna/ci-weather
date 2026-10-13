import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONTEXT } from "./lib/config.mjs";
import { ownedDseqs } from "./lib/owned.mjs";
import { doctor } from "./lib/doctor.mjs";
import { runScenario } from "./lib/run.mjs";
import { toZero } from "./lib/tozero.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const USAGE = `canary - the ci-weather deployment canary

  node script/canary.mjs run --scenario <id> [--context <name>] [--akt <path>] [--out <dir>] [--adopt <dseq>]
  node script/canary.mjs reap [--context <name>] [--akt <path>] [--adopt <dseq>]
  node script/canary.mjs doctor [--context <name>] [--akt <path>]

--context defaults to ${DEFAULT_CONTEXT}. Pointing it at a funded network is an explicit
act, never a default. run and reap close only the deployments the committed run history
proves this project created. Everything else active on the account is foreign and is left
alone. --adopt adds a dseq to the owned set, for a deployment this project created but
never recorded.`;

function parseArgs(argv) {
  const out = { adopt: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument ${a}`);
    const key = a.slice(2);
    const value = argv[++i];
    if (value === undefined || value.startsWith("--")) throw new Error(`${a} needs a value`);
    if (key === "adopt") out.adopt.push(value);
    else if (["scenario", "context", "akt", "out"].includes(key)) out[key] = value;
    else throw new Error(`unknown flag ${a}`);
  }
  return out;
}

async function main(argv) {
  const command = argv[0];
  if (!command || command === "--help" || command === "-h") {
    console.log(USAGE);
    return 0;
  }

  const args = parseArgs(argv.slice(1));
  const bin = args.akt ?? "akt";
  const contextName = args.context ?? DEFAULT_CONTEXT;
  const outRoot = args.out ?? join(repoRoot, "data/runs");

  if (command === "run") {
    if (!args.scenario) throw new Error("run needs --scenario <id>");
    const doc = await runScenario({
      bin,
      contextName,
      scenarioId: args.scenario,
      repoRoot,
      outRoot,
      adopt: args.adopt,
      log: (m) => console.log(m),
    });
    console.log(`outcome ${doc.outcome.kind}, escrow ${doc.escrow.kind}`);
    return doc.outcome.kind === "passed" ? 0 : 1;
  }

  if (command === "reap") {
    const own = [...ownedDseqs(outRoot), ...args.adopt];
    console.log(`reap on ${contextName}, ${own.length} deployment(s) known to be ours`);
    const r = await toZero({ bin, context: contextName, own, log: (m) => console.log(m) });
    console.log(
      `ours ${r.listed.length}, closed ${r.closed.length}, foreign left alone ${r.foreign.length}, still active ${r.stillActive.length}`,
    );
    for (const s of r.stillActive) console.error(`STILL ACTIVE ${s.dseq}: ${s.reason}`);
    for (const e of r.errors) console.error(`    ${e}`);
    return r.stillActive.length === 0 ? 0 : 1;
  }

  if (command === "doctor") {
    const ok = await doctor({ bin, contextName, repoRoot, outRoot });
    return ok ? 0 : 1;
  }

  throw new Error(`unknown command ${command}`);
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    console.error(e.stack ?? String(e));
    process.exitCode = 2;
  },
);
