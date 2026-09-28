const axios = require('axios');
const { ethers } = require('ethers');
const crypto = require('crypto');

class PayoutService {
    constructor(config) {
        this.config = config;
        this.oracleWallet = null;
        try {
            if (config.oraclePrivateKey) {
                this.oracleWallet = new ethers.Wallet(config.oraclePrivateKey);
                console.log(`[PayoutService] Oracle wallet initialized: ${this.oracleWallet.address}`);
            } else {
                console.warn('[PayoutService] No oraclePrivateKey provided. Signature generation will be disabled.');
            }
        } catch (error) {
            console.error('[PayoutService] Failed to initialize oracle wallet:', error.message);
        }
        this.rewardTokenAddress = config.rewardTokenAddress;
        this.payoutManagerAddress = config.payoutManagerAddress;
        this.chainId = config.chainId;
    }

    async generatePayoutSignature(userAddress, taskId, amount, nonce) {
        if (!this.oracleWallet) {
            throw new Error('Oracle wallet not configured');
        }
        const domain = {
            name: 'PayoutManager',
            version: '1',
            chainId: this.chainId,
            verifyingContract: this.payoutManagerAddress
        };

        const types = {
            Payout: [
                { name: 'user', type: 'address' },
                { name: 'taskId', type: 'string' },
                { name: 'amount', type: 'uint256' },
                { name: 'nonce', type: 'uint256' }
            ]
        };

        const value = { user: userAddress, taskId, amount, nonce };
        return await this.oracleWallet.signTypedData(domain, types, value);
    }

    /**
     * Sign an authorisation for a specific reward amount.
     *
     * The amount MUST come from the task definition. It used to be hardcoded to
     * 10 USDC here regardless of the task, which meant a $1 registration task
     * and a $25 sharing task both paid $10 - the UI would promise one number
     * and the contract would pay another. The amount is now a required
     * parameter so that cannot recur silently.
     */
    async authorizePayout(userAddress, taskId, rewardUsd, rewardDecimals = 6) {
        // Sentinel: Validate inputs to prevent signing malicious or malformed data
        if (!userAddress || !ethers.isAddress(userAddress)) {
            throw new Error('Invalid user address');
        }
        if (!taskId || typeof taskId !== 'string' || taskId.length > 100) {
            throw new Error('Invalid taskId');
        }
        // Refuse a non-positive or non-finite amount rather than signing a
        // zero-value or NaN payout.
        const reward = Number(rewardUsd);
        if (!Number.isFinite(reward) || reward <= 0) {
            throw new Error(`Invalid reward amount: ${rewardUsd}`);
        }
        // Truncate down to the token's own precision: a fractional token
        // amount would make the router reject the transfer and cost gas.
        const amount = ethers.parseUnits(
            reward.toFixed(rewardDecimals).replace(/0+$/, '').replace(/\.$/, '') || '0',
            rewardDecimals
        );
        if (amount <= 0n) {
            throw new Error(`Reward ${rewardUsd} rounds to zero at ${rewardDecimals} decimals`);
        }

        // A cryptographically random 256-bit nonce, so it cannot be predicted
        // or collided across users.
        const nonce = BigInt('0x' + crypto.randomBytes(32).toString('hex'));
        const signature = await this.generatePayoutSignature(userAddress, taskId, amount, nonce);

        return { user: userAddress, taskId, amount: amount.toString(), nonce: nonce.toString(), signature };
    }
}

module.exports = PayoutService;
