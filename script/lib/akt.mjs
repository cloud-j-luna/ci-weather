import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const BECH32_ADDRESS = /^akash1[a-z0-9]{20,}$/;

function runOnce(bin, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function assertOk({ code, stdout, stderr }, bin, args) {
  if (code !== 0) {
    throw new Error(stderr.trim() || `akt exited ${code} running: ${bin} ${args.join(" ")}`);
  }
  return stdout;
}

export async function version(bin) {
  const args = ["version"];
  const stdout = assertOk(await runOnce(bin, args), bin, args);
  const match = stdout.match(/akt\s+(\d+\.\d+\.\d+)/);
  if (!match) throw new Error(`could not parse akt version from: ${stdout.trim()}`);
  return match[1];
}

export async function contexts(bin) {
  const args = ["context", "list", "-o", "json"];
  const stdout = assertOk(await runOnce(bin, args), bin, args);
  return JSON.parse(stdout);
}

export async function accountAddress(bin, ctx) {
  const list = await contexts(bin);
  const entry = list.find((c) => c.name === ctx);
  if (!entry) throw new Error(`no context named ${ctx}`);
  const account = entry.default_account;
  if (!account) throw new Error(`context ${ctx} has no default_account`);
  if (BECH32_ADDRESS.test(account)) return account;

  // default_account is commonly a keyring key name, not an address; resolve it.
  const args = ["context", "keys", "list", "--context", ctx, "-o", "json"];
  const stdout = assertOk(await runOnce(bin, args), bin, args);
  const keys = JSON.parse(stdout);
  const key = keys.find((k) => k.name === account);
  if (!key) throw new Error(`no key named ${account} in context ${ctx}`);
  return key.address;
}

export async function balances(bin, ctx, address) {
  const args = ["query", "bank", "balances", address, "--context", ctx, "-o", "json"];
  const stdout = assertOk(await runOnce(bin, args), bin, args);
  return JSON.parse(stdout).balances;
}

// akt reports ips as map[service][]LeasedIPStatus, not a flat array, and that struct
// carries no json tags, so Go marshals Go field names (IP, ExternalPort) while the
// sibling proto type uses snake_case. Accept every one of those shapes: guessing wrong
// crashed a live mainnet run and reported it as the network failing.
function normalizeIps(raw) {
  if (raw === null || raw === undefined) return [];
  const groups = Array.isArray(raw) ? [raw] : Object.values(raw);
  const out = [];
  for (const group of groups) {
    for (const e of Array.isArray(group) ? group : [group]) {
      const ip = e?.ip ?? e?.IP;
      const port = e?.port ?? e?.Port;
      const externalPort = e?.external_port ?? e?.externalPort ?? e?.ExternalPort;
      const protocol = e?.protocol ?? e?.Protocol;
      if (typeof ip !== "string" || ip.length === 0) continue;
      if (!Number.isInteger(port) || !Number.isInteger(externalPort)) continue;
      if (typeof protocol !== "string") continue;
      out.push({ ip, port, externalPort, protocol });
    }
  }
  return out;
}

export async function leaseStatus(bin, ctx, dseq) {
  const args = ["provider", "lease-status", String(dseq), "--context", ctx, "-o", "json"];
  const stdout = assertOk(await runOnce(bin, args), bin, args);
  const parsed = JSON.parse(stdout);
  return { ips: normalizeIps(parsed.ips) };
}

// akt 1.0.1 (pkg.akt.dev/go v0.4.5-rc0) calls this field tee_platform; an older module
// version spelled it tee_type, so both are read, platform first.
const ATTESTATION_FIELDS = [
  {
    path: "tee_platform",
    get: (quote) => quote.tee_platform ?? quote.tee_type,
    ok: (v) => typeof v === "string" && v.length > 0,
    want: "a non-empty string",
  },
  {
    path: "nonce_verified",
    get: (quote, parsed) => parsed.nonce_verified,
    ok: (v) => typeof v === "boolean",
    want: "a boolean",
  },
  {
    path: "mock_report",
    get: (quote, parsed) => parsed.mock_report,
    ok: (v) => typeof v === "boolean",
    want: "a boolean",
  },
];

export async function leaseAttestation(bin, ctx, dseq) {
  const args = ["provider", "lease-attestation", String(dseq), "--context", ctx, "-o", "json"];
  const stdout = assertOk(await runOnce(bin, args), bin, args);
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`akt reported unparsable lease-attestation output: ${stdout}`);
  }
  const quote = parsed.quote ?? {};

  for (const field of ATTESTATION_FIELDS) {
    const value = field.get(quote, parsed);
    if (!field.ok(value)) {
      throw new Error(`akt reported ${field.path} as ${JSON.stringify(value)}, not ${field.want}`);
    }
  }

  const record = {
    teeType: quote.tee_platform ?? quote.tee_type,
    nonceVerified: parsed.nonce_verified,
    mockReport: parsed.mock_report,
    certChainPresent: typeof quote.cert_chain === "string" && quote.cert_chain.length > 0,
    gpuReportCount: Array.isArray(quote.gpu_reports) ? quote.gpu_reports.length : 0,
  };
  if (Number.isInteger(parsed.report_size_bytes)) {
    record.reportSizeBytes = parsed.report_size_bytes;
  }
  return record;
}

