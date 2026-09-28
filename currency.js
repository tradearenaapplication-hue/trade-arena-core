/**
 * CURRENCY — AUD-native display layer
 * ------------------------------------------------------------------
 * All internal maths stays in USD. USDC is a USD stablecoin and the
 * on-chain engine prices and risk-limits in USD, so nothing below
 * changes a calculation. This module exists purely to RENDER and PARSE
 * amounts in AUD, the app's native display currency.
 *
 * Why keep USD underneath: MAX_TRADE_USD, slippage floors and on-chain
 * quotes are all USD-denominated. Converting them would put rounding
 * error inside the risk check. Conversion happens only at the edges -
 * when a number is shown, and when a user types an amount in.
 *
 * Rate is fetched live and cached. If the fetch fails the last known
 * rate is reused; if there has never been one, AUD is disabled and the
 * app falls back to showing USD rather than inventing a rate.
 */
const Currency = (() => {
    'use strict';

    const NATIVE = 'AUD';
    const BASE = 'USD';

    let usdToAud = null;      // null until first successful fetch
    let fetchedAt = 0;
    let inflight = null;
    const TTL_MS = 15 * 60 * 1000;   // 15 minutes

    function log(...a) { console.warn('[Currency]', ...a); }

    /**
     * Fetch USD -> AUD. Returns the rate, or the cached one on failure.
     * Never throws.
     */
    async function refresh(force = false) {
        if (!force && usdToAud !== null && Date.now() - fetchedAt < TTL_MS) {
            return usdToAud;
        }
        if (inflight) return inflight;

        inflight = (async () => {
            // Two sources, tried in order.
            //
            // Frankfurter is used first: it is an ECB-derived reference rate
            // with no API key and an unambiguous { base, rates: { AUD } }
            // shape for USD -> AUD.
            //
            // CoinGecko is a fallback, but it must be queried as ids=usd and
            // its "aud" figure is actually AUD->USD, so it is INVERTED here.
            // Reading it directly gave 0.00163 and would have made AUD display
            // roughly 1/1000 of the true value.
            const sources = [
                {
                    url: 'https://api.frankfurter.app/latest?from=USD&to=AUD',
                    read: (d) => Number(d && d.rates && d.rates.AUD)
                },
                {
                    url: 'https://api.coingecko.com/api/v3/simple/price?ids=usd&vs_currencies=aud',
                    read: (d) => {
                        const v = Number(d && d.usd && d.usd.aud);
                        return v > 0 ? 1 / v : NaN;   // invert: coingecko returns AUD->USD
                    }
                }
            ];

            for (const src of sources) {
                try {
                    const ctrl = new AbortController();
                    const timer = setTimeout(() => ctrl.abort(), 8000);
                    const res = await fetch(src.url, { signal: ctrl.signal });
                    clearTimeout(timer);
                    if (!res.ok) throw new Error('HTTP ' + res.status);
                    const rate = src.read(await res.json());
                    if (!Number.isFinite(rate) || rate <= 0) throw new Error('bad rate');
                    usdToAud = rate;
                    fetchedAt = Date.now();
                    return rate;
                } catch (e) {
                    log('source failed:', src.url.split('?')[0], e.message);
                }
            }

            log('all sources failed;', usdToAud === null
                ? 'falling back to USD display'
                : 'reusing cached rate ' + usdToAud.toFixed(4));
            return usdToAud;
        })();

        return inflight;
    }

    /** True once a usable rate is available. */
    function ready() { return usdToAud !== null; }
    function rate() { return usdToAud; }

    /** USD -> AUD. Returns the input unchanged if no rate is available. */
    function toAud(usd) {
        const n = Number(usd);
        if (!Number.isFinite(n)) return 0;
        if (usdToAud === null) return n;
        return n * usdToAud;
    }

    /** AUD -> USD. Returns the input unchanged if no rate is available. */
    function toUsd(aud) {
        const n = Number(aud);
        if (!Number.isFinite(n)) return 0;
        if (usdToAud === null) return n;
        return n / usdToAud;
    }

    /**
     * Format a USD amount for display in the app's native currency.
     *
     *   fmtUSD(12.5)  ->  "A$19.13"   (at ~1.53)
     *   fmtUSD(0)     ->  "A$0.00"
     *
     * Falls back to "$12.50" (plain USD) if no rate has ever loaded, so the
     * UI is never wrong - only USD, clearly marked - when AUD is unavailable.
     */
    function fmtUSD(usd, dp) {
        const n = Number(usd);
        if (!Number.isFinite(n)) return `${NATIVE === 'AUD' ? 'A$' : '$'}0.00`;
        if (usdToAud === null) {
            const places = dp === undefined ? 2 : dp;
            return '$' + n.toFixed(places);
        }
        const places = dp === undefined ? 2 : dp;
        return 'A$' + toAud(n).toFixed(places);
    }

    /**
     * Format a value that is ALREADY in AUD.
     *
     * Use this for input presets and anything the user typed, where the number
     * is a native AUD amount and must NOT be converted again. fmtUSD() is for
     * USD amounts coming out of the maths.
     */
    function fmtAUD(aud, dp) {
        const n = Number(aud);
        if (!Number.isFinite(n)) return 'A$0.00';
        const places = dp === undefined ? 2 : dp;
        return 'A$' + n.toFixed(places);
    }

    /** Parse a user-typed amount. Strips currency marks and separators. */
    function parseAmount(text) {
        if (typeof text === 'number') return text;
        if (text === null || text === undefined) return NaN;
        const cleaned = String(text).replace(/[^0-9.]/g, '');
        const n = parseFloat(cleaned);
        return Number.isFinite(n) ? n : NaN;
    }

    /** Symbol prefix, for markup that cannot go through fmtUSD. */
    function symbol() { return usdToAud === null ? '$' : 'A$'; }

    /** Short label, e.g. for a settings header. */
    function label() { return usdToAud === null ? BASE : NATIVE; }

    return {
        NATIVE, BASE, refresh, ready, rate, toAud, toUsd,
        fmtUSD, parseAmount, symbol, label
    };
})();

