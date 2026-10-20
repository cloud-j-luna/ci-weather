// Exported so gpu-check waits on the same schedule. The two steps ask the same origin
// the same question, and a workload that is still starting answers both the same way.
export const BACKOFF_SCHEDULE_MS = [250, 500, 1000, 2000];

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function attempt(
  scheme,
  host,
  path,
  expectStatus,
  expectBodyContains,
  deadline,
  attemptTimeoutMs,
  fetchImpl,
  now,
) {
  const url = `${scheme}://${host}${path}`;
  const startMs = now();
  const remaining = deadline - startMs;
  if (remaining <= 0) return null;

  const timeoutMs = Math.min(attemptTimeoutMs, remaining);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const record = { scheme, url, at: new Date(startMs).toISOString() };

  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    record.durationMs = Math.max(0, Math.round(now() - startMs));
    record.status = res.status;
    let success = res.status === expectStatus;
    if (expectBodyContains !== undefined) {
      const body = await res.text();
      record.bodyMatched = body.includes(expectBodyContains);
      success = success && record.bodyMatched;
    }
    return { record, success };
  } catch (err) {
    record.durationMs = Math.max(0, Math.round(now() - startMs));
    record.error = err.message;
    return { record, success: false };
  } finally {
    clearTimeout(timer);
  }
}

export async function probe({
  uris,
  path,
  expectStatus,
  expectBodyContains,
  budgetMs,
  attemptTimeoutMs = 5000,
  fetchImpl = fetch,
  now = () => Date.now(),
  sleep = defaultSleep,
}) {
  const attempts = [];
  const deadline = now() + budgetMs;
  const host = uris[0];
  // Without this an empty list dials the literal string "https://undefined/" and
  // reports a DNS failure, which reads as the workload being unreachable rather than
  // as us never having had an address to reach.
  if (typeof host !== "string" || host.length === 0) {
    return { attempts, error: "the lease reported no address to probe" };
  }
  let round = 0;

  for (;;) {
    for (const scheme of ["https", "http"]) {
      if (now() >= deadline) return { attempts };
      const outcome = await attempt(
        scheme,
        host,
        path,
        expectStatus,
        expectBodyContains,
        deadline,
        attemptTimeoutMs,
        fetchImpl,
        now,
      );
      if (outcome === null) return { attempts };
      attempts.push(outcome.record);
      if (outcome.success) return { attempts, servedBy: scheme, url: outcome.record.url };
    }

    if (now() >= deadline) return { attempts };
    const backoff = BACKOFF_SCHEDULE_MS[Math.min(round, BACKOFF_SCHEDULE_MS.length - 1)];
    round += 1;
    await sleep(backoff);
  }
}
