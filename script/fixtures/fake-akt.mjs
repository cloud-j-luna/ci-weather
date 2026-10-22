export const ADDRESS = "akash18yw2yky7l7suahs8u29dvfq8v3w5q5hnnla655";

// Handlers are serialized with Function.prototype.toString into a standalone script, so a
// handler must not close over anything. Everything it needs arrives through ctx, and
// per-handler parameters travel as data via `configured`.
const configured = (fn, config) => ({ fn, config });

const deploy = async (
  { argv, state, out, sleep, address, uri },
  { failAt, bidFailures = 0, bidFailStep = "wait-for-bids", ingress = uri },
) => {
  if (!argv.includes("--bid-select")) {
    return {
      stderr: "fake akt: --bid-select missing, real akt would block on stdin here\n",
      exitCode: 1,
    };
  }
  const s = state.read();
  const dseq = String(s.next);
  s.next += 1;
  s.deploys = (s.deploys ?? 0) + 1;
  const effectiveFailAt = s.deploys <= bidFailures ? bidFailStep : failAt;
  const bidsTotal =
    effectiveFailAt === "wait-for-bids" ? "0" : effectiveFailAt === "select-bid" ? "2" : "3";
  s.active.push(dseq);
  state.write(s);
  const provider = "akash1rk090a6mq9gvm0h6ljf8kz8mrxglwwxsk4srxh";
  const steps = [
    [
      "create-deployment",
      { dseq, owner: address, sdl_path: "sdl/web.yaml" },
      [{ hash: "A".repeat(64), code: 0 }],
    ],
    [
      "wait-for-bids",
      {
        bids: [],
        pagination: { next_key: null, total: bidsTotal },
        provider_metadata: {
          [provider]: {
            audited: true,
            attributes: { "location-region": "na-us-west", organization: "overclock" },
          },
        },
      },
      [],
    ],
    [
      "select-bid",
      {
        dseq,
        provider,
        price: "2.930853000000000000uact",
        selected: { bid: { price: { amount: "2.930853000000000000", denom: "uact" } } },
      },
      [],
    ],
    ["create-lease", { dseq, provider }, [{ hash: "B".repeat(64), code: 0 }]],
    ["send-manifest", null, []],
    [
      "display-result",
      { dseq, provider, ready: true, text: "Deployment created!", uris: { web: [ingress] } },
      [],
    ],
    ["wait-for-ready", { dseq, provider, ready: true, uris: { web: [ingress] } }, []],
  ];
  const emitted = [];
  const entries = [];
  for (const [step, outputs, txs] of steps) {
    await sleep(step === "wait-for-bids" ? 400 : 5);
    const failing = step === effectiveFailAt;
    const errorText =
      step === "wait-for-bids"
        ? "no bids received (at least 1 required); timed out after 5m0s"
        : step === "select-bid"
          ? "no item selected"
          : "the fake provider refused the manifest";
    const e = {
      workflow: "deploy",
      id: "fake",
      step,
      result: failing ? "error" : "completed",
      errors: failing ? [errorText] : [],
      txs,
    };
    if (outputs) e.outputs = outputs;
    emitted.push(e);
    if (step !== "wait-for-ready") {
      entries.unshift({
        ts: new Date().toISOString(),
        type: "workflow",
        action: "deploy",
        workflow_id: "fake",
        step: entries.length,
        step_name: step,
        status: failing ? "error" : "success",
      });
    }
    if (failing) break;
  }
  const withLog = state.read();
  withLog.log = entries;
  state.write(withLog);
  for (const e of emitted) out(e);
  return { exitCode: emitted.some((e) => e.result === "error") ? 1 : 0 };
};

const leaseStatus = ({ uri }, { ip = false }) => {
  if (!ip) return { stdout: { ips: null, forwarded_ports: null } };
  const [host, port] = uri.split(":");
  return {
    stdout: {
      ips: [{ port: 80, external_port: Number(port), protocol: "TCP", ip: host }],
      forwarded_ports: null,
    },
  };
};

const leaseAttestation = (
  _ctx,
  { platform = "snp-gpu", nonceVerified = true, mockReport = false, fail = false },
) => {
  if (fail) {
    return { stderr: "rpc error: attestation sidecar unreachable\n", exitCode: 1 };
  }
  return {
    stdout: {
      nonce: "bm9uY2U=",
      quote: {
        report: "cmVwb3J0",
        cert_chain: "",
        tee_platform: platform,
        auxblob: "",
        gpu_reports: [{ device_index: 0, report: "cmVwb3J0" }],
        tls_bound: false,
      },
      report_size_bytes: 1184,
      nonce_verified: nonceVerified,
      mock_report: mockReport,
    },
  };
};

