import {
  readFileSync,
  readdirSync,
  existsSync,
  statSync,
  mkdirSync,
  copyFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, extname, sep } from "node:path";
import { createServer } from "node:http";
import { parse as parseYaml } from "yaml";

const root = new URL("..", import.meta.url).pathname;

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { source: "data/runs", out: "site/dist", serve: false, port: 8080 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--source") args.source = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--serve") args.serve = true;
    else if (a === "--port") args.port = Number(argv[++i]);
    else fail(`unrecognised argument: ${a}`);
  }
  if (args.source === undefined) fail("--source needs a value");
  if (args.out === undefined) fail("--out needs a value");
  if (args.serve && !Number.isInteger(args.port)) fail("--port needs an integer value");
  return args;
}

function validateScenariosConfig(cfg) {
  const problems = [];
  const lookbackDays = cfg?.weather?.lookbackDays;
  if (!(Number.isInteger(lookbackDays) && lookbackDays > 0)) {
    problems.push("weather.lookbackDays must be a positive integer");
  }
  const denominator = cfg?.weather?.passRate?.denominator;
  if (denominator !== "days-with-a-run") {
    problems.push(
      `weather.passRate.denominator must be "days-with-a-run", got ${JSON.stringify(denominator)}`,
    );
  }
  const thresholds = cfg?.weather?.thresholds;
  const thresholdsOk =
    Array.isArray(thresholds) &&
    thresholds.length > 0 &&
    thresholds.every(
      (t) =>
        t &&
        Number.isInteger(t.minPassRate) &&
        typeof t.icon === "string" &&
        typeof t.label === "string",
    );
  if (!thresholdsOk) {
    problems.push(
      "weather.thresholds must be a non-empty array of {minPassRate:int, icon:string, label:string}",
    );
  }
  const scenarios = cfg?.scenarios;
  const scenariosOk =
    Array.isArray(scenarios) &&
    scenarios.length > 0 &&
    scenarios.every((s) => s && typeof s.id === "string" && typeof s.title === "string");
  if (!scenariosOk) {
    problems.push("scenarios must be a non-empty array of entries with id and title");
  }
  return problems;
}

function readStepOrder() {
  const schema = JSON.parse(readFileSync(join(root, "schema/run.schema.json"), "utf8"));
  const stepOrder = schema?.$defs?.step?.examples;
  if (!Array.isArray(stepOrder) || stepOrder.length === 0) {
    fail("schema/run.schema.json: $defs.step.examples must be a non-empty array");
  }
  return stepOrder;
}

function collectRuns(sourceDir) {
  const byDir = new Map();
  if (!existsSync(sourceDir)) {
    console.error(`warning: source directory ${sourceDir} does not exist`);
    return byDir;
  }
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dirPath = join(sourceDir, entry.name);
    const runs = [];
    // The runner writes <scenario>/<runId>/run.json beside its sidecar logs, while the
    // fixture corpus is flat <scenario>/<day>.json. validate-runs.mjs accepts both, so
    // the build must glob identically or production reads an empty directory.
    const candidates = [];
    for (const f of readdirSync(dirPath)) {
      const entry = join(dirPath, f);
      if (f.endsWith(".json")) candidates.push(entry);
      else if (statSync(entry).isDirectory()) candidates.push(join(entry, "run.json"));
    }
    for (const filePath of candidates.filter((f) => existsSync(f)).sort()) {
      let run;
      try {
        run = JSON.parse(readFileSync(filePath, "utf8"));
      } catch (err) {
        fail(`failed to parse ${filePath}: ${err.message}`);
      }
      if (typeof run.startedAt !== "string" || run.startedAt.length < 10) {
        fail(`${filePath}: missing or invalid startedAt`);
      }
      runs.push({ file: filePath, run, day: run.startedAt.slice(0, 10) });
    }
    byDir.set(entry.name, runs);
  }
  if ([...byDir.values()].every((runs) => runs.length === 0)) {
    console.error(`warning: no runs found under ${sourceDir}`);
  }
  return byDir;
}

function computeAnchor(byDir) {
  let latest = null;
  for (const runs of byDir.values()) {
    for (const r of runs) if (latest === null || r.day > latest) latest = r.day;
  }
  const today = new Date().toISOString().slice(0, 10);
  // Anchoring only on the latest run would hide a canary that stopped running days
  // ago; anchoring only on today would make an aging fixture build go blank.
  return latest !== null && latest > today ? latest : today;
}

