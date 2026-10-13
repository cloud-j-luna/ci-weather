import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";

export const AKT_VERSION_PIN = "1.0.1";
export const DEFAULT_CONTEXT = "sandbox-2";

// What `auto` resolves to, measured live per network. These differ by 40x, so a single
// constant taken from sandbox told a mainnet operator their balance was fine when it
// covered a fortieth of what it claimed.
const AUTO_DEPOSIT_UACT = {
  "sandbox-2": 500000n,
  mainnet: 20000000n,
};
const AUTO_DEPOSIT_UACT_FALLBACK = 20000000n;

function autoDepositUact(contextName) {
  return AUTO_DEPOSIT_UACT[contextName] ?? AUTO_DEPOSIT_UACT_FALLBACK;
}

// How many times over doctor insists the account can fund every scenario's deposit at once.
export const BALANCE_MARGIN = 2;

// A scenario pinned to one provider fails at bidding whenever that provider is briefly
// full, which says nothing about Akash. These bound the retry: a count, and a delay that
// also spaces the close of the failed attempt from the next create-deployment broadcast.
export const DEFAULT_BID_ATTEMPTS = 3;
export const DEFAULT_BID_RETRY_DELAY = "30s";

const SCENARIO_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const DURATION_RE = /^(\d+)(ms|s|m|h)$/;
const DURATION_MULTIPLIERS = { ms: 1, s: 1000, m: 60000, h: 3600000 };
const PROBE_TARGETS = new Set(["uri", "ip"]);
const DEPOSIT_RE = /^(auto|\d+uact)$/;
// The four values the attestation sidecar emits; anything else is a typo.
const TEE_TYPES = new Set(["snp", "tdx", "snp-gpu", "tdx-gpu"]);

export function parseDuration(text) {
  if (typeof text === "number") {
    if (!Number.isInteger(text) || text < 0) throw new Error(`invalid duration: ${text}`);
    return text;
  }
  if (typeof text === "string") {
    const match = DURATION_RE.exec(text.trim());
    if (match) return Number(match[1]) * DURATION_MULTIPLIERS[match[2]];
  }
  throw new Error(`invalid duration: ${JSON.stringify(text)}`);
}

const BID_SELECT_RE = /^(cheapest|provider=akash1[a-z0-9]{38})$/;

function validateBidSelect(value, where) {
  if (value === undefined) return;
  if (typeof value === "string") {
    if (BID_SELECT_RE.test(value)) return;
    throw new Error(
      `${where}: bidSelect must be "cheapest" or "provider=<bech32>", got ${JSON.stringify(value)}`,
    );
  }
  if (value && typeof value === "object") {
    if (value.default === undefined) {
      throw new Error(`${where}: a per-network bidSelect needs a "default"`);
    }
    for (const [network, v] of Object.entries(value)) {
      validateBidSelect(v, `${where} bidSelect.${network}`);
    }
    return;
  }
  throw new Error(`${where}: bidSelect must be a string or a per-network map`);
}

/** A pinned provider only exists on the network it was pinned for. */
export function bidSelectFor(sc, contextName) {
  const v = sc.bidSelect;
  if (typeof v === "string") return v;
  if (v && typeof v === "object") return v[contextName] ?? v.default;
  return "cheapest";
}

function validateDeposit(value, where) {
  if (typeof value !== "string" || !DEPOSIT_RE.test(value)) {
    throw new Error(
      `${where}: deposit must be "auto" or "<digits>uact", got ${JSON.stringify(value)}`,
    );
  }
}

