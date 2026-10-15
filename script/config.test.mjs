import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { depositPlan, loadConfig } from "./lib/config.mjs";

function baseScenarios() {
  return [
    { id: "scenario-a", sdl: "sdl/a.yaml", probe: { path: "/", expectStatus: 200 } },
    { id: "scenario-b", sdl: "sdl/b.yaml", probe: { path: "/", expectStatus: 200 } },
  ];
}

function withDeposit(index, value) {
  const scenarios = baseScenarios();
  scenarios[index].deposit = value;
  return scenarios;
}

function withBidAttempts(index, value) {
  const scenarios = baseScenarios();
  scenarios[index].bidAttempts = value;
  return scenarios;
}

function makeRepo(over = {}) {
  const root = mkdtempSync(join(tmpdir(), "config-"));
  const scenariosDir = join(root, "scenarios");
  mkdirSync(join(scenariosDir, "sdl"), { recursive: true });

  const budgets = {
    bidTimeout: "5m",
    leaseReadyTimeout: "8m",
    probeTimeout: "30s",
    totalRunTimeout: "25m",
    deposit: "1000000uact",
    ...over.budgets,
  };
  for (const key of Object.keys(budgets)) {
    if (budgets[key] === undefined) delete budgets[key];
  }

  const scenarios = over.scenarios ?? baseScenarios();
  for (const sc of scenarios) {
    writeFileSync(join(scenariosDir, sc.sdl), "");
  }
  writeFileSync(join(scenariosDir, "scenarios.yaml"), stringify({ budgets, scenarios }));
  return root;
}

describe("loadConfig, deposit", () => {
  it("budgets.deposit with no scenario override applies to every scenario", () => {
    const config = loadConfig(makeRepo());
    for (const id of ["scenario-a", "scenario-b"]) {
      assert.equal(config.scenarios.get(id).deposit, "1000000uact");
    }
  });

  it("a scenario-level deposit overrides the budget value for that scenario only", () => {
    const config = loadConfig(makeRepo({ scenarios: withDeposit(0, "2000000uact") }));

    assert.equal(config.scenarios.get("scenario-a").deposit, "2000000uact");
    assert.equal(config.scenarios.get("scenario-b").deposit, "1000000uact");
  });

  it('"auto" is accepted at the budget level and carried through to every scenario', () => {
    const config = loadConfig(makeRepo({ budgets: { deposit: "auto" } }));
    for (const id of ["scenario-a", "scenario-b"]) {
      assert.equal(config.scenarios.get(id).deposit, "auto");
    }
  });

  const invalidCases = [
    {
      name: "missing the uact suffix",
      over: { budgets: { deposit: "1000000" } },
      expect: /budgets/,
    },
    { name: "missing digits", over: { scenarios: withDeposit(0, "uact") }, expect: /scenario-a/ },
    {
      name: '"auto-ish" is not exactly "auto"',
      over: { budgets: { deposit: "auto-ish" } },
      expect: /budgets/,
    },
    {
      name: "a bare number instead of a string",
      over: { scenarios: withDeposit(1, 1000000) },
      expect: /scenario-b/,
    },
    {
      name: "omitted at the budget level with no scenario override",
      over: { budgets: { deposit: undefined } },
      expect: /budgets/,
    },
  ];

  for (const c of invalidCases) {
    it(`rejects a deposit that is ${c.name}`, () => {
      assert.throws(() => loadConfig(makeRepo(c.over)), c.expect);
    });
  }
});

describe("loadConfig, bidAttempts", () => {
  it("defaults to 3 when absent from both budgets and the scenario", () => {
    const config = loadConfig(makeRepo());
    assert.equal(config.budgets.bidAttempts, 3);
    for (const id of ["scenario-a", "scenario-b"]) {
      assert.equal(config.scenarios.get(id).bidAttempts, 3);
    }
  });

  it("a scenario-level bidAttempts overrides the budget value for that scenario only", () => {
    const config = loadConfig(makeRepo({ scenarios: withBidAttempts(0, 5) }));

    assert.equal(config.scenarios.get("scenario-a").bidAttempts, 5);
    assert.equal(config.scenarios.get("scenario-b").bidAttempts, 3);
  });

  it("rejects a bidAttempts below 1", () => {
    assert.throws(() => loadConfig(makeRepo({ scenarios: withBidAttempts(0, 0) })), /scenario-a/);
  });
});