function windowDays(anchor, lookbackDays) {
  const [y, m, d] = anchor.split("-").map(Number);
  const anchorMs = Date.UTC(y, m - 1, d);
  const days = [];
  for (let i = lookbackDays - 1; i >= 0; i--) {
    days.push(new Date(anchorMs - i * 86400000).toISOString().slice(0, 10));
  }
  return days;
}

function buildScenarios(registry, byDir, days) {
  const daySet = new Set(days);
  const networks = new Map();
  const scenarios = registry.map((reg) => {
    const inWindow = (byDir.get(reg.id) ?? []).filter((r) => daySet.has(r.day));
    const byDay = new Map();
    for (const r of inWindow) {
      const existing = byDay.get(r.day);
      if (!existing) {
        byDay.set(r.day, r);
        continue;
      }
      const [kept, dropped] =
        new Date(r.run.startedAt) > new Date(existing.run.startedAt)
          ? [r, existing]
          : [existing, r];
      console.error(
        `warning: duplicate run for ${reg.id} on ${r.day}: keeping ${kept.file}, dropping ${dropped.file}`,
      );
      byDay.set(r.day, kept);
    }
    const cells = days.map((day) => {
      const entry = byDay.get(day);
      if (!entry) return null;
      const net = entry.run.network;
      if (net && net.name !== undefined && net.chainId !== undefined) {
        networks.set(`${net.name}\u0000${net.chainId}`, net);
      }
      return entry.run;
    });
    return {
      id: reg.id,
      title: reg.title,
      question: reg.question ?? "",
      tags: reg.tags ?? [],
      cells,
    };
  });
  const registeredIds = new Set(registry.map((r) => r.id));
  const unregisteredScenarios = [...byDir.keys()].filter((id) => !registeredIds.has(id)).sort();
  return { scenarios, networks: [...networks.values()], unregisteredScenarios };
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function serve(outDir, port) {
  const server = createServer((req, res) => {
    const urlPath = decodeURIComponent(req.url.split("?")[0]);
    const relPath = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
    const filePath = resolve(outDir, relPath);
    if (filePath !== outDir && !filePath.startsWith(outDir + sep)) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    let body;
    try {
      body = readFileSync(filePath);
    } catch {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[extname(filePath)] ?? "application/octet-stream" });
    res.end(body);
  });
  server.listen(port, () => {
    console.log(`serving ${outDir} at http://localhost:${port}/`);
  });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const sourceDir = resolve(root, args.source);
  const outDir = resolve(root, args.out);

  const stepOrder = readStepOrder();

  let scenariosConfig;
  try {
    scenariosConfig = parseYaml(readFileSync(join(root, "scenarios/scenarios.yaml"), "utf8"));
  } catch (err) {
    fail(`failed to parse scenarios/scenarios.yaml: ${err.message}`);
  }
  const problems = validateScenariosConfig(scenariosConfig);
  if (problems.length > 0) {
    for (const p of problems) console.error(`error: ${p}`);
    process.exit(1);
  }

  const thresholds = [...scenariosConfig.weather.thresholds].sort(
    (a, b) => b.minPassRate - a.minPassRate,
  );

  const byDir = collectRuns(sourceDir);
  const anchor = computeAnchor(byDir);
  const days = windowDays(anchor, scenariosConfig.weather.lookbackDays);
  const { scenarios, networks, unregisteredScenarios } = buildScenarios(
    scenariosConfig.scenarios,
    byDir,
    days,
  );

  const data = {
    generatedAt: new Date().toISOString(),
    source: args.source,
    weather: {
      lookbackDays: scenariosConfig.weather.lookbackDays,
      passRateDenominator: scenariosConfig.weather.passRate.denominator,
      thresholds,
    },
    stepOrder,
    days,
    networks,
    scenarios,
    unregisteredScenarios,
  };

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "data.json"), JSON.stringify(data, null, 1) + "\n");

  for (const name of ["index.html", "app.js", "style.css"]) {
    const src = join(root, "site", name);
    if (existsSync(src)) copyFileSync(src, join(outDir, name));
    else console.error(`warning: site/${name} is missing, skipping`);
  }

  if (args.serve) serve(outDir, args.port);
}

main();