function validateAttempts(value, where) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${where}: bidAttempts must be an integer >= 1, got ${JSON.stringify(value)}`);
  }
}

function depositUact(deposit, contextName) {
  if (deposit === "auto") return autoDepositUact(contextName);
  return BigInt(deposit.slice(0, -"uact".length));
}

export function depositPlan(config, contextName) {
  const scenarios = [...config.scenarios.values()].map((sc) => ({
    id: sc.id,
    uact: depositUact(sc.deposit, contextName),
  }));
  const total = scenarios.reduce((sum, s) => sum + s.uact, 0n);
  return { scenarios, total, floor: total * BigInt(BALANCE_MARGIN) };
}

function validateScenario(entry, repoRoot) {
  const id = entry?.id;
  if (typeof id !== "string" || id.length === 0 || !SCENARIO_ID_RE.test(id)) {
    throw new Error(
      `scenario ${JSON.stringify(id)}: id must be non-empty and match ${SCENARIO_ID_RE}`,
    );
  }
  if (typeof entry.sdl !== "string" || entry.sdl.length === 0) {
    throw new Error(`scenario ${id}: missing sdl`);
  }
  const sdlPath = resolve(repoRoot, "scenarios", entry.sdl);
  if (!existsSync(sdlPath)) {
    throw new Error(`scenario ${id}: sdl file does not exist at ${sdlPath}`);
  }
  if (typeof entry.probe?.path !== "string" || entry.probe.path.length === 0) {
    throw new Error(`scenario ${id}: probe.path is required`);
  }
  if (!Number.isInteger(entry.probe?.expectStatus)) {
    throw new Error(`scenario ${id}: probe.expectStatus must be an integer`);
  }
  const target = entry.probe.target ?? "uri";
  if (!PROBE_TARGETS.has(target)) {
    throw new Error(
      `scenario ${id}: probe.target must be "uri" or "ip", got ${JSON.stringify(entry.probe.target)}`,
    );
  }

  if (entry.attestation !== undefined) {
    if (typeof entry.attestation !== "object" || entry.attestation === null) {
      throw new Error(`scenario ${id}: attestation must be an object`);
    }
    const keys = Object.keys(entry.attestation);
    if (keys.length !== 1 || keys[0] !== "teeType") {
      throw new Error(`scenario ${id}: attestation's only key is teeType, got ${keys.join(", ")}`);
    }
    if (!TEE_TYPES.has(entry.attestation.teeType)) {
      throw new Error(
        `scenario ${id}: attestation.teeType must be one of ${[...TEE_TYPES].join(", ")}, got ${JSON.stringify(entry.attestation.teeType)}`,
      );
    }
  }

  return { ...entry, probe: { ...entry.probe, target }, sdlPath };
}

export function loadConfig(repoRoot) {
  const text = readFileSync(resolve(repoRoot, "scenarios", "scenarios.yaml"), "utf8");
  const parsed = parseYaml(text);

  const rawBudgets = parsed.budgets ?? {};
  validateDeposit(rawBudgets.deposit, "budgets");
  const bidAttempts = rawBudgets.bidAttempts ?? DEFAULT_BID_ATTEMPTS;
  validateAttempts(bidAttempts, "budgets");
  const bidRetryDelay = rawBudgets.bidRetryDelay ?? DEFAULT_BID_RETRY_DELAY;
  // Spreading raw would let a typo'd key sit there silently while the real setting
  // falls back to its default, and bidAttempts is exactly where that hurts.
  const KNOWN_BUDGETS = new Set([
    "bidTimeout",
    "leaseReadyTimeout",
    "probeTimeout",
    "totalRunTimeout",
    "deposit",
    "bidAttempts",
    "bidRetryDelay",
  ]);
  for (const key of Object.keys(rawBudgets)) {
    if (!KNOWN_BUDGETS.has(key)) {
      throw new Error(
        `budgets: unknown key ${JSON.stringify(key)}, expected one of ${[...KNOWN_BUDGETS].join(", ")}`,
      );
    }
  }

  const budgets = {
    ...rawBudgets,
    bidAttempts,
    bidRetryDelay,
    bidTimeoutMs: parseDuration(rawBudgets.bidTimeout),
    leaseReadyTimeoutMs: parseDuration(rawBudgets.leaseReadyTimeout),
    probeTimeoutMs: parseDuration(rawBudgets.probeTimeout),
    totalRunTimeoutMs: parseDuration(rawBudgets.totalRunTimeout),
    bidRetryDelayMs: parseDuration(bidRetryDelay),
  };

  const placement = parsed.placement ?? {};
  if (placement.bidSelect !== undefined) validateBidSelect(placement.bidSelect, "placement");

  const scenarios = new Map();
  for (const entry of parsed.scenarios ?? []) {
    const validated = validateScenario(entry, repoRoot);
    if (validated.bidSelect === undefined) validated.bidSelect = placement.bidSelect;
    validateBidSelect(validated.bidSelect, `scenario ${validated.id}`);
    if (validated.deposit === undefined) validated.deposit = budgets.deposit;
    validateDeposit(validated.deposit, `scenario ${validated.id}`);
    if (validated.bidAttempts === undefined) validated.bidAttempts = budgets.bidAttempts;
    validateAttempts(validated.bidAttempts, `scenario ${validated.id}`);
    validated.probeTimeoutMs =
      validated.probeTimeout === undefined
        ? budgets.probeTimeoutMs
        : parseDuration(validated.probeTimeout);
    scenarios.set(validated.id, validated);
  }

  return { weather: parsed.weather, budgets, placement, scenarios };
}

export function scenario(config, id) {
  const found = config.scenarios.get(id);
  if (!found) {
    throw new Error(
      `unknown scenario "${id}", valid ids: ${[...config.scenarios.keys()].join(", ")}`,
    );
  }
  return found;
}
