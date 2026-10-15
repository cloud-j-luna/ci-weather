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
      name: "a non-200 status",
      record: { url: "http://host/gpu.csv", status: 404, lines: [], devices: [] },
      want: /answered 404, not 200/,
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
  it("never throws when fetchImpl throws, and records the error instead", async () => {
    const record = await fetchGpuReport({
      url: "http://host/gpu.csv",
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
      fetchImpl: async () => ({ status: 404, text: async () => "not found" }),
    });
    assert.equal(record.status, 404);
    assert.deepEqual(record.devices, []);
  });
});