export async function activeDeployments(bin, ctx) {
  const args = ["query", "deployment", "active", "-o", "json", "--context", ctx];
  const stdout = assertOk(await runOnce(bin, args), bin, args);
  const parsed = JSON.parse(stdout);
  return (parsed.deployments ?? []).map((entry) => {
    const dseq = entry.deployment.id.dseq;
    const uact = entry.escrow_account?.state?.funds?.find((f) => f.denom === "uact");
    // amount is a decimal string like "5000000.000000000000000000"; uact has no subunits.
    const depositUact = uact ? uact.amount.split(".")[0] : "0";
    return { dseq, depositUact };
  });
}

export async function closeDeployment(bin, ctx, dseq) {
  const args = ["close", String(dseq), "--context", ctx, "--yes", "-o", "jsonl"];
  const { code, stdout, stderr } = await runOnce(bin, args);
  const jsonl = stdout;
  const events = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const closeEvent = events.find((e) => e.step === "close-deployment") ?? events.at(-1);

  if (!closeEvent) {
    return {
      ok: false,
      dseq,
      errors: [stderr.trim() || `akt close exited ${code} with no parsable jsonl output`],
      jsonl,
    };
  }

  if (closeEvent.result === "completed") {
    const txHash = closeEvent.txs?.[0]?.hash;
    return { ok: true, dseq, ...(txHash !== undefined ? { txHash } : {}), errors: [], jsonl };
  }

  return {
    ok: false,
    dseq,
    errors: closeEvent.errors ?? [
      stderr.trim() || "akt close reported an error with no errors[] detail",
    ],
    jsonl,
  };
}

export async function workflowLog(bin, ctx, workflowId) {
  const args = ["context", "log", "--workflow-id", workflowId, "--context", ctx, "-o", "json"];
  const { code, stdout } = await runOnce(bin, args);
  if (code !== 0) return [];
  try {
    const parsed = JSON.parse(stdout);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function sdlValidate(bin, sdlPath) {
  const args = ["sdl", "validate", sdlPath];
  const { code, stdout, stderr } = await runOnce(bin, args);
  return { ok: code === 0, output: (stdout + stderr).trim() };
}

export async function deployStream(bin, args, hooks = {}) {
  const { onEvent, onStdoutChunk, onStderrChunk, signal } = hooks;

  return new Promise((resolve, reject) => {
    const child = spawn(bin, args);
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let killTimer = null;

    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => {
      let event = null;
      try {
        event = JSON.parse(line);
      } catch {
        event = null;
      }
      onEvent?.({ at: Date.now(), line, event });
    });

    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      onStdoutChunk?.(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      onStderrChunk?.(chunk);
    });

    function onAbort() {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
    }

    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      reject(err);
    });

    // 'close', not 'exit': stdio must be fully drained so every jsonl line was
    // already handed to onEvent before the caller sees the process as done.
    child.on("close", (code, procSignal) => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve({ code, signal: procSignal, stdoutBytes, stderrBytes });
    });
  });
}
