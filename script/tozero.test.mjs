import { test } from "node:test";
import assert from "node:assert/strict";
import { toZero } from "./lib/tozero.mjs";

const settle = { settleMs: 30, pollMs: 1 };

function makeAkt({ lists, closes = {} }) {
  const calls = [];
  const sleeps = [];
  const attempts = new Map();
  let nowMs = 0;
  let listIndex = 0;
  const akt = {
    async activeDeployments(bin, ctx) {
      calls.push({ fn: "activeDeployments", bin, ctx, atMs: nowMs });
      const result = lists[Math.min(listIndex, lists.length - 1)];
      listIndex += 1;
      return result;
    },
    async closeDeployment(bin, ctx, dseq) {
      calls.push({ fn: "closeDeployment", bin, ctx, dseq, atMs: nowMs });
      const configured = closes[dseq];
      if (!configured) {
        throw new Error(`the reaper tried to close ${dseq}, which this test never placed in own`);
      }
      const n = attempts.get(dseq) ?? 0;
      attempts.set(dseq, n + 1);
      return Array.isArray(configured)
        ? configured[Math.min(n, configured.length - 1)]
        : configured;
    },
  };
  const sleep = async (ms) => {
    sleeps.push(ms);
    nowMs += ms;
  };
  return { akt, calls, sleeps, sleep };
}

const closeCalls = (calls) => calls.filter((c) => c.fn === "closeDeployment");

test("a foreign deployment is never passed to close: own names none of them", async () => {
  const foreignList = [
    { dseq: "10", depositUact: "1000000" },
    { dseq: "20", depositUact: "2000000" },
    { dseq: "30", depositUact: "3000000" },
  ];
  const { akt, calls, sleep } = makeAkt({ lists: [foreignList, foreignList] });

  const result = await toZero(
    { bin: "akt", context: "sandbox-2", own: ["999"], ...settle, sleep },
    akt,
  );

  assert.deepStrictEqual(
    closeCalls(calls),
    [],
    "a dseq absent from own must never reach closeDeployment: this is the exact bug that destroyed seven mainnet deployments",
  );
  assert.deepStrictEqual(
    result.foreign,
    ["10", "20", "30"],
    "every active dseq not in own must be reported as foreign, in list order",
  );
  assert.deepStrictEqual(result.listed, []);
});

test("owned and foreign on the same account: only the owned dseqs close, foreign is reported not touched", async () => {
  const { akt, calls, sleep } = makeAkt({
    lists: [
      [
        { dseq: "100", depositUact: "5000000" },
        { dseq: "999", depositUact: "1000000" },
        { dseq: "200", depositUact: "5000000" },
      ],
      [],
    ],
    closes: {
      100: { ok: true, dseq: "100", txHash: "HASH100", errors: [], jsonl: '{"a":1}\n' },
      200: { ok: true, dseq: "200", txHash: "HASH200", errors: [], jsonl: '{"a":2}\n' },
    },
  });

  const result = await toZero(
    { bin: "akt", context: "sandbox-2", own: ["100", "200"], ...settle, sleep },
    akt,
  );

  assert.deepStrictEqual(
    closeCalls(calls).map((c) => c.dseq),
    ["100", "200"],
    "close must be issued for exactly the owned dseqs, never for the foreign one sitting between them",
  );
  assert.deepStrictEqual(result.listed, ["100", "200"]);
  assert.deepStrictEqual(result.foreign, ["999"]);
});

test("empty own issues zero closes even when the account holds many active deployments", async () => {
  const activeList = [
    { dseq: "1", depositUact: "1000000" },
    { dseq: "2", depositUact: "2000000" },
    { dseq: "3", depositUact: "3000000" },
  ];
  const { akt, calls, sleep } = makeAkt({ lists: [activeList, activeList] });

  const result = await toZero({ bin: "akt", context: "sandbox-2", own: [], ...settle, sleep }, akt);

  assert.deepStrictEqual(closeCalls(calls), []);
  assert.deepStrictEqual(result, {
    listed: [],
    foreign: ["1", "2", "3"],
    closed: [],
    stillActive: [],
    errors: [],
    jsonl: "",
  });
});

test("a foreign deployment still active at the re-list is not reported in stillActive", async () => {
  const { akt, calls, sleep } = makeAkt({
    lists: [
      [
        { dseq: "500", depositUact: "5000000" },
        { dseq: "999", depositUact: "1000000" },
      ],
      [{ dseq: "999", depositUact: "1000000" }],
    ],
    closes: {
      500: { ok: true, dseq: "500", txHash: "HASH500", errors: [], jsonl: '{"a":1}\n' },
    },
  });

  const result = await toZero(
    { bin: "akt", context: "sandbox-2", own: ["500"], ...settle, sleep },
    akt,
  );

  assert.deepStrictEqual(
    result.stillActive,
    [],
    "foreign is somebody else's deployment, not a leak: reporting it in stillActive would exit the job 1 forever",
  );
  assert.deepStrictEqual(
    closeCalls(calls).map((c) => c.dseq),
    ["500"],
  );
});

