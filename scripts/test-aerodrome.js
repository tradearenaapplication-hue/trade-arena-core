"use strict";

/**
 * Does the Aerodrome adapter actually price swaps, and does it agree with
 * Uniswap on the same block?
 *
 * Agreement is the real test. Two independent venues quoting the same trade at
 * wildly different prices would mean one is broken, and a cross-venue scanner
 * built on a broken leg will manufacture arbitrage that does not exist — which
 * is precisely the failure that produced a phantom 11,583% ROI earlier.
 */

const { ethers } = require("ethers");
const { FailoverProvider } = require("./rpc-failover.js");
const {
  AerodromeAdapter,
  AERODROME_FACTORY,
  KNOWN_POOLS,
} = require("./aerodrome-adapter.js");

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

const WETH = {
  symbol: "WETH",
  address: "0x4200000000000000000000000000000000000006",
  decimals: 18,
};
const USDC = {
  symbol: "USDC",
  address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  decimals: 6,
};

const QUOTER = "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a";
const QUOTER_ABI = [
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 ticksCrossed,uint256 gasEstimate)",
];

async function run() {
  console.log("=".repeat(70));
  console.log("AERODROME ADAPTER TEST — genuine cross-venue pricing");
  console.log("=".repeat(70));
  console.log();

  const fp = new FailoverProvider();
  const block = await fp.getBlockNumber();
  const aero = new AerodromeAdapter(fp);
  console.log(`pinned to block ${block}`);
  console.log();

  console.log("--- addresses are real contracts ---");

  await check("the Aerodrome factory is a contract with code", async () => {
    const code = await fp.getCode(AERODROME_FACTORY);
    assert(code !== "0x", "factory has NO CODE - wrong chain or wrong address");
    const bytes = (code.length - 2) / 2;
    assert(bytes > 500, `factory code suspiciously small: ${bytes} bytes`);
  });

  await check("the known WETH/USDC pool is a contract with code", async () => {
    const code = await fp.getCode(KNOWN_POOLS["WETH/USDC"]);
    assert(code !== "0x", "pool has NO CODE");
    // 45 bytes here is CORRECT, not a warning sign. Aerodrome deploys its pools
    // as EIP-1167 minimal clones, which are fixed-size stubs that delegate to a
    // shared implementation - the `363d3d37` prefix is the standard clone magic.
    // An earlier version of this test asserted >500 bytes and failed on a
    // perfectly healthy pool. What matters is that there is code and that it
    // answers calls, which the quoting checks below cover directly.
    const bytes = (code.length - 2) / 2;
    assert(
      bytes >= 45,
      `pool code is only ${bytes} bytes - too small even for a minimal proxy`,
    );
    const isClone = code.startsWith("0x363d3d37");
    console.log(
      `         pool is ${bytes} bytes` +
        (isClone ? " (EIP-1167 minimal clone - expected for Aerodrome)" : ""),
    );
  });

  await check("the pool delegates to a live implementation", async () => {
    // For a clone, the implementation sits in the code itself. Reading it back
    // proves the proxy has something real behind it rather than pointing at a
    // dead address that would silently return empty data.
    const code = await fp.getCode(KNOWN_POOLS["WETH/USDC"]);
    if (!code.startsWith("0x363d3d37")) return; // not a clone; nothing to check
    const impl = "0x" + code.slice(2 + 20, 2 + 60);
    assert(ethers.isAddress(impl), `implementation address malformed: ${impl}`);
    const implCode = await fp.getCode(impl);
    assert(implCode !== "0x", `implementation ${impl} has no code`);
    console.log(
      `         implementation ${impl} (${(implCode.length - 2) / 2} bytes)`,
    );
  });

  await check("every configured address passes checksum validation", async () => {
    // A bad checksum makes ethers fall back to ENS resolution, producing a
    // baffling "network does not support ENS" error instead of "no such
    // contract". That cost real debugging time, so assert it directly.
    for (const [k, v] of Object.entries({ factory: AERODROME_FACTORY, ...KNOWN_POOLS })) {
      assert(ethers.isAddress(v), `${k} address fails isAddress: ${v}`);
    }
  });

  console.log();
  console.log("--- quoting ---");

  await check("quotes WETH -> USDC and returns a plausible amount", async () => {
    const q = await aero.quote({
      tokenIn: WETH,
      tokenOut: USDC,
      rawAmount: ethers.parseEther("1"),
      blockTag: block,
    });
    assert(!q.error, `quote failed: ${q.error}`);
    const usd = Number(ethers.formatUnits(q.amountOut, 6));
    assert(usd > 1000 && usd < 10000, `1 WETH priced at $${usd}, outside any sane band`);
  });

  await check("quotes USDC -> WETH and returns a plausible amount", async () => {
    const q = await aero.quote({
      tokenIn: USDC,
      tokenOut: WETH,
      rawAmount: ethers.parseUnits("1000", 6),
      blockTag: block,
    });
    assert(!q.error, `quote failed: ${q.error}`);
    const weth = Number(ethers.formatUnits(q.amountOut, 18));
    assert(weth > 0.1 && weth < 1, `1000 USDC priced at ${weth} WETH, implausible`);
  });

  console.log();
  console.log("--- the cross-venue consistency check that matters ---");

  await check("Aerodrome and Uniswap agree within 1% on the same block", async () => {
    const oneWeth = ethers.parseEther("1");

    const [aeroQ, uniQ] = await Promise.all([
      aero.quote({ tokenIn: WETH, tokenOut: USDC, rawAmount: oneWeth, blockTag: block }),
      fp.withFailover(async (provider) => {
        const q = new ethers.Contract(QUOTER, QUOTER_ABI, provider);
        const data = q.interface.encodeFunctionData("quoteExactInputSingle", [
          {
            tokenIn: WETH.address,
            tokenOut: USDC.address,
            amountIn: oneWeth,
            fee: 500,
            sqrtPriceLimitX96: 0,
          },
        ]);
        const raw = await provider.call({ to: QUOTER, data, blockTag: block });
        return ethers.AbiCoder.defaultAbiCoder().decode(["uint256"], raw)[0];
      }),
    ]);

    assert(!aeroQ.error, `aerodrome quote failed: ${aeroQ.error}`);
    assert(uniQ.ok, `uniswap quote failed: ${uniQ.error}`);

    const a = Number(ethers.formatUnits(aeroQ.amountOut, 6));
    const u = Number(ethers.formatUnits(uniQ.value, 6));
    const diffBps = (Math.abs(a - u) / Math.min(a, u)) * 10000;
    console.log(
      `         aerodrome $${a.toFixed(4)}  vs  uniswap $${u.toFixed(4)}` +
        `   = ${diffBps.toFixed(1)} bps apart`,
    );
    assert(
      diffBps < 100,
      `venues disagree by ${diffBps.toFixed(1)} bps (>100). One leg is broken, and a ` +
        "cross-venue scanner built on it would invent arbitrage.",
    );
  });

  await check("a pair with no Aerodrome pool errors instead of returning zero", async () => {
    // Silent zero is the dangerous failure: it looks like a real quote of zero
    // output and reads as a catastrophic loss on every round trip.
    const fake = {
      symbol: "FAKE",
      address: "0x000000000000000000000000000000000000dEaD",
      decimals: 18,
    };
    const q = await aero.quote({
      tokenIn: fake,
      tokenOut: USDC,
      rawAmount: ethers.parseEther("1"),
      blockTag: block,
    });
    assert(!!q.error, "expected an error for a nonexistent pool, got a quote");
    assert(q.amountOut === undefined, "a failing quote must not also return an amountOut");
  });

  console.log();
  console.log("=".repeat(70));
  if (failed === 0) {
    console.log(`ALL ${passed} AERODROME CHECKS PASSED`);
    console.log("=".repeat(70));
    console.log();
    console.log("VERDICT: Aerodrome is genuinely pricing swaps, and agrees with");
    console.log("Uniswap on the same block. Cross-venue comparison is now real,");
    console.log("not two fee tiers on one AMM.");
  } else {
    console.log(`${failed} of ${passed + failed} CHECKS FAILED`);
    console.log("=".repeat(70));
    for (const f of failures) console.log(`  - ${f}`);
    console.log();
    console.log("VERDICT: the cross-venue path is NOT trustworthy yet.");
  }
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((e) => {
  console.error("HARNESS ERROR: " + e.stack);
  process.exit(1);
});