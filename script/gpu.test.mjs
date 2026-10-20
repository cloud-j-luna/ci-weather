import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fetchGpuReport, gpuFailure, parseGpuCsv } from "./lib/gpu.mjs";

describe("parseGpuCsv", () => {
  const cases = [
    {
      name: "a single A100 row parses one device with memory in MiB",
      body: "NVIDIA A100-SXM4-80GB, 535.183.01, 81920 MiB, 8.0",
      lines: 1,
      devices: [
        {
          name: "NVIDIA A100-SXM4-80GB",
          driverVersion: "535.183.01",
          memoryTotalMiB: 81920,
          computeCapability: "8.0",
        },
      ],
    },
    {
      name: "CRLF line endings split cleanly into two devices",
      body:
        "NVIDIA A100-SXM4-80GB, 535.183.01, 81920 MiB, 8.0\r\n" +
        "NVIDIA A100-SXM4-80GB, 535.183.01, 81920 MiB, 8.0",
      lines: 2,
      devices: 2,
    },
    {
      name: "two byte-identical rows are not deduplicated",
      body:
        "NVIDIA A100-SXM4-80GB, 535.183.01, 81920 MiB, 8.0\n" +
        "NVIDIA A100-SXM4-80GB, 535.183.01, 81920 MiB, 8.0",
      lines: 2,
      devices: 2,
    },
    {
      name: "a missing binary produces one line and no device",
      body: "sh: nvidia-smi: command not found",
      lines: 1,
      devices: 0,
    },
    {
      name: "nvidia-smi's own header row ahead of a real row still yields one device",
      body:
        "name, driver_version, memory.total [MiB], compute_cap\n" +
        "NVIDIA A100-SXM4-80GB, 535.183.01, 81920 MiB, 8.0",
      lines: 2,
      devices: 1,
    },
    {
      name: "the header row alone is the false green: zero devices, not one",
      body: "name, driver_version, memory.total [MiB], compute_cap",
      lines: 1,
      devices: 0,
    },
    {
      name: "an NVML init failure produces one line and no device",
      body: "Failed to initialize NVML: Driver/library version mismatch",
      lines: 1,
      devices: 0,
    },
    {
      name: "a warning line beside a good row drops the warning but keeps the device",
      body:
        "nvidia-smi has failed because it couldn't communicate with the NVIDIA driver.\n" +
        "NVIDIA A100-SXM4-80GB, 535.183.01, 81920 MiB, 8.0",
      lines: 2,
      devices: 1,
    },
    {
      name: "[N/A] in the memory field is kept as a device with memoryTotalMiB absent",
      body: "NVIDIA A100-SXM4-80GB, 535.183.01, [N/A], 8.0",
      lines: 1,
      devices: [
        {
          name: "NVIDIA A100-SXM4-80GB",
          driverVersion: "535.183.01",
          computeCapability: "8.0",
        },
      ],
    },
    {
      name: "the nounits form (no MiB suffix) still parses the memory figure",
      body: "NVIDIA A100-SXM4-80GB, 535.183.01, 81920, 8.0",
      lines: 1,
      devices: [
        {
          name: "NVIDIA A100-SXM4-80GB",
          driverVersion: "535.183.01",
          memoryTotalMiB: 81920,
          computeCapability: "8.0",
        },
      ],
    },
    {
      name: "an empty body has no lines and no devices",
      body: "",
      lines: 0,
      devices: 0,
    },
    {
      name: "blank lines alone have no lines and no devices",
      body: "   \n  \n",
      lines: 0,
      devices: 0,
    },
    {
      name: "a row with an empty field is dropped entirely",
      body: ", , , 8.0",
      lines: 1,
      devices: 0,
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const result = parseGpuCsv(c.body);
      assert.equal(result.lines.length, c.lines);
      if (Array.isArray(c.devices)) assert.deepEqual(result.devices, c.devices);
      else assert.equal(result.devices.length, c.devices);
    });
  }
});

describe("gpuFailure", () => {
  const cleanRecord = {
    url: "http://host/gpu.csv",
    status: 200,
    lines: ["NVIDIA A100-SXM4-80GB, 535.183.01, 81920 MiB, 8.0"],
    devices: [
      {
        name: "NVIDIA A100-SXM4-80GB",
        driverVersion: "535.183.01",
        memoryTotalMiB: 81920,
        computeCapability: "8.0",
      },
    ],
  };

  const cases = [
    { name: "a clean record passes", record: cleanRecord, want: null },
    {
      name: "no record at all, the step never ran",
      record: null,
      want: /recorded no result/,
    },
    {
      name: "a fetch error",
      record: { url: "http://host/gpu.csv", error: "ECONNRESET" },
      want: /could not be fetched.*ECONNRESET/,
    },
    {
      name: "a 404, which the origin itself produced",
      record: { url: "http://host/gpu.csv", status: 404, lines: [], devices: [] },
      want: /answered 404, not 200.*not at the path the SDL writes it to/s,
    },
    {
      // The 2026-10-20 gpu run. Reporting this as "served its index page but not the
      // nvidia-smi output" pointed at the SDL, when the SDL writes both files before it
      // starts the server and the provider's ingress was simply between backends.
      name: "a 5xx, which the provider's ingress produced and which is not about the path",
      record: {
        url: "http://host/gpu.csv",
        status: 503,
        attempts: [{ at: "2026-10-20T08:02:02.652Z", durationMs: 129, status: 503 }],
        lines: [],
        devices: [],
      },
      want: /answered 503 on all 1 attempt\(s\).*ingress kept the route but never had a healthy backend/s,
    },
    {
      name: "an empty body",
      record: { url: "http://host/gpu.csv", status: 200, lines: [], devices: [] },
      want: /is empty/,
    },
    {
      name: "a body that is not nvidia-smi CSV",
      record: {
        url: "http://host/gpu.csv",
        status: 200,
        lines: ["sh: nvidia-smi: command not found"],
        devices: [],
      },
      want: /is not nvidia-smi CSV.*command not found/,
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const got = gpuFailure(c.record);
      if (c.want === null) assert.equal(got, null);
      else assert.match(got, c.want);
    });
  }
});

