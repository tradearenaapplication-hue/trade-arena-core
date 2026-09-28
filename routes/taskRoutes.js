/**
 * Earn module routes.
 *
 * Registration and claiming both require a signature from the wallet being
 * claimed for. Without that, anyone could register a claim against someone
 * else's address and be paid for it.
 *
 * The signed nonce is bound to a specific wallet AND a specific task, so a
 * signature captured for one task cannot be replayed to claim another.
 *
 * Payout honesty: nothing here reports a reward as paid unless a payout tx
 * exists. See services/task-registry.js for why there is no client-side credit
 * balance standing in for real money.
 */

'use strict';

const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { ethers } = require('ethers');

const db = require('../data/database');
const taskRegistry = require('../services/task-registry');

const router = express.Router();

const NONCE_TTL_MS = 5 * 60 * 1000;
const TASK_NONCES = new Map();

const earnLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 30,
    message: { success: false, error: 'Too many earn requests. Try again shortly.' }
});

/** Catalogue plus whether payouts are actually possible right now. */
router.get('/', (req, res) => {
    try {
        res.json({
            success: true,
            tasks: taskRegistry.TASKS,
            payout: taskRegistry.payoutConfiguration()
        });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Could not load the task catalogue' });
    }
});

/** A wallet's status on every task. */
router.get('/:address', (req, res) => {
    try {
        const address = String(req.params.address || '').trim();
        if (!ethers.isAddress(address)) {
            return res.status(400).json({ success: false, error: 'A valid address is required' });
        }

        const claims = db.getTaskClaims(address);
        const byId = new Map(claims.map(c => [c.taskId, c]));

        // Paid total counts only records that actually carry a payout tx.
        // Summing rewardUsd across every claim would report money that was
        // never sent, which is the exact illusion this module must not create.
        let paidUsd = 0;
        let pendingUsd = 0;
        for (const c of claims) {
            if (typeof c.rewardUsd !== 'number') continue;
            if (c.payoutStatus === 'PAID') paidUsd += c.rewardUsd;
            else if (c.payoutStatus === 'ELIGIBLE' || c.payoutStatus === 'PENDING_CONFIGURATION') pendingUsd += c.rewardUsd;
        }

        res.json({
            success: true,
            address: ethers.getAddress(address),
            payout: taskRegistry.payoutConfiguration(),
            paidUsd,
            pendingUsd,
            tasks: taskRegistry.TASKS.map(t => {
                const c = byId.get(t.id) || null;
                return {
                    id: t.id, label: t.label, description: t.description,
                    rewardUsd: t.rewardUsd, icon: t.icon,
                    verification: t.verification, action: t.action,
                    status: c ? c.payoutStatus : 'NOT_CLAIMED',
                    claimedAt: c ? c.createdAt : null,
                    reason: c ? c.reason : null,
                    evidence: c ? c.evidence : null,
                    proven: c ? c.proven === true : false,
                    txHash: c ? c.txHash : null,
                    explorerUrl: c ? c.explorerUrl : null
                };
            })
        });
    } catch (err) {
        console.error('[tasks] GET /:address failed:', err);
        res.status(500).json({ success: false, error: 'Could not load task status' });
    }
});

/**
 * Canonical earn-authorisation message.
 *
 * Single source of truth for BOTH the nonce endpoint and the verifier. These
 * were previously two separate template literals, and they drifted: the issued
 * message carried a trailing "This authorises..." line that the verifier did
 * not, so every correctly signed claim was rejected with "Signature does not
 * match this wallet". One builder makes that class of bug impossible.
 */
function earnMessage(address, taskId, nonce) {
    return `Trade Arena earn authorisation\n\nAddress: ${address}\nTask: ${taskId}\nNonce: ${nonce}\n\nThis authorises registering or claiming only the task named above.`;
}

/** Issue an earn nonce bound to one wallet and one task. */
router.post('/:address/nonce', earnLimiter, (req, res) => {
    try {
        const address = String(req.params.address || '').trim();
        if (!ethers.isAddress(address)) {
            return res.status(400).json({ success: false, error: 'A valid address is required' });
        }
        const taskId = String((req.body && req.body.taskId) || 'wallet_connected');
        if (!taskRegistry.getTask(taskId)) {
            return res.status(400).json({ success: false, error: `Unknown task "${taskId}".` });
        }

        const nonce = '0x' + crypto.randomBytes(16).toString('hex');
        const payloadHash = ethers.keccak256(ethers.toUtf8Bytes(`${address.toLowerCase()}|${taskId}`));
        TASK_NONCES.set(`${address.toLowerCase()}:earn:${nonce}`, { issuedAt: Date.now(), payloadHash });

        // Opportunistic cleanup so the map cannot grow without bound.
        const now = Date.now();
        for (const [k, e] of TASK_NONCES) {
            if (now - e.issuedAt > NONCE_TTL_MS) TASK_NONCES.delete(k);
        }

        res.json({
            success: true,
            address: ethers.getAddress(address),
            taskId,
            nonce,
            message: earnMessage(address, taskId, nonce)
        });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Could not issue an earn nonce' });
    }
});

