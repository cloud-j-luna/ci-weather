import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { leaseAttestation, leaseStatus } from "./lib/akt.mjs";

function fakeAkt({ argvLog, stdout = "", stderr = "", exitCode = 0 }) {
  return `#!/usr/bin/env node
import { appendFileSync } from "node:fs";

const argv = process.argv.slice(2);
appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(argv) + "\\n");
process.stdout.write(${JSON.stringify(stdout)});
process.stderr.write(${JSON.stringify(stderr)});
process.exitCode = ${exitCode};
`;
}

function build(dir, name, opts) {
  const argvLog = join(dir, `${name}-argv.log`);
  const bin = join(dir, `${name}-akt.mjs`);
  writeFileSync(bin, fakeAkt({ argvLog, ...opts }));
  chmodSync(bin, 0o755);
  return { bin, argvLog };
}

describe("leaseStatus", () => {
  const dir = mkdtempSync(join(tmpdir(), "akt-lease-status-"));

  it("parses a populated ips array, mapping external_port to externalPort", async () => {
    const { bin } = build(dir, "populated", {
      stdout: JSON.stringify({
        ips: [{ port: 80, external_port: 30001, protocol: "TCP", ip: "45.33.12.7" }],
        forwarded_ports: null,
      }),
    });

    const status = await leaseStatus(bin, "sandbox-2", "5715077");

    assert.deepEqual(status, {
      ips: [{ ip: "45.33.12.7", port: 80, externalPort: 30001, protocol: "TCP" }],
    });
  });

  it("parses ips: null into an empty array", async () => {
    const { bin } = build(dir, "null-ips", {
      stdout: JSON.stringify({ ips: null, forwarded_ports: null }),
    });

    const status = await leaseStatus(bin, "sandbox-2", "5715077");

    assert.deepEqual(status, { ips: [] });
  });

  it("drops an entry missing a field, so a half-reported endpoint reads as no IP rather than crashing the run", async () => {
    const { bin } = build(dir, "incomplete", {
      stdout: JSON.stringify({
        ips: [
          { port: 80, protocol: "TCP", ip: "45.33.12.7" },
          { port: 80, external_port: 30002, protocol: "TCP", ip: "45.33.12.8" },
        ],
      }),
    });

    const status = await leaseStatus(bin, "sandbox-2", "5715077");

    assert.deepEqual(status, {
      ips: [{ ip: "45.33.12.8", port: 80, externalPort: 30002, protocol: "TCP" }],
    });
  });

  it("passes the dseq positionally and the context as --context", async () => {
    const { bin, argvLog } = build(dir, "argv", {
      stdout: JSON.stringify({ ips: null }),
    });

    await leaseStatus(bin, "sandbox-2", "5715077");

    const argv = JSON.parse(readFileSync(argvLog, "utf8").trim());
    assert.deepEqual(argv, [
      "provider",
      "lease-status",
      "5715077",
      "--context",
      "sandbox-2",
      "-o",
      "json",
    ]);
  });

  it("rejects with the binary's stderr text on a non-zero exit, like the other helpers", async () => {
    const { bin } = build(dir, "fail", {
      stderr: "rpc error: lease not found\n",
      exitCode: 1,
    });

    await assert.rejects(
      () => leaseStatus(bin, "sandbox-2", "5715077"),
      /rpc error: lease not found/,
    );
  });
});

describe("leaseAttestation", () => {
  const dir = mkdtempSync(join(tmpdir(), "akt-lease-attestation-"));

  const fullQuote = {
    nonce: "bm9uY2U=",
    quote: {
      report: "cmVwb3J0",
      cert_chain: "Y2VydA==",
      tee_platform: "snp-gpu",
      auxblob: "",
      gpu_reports: [{ device_index: 0, report: "cmVwb3J0" }],
      tls_bound: false,
    },
    report_size_bytes: 1184,
    nonce_verified: true,
    mock_report: false,
  };

  it("passes the dseq positionally and the context as --context", async () => {
    const { bin, argvLog } = build(dir, "argv", { stdout: JSON.stringify(fullQuote) });

    await leaseAttestation(bin, "sandbox-2", "5715077");

    const argv = JSON.parse(readFileSync(argvLog, "utf8").trim());
    assert.deepEqual(argv, [
      "provider",
      "lease-attestation",
      "5715077",
      "--context",
      "sandbox-2",
      "-o",
      "json",
    ]);
  });

  it("maps a full quote to camelCase, with certChainPresent true and gpuReportCount from the array length", async () => {
    const { bin } = build(dir, "full", { stdout: JSON.stringify(fullQuote) });

    const record = await leaseAttestation(bin, "sandbox-2", "5715077");

    assert.deepEqual(record, {
      teeType: "snp-gpu",
      nonceVerified: true,
      mockReport: false,
      certChainPresent: true,
      gpuReportCount: 1,
      reportSizeBytes: 1184,
    });
  });

  it("an empty cert_chain and an absent gpu_reports give certChainPresent false and gpuReportCount 0", async () => {
    const { bin } = build(dir, "empty", {
      stdout: JSON.stringify({
        quote: { tee_platform: "snp", cert_chain: "" },
        nonce_verified: true,
        mock_report: false,
      }),
    });

    const record = await leaseAttestation(bin, "sandbox-2", "5715077");

    assert.equal(record.certChainPresent, false);
    assert.equal(record.gpuReportCount, 0);
  });

  it("reads tee_type when tee_platform is absent", async () => {
    const { bin } = build(dir, "tee-type", {
      stdout: JSON.stringify({
        quote: { tee_type: "tdx" },
        nonce_verified: true,
        mock_report: false,
      }),
    });

    const record = await leaseAttestation(bin, "sandbox-2", "5715077");

    assert.equal(record.teeType, "tdx");
  });

  it("omits reportSizeBytes rather than inventing a number when absent", async () => {
    const { bin } = build(dir, "no-size", {
      stdout: JSON.stringify({
        quote: { tee_platform: "snp-gpu" },
        nonce_verified: true,
        mock_report: false,
      }),
    });

    const record = await leaseAttestation(bin, "sandbox-2", "5715077");

    assert.ok(!("reportSizeBytes" in record));
  });

  it("rejects with the binary's stderr text on a non-zero exit, like the other helpers", async () => {
    const { bin } = build(dir, "fail", {
      stderr: "rpc error: lease not found\n",
      exitCode: 1,
    });

    await assert.rejects(
      () => leaseAttestation(bin, "sandbox-2", "5715077"),
      /rpc error: lease not found/,
    );
  });

  it('rejects naming mock_report when it is the string "false" rather than the boolean', async () => {
    const { bin } = build(dir, "mock-string", {
      stdout: JSON.stringify({
        quote: { tee_platform: "snp-gpu" },
        nonce_verified: true,
        mock_report: "false",
      }),
    });

    await assert.rejects(() => leaseAttestation(bin, "sandbox-2", "5715077"), /mock_report/);
  });

  it("rejects naming mock_report when it is absent", async () => {
    const { bin } = build(dir, "mock-absent", {
      stdout: JSON.stringify({
        quote: { tee_platform: "snp-gpu" },
        nonce_verified: true,
      }),
    });

    await assert.rejects(() => leaseAttestation(bin, "sandbox-2", "5715077"), /mock_report/);
  });
});
