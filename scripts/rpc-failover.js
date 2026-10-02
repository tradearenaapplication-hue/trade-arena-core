"use strict";

/**
 * Resilient JSON-RPC access across several free public Base endpoints.
 *
 * WHY THIS EXISTS
 * ---------------
 * A scan is hundreds of `eth_call`s. Against a single public endpoint that is
 * enough to trip rate limits, and a throttled request is INDISTINGUISHABLE from
 * a genuine quote failure: both arrive as "missing revert data" with no revert
 * reason. Left unhandled, a throttled run produced a 0%-coverage report that
 * read exactly like "no arbitrage here" - the most expensive possible failure
 * mode for a tool whose only job is to tell you the truth about a market.
 *
 * Measured sustained throughput, 60 consecutive pinned quotes, zero failures on
 * all four:
 *
 *   tenderly  60/60   268 ms/call
 *   blast     60/60   273 ms/call
 *   drpc      60/60   432 ms/call
 *   base.org  60/60  1976 ms/call   (slow but reliable)
 *
 * So the fix is not a subscription, it is failover plus a circuit breaker.
 */

const { ethers } = require("ethers");

/** Free public Base endpoints, fastest measured first. */
const DEFAULT_ENDPOINTS = [
  { name: "tenderly", url: "https://base.gateway.tenderly.co" },
  { name: "blast", url: "https://base-mainnet.public.blastapi.io" },
  { name: "drpc", url: "https://base.drpc.org" },
  { name: "base.org", url: "https://mainnet.base.org" },
];

const CHAIN_ID = 84532; // Base
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class FailoverProvider {
  /**
   * @param {object} opts
   * @param {Array<{name:string,url:string}>} [opts.endpoints]
   * @param {number} [opts.failureThreshold] consecutive failures before a
   *   provider is benched. 3 is enough to clear a burst without giving up on a
   *   provider that is merely briefly busy.
   * @param {number} [opts.benchMs] how long a benched provider stays out.
   */
  constructor({
    endpoints = DEFAULT_ENDPOINTS,
    failureThreshold = 3,
    benchMs = 30_000,
  } = {}) {
    if (!endpoints.length) throw new Error("FailoverProvider needs at least one endpoint");
    this.endpoints = endpoints.map((e) => ({
      ...e,
      provider: new ethers.JsonRpcProvider(e.url, CHAIN_ID, { staticNetwork: true }),
      failures: 0,
      benchedUntil: 0,
    }));
    this.failureThreshold = failureThreshold;
    this.benchMs = benchMs;
    // Start at the fastest measured endpoint.
    this.cursor = 0;
  }

  /** Endpoints not currently benched. If all are benched, all are eligible. */
  _available(now = Date.now()) {
    const live = this.endpoints.filter((e) => e.benchedUntil <= now);
    return live.length ? live : this.endpoints;
  }

  /**
   * Run `fn` against the first endpoint that answers, rotating on failure.
   *
   * NOTE: the supplied callback receives the endpoint, and is expected to be
   * cheap to retry. Callers MUST pass an explicit `blockTag` for anything
   * correctness-sensitive: retrying against a different head mid-scan would
   * silently mix two market states.
   */
  async withFailover(fn, { attempts = this.endpoints.length } = {}) {
    let lastErr = null;
    for (let i = 0; i < attempts; i++) {
      const now = Date.now();
      const pool = this._available(now);
      if (!pool.length) break;
      const ep = pool[(this.cursor + i) % pool.length];

      try {
        const value = await fn(ep.provider, ep);
        // Success resets the breaker and points the next call at this endpoint.
        ep.failures = 0;
        this.cursor = (this.endpoints.indexOf(ep) + 1) % this.endpoints.length;
        return { ok: true, value, endpoint: ep.name };
      } catch (e) {
        lastErr = e;
        ep.failures++;
        if (ep.failures >= this.failureThreshold) {
          ep.benchedUntil = Date.now() + this.benchMs;
        }
      }
    }
    return {
      ok: false,
      error: lastErr ? lastErr.shortMessage || lastErr.message : "all endpoints failed",
    };
  }

  /**
   * Read a single block height, trying endpoints until one answers.
   * Used once to pin the scan.
   */
  async getBlockNumber() {
    const r = await this.withFailover((p) => p.getBlockNumber());
    if (!r.ok) throw new Error("could not read block number: " + r.error);
    return r.value;
  }

  /** `eth_getCode` - used to reject tokens that are not real contracts. */
  async getCode(address) {
    const r = await this.withFailover((p) => p.getCode(address));
    if (!r.ok) throw new Error("could not read code for " + address + ": " + r.error);
    return r.value;
  }

  /** Health snapshot, for reporting rather than guessing. */
  status() {
    const now = Date.now();
    return this.endpoints.map((e) => ({
      name: e.name,
      url: e.url,
      failures: e.failures,
      benched: e.benchedUntil > now,
    }));
  }
}

module.exports = { FailoverProvider, DEFAULT_ENDPOINTS, CHAIN_ID };
