import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { probe } from "./lib/probe.mjs";

function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: (ms) => {
      t += ms;
      return Promise.resolve();
    },
    advance: (ms) => {
      t += ms;
    },
  };
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function makeFetch(clock, responses) {
  let i = 0;
  return async () => {
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    clock.advance(r.latencyMs ?? 10);
    if (r.error) throw new Error(r.error);
    return { status: r.status, text: async () => r.body ?? "" };
  };
}

describe("probe", () => {
  it("https refused, http 200: servedBy http, two attempts, the first carries the verbatim transport error", async () => {
    const clock = fakeClock();
    const result = await probe({
      uris: ["example.test"],
      path: "/",
      expectStatus: 200,
      budgetMs: 10000,
      fetchImpl: makeFetch(clock, [
        { error: "dial tcp: connect: connection refused" },
        { status: 200 },
      ]),
      now: clock.now,
      sleep: clock.sleep,
    });

    assert.deepStrictEqual(result, {
      servedBy: "http",
      url: "http://example.test/",
      attempts: [
        {
          scheme: "https",
          url: "https://example.test/",
          at: iso(0),
          durationMs: 10,
          error: "dial tcp: connect: connection refused",
        },
        { scheme: "http", url: "http://example.test/", at: iso(10), durationMs: 10, status: 200 },
      ],
    });
  });

  it("https 200 on the first try: servedBy https, exactly one attempt", async () => {
    const clock = fakeClock();
    const result = await probe({
      uris: ["example.test"],
      path: "/",
      expectStatus: 200,
      budgetMs: 10000,
      fetchImpl: makeFetch(clock, [{ status: 200 }]),
      now: clock.now,
      sleep: clock.sleep,
    });

    assert.deepStrictEqual(result, {
      servedBy: "https",
      url: "https://example.test/",
      attempts: [
        { scheme: "https", url: "https://example.test/", at: iso(0), durationMs: 10, status: 200 },
      ],
    });
  });

  it("a non-matching status is retried rather than accepted", async () => {
    const clock = fakeClock();
    const result = await probe({
      uris: ["example.test"],
      path: "/",
      expectStatus: 200,
      budgetMs: 10000,
      fetchImpl: makeFetch(clock, [{ status: 404 }, { status: 200 }]),
      now: clock.now,
      sleep: clock.sleep,
    });

    assert.deepStrictEqual(result, {
      servedBy: "http",
      url: "http://example.test/",
      attempts: [
        { scheme: "https", url: "https://example.test/", at: iso(0), durationMs: 10, status: 404 },
        { scheme: "http", url: "http://example.test/", at: iso(10), durationMs: 10, status: 200 },
      ],
    });
  });

  it("a body expectation unmet is not a success, so it backs off and retries until the body matches", async () => {
    const clock = fakeClock();
    const result = await probe({
      uris: ["example.test"],
      path: "/",
      expectStatus: 200,
      expectBodyContains: "Welcome",
      budgetMs: 10000,
      fetchImpl: makeFetch(clock, [
        { status: 200, body: "nope" },
        { status: 200, body: "nope" },
        { status: 200, body: "Welcome!" },
      ]),
      now: clock.now,
      sleep: clock.sleep,
    });

    assert.deepStrictEqual(result, {
      servedBy: "https",
      url: "https://example.test/",
      attempts: [
        {
          scheme: "https",
          url: "https://example.test/",
          at: iso(0),
          durationMs: 10,
          status: 200,
          bodyMatched: false,
        },
        {
          scheme: "http",
          url: "http://example.test/",
          at: iso(10),
          durationMs: 10,
          status: 200,
          bodyMatched: false,
        },
        {
          scheme: "https",
          url: "https://example.test/",
          at: iso(270),
          durationMs: 10,
          status: 200,
          bodyMatched: true,
        },
      ],
    });
  });

  it("nothing ever answers: no servedBy, and the attempt count is exactly bounded by the budget", async () => {
    const clock = fakeClock();
    const result = await probe({
      uris: ["example.test"],
      path: "/",
      expectStatus: 200,
      budgetMs: 1000,
      fetchImpl: makeFetch(clock, [{ status: 500 }]),
      now: clock.now,
      sleep: clock.sleep,
    });

    assert.strictEqual(result.servedBy, undefined);
    assert.strictEqual(result.attempts.length, 6);
    assert.ok(result.attempts.every((a) => a.status === 500));
    assert.ok(result.attempts.every((a) => !("error" in a)));
  });
});
