/**
 * Earn tab, accounting dashboard and on-chain evidence links.
 *
 * Plain script, no build step. Exposed on window so the page's existing inline
 * code can call into it.
 *
 * Three rules this module follows, deliberately:
 *
 *  1. It never invents money. A reward is shown as PAID only when the server
 *     returned a payout transaction hash. PENDING is labelled pending, with
 *     the server's own reason shown rather than hidden.
 *  2. It shows how each task is verified. A self-reported task says so next
 *     to its reward.
 *  3. Every on-chain claim links to the block explorer, so a fill can be
 *     checked without trusting this page.
 */

(function () {
    'use strict';

    const state = {
        address: null,
        tasks: [],
        payout: null,
        paidUsd: 0,
        pendingUsd: 0,
        tradeLogs: [],
        accounting: null,
        explorer: 'https://basescan.org',
        busy: false
    };

    const $ = (sel) => document.querySelector(sel);

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function money(usd) {
        const n = Number(usd) || 0;
        const sign = n < 0 ? '-' : '';
        return sign + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    /** Use the page's AUD formatter when present, so this matches the rest of the UI. */
    function aud(usd) {
        if (typeof window.fmtUSD === 'function') {
            try { return window.fmtUSD(Number(usd) || 0); } catch (e) { /* fall through */ }
        }
        return money(usd);
    }

    async function getAddress() {
        if (state.address) return state.address;
        if (typeof window.getPrivyAddress === 'function') {
            const a = await window.getPrivyAddress();
            if (a) { state.address = a; return a; }
        }
        return null;
    }

    // ─── Earn tab ────────────────────────────────────────────────

    const VERIFICATION_LABEL = {
        PROVEN: 'verified from your trade record',
        ATTESTED: 'self-reported, not independently checked',
        EXTERNAL_UNAVAILABLE: 'no verification available on this server'
    };

    const STATUS_BADGE = {
        NOT_CLAIMED: '',
        PENDING_CONFIGURATION: 'verified, awaiting payout — no tokens sent',
        ELIGIBLE: 'verified, payout queued',
        PAID: 'paid on-chain',
        REJECTED: 'not eligible'
    };

    async function loadTasks() {
        const addr = await getAddress();
        const root = $('#earn-tasks');
        if (!root) return;
        if (!addr) {
            root.innerHTML = '<p class="earn-empty">Connect a wallet to register and claim tasks.</p>';
            return;
        }
        if (state.busy) return;
        state.busy = true;

        try {
            const res = await fetch('/api/tasks/' + addr);
            const data = await res.json();
            if (!data.success) throw new Error(data.error || 'Could not load tasks');

            state.tasks = data.tasks || [];
            state.payout = data.payout;
            state.paidUsd = data.paidUsd || 0;
            state.pendingUsd = data.pendingUsd || 0;

            const payNote = $('#earn-payout-note');
            if (payNote) {
                const enabled = state.payout && state.payout.enabled;
                payNote.textContent = enabled
                    ? 'On-chain payouts are active.'
                    : 'On-chain payouts are NOT active on this server. Verified tasks are recorded, ' +
                      'but no tokens are sent until ' +
                      (state.payout && state.payout.missing ? state.payout.missing.join(', ') : 'payout is configured') +
                      ' is set.';
                payNote.className = 'earn-note ' + (enabled ? 'ok' : 'warn');
            }

            // The two totals are deliberately separate. Adding them together
            // would display unpaid rewards as though they had been received.
            const paidEl = $('#earn-paid');
            const pendEl = $('#earn-pending');
            if (paidEl) paidEl.textContent = aud(state.paidUsd);
            if (pendEl) pendEl.textContent = aud(state.pendingUsd);

            root.innerHTML = state.tasks.map(taskCard).join('');
        } catch (err) {
            root.innerHTML = '<p class="earn-empty">Could not load tasks: ' + esc(err.message) + '</p>';
        } finally {
            state.busy = false;
        }
    }

    function taskCard(t) {
        const done = t.status === 'PAID' || t.status === 'PENDING_CONFIGURATION' || t.status === 'ELIGIBLE';
        const badge = STATUS_BADGE[t.status] || t.status;
        const verif = VERIFICATION_LABEL[t.verification] || t.verification;

        let action;
        if (t.verification === 'EXTERNAL_UNAVAILABLE') {
            action = '<span class="earn-btn disabled">unavailable</span>';
        } else if (t.status === 'PAID') {
            action = '<span class="earn-btn done">claimed</span>';
        } else if (t.action === 'TRADE' && !done) {
            action = '<span class="earn-btn disabled">trade first</span>';
        } else if (t.action === 'REGISTER') {
            action = '<button class="earn-btn" data-task="' + esc(t.id) + '">' +
                (done ? 're-register' : 'register') + '</button>';
        } else {
            action = '<button class="earn-btn" data-task="' + esc(t.id) + '"' +
                (done ? ' disabled' : '') + '>claim</button>';
        }

        const evidence = t.explorerUrl
            ? ' <a href="' + esc(t.explorerUrl) + '" target="_blank" rel="noopener">view payout on explorer ↗</a>'
            : '';

        return '<div class="earn-card' + (t.status === 'REJECTED' ? ' rejected' : '') + '">' +
            '<div class="earn-icon">' + t.icon + '</div>' +
            '<div class="earn-main">' +
                '<div class="earn-label">' + esc(t.label) + '</div>' +
                '<div class="earn-desc">' + esc(t.description) + '</div>' +
                '<div class="earn-verif">' + esc(verif) + '</div>' +
                (t.reason ? '<div class="earn-reason">' + esc(t.reason) + '</div>' : '') +
                (badge ? '<div class="earn-badge ' + esc(t.status) + '">' + esc(badge) + evidence + '</div>' : '') +
            '</div>' +
            '<div class="earn-side">' +
                '<div class="earn-reward">' + aud(t.rewardUsd) + '</div>' +
                action +
            '</div>' +
        '</div>';
    }

    async function claimTask(taskId) {
        if (state.busy) return;
        const addr = await getAddress();
        if (!addr) return;
        state.busy = true;

        try {
            if (typeof window.privySignMessage !== 'function') {
                throw new Error('Wallet signing is not available. Connect a wallet first.');
            }
            const nonceRes = await fetch('/api/tasks/' + addr + '/nonce', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ taskId })
            });
            const nonce = await nonceRes.json();
            if (!nonce.success) throw new Error(nonce.error || 'Could not get a nonce');

            const signature = await window.privySignMessage(nonce.message);
            if (!signature) throw new Error('Signature was not provided');

            const isRegister = taskId === 'wallet_connected';
            const res = await fetch('/api/tasks/' + addr + (isRegister ? '/register' : '/claim'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ taskId, nonce: nonce.nonce, signature })
            });
            const data = await res.json();
            if (!res.ok || !data.success) throw new Error(data.error || ('HTTP ' + res.status));

            toast(data.message || 'Task recorded.');
        } catch (err) {
            toast(err.message, true);
        } finally {
            state.busy = false;
            await loadTasks();
        }
    }

    function toast(msg, isError) {
        const el = $('#earn-toast');
        if (!el) { if (isError) console.error(msg); else console.log(msg); return; }
        el.textContent = msg;
        el.className = 'earn-toast show' + (isError ? ' err' : '');
        clearTimeout(toast._t);
        toast._t = setTimeout(function () { el.className = 'earn-toast'; }, 6000);
    }
    window.TA_earnToast = toast;

    // ─── On-chain evidence in the trade log ──────────────────────

    /**
     * Add explorer links to logged trades.
     *
     * Prefers the URL the server stored with the record, so the link is part of
     * the evidence rather than something the page reconstructs. Falls back to
     * building one from the hash only for older rows that predate the stored
     * link, so they still resolve instead of showing a bare hash.
     */
    function annotateTradeLogs(logs, explorer) {
        const base = explorer || state.explorer;
        return (logs || []).map(function (t) {
            const d = t.details || {};
            if (!d.txHash) return t;
            d.explorerUrl = d.explorerUrl || (base + '/tx/' + d.txHash);
            t.details = d;
            return t;
        });
    }
    window.TA_annotateTradeLogs = annotateTradeLogs;

    /** Render a trade-log row including its on-chain evidence. */
    function tradeLogRow(t) {
        const d = t.details || {};
        const when = new Date(t.timestamp).toLocaleString();
        const pnl = Number(t.pnl) || 0;
        const pnlCls = pnl > 0 ? 'up' : pnl < 0 ? 'down' : '';
        const pnlTxt = t.pnl ? (pnl > 0 ? '+' : '') + money(pnl) : '—';

        const link = d.explorerUrl
            ? '<a class="tl-evidence" href="' + esc(d.explorerUrl) + '" target="_blank" rel="noopener">basescan ↗</a>'
            : '<span class="tl-evidence muted">no on-chain record</span>';

        const gas = d.gasUsd ? ' · gas ' + aud(d.gasUsd) : '';
        const block = d.blockNumber ? ' · block ' + esc(d.blockNumber) : '';

        return '<tr>' +
            '<td>' + esc(when) + '</td>' +
            '<td>' + esc(t.symbol || '—') + '</td>' +
            '<td>' + esc(d.fromAmount != null ? d.fromAmount : t.amount) + '</td>' +
            '<td class="' + pnlCls + '">' + pnlTxt + '</td>' +
            '<td>' + esc(d.mode || '—') + gas + block + '</td>' +
            '<td>' + link + '</td>' +
        '</tr>';
    }
    window.TA_tradeLogRow = tradeLogRow;

    // ─── Accounting dashboard ────────────────────────────────────

    async function loadAccounting() {
        const root = $('#acct-panel');
        if (!root) return;
        const addr = await getAddress();
        if (!addr) { root.innerHTML = '<p class="earn-empty">Connect a wallet to view P&amp;L.</p>'; return; }

        root.innerHTML = '<p class="earn-empty">Loading P&amp;L…</p>';
        try {
            const res = await fetch('/api/accounting/' + addr);
            const data = await res.json();
            if (!data.success) throw new Error(data.error || 'Could not load accounting');
            state.accounting = data;

            const metrics = [
                ['Realised P&amp;L', money(data.realized), 'Closed positions, net of gas'],
                ['Unrealised P&amp;L', money(data.unrealized), 'Open positions at current prices'],
                ['Total P&amp;L', money(data.totalPnlUsd), 'Whether the arena is up overall'],
                ['Gas paid', money(data.gasUsd), 'Real execution cost'],
                ['Open position value', money(data.openPositionValueUsd), 'At current prices']
            ];
            const grid = metrics.map(function (r) {
                const v = parseFloat(String(r[1]).replace(/[^0-9.\-]/g, ''));
                const cls = v > 0 ? 'up' : v < 0 ? 'down' : '';
                return '<div class="acct-row"><span class="acct-k">' + r[0] + '</span>' +
                    '<span class="acct-v ' + cls + '">' + r[1] + '</span>' +
                    '<span class="acct-n">' + r[2] + '</span></div>';
            }).join('');

            const openRows = (data.openPositions || []).map(function (p) {
                const cls = p.unrealizedUsd > 0 ? 'up' : p.unrealizedUsd < 0 ? 'down' : '';
                return '<tr><td>' + esc(p.token) + '</td><td>' + esc(p.botId) + '</td>' +
                    '<td>' + esc(p.unitsFormatted) + '</td>' +
                    '<td class="' + cls + '">' + money(p.unrealizedUsd) + '</td></tr>';
            }).join('');

            const cgt = data.taxLotSplit || {};
            const warns = (data.warnings || []).length
                ? '<p class="acct-warn">' + data.warnings.length + ' ledger warning(s): ' +
                  esc(data.warnings[0]) + '</p>'
                : '';

            root.innerHTML =
                '<div class="acct-grid">' + grid + '</div>' +
                '<div class="acct-sub">Cost basis <b>' + esc(data.costBasisMethod) + '</b> · ' +
                    esc(data.tradeCount) + ' logged trade(s) · CGT short ' + money(cgt.shortTermGainUsd) +
                    ' / long ' + money(cgt.longTermGainUsd) + '</div>' +
                (openRows
                    ? '<table class="acct-table"><thead><tr><th>Asset</th><th>Bot</th><th>Held</th><th>Unrealised</th></tr></thead><tbody>' +
                      openRows + '</tbody></table>'
                    : '') +
                warns;
        } catch (err) {
            root.innerHTML = '<p class="earn-empty">Could not load P&amp;L: ' + esc(err.message) + '</p>';
        }
    }

    // ─── Wiring ──────────────────────────────────────────────────

    document.addEventListener('click', function (e) {
        const btn = e.target && e.target.closest ? e.target.closest('.earn-btn[data-task]') : null;
        if (!btn) return;
        if (btn.classList.contains('disabled') || btn.disabled) return;
        claimTask(btn.getAttribute('data-task'));
    });

    document.addEventListener('DOMContentLoaded', function () {
        loadTasks();
        loadAccounting();
    });

    window.TA_earn = { loadTasks, loadAccounting, state };
    // The page fires this after recording a trade so P&L and task eligibility
    // refresh together instead of waiting for a manual reload.
    window.addEventListener('tradeLogged', function () { loadTasks(); loadAccounting(); });
})();
