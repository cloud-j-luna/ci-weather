import { BACKOFF_SCHEDULE_MS } from "./probe.mjs";

const GPU_ATTEMPT_TIMEOUT_MS = 5000;
const GPU_BUDGET_MS = 30000;
const DRIVER_VERSION_RE = /^(\d+(\.\d+)+|\[N\/A\])$/;
const MIB_RE = /^(\d+)(\s*MiB)?$/i;

export function parseGpuCsv(body) {
  const lines = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const devices = [];
  for (const line of lines) {
    const fields = line.split(",").map((f) => f.trim());
    if (fields.length !== 4 || fields.some((f) => f.length === 0)) continue;
    // nvidia-smi's stderr is merged into the same file as its CSV, so a driver warning
    // or nvidia-smi's own header row must not parse as a device. driverVersion is the
    // field that tells them apart, since it is the oldest queryable field nvidia-smi has.
    if (!DRIVER_VERSION_RE.test(fields[1])) continue;

    const device = { name: fields[0], driverVersion: fields[1] };
    const mib = MIB_RE.exec(fields[2]);
    if (mib) device.memoryTotalMiB = Number(mib[1]);
    device.computeCapability = fields[3];
    devices.push(device);
  }

  return { lines, devices };
}

function quote(s) {
  const stripped = s.replace(/[\x00-\x1f\x7f]/g, "");
  return JSON.stringify(stripped.slice(0, 120));
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A 503 is what a provider's ingress answers while the route exists but nothing is
 * accepting connections behind it yet, which is every workload's first seconds. It is
 * not a statement about the path requested, so it says nothing about whether nvidia-smi
 * wrote its output. Across every run recorded here, a probe that saw a 5xx went on to
 * get a 200 within 0.5s to 7.1s; it has never once been terminal. A status the origin
 * actually produced, 404 included, is a real answer and is not retried.
 */
const transient = (r) => r.error !== undefined || (r.status !== undefined && r.status >= 500);

async function attempt(url, timeoutMs, fetchImpl, now) {
  const startMs = now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const record = { at: new Date(startMs).toISOString() };
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    record.status = res.status;
    record.body = await res.text();
  } catch (e) {
    record.error = e.message;
  } finally {
    clearTimeout(timer);
    record.durationMs = Math.max(0, Math.round(now() - startMs));
  }
  return record;
}

/**
 * MUST NEVER THROW. A throw here reaches runScenario's outer catch, which seals the run
 * as "runner error", and scenarios.yaml excludes aborted runs from BOTH sides of the pass
 * rate, so a real GPU failure would become no data at all.
 *
 * Retries on the same schedule as the probe, and for the same reason. This step runs
 * milliseconds after the probe's first success, against the same origin, so it lands
 * inside the startup window the probe just spent seconds riding out. A single unretried
 * sample there reports a working A100 as a dead one.
 */
export async function fetchGpuReport({
  url,
  budgetMs = GPU_BUDGET_MS,
  attemptTimeoutMs = GPU_ATTEMPT_TIMEOUT_MS,
  fetchImpl = fetch,
  now = () => Date.now(),
  sleep = defaultSleep,
}) {
  const deadline = now() + budgetMs;
  const attempts = [];
  let last;

  for (let round = 0; ; round += 1) {
    const remaining = deadline - now();
    // The first attempt always runs, whatever the budget. A caller that left no time
    // still deserves one sample: a record with no status at all reads as "the step
    // never ran", which is a different and less honest finding than what we saw.
    if (attempts.length > 0 && remaining <= 0) break;
    const timeoutMs =
      attempts.length === 0 ? attemptTimeoutMs : Math.min(attemptTimeoutMs, remaining);

    last = await attempt(url, timeoutMs, fetchImpl, now);
    const { body, ...evidence } = last;
    attempts.push(evidence);
    if (!transient(last)) break;

    const backoff = BACKOFF_SCHEDULE_MS[Math.min(round, BACKOFF_SCHEDULE_MS.length - 1)];
    if (now() + backoff >= deadline) break;
    await sleep(backoff);
  }

  const record = { url, attempts, lines: [], devices: [] };
  // Order matters: a res.text() that throws leaves both a status and an error, and
  // gpuFailure reports the error, which is the one that explains the missing body.
  if (last.status !== undefined) record.status = last.status;
  if (last.error !== undefined) record.error = last.error;
  if (last.body !== undefined) {
    record.body = last.body;
    Object.assign(record, parseGpuCsv(last.body));
  }
  return record;
}

const GPU_CHECKS = [
  {
    bad: (r) => !r,
    message: () =>
      "the gpu-check step started but recorded no result, so the run cannot say whether a GPU was present",
  },
  {
    bad: (r) => r.error !== undefined,
    message: (r) =>
      `the GPU report at ${r.url} could not be fetched although the same origin had just served the probe: ${r.error}`,
  },
  // Split on who produced the status. A 5xx comes from the provider's ingress with no
  // healthy backend behind it and is path-independent, so it is evidence about the
  // provider, not about nvidia-smi. Reporting it as a missing file sent a day of
  // debugging after the SDL when the workload had been fine.
  {
    bad: (r) => r.status >= 500,
    message: (r) =>
      `the GPU report at ${r.url} answered ${r.status} on all ${r.attempts?.length ?? 1} attempt(s) over the probe budget: the provider's ingress kept the route but never had a healthy backend behind it again after the probe reached it once`,
  },
  {
    bad: (r) => r.status !== 200,
    message: (r) =>
      `the GPU report at ${r.url} answered ${r.status}, not 200, although the same origin served the probe, so the workload is serving but nvidia-smi's output is not at the path the SDL writes it to`,
  },
  {
    bad: (r) => r.lines.length === 0,
    message: (r) => `the GPU report at ${r.url} is empty, so nvidia-smi wrote nothing at all`,
  },
  // Both this and the previous check are "zero devices", split on whether the body had
  // any content at all. Keep that split: a further check below them could never fire,
  // since any record with devices.length === 0 is already caught by one of these two.
  {
    bad: (r) => r.devices.length === 0,
    // The first line is quoted because the cause lives inside a container nobody can
    // reach once the lease closes, so the error text is the only diagnosis a reader will
    // ever get.
    message: (r) =>
      `the GPU report at ${r.url} is not nvidia-smi CSV: none of its ${r.lines.length} non-blank line(s) carries the four queried fields, and the first reads ${quote(r.lines[0])}`,
  },
];

export function gpuFailure(record) {
  for (const check of GPU_CHECKS) {
    if (check.bad(record)) return check.message(record);
  }
  return null;
}