describe("depositPlan", () => {
  it("sums every scenario's deposit, resolving auto per network, and doubles it for the balance floor", () => {
    const scenarios = baseScenarios();
    scenarios[0].deposit = "1000000uact";
    scenarios[1].deposit = "auto";
    const config = loadConfig(makeRepo({ scenarios }));

    const sandboxPlan = depositPlan(config, "sandbox-2");
    const mainnetPlan = depositPlan(config, "mainnet");

    assert.equal(sandboxPlan.total, 1500000n);
    assert.equal(sandboxPlan.floor, 3000000n);
    assert.equal(mainnetPlan.total, 21000000n);
    assert.equal(mainnetPlan.floor, 42000000n);
    assert.notEqual(sandboxPlan.floor, mainnetPlan.floor);
    assert.deepEqual(sandboxPlan.scenarios, [
      { id: "scenario-a", uact: 1000000n },
      { id: "scenario-b", uact: 500000n },
    ]);
  });
});

describe("loadConfig, gpuCheck", () => {
  it("absent leaves scenario.gpuCheck undefined", () => {
    const config = loadConfig(makeRepo());
    assert.equal(config.scenarios.get("scenario-a").gpuCheck, undefined);
  });

  it("an empty object defaults path to /gpu.csv", () => {
    const scenarios = baseScenarios();
    scenarios[0].gpuCheck = {};
    const config = loadConfig(makeRepo({ scenarios }));
    assert.deepEqual(config.scenarios.get("scenario-a").gpuCheck, { path: "/gpu.csv" });
  });

  it("an explicit path is kept", () => {
    const scenarios = baseScenarios();
    scenarios[0].gpuCheck = { path: "/nvidia-smi.csv" };
    const config = loadConfig(makeRepo({ scenarios }));
    assert.deepEqual(config.scenarios.get("scenario-a").gpuCheck, { path: "/nvidia-smi.csv" });
  });

  it("rejects a relative path", () => {
    const scenarios = baseScenarios();
    scenarios[0].gpuCheck = { path: "gpu.csv" };
    assert.throws(() => loadConfig(makeRepo({ scenarios })), /scenario-a/);
  });

  it("rejects an absolute URL, which would silently ignore the probe's own origin", () => {
    const scenarios = baseScenarios();
    scenarios[0].gpuCheck = { path: "http://evil.test/gpu.csv" };
    assert.throws(() => loadConfig(makeRepo({ scenarios })), /scenario-a/);
  });

  it("rejects an unknown key", () => {
    const scenarios = baseScenarios();
    scenarios[0].gpuCheck = { path: "/gpu.csv", timeout: "5s" };
    assert.throws(() => loadConfig(makeRepo({ scenarios })), /scenario-a/);
  });

  it("rejects an array", () => {
    const scenarios = baseScenarios();
    scenarios[0].gpuCheck = [];
    assert.throws(() => loadConfig(makeRepo({ scenarios })), /scenario-a/);
  });

  it("rejects null", () => {
    const scenarios = baseScenarios();
    scenarios[0].gpuCheck = null;
    assert.throws(() => loadConfig(makeRepo({ scenarios })), /scenario-a/);
  });
});

describe("loadConfig, probe.target", () => {
  const cases = [
    { name: "defaults to uri when absent", target: undefined, expectTarget: "uri" },
    { name: "accepts ip", target: "ip", expectTarget: "ip" },
    { name: "rejects an unknown target", target: "gpu", throws: /scenario-a: probe\.target/ },
    { name: "rejects a target with trailing whitespace", target: "ip ", throws: /scenario-a/ },
    { name: "rejects a numeric target", target: 5, throws: /scenario-a/ },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const scenarios = baseScenarios();
      const probe = { path: "/", expectStatus: 200 };
      if (c.target !== undefined) probe.target = c.target;
      scenarios[0].probe = probe;
      const root = makeRepo({ scenarios });

      if (c.throws) {
        assert.throws(() => loadConfig(root), c.throws);
      } else {
        const config = loadConfig(root);
        assert.equal(config.scenarios.get("scenario-a").probe.target, c.expectTarget);
      }
    });
  }
});