// Global helpers used throughout the UI templates.
window.Currency = Currency;
window.fmtUSD = Currency.fmtUSD;
window.fmtAUD = Currency.fmtAUD;
window.audToUsd = Currency.toUsd;
window.usdToAud = Currency.toAud;

/**
 * Format a number as AUD without a currency symbol. Kept separate from
 * fmtUSD so percentage and ratio displays (win rate, slippage %) are
 * never accidentally converted.
 */
window.fmtNum = function (n, dp) {
    const v = Number(n);
    return Number.isFinite(v) ? v.toFixed(dp === undefined ? 2 : dp) : '0';
};

// Kick off the rate fetch immediately, and refresh on a timer.
if (typeof window !== 'undefined') {
    Currency.refresh();
    setInterval(() => Currency.refresh(true), 15 * 60 * 1000);
}

// Defensive fallbacks. If this file fails to load, or throws above, the formatters
// must still exist: the UI renders money during initial parse, and an undefined
// fmtUSD()/fmtAUD() there throws a ReferenceError that silently stops bots being
// added and trade logs from rendering. Degrade to plain USD rather than break.
if (typeof window !== 'undefined') {
    if (typeof window.fmtUSD !== 'function') {
        window.fmtUSD = (v, dp) => {
            const n = Number(v);
            return '$' + (Number.isFinite(n) ? n.toFixed(dp === undefined ? 2 : dp) : '0.00');
        };
        console.warn('[Currency] formatter unavailable - falling back to plain USD display.');
    }
    if (typeof window.fmtAUD !== 'function') {
        window.fmtAUD = (v, dp) => {
            const n = Number(v);
            return 'A$' + (Number.isFinite(n) ? n.toFixed(dp === undefined ? 2 : dp) : '0.00');
        };
    }
    if (typeof window.fmtNum !== 'function') {
        window.fmtNum = (v, dp) => {
            const n = Number(v);
            return Number.isFinite(n) ? n.toFixed(dp === undefined ? 2 : dp) : '0';
        };
    }
    if (typeof window.audToUsd !== 'function') window.audToUsd = (v) => Number(v) || 0;
    if (typeof window.usdToAud !== 'function') window.usdToAud = (v) => Number(v) || 0;
}
