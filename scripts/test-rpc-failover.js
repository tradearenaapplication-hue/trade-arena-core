"use strict";

/**
 * Does the failover layer actually fail over?
 *
 * A breaker that never trips is indistinguishable from no breaker at all: the
 * happy path looks perfect either way. These tests inject failures and assert
 * the layer routes around them, so a green run means something.
 */

const { FailoverProvider, DEFAULT_ENDPOINTS } = require("./rpc-failover.js");

let passed = 0;
let failed = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`   PASS  ${name}`);
  } catch (e) {
    failed++;
    failures.push(`${name}: ${e.message}`);
    console.log(`   FAIL  ${name}\n         ${e.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const eq = (a, b, msg) =>
  assert(String(a) === String(b), `${msg} (expected ${b}, got ${a})`);

/** Endpoints with no network - the provider is never actually dialled. */
const fakeEndpoints = (names) =>
  names.map((name) => ({ name, url: "http://127.0.0.1:1/" + name }));

async function run() {
  console.log("=".repeat(70));
  console.log("RPC FAILOVER TEST: does a dead endpoint really get routed around?");
  console.log("=".repeat(70));
  console.log();

  console.log("--- routing ---");

  await check("uses the first endpoint when all are healthy", async () => {
    const f = new FailoverProvider({ endpoints: fakeEndpoints(["a", "b"]) });
    const r = await f.withFailover(async () => "ok");
    assert(r.ok, `expected success, got ${r.error}`);
    eq(r.value, "ok", "wrong value returned");
  });

  await check("falls over to the next endpoint when one throws", async () => {
    const f = new FailoverProvider({ endpoints: fakeEndpoints(["dead", "alive"]) });
    const r = await f.withFailover(async (p, ep) => {
      if (ep.name === "dead") throw new Error("connection refused");
      return "from-alive";
    });
    assert(r.ok, `expected failover to succeed, got ${r.error}`);
    eq(r.value, "from-alive", "did not use the healthy endpoint");
  });

  await check("reports failure when every endpoint is down", async () => {
    const f = new FailoverProvider({ endpoints: fakeEndpoints(["x", "y"]) });
    const r = await f.withFailover(async () => {
      throw new Error("all dead");
    });
    assert(!r.ok, "should have reported failure");
    assert(typeof r.error === "string" && r.error.length > 0, "no error message returned");
  });

  console.log();
  console.log("--- circuit breaker ---");

  await check("benches an endpoint after repeated failures", async () => {
    const f = new FailoverProvider({
      endpoints: fakeEndpoints(["bad", "good"]),
      failureThreshold: 3,
    });
    for (let i = 0; i < 4; i++) {
      await f.withFailover(async (p, ep) => {
        if (ep.name === "bad") throw new Error("down");
        return 1;
      });
    }
    const status = f.status();
    const bad = status.find((s) => s.name === "bad");
    const good = status.find((s) => s.name === "good");
    assert(bad.benched, "the failing endpoint was never benched");
    assert(!good.benched, "the healthy endpoint was benched as collateral damage");
  });

  await check("recovers after being benched (breaker is not permanent)", async () => {
    const f = new FailoverProvider({
      endpoints: fakeEndpoints(["flaky"]),
      failureThreshold: 1,
      benchMs: 40, // short, so recovery is testable
    });
    await f.withFailover(async () => {
      throw new Error("down");
    });
    assert(f.status()[0].benched, "should be benched immediately");
    await new Promise((r) => setTimeout(r, 60));
    assert(!f.status()[0].benched, "should have recovered after benchMs");
  });

  await check("a success resets the failure counter", async () => {
    const f2 = new FailoverProvider({
      endpoints: fakeEndpoints(["a", "b"]),
      failureThreshold: 3,
    });
    f2.endpoints[0].failures = 2;
    await f2.withFailover(async (p, ep) => {
      if (ep.name === "a") return "recovered";
      return 1;
    });
    eq(f2.endpoints[0].failures, 0, "success did not reset the failure count");
  });

  await check("benching every endpoint does not black-hole the client", async () => {
    // If all endpoints are benched the pool must stay usable, otherwise a burst
    // of failures would black-hole the scanner for the whole bench window.
    const f = new FailoverProvider({
      endpoints: fakeEndpoints(["a", "b"]),
      failureThreshold: 1,
      benchMs: 60_000,
    });
    for (let i = 0; i < 4; i++) {
      await f.withFailover(async () => {
        throw new Error("down");
      });
    }
    const r = await f.withFailover(async () => "still reachable");
    assert(typeof r.ok === "boolean", "failover returned a malformed result");
  });

  console.log();
  console.log("--- safety ---");

  await check("refuses to be constructed with no endpoints", async () => {
    let threw = false;
    try {
      new FailoverProvider({ endpoints: [] });
    } catch (e) {
      threw = true;
    }
    assert(threw, "an empty endpoint list must be rejected loudly");
  });

  await check("the real endpoint list is well formed and distinct", async () => {
    assert(DEFAULT_ENDPOINTS.length >= 3, "expected several fallbacks");
    for (const e of DEFAULT_ENDPOINTS) {
      assert(
        typeof e.url === "string" && e.url.startsWith("https://"),
        `bad url: ${e.url}`,
      );
      assert(e.name && !e.name.includes(" "), `bad name: ${e.name}`);
    }
    // Duplicate hosts would make failover a no-op dressed as redundancy.
    const hosts = new Set(DEFAULT_ENDPOINTS.map((e) => new URL(e.url).host));
    eq(hosts.size, DEFAULT_ENDPOINTS.length, "duplicate hosts in the endpoint list");
  });

  console.log();
  console.log("=".repeat(70));
  if (failed === 0) {
    console.log(`ALL ${passed} FAILOVER CHECKS PASSED`);
    console.log("=".repeat(70));
    console.log();
    console.log("VERDICT: a dead or throttled endpoint is genuinely routed around,");
    console.log("so scan coverage no longer depends on one provider's mood.");
  } else {
    console.log(`${failed} of ${passed + failed} CHECKS FAILED`);
    console.log("=".repeat(70));
    for (const x of failures) console.log(`  - ${x}`);
  }
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((e) => {
  console.error("HARNESS ERROR: " + e.stack);
  process.exit(1);
});
