"use strict";

/**
 * Append-only scan history, stored as JSONL.
 *
 * WHY
 * ---
 * Every scan so far printed to stdout and vanished. That makes the central
 * question - "does an arbitrage edge ever exist on Base, and for how long?" -
 * unanswerable, because answering it needs a time series and there isn't one.
 *
 * WHY JSONL AND NOT A DATABASE
 * ----------------------------
 * A warehouse is the right answer for historical, high-volume, batch data -
 * and this IS that shape, which is why DuckDB reads it later. But the WRITER
 * should stay trivial: appending one line is atomic-ish, crash-safe, never
 * corrupts, and needs no server. A crashed scan must not be able to destroy
 * the history, because the history is the expensive part.
 */

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const SCAN_FILE = path.join(DATA_DIR, "scan-history.jsonl");

/**
 * Field order is fixed and documented because this IS the schema. DuckDB reads
 * the file by sniffing the first line, so the keys here are the column names
 * used by every later query. Adding a key is backwards compatible; renaming
 * one silently breaks old history, so treat it as append-only.
 */
class ScanRecorder {
  constructor({ file = SCAN_FILE, enabled = true } = {}) {
    this.file = file;
    this.enabled = enabled;
    this.count = 0;
    if (this.enabled) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
    }
  }

  /**
   * Append one scan.
   *
   * Never throws: a recording failure must not take down a scan that otherwise
   * worked, so failures are reported and swallowed.
   */
  record(snapshot) {
    if (!this.enabled) return { ok: false, reason: "recording disabled" };
    try {
      const line = JSON.stringify(snapshot);
      fs.appendFileSync(this.file, line + "\n", "utf8");
      this.count++;
      return { ok: true, file: this.file, bytes: Buffer.byteLength(line) };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }

  /** How many scans are on disk. Used to confirm a schedule is really running. */
  static countLines(file = SCAN_FILE) {
    if (!fs.existsSync(file)) return 0;
    const raw = fs.readFileSync(file, "utf8");
    if (!raw.trim()) return 0;
    // Subtract the trailing newline so a partial final line is not counted as
    // a whole record; a torn write is a real possibility if the process dies.
    return raw.split("\n").filter((l) => l.trim().length > 0).length;
  }

  /** Read the most recent n records, newest last. */
  static tail(n = 10, file = SCAN_FILE) {
    if (!fs.existsSync(file)) return [];
    const lines = fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0);
    const slice = lines.slice(-n);
    return slice
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch (e) {
          return null; // tolerate a torn line rather than failing the read
        }
      })
      .filter(Boolean);
  }
}

/**
 * Build the canonical snapshot object.
 *
 * Note what is NOT here: any claim that the market had no opportunities. A scan
 * that could not price most of its routes has not established anything, and
 * recording that as a negative result would poison the whole dataset. The
 * `conclusive` flag exists so a later query can exclude non-evidence.
 */
function buildSnapshot({
  blockNumber,
  chainId = 84532,
  tokens = [],
  usdPrices = {},
  sizes = [],
  feeTiers = [],
  stats = {},
  best = null,
  viable = [],
  endpoints = [],
  scanner = {},
  note = null,
}) {
  const totalAttempts = (stats.ok || 0) + (stats.failed || 0) + (stats.inconclusive || 0);
  const coverage = totalAttempts > 0 ? (stats.ok || 0) / totalAttempts : 0;

  return {
    // Time and block are the join keys. `ts` is when the scan ran; `block` is
    // the chain state it actually observed. They differ, and conflating them
    // would make it impossible to line a scan up with what the chain did.
    ts: new Date().toISOString(),
    block: blockNumber,
    chainId,

    tokens,
    usdPrices,

    sizes,
    feeTiers,

    quotesOk: stats.ok || 0,
    quotesFailed: stats.failed || 0,
    quotesInconclusive: stats.inconclusive || 0,
    coverage: Number(coverage.toFixed(4)),
    // The single most important field in the file. A scan below 50% coverage
    // is not evidence about the market, and must be excluded from any
    // "how often is there an edge" statistic.
    conclusive: coverage >= 0.5 && (stats.ok || 0) > 0,

    roundTripsCompleted: stats.grossProfitable ?? null,
    viableCount: (viable || []).length,
    bestNetProfitUSD: best ? Number(best.netProfitUSD.toFixed(2)) : null,
    bestPair: best ? best.pair : null,
    bestSpreadBps: best
      ? Number((((best.grossProfitUSD || 0) / (best.borrowedUSD || 1)) * 10000).toFixed(2))
      : null,

    endpoints,
    scanner,
    note,
  };
}

module.exports = { ScanRecorder, buildSnapshot, SCAN_FILE };