test("own is a superset from run history: a dseq in own but not currently active is never closed", async () => {
  const { akt, calls, sleep } = makeAkt({
    lists: [[{ dseq: "700", depositUact: "5000000" }], []],
    closes: {
      700: { ok: true, dseq: "700", txHash: "HASH700", errors: [], jsonl: '{"a":1}\n' },
    },
  });

  const result = await toZero(
    { bin: "akt", context: "sandbox-2", own: ["700", "701", "702"], ...settle, sleep },
    akt,
  );

  assert.deepStrictEqual(
    closeCalls(calls).map((c) => c.dseq),
    ["700"],
    "own carries dseqs from earlier runs that may have already closed or never landed: only the intersection with the active list may be closed",
  );
  assert.deepStrictEqual(result.listed, ["700"]);
});

test("consecutive closes are paced by betweenClosesMs, and a single close never pays the delay", async () => {
  const { akt, calls, sleep } = makeAkt({
    lists: [
      [
        { dseq: "100", depositUact: "5000000" },
        { dseq: "200", depositUact: "5000000" },
      ],
      [],
    ],
    closes: {
      100: { ok: true, dseq: "100", txHash: "HASH100", errors: [], jsonl: '{"a":1}\n' },
      200: { ok: true, dseq: "200", txHash: "HASH200", errors: [], jsonl: '{"a":2}\n' },
    },
  });

  await toZero(
    {
      bin: "akt",
      context: "sandbox-2",
      own: ["100", "200"],
      ...settle,
      betweenClosesMs: 7000,
      sleep,
    },
    akt,
  );

  const [first, second] = closeCalls(calls);
  assert.strictEqual(
    first.atMs,
    0,
    "a single close must never be made to pay the inter-close delay",
  );
  assert.ok(
    second.atMs - first.atMs >= 7000,
    "back-to-back closes on one account produced Cosmos code 32 and left escrow locked: the second close must wait betweenClosesMs",
  );
});

test('a close failing with "code 32" is retried once and succeeds, recording no error', async () => {
  const { akt, calls, sleep } = makeAkt({
    lists: [[{ dseq: "300", depositUact: "5000000" }], []],
    closes: {
      300: [
        { ok: false, dseq: "300", errors: ["rpc error: code 32"], jsonl: '{"attempt":1}\n' },
        { ok: true, dseq: "300", txHash: "HASH300B", errors: [], jsonl: '{"attempt":2}\n' },
      ],
    },
  });

  const result = await toZero(
    { bin: "akt", context: "sandbox-2", own: ["300"], ...settle, betweenClosesMs: 7000, sleep },
    akt,
  );

  const dseqCloses = closeCalls(calls);
  assert.strictEqual(
    dseqCloses.length,
    2,
    "a sequence-mismatch close must be retried exactly once, not looped forever and not abandoned",
  );
  assert.deepStrictEqual(result.closed, [{ dseq: "300", closeTxHash: "HASH300B" }]);
  assert.deepStrictEqual(
    result.errors,
    [],
    "a close that ultimately succeeds on retry is not an error, even though the first attempt failed",
  );
  assert.ok(
    dseqCloses[1].atMs - dseqCloses[0].atMs >= 7000,
    "the retry must wait betweenClosesMs just like any other close, or it reproduces the same sequence mismatch",
  );
});

test('a close failing with "incorrect account sequence" is retried once and succeeds', async () => {
  const { akt, calls, sleep } = makeAkt({
    lists: [[{ dseq: "400", depositUact: "5000000" }], []],
    closes: {
      400: [
        {
          ok: false,
          dseq: "400",
          errors: ["incorrect account sequence"],
          jsonl: '{"attempt":1}\n',
        },
        { ok: true, dseq: "400", txHash: "HASH400B", errors: [], jsonl: '{"attempt":2}\n' },
      ],
    },
  });

  const result = await toZero(
    { bin: "akt", context: "sandbox-2", own: ["400"], ...settle, betweenClosesMs: 7000, sleep },
    akt,
  );

  const dseqCloses = closeCalls(calls);
  assert.strictEqual(dseqCloses.length, 2);
  assert.deepStrictEqual(result.closed, [{ dseq: "400", closeTxHash: "HASH400B" }]);
  assert.deepStrictEqual(result.errors, []);
  assert.ok(dseqCloses[1].atMs - dseqCloses[0].atMs >= 7000);
});

test("a close failing with an unrelated error is not retried", async () => {
  const { akt, calls, sleep } = makeAkt({
    lists: [[{ dseq: "500", depositUact: "5000000" }], [{ dseq: "500", depositUact: "5000000" }]],
    closes: {
      500: { ok: false, dseq: "500", errors: ["rpc error: insufficient fees"], jsonl: '{"a":1}\n' },
    },
  });

  const result = await toZero(
    { bin: "akt", context: "sandbox-2", own: ["500"], ...settle, sleep },
    akt,
  );

  assert.strictEqual(
    closeCalls(calls).length,
    1,
    "only a sequence-mismatch error earns a retry: anything else must fail once and move on",
  );
  assert.deepStrictEqual(result.errors, ["rpc error: insufficient fees"]);
});