const bank = (_ctx, { uact = "60000000" }) => ({
  stdout: {
    balances: [
      { denom: "uact", amount: uact },
      { denom: "uakt", amount: "7988246" },
    ],
    pagination: { next_key: null, total: "0" },
  },
});

export const verbs = {
  deploy: (config) => configured(deploy, config),
  leaseStatus: (config) => configured(leaseStatus, config),
  leaseAttestation: (config) => configured(leaseAttestation, config),
  bank: (config) => configured(bank, config),
};

const defaultHandlers = {
  version: () => ({ stdout: "akt 1.0.1 (commit: fake, built: 2026-10-09T05:05:46Z)\n" }),
  "context list": () => ({
    stdout: [
      {
        current: false,
        name: "sandbox-2",
        network: "sandbox-2",
        keyring: "default",
        default_account: "mykey2",
        chain_id: "sandbox-2",
      },
    ],
  }),
  "context keys list": ({ address }) => ({
    stdout: [{ name: "mykey2", type: "local", address, pubkey: "02" }],
  }),
  "context log": ({ state }) => ({ stdout: state.read().log ?? [] }),
  "query bank": bank,
  "query deployment active": ({ state, address }) => {
    const s = state.read();
    return {
      stdout: {
        deployments: s.active.map((dseq) => ({
          deployment: { id: { owner: address, dseq }, state: "active" },
          groups: [],
          escrow_account: {
            state: { funds: [{ denom: "uact", amount: "5000000.000000000000000000" }] },
          },
        })),
        pagination: { next_key: null, total: String(s.active.length) },
      },
    };
  },
  "sdl validate": () => ({ stdout: "valid: 1 service(s), 1 group(s), 0 warning(s)\n" }),
  "provider lease-status": leaseStatus,
  "provider lease-attestation": leaseAttestation,
  deploy,
  close: ({ argv, state, address }) => {
    const dseq = argv[1];
    const s = state.read();
    if (!s.active.includes(dseq)) {
      return {
        stdout: {
          workflow: "close",
          step: "close-deployment",
          result: "error",
          errors: ["rpc error: Deployment closed: unknown request"],
          txs: [],
        },
        exitCode: 1,
      };
    }
    s.active = s.active.filter((d) => d !== dseq);
    state.write(s);
    return {
      stdout: {
        workflow: "close",
        step: "close-deployment",
        result: "completed",
        errors: [],
        txs: [{ hash: "C".repeat(64), code: 0 }],
        outputs: { dseq, owner: address },
      },
    };
  },
};

const entry = (handler) => (typeof handler === "function" ? { fn: handler, config: {} } : handler);

// A handler key is a space-separated argv prefix; the longest matching prefix wins.
// A handler returns { stdout, stderr, exitCode }, where an object stdout is written as one
// JSON line. Overriding a key replaces that verb outright, so a test states what the verb
// does instead of setting a flag some branch reads.
export function fakeAkt({ statePath, argvLog, uri, handlers = {} }) {
  const table = Object.entries({ ...defaultHandlers, ...handlers }).map(([key, handler]) => {
    const { fn, config } = entry(handler);
    return `[${JSON.stringify(key.split(" "))}, ${fn.toString()}, ${JSON.stringify(config)}]`;
  });
  return `#!/usr/bin/env node
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";

const argv = process.argv.slice(2);
appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(argv) + "\\n");

const statePath = ${JSON.stringify(statePath)};
const state = {
  read: () => (existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { active: [], next: 9000001 }),
  write: (s) => writeFileSync(statePath, JSON.stringify(s)),
};
const render = (v) => (typeof v === "string" ? v : JSON.stringify(v) + "\\n");
const ctx = {
  argv,
  state,
  uri: ${JSON.stringify(uri)},
  address: ${JSON.stringify(ADDRESS)},
  out: (v) => process.stdout.write(render(v)),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

const table = [
${table.join(",\n")},
];

const matches = table.filter(([words]) => words.every((w, i) => argv[i] === w));
const best = matches.sort((a, b) => b[0].length - a[0].length)[0];
if (!best) {
  process.stderr.write("fake akt: unhandled " + argv.join(" ") + "\\n");
  process.exit(1);
}
const result = (await best[1](ctx, best[2])) ?? {};
if (result.stdout !== undefined) ctx.out(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exitCode = result.exitCode ?? 0;
`;
}