/** Shared claim path for register and claim. */
async function handleClaim(req, res, taskIdOverride) {
    try {
        const address = String(req.params.address || '').trim();
        if (!ethers.isAddress(address)) {
            return res.status(400).json({ success: false, error: 'A valid address is required' });
        }

        const { nonce, signature } = req.body || {};
        if (!nonce || !signature) {
            return res.status(401).json({
                success: false,
                error: 'Sign the earn authorisation first: request a nonce, sign it, then submit.'
            });
        }

        const key = `${address.toLowerCase()}:earn:${nonce}`;
        const entry = TASK_NONCES.get(key);
        if (!entry) {
            return res.status(401).json({ success: false, error: 'Unknown or already-used earn nonce.' });
        }
        if (Date.now() - entry.issuedAt > NONCE_TTL_MS) {
            TASK_NONCES.delete(key);
            return res.status(401).json({ success: false, error: 'Earn nonce expired. Request a new one.' });
        }

        const taskId = taskIdOverride || req.body.taskId;
        const task = taskRegistry.getTask(taskId);
        if (!task) {
            TASK_NONCES.delete(key);
            return res.status(400).json({ success: false, error: `Unknown task "${taskId}".` });
        }

        // The signature must cover this wallet AND this task, so a signature
        // captured for one task cannot be replayed to claim another.
        const expectedHash = ethers.keccak256(ethers.toUtf8Bytes(`${address.toLowerCase()}|${taskId}`));
        if (entry.payloadHash !== expectedHash) {
            TASK_NONCES.delete(key);
            return res.status(401).json({ success: false, error: 'Earn authorisation was issued for a different task.' });
        }

        let recovered;
        try {
            recovered = ethers.verifyMessage(earnMessage(address, taskId, nonce), signature);
        } catch (e) {
            TASK_NONCES.delete(key);
            return res.status(401).json({ success: false, error: 'Could not verify the earn signature.' });
        }
        if (recovered.toLowerCase() !== address.toLowerCase()) {
            TASK_NONCES.delete(key);
            return res.status(401).json({ success: false, error: 'Signature does not match this wallet.' });
        }
        TASK_NONCES.delete(key);

        // One claim per wallet per task, enforced by the record key rather
        // than by trusting the client to remember.
        const existing = db.getTaskRecord(address, taskId);
        if (existing && existing.payoutStatus === 'PAID') {
            return res.status(409).json({
                success: false,
                error: 'This task has already been claimed and paid for this wallet.',
                record: existing
            });
        }

        const tradeLogs = db.getTradeLogs(address, 10000);
        const pnlByTxHash = {};
        for (const t of tradeLogs) {
            const tx = t && t.details ? t.details.txHash : null;
            if (tx && typeof t.pnl === 'number') pnlByTxHash[tx] = t.pnl;
        }

        // Verification runs against server-side evidence. A request body can
        // add a submission link for an attested task, but it can never turn a
        // failed verification into a pass.
        const verdict = taskRegistry.verifyTask(taskId, { tradeLogs, pnlByTxHash });
        const payout = taskRegistry.payoutConfiguration();

        if (!verdict.ok) {
            const rejected = db.recordTaskClaim(address, taskId, {
                payoutStatus: 'REJECTED',
                verification: task.verification,
                proven: false,
                rewardUsd: task.rewardUsd,
                reason: verdict.reason,
                evidence: verdict.evidence
            });
            return res.status(400).json({ success: false, error: verdict.reason, record: rejected });
        }

        const payoutStatus = payout.enabled ? 'ELIGIBLE' : 'PENDING_CONFIGURATION';
        const record = db.recordTaskClaim(address, taskId, {
            payoutStatus,
            verification: task.verification,
            // An attested claim is not proven, and the record says so.
            proven: task.verification === 'PROVEN',
            rewardUsd: task.rewardUsd,
            reason: verdict.reason,
            evidence: verdict.evidence,
            submissionUrl: (req.body && req.body.submissionUrl) || null,
            txHash: null,
            explorerUrl: null
        });

        res.json({
            success: true,
            record,
            payout,
            message: payout.enabled
                ? 'Task verified. Payout is queued.'
                : 'Task verified and recorded. No tokens were sent: ' + payout.detail
        });
    } catch (err) {
        console.error('[tasks] claim failed:', err);
        res.status(500).json({ success: false, error: 'Could not process the task claim' });
    }
}

router.post('/:address/register', earnLimiter, (req, res) => handleClaim(req, res, 'wallet_connected'));
router.post('/:address/claim', earnLimiter, (req, res) => handleClaim(req, res, null));

module.exports = router;
