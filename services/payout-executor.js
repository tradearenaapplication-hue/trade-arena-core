/**
 * On-chain reward payout.
 *
 * Gated on configuration. With PAYOUT_MANAGER_ADDRESS, REWARD_TOKEN_ADDRESS and
 * PAYOUT_PRIVATE_KEY unset, every method here refuses rather than pretending,
 * so a claim is recorded as PENDING_CONFIGURATION and the UI says so.
 *
 * The flow mirrors what PayoutManager.claimReward expects: the server signs an
 * EIP-712 authorisation as the oracle, and either the server or the user relays
 * it to the contract. The contract itself enforces that the signature came from
 * the oracle and that a nonce is used once, so relaying cannot forge a payout.
 */

'use strict';

const { ethers } = require('ethers');
const PayoutService = require('./payouts/payoutService');

const CLAIM_ABI = [
    'function claimReward(address user,string taskId,uint256 amount,uint256 nonce,bytes signature) external',
    'event RewardClaimed(address indexed user, string taskId, uint256 amount)'
];

class PayoutExecutor {
    constructor(opts = {}) {
        this.chainId = Number(opts.chainId || 8453);
        this.rpcUrl = opts.rpcUrl || 'https://mainnet.base.org';
        this.explorer = opts.explorer || 'https://basescan.org';

        const missing = [];
        if (!opts.payoutManagerAddress) missing.push('PAYOUT_MANAGER_ADDRESS');
        if (!opts.rewardTokenAddress) missing.push('REWARD_TOKEN_ADDRESS');
        if (!opts.oraclePrivateKey) missing.push('PAYOUT_PRIVATE_KEY');
        this.missing = missing;
        this.configured = missing.length === 0;

        this.service = new PayoutService({
            oraclePrivateKey: opts.oraclePrivateKey,
            rewardTokenAddress: opts.rewardTokenAddress,
            payoutManagerAddress: opts.payoutManagerAddress,
            chainId: this.chainId
        });

        this.provider = this.configured ? new ethers.JsonRpcProvider(this.rpcUrl) : null;
        this.wallet = this.configured ? new ethers.Wallet(opts.oraclePrivateKey, this.provider) : null;
    }

    /**
     * Send a reward on-chain.
     *
     * @returns {{ok: boolean, txHash?: string, explorerUrl?: string, amount?: string, reason: string}}
     */
    async payReward({ userAddress, taskId, rewardUsd, rewardDecimals = 6 }) {
        if (!this.configured) {
            return {
                ok: false,
                reason: 'On-chain payouts are not configured; missing ' + this.missing.join(', ') + '.'
            };
        }

        // The contract is the final authority on validity. If the address is
        // not deployed, every call reverts; say so once rather than retrying
        // per claim and burning gas on a known-bad target.
        let code;
        try {
            code = await this.provider.getCode(this.service.payoutManagerAddress);
        } catch (err) {
            return { ok: false, reason: 'Could not reach the chain: ' + err.message };
        }
        if (!code || code === '0x') {
            return {
                ok: false,
                reason: `No contract deployed at ${this.service.payoutManagerAddress} on chain ${this.chainId}. ` +
                    'PayoutManager must be deployed before rewards can be paid.'
            };
        }

        let auth;
        try {
            auth = await this.service.authorizePayout(userAddress, taskId, rewardUsd, rewardDecimals);
        } catch (err) {
            return { ok: false, reason: 'Could not sign the payout: ' + err.message };
        }

        try {
            const contract = new ethers.Contract(this.service.payoutManagerAddress, CLAIM_ABI, this.wallet);
            const tx = await contract.claimReward(
                auth.user, auth.taskId, auth.amount, auth.nonce, auth.signature
            );
            const receipt = await tx.wait();

            if (receipt.status !== 1) {
                return { ok: false, txHash: tx.hash, reason: 'Payout transaction reverted on-chain.' };
            }
            return {
                ok: true,
                txHash: receipt.hash,
                blockNumber: receipt.blockNumber,
                amount: auth.amount,
                explorerUrl: `${this.explorer}/tx/${receipt.hash}`,
                reason: 'Reward paid on-chain.'
            };
        } catch (err) {
            return { ok: false, reason: 'Payout transaction failed: ' + (err.shortMessage || err.message) };
        }
    }
}

module.exports = { PayoutExecutor };
