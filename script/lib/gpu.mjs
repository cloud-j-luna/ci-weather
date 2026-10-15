const GPU_FETCH_TIMEOUT_MS = 5000;
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

/**
 * MUST NEVER THROW. A throw here reaches runScenario's outer catch, which seals the run
 * as "runner error", and scenarios.yaml excludes aborted runs from BOTH sides of the pass
 * rate, so a real GPU failure would become no data at all.
 */
export async function fetchGpuReport({ url, timeoutMs = GPU_FETCH_TIMEOUT_MS, fetchImpl = fetch }) {
  const record = { url, lines: [], devices: [] };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    record.status = res.status;
    record.body = await res.text();
    Object.assign(record, parseGpuCsv(record.body));
  } catch (e) {
    record.error = e.message;
  } finally {
    clearTimeout(timer);
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
  {
    bad: (r) => r.status !== 200,
    message: (r) =>
      `the GPU report at ${r.url} answered ${r.status}, not 200, so the workload served its index page but not the nvidia-smi output`,
  },
  {
    bad: (r) => r.lines.length === 0,
    message: (r) => `the GPU report at ${r.url} is empty, so nvidia-smi wrote nothing at all`,
  },
  // Both this and the previous check are "zero devices", split on whether the body had
  // any content at all. Keep that split: a sixth check here could never fire, since any
  // record with devices.length === 0 is already caught by one of these two.
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