test("list runs before any close and again after: the call transcript is list, close, list", async () => {
  const { akt, calls, sleep } = makeAkt({
    lists: [[{ dseq: "700", depositUact: "5000000" }], []],
    closes: {
      700: { ok: true, dseq: "700", txHash: "HASH700", errors: [], jsonl: '{"a":1}\n' },
    },
  });

  await toZero({ bin: "akt", context: "sandbox-2", own: ["700"], ...settle, sleep }, akt);

  assert.deepStrictEqual(
    calls.map((c) => (c.fn === "closeDeployment" ? [c.fn, c.dseq] : [c.fn])),
    [["activeDeployments"], ["closeDeployment", "700"], ["activeDeployments"]],
  );
});

test("a close the chain has not committed yet is polled to convergence and never re-closed", async () => {
  const { akt, calls, sleep } = makeAkt({
    lists: [
      [{ dseq: "800", depositUact: "5000000" }],
      [{ dseq: "800", depositUact: "5000000" }],
      [{ dseq: "800", depositUact: "5000000" }],
      [],
    ],
    closes: {
      800: { ok: true, dseq: "800", txHash: "HASH800", errors: [], jsonl: '{"a":1}\n' },
    },
  });

  const result = await toZero(
    { bin: "akt", context: "sandbox-2", own: ["800"], ...settle, settleMs: 5000, sleep },
    akt,
  );

  assert.deepStrictEqual(result.stillActive, [], "sync-mode broadcast lag must not read as a leak");
  assert.deepStrictEqual(result.closed, [{ dseq: "800", closeTxHash: "HASH800" }]);
  assert.strictEqual(
    closeCalls(calls).length,
    1,
    "polling for convergence must never issue a second close: it burns gas and exits 1",
  );
  assert.ok(calls.filter((c) => c.fn === "activeDeployments").length >= 3);
});

test("a failed close records akt's error text verbatim and the loop continues to the next owned dseq", async () => {
  const { akt, calls, sleep } = makeAkt({
    lists: [
      [
        { dseq: "400", depositUact: "5000000" },
        { dseq: "500", depositUact: "5000000" },
      ],
      [{ dseq: "400", depositUact: "5000000" }],
    ],
    closes: {
      400: {
        ok: false,
        dseq: "400",
        errors: ["rpc error: ... Deployment closed ... unknown request"],
        jsonl: '{"result":"error"}\n',
      },
      500: {
        ok: true,
        dseq: "500",
        txHash: "HASH500",
        errors: [],
        jsonl: '{"result":"completed"}\n',
      },
    },
  });

  const result = await toZero(
    { bin: "akt", context: "sandbox-2", own: ["400", "500"], ...settle, sleep },
    akt,
  );

  assert.deepStrictEqual(result.errors, ["rpc error: ... Deployment closed ... unknown request"]);
  assert.deepStrictEqual(result.closed, [{ dseq: "500", closeTxHash: "HASH500" }]);
  assert.deepStrictEqual(result.stillActive, [
    {
      dseq: "400",
      reason: "rpc error: ... Deployment closed ... unknown request",
      depositUact: "5000000",
    },
  ]);
  assert.deepStrictEqual(
    closeCalls(calls).map((c) => c.dseq),
    ["400", "500"],
  );
});

test('a close that reports success while the re-list still shows it uses reason "still active after close"', async () => {
  const { akt, sleep } = makeAkt({
    lists: [[{ dseq: "600", depositUact: "5000000" }], [{ dseq: "600", depositUact: "5000000" }]],
    closes: {
      600: {
        ok: true,
        dseq: "600",
        txHash: "HASH600",
        errors: [],
        jsonl: '{"result":"completed"}\n',
      },
    },
  });

  const result = await toZero(
    { bin: "akt", context: "sandbox-2", own: ["600"], ...settle, sleep },
    akt,
  );

  assert.deepStrictEqual(result.closed, [{ dseq: "600", closeTxHash: "HASH600" }]);
  assert.deepStrictEqual(result.stillActive, [
    { dseq: "600", reason: "still active after close", depositUact: "5000000" },
  ]);
});

test("jsonl from successive closes is concatenated in order", async () => {
  const { akt, sleep } = makeAkt({
    lists: [
      [
        { dseq: "100", depositUact: "5000000" },
        { dseq: "200", depositUact: "5000000" },
      ],
      [],
    ],
    closes: {
      100: { ok: true, dseq: "100", txHash: "HASH100", errors: [], jsonl: '{"a":1}\n' },
      200: { ok: true, dseq: "200", txHash: "HASH200", errors: [], jsonl: '{"a":2}\n' },
    },
  });

  const result = await toZero(
    { bin: "akt", context: "sandbox-2", own: ["100", "200"], ...settle, sleep },
    akt,
  );

  assert.strictEqual(result.jsonl, '{"a":1}\n{"a":2}\n');
});