describe("fetchGpuReport", () => {
  // budgetMs 0 pins these to a single attempt. Without it the retry loop waits out the
  // whole default budget on real timers for every case that never succeeds, which put
  // 30s of sleeping into the suite. Patience itself is covered below, on a fake clock.
  it("never throws when fetchImpl throws, and records the error instead", async () => {
    const record = await fetchGpuReport({
      url: "http://host/gpu.csv",
      budgetMs: 0,
      fetchImpl: async () => {
        throw new Error("network is unreachable");
      },
    });
    assert.equal(record.url, "http://host/gpu.csv");
    assert.equal(record.error, "network is unreachable");
    assert.deepEqual(record.devices, []);
  });

  it("parses a successful response into status, lines and devices", async () => {
    const record = await fetchGpuReport({
      url: "http://host/gpu.csv",
      fetchImpl: async () => ({
        status: 200,
        text: async () => "NVIDIA A100-SXM4-80GB, 535.183.01, 81920 MiB, 8.0",
      }),
    });
    assert.equal(record.status, 200);
    assert.equal(record.devices.length, 1);
    assert.equal(record.error, undefined);
  });

  it("records a non-200 status without throwing", async () => {
    const record = await fetchGpuReport({
      url: "http://host/gpu.csv",
      budgetMs: 0,
      fetchImpl: async () => ({ status: 404, text: async () => "not found" }),
    });
    assert.equal(record.status, 404);
    assert.deepEqual(record.devices, []);
  });
});

describe("fetchGpuReport patience", () => {
  const csv = "NVIDIA A100-SXM4-80GB, 580.126.20, 81920 MiB, 8.0";

  function clock() {
    let t = 0;
    return {
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      advance: (ms) => {
        t += ms;
      },
    };
  }

  it("rides out the startup 503s that killed the 2026-10-20 run, and reports the GPU", async () => {
    const c = clock();
    let n = 0;
    const record = await fetchGpuReport({
      url: "http://host/gpu.csv",
      budgetMs: 30000,
      now: c.now,
      sleep: c.sleep,
      fetchImpl: async () => {
        n += 1;
        c.advance(100);
        if (n <= 7) return { status: 503, text: async () => "no healthy upstream" };
        return { status: 200, text: async () => csv };
      },
    });
    assert.equal(record.status, 200);
    assert.equal(record.devices.length, 1);
    assert.equal(record.devices[0].name, "NVIDIA A100-SXM4-80GB");
    assert.equal(gpuFailure(record), null);
    assert.equal(record.attempts.length, 8, "every attempt is recorded, so flapping is visible");
    assert.equal(record.attempts[0].status, 503);
    assert.equal(record.attempts.at(-1).status, 200);
  });

  it("retries a transport error too, since that is the same origin not answering", async () => {
    const c = clock();
    let n = 0;
    const record = await fetchGpuReport({
      url: "http://host/gpu.csv",
      budgetMs: 30000,
      now: c.now,
      sleep: c.sleep,
      fetchImpl: async () => {
        n += 1;
        c.advance(100);
        if (n === 1) throw new Error("fetch failed");
        return { status: 200, text: async () => csv };
      },
    });
    assert.equal(record.error, undefined);
    assert.equal(record.devices.length, 1);
    assert.equal(record.attempts.length, 2);
  });

  it("does not retry a 404, which is the origin answering that the file is not there", async () => {
    const c = clock();
    let n = 0;
    const record = await fetchGpuReport({
      url: "http://host/gpu.csv",
      budgetMs: 30000,
      now: c.now,
      sleep: c.sleep,
      fetchImpl: async () => {
        n += 1;
        c.advance(100);
        return { status: 404, text: async () => "not found" };
      },
    });
    assert.equal(n, 1, "a real answer from the workload is a finding, not something to wait out");
    assert.equal(record.status, 404);
    assert.match(gpuFailure(record), /answered 404/);
  });

  it("gives up at the budget and reports the last 5xx rather than hanging", async () => {
    const c = clock();
    let n = 0;
    const record = await fetchGpuReport({
      url: "http://host/gpu.csv",
      budgetMs: 3000,
      now: c.now,
      sleep: c.sleep,
      fetchImpl: async () => {
        n += 1;
        c.advance(100);
        return { status: 503, text: async () => "no healthy upstream" };
      },
    });
    assert.ok(c.now() <= 3000 + 5000, `stopped near the budget, not after ${c.now()}ms`);
    assert.ok(n > 1 && n < 50, `retried but bounded, got ${n} attempts`);
    assert.equal(record.status, 503);
    assert.match(gpuFailure(record), /answered 503 on all/);
  });

  it("still takes one sample when the budget is already spent", async () => {
    const c = clock();
    const record = await fetchGpuReport({
      url: "http://host/gpu.csv",
      budgetMs: 0,
      now: c.now,
      sleep: c.sleep,
      fetchImpl: async () => ({ status: 503, text: async () => "" }),
    });
    assert.equal(record.attempts.length, 1);
    assert.equal(record.status, 503, "a sample, not 'the step never ran'");
  });
});
