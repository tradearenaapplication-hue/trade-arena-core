/**
 * Earn module: task catalogue and verification.
 *
 * Honest verification
 * -------------------
 * Every task declares HOW it is verified, and the UI must show that.
 * Some tasks can be checked against facts this server already holds; others
 * genuinely cannot be verified here, and pretending otherwise would let anyone
 * farm rewards by calling an endpoint.
 *
 *   PROVEN             verified against real data the server already has
 *                      (a trade really is in the log, a P&L really was booked).
 *   ATTESTED           the user asserts it and the claim is recorded as
 *                      UNVERIFIED. Honest, but an assertion is not a fact, and
 *                      the payout status reflects the difference.
 *   EXTERNAL_UNAVAILABLE
 *                      needs a third-party API that is not configured.
 *                      Refused rather than faked.
 *
 * Payout reality
 * --------------
 * Rewards are paid on-chain ONLY when a payout contract, reward token and
 * signing key are configured. When they are not, a verified claim is stored as
 * PENDING_CONFIGURATION. It is never reported as paid, and there is no
 * client-side "credits" balance standing in for money - that is what the
 * previous localStorage faucet did, and it made unpaid rewards look like
 * winnings.
 */

'use strict';

const TASKS = [
  {
    id: 'first_trade',
    label: 'Execute your first on-chain trade',
    description: 'Complete one real swap on Base. Verified against the trade log.',
    rewardUsd: 5, icon: '🎰', verification: 'PROVEN', action: 'TRADE'
  },
  {
    id: 'trade_volume',
    label: 'Reach $100 in executed volume',
    description: 'Cumulative USD value traded on-chain.',
    rewardUsd: 10, icon: '📈', verification: 'PROVEN', action: 'TRADE'
  },
  {
    id: 'realised_profit',
    label: 'Close a position in profit',
    description: 'A trade that realised a positive P&L after gas.',
    rewardUsd: 15, icon: '🏆', verification: 'PROVEN', action: 'TRADE'
  },
  {
    id: 'wallet_connected',
    label: 'Connect and register your wallet',
    description: 'Attested at registration by signing a message with the wallet.',
    rewardUsd: 1, icon: '🔗', verification: 'ATTESTED', action: 'REGISTER'
  },
  {
    id: 'share_win',
    label: 'Share a trade',
    description: 'Submit a public post link about a trade. Not independently verified here.',
    rewardUsd: 25, icon: '🚀', verification: 'ATTESTED', action: 'SUBMIT'
  },
  {
    id: 'join_discord',
    label: 'Join the community',
    description: 'Requires a Discord membership API, which is not configured.',
    rewardUsd: 15, icon: '💬', verification: 'EXTERNAL_UNAVAILABLE', action: 'NONE'
  },
  {
    id: 'follow_twitter',
    label: 'Follow on X',
    description: 'Requires a social API integration, which is not configured.',
    rewardUsd: 10, icon: '🐦', verification: 'EXTERNAL_UNAVAILABLE', action: 'NONE'
  }
];

const TASK_IDS = new Set(TASKS.map(t => t.id));
const MAX_CLAIMS_PER_ADDRESS_PER_DAY = 20;

function getTask(id) {
  return TASKS.find(t => t.id === id) || null;
}

/**
 * Total USD volume a wallet has traded, from its own trade log.
 *
 * Uses the stored USD legs rather than re-pricing: the value at the time of
 * the fill is the only figure that was actually true.
 */
function volumeUsdFor(tradeLogs) {
  let total = 0;
  for (const t of tradeLogs || []) {
    const d = (t && t.details) || {};
    const usd = d.fromUsd != null ? d.fromUsd : (t && typeof t.amount === 'number' ? t.amount : 0);
    if (typeof usd === 'number' && Number.isFinite(usd)) total += usd;
  }
  return total;
}

/**
 * Verify a claim against real server-side evidence.
 *
 * @returns {{ok: boolean, reason: string, evidence: object|null}}
 */
function verifyTask(taskId, ctx) {
  const task = getTask(taskId);
  if (!task) return { ok: false, reason: 'Unknown task.', evidence: null };

  const { tradeLogs = [], pnlByTxHash = {} } = ctx || {};

  switch (taskId) {
    case 'first_trade': {
      const count = tradeLogs.length;
      const first = tradeLogs[0] && tradeLogs[0].details ? tradeLogs[0].details.txHash : null;
      return {
        ok: count > 0,
        reason: count > 0
          ? `${count} on-chain trade(s) on record.`
          : 'No on-chain trades recorded for this wallet yet.',
        evidence: { tradeCount: count, firstTxHash: first }
      };
    }
    case 'trade_volume': {
      const vol = volumeUsdFor(tradeLogs);
      return {
        ok: vol >= 100,
        reason: `Executed volume $${vol.toFixed(2)} of the $100 required.`,
        evidence: { volumeUsd: vol, requiredUsd: 100 }
      };
    }
    case 'realised_profit': {
      const winners = Object.entries(pnlByTxHash).filter((e) => Number(e[1]) > 0);
      return {
        ok: winners.length > 0,
        reason: winners.length > 0
          ? `${winners.length} profitable exit(s) recorded.`
          : 'No closed position has realised a profit yet.',
        evidence: { profitableExits: winners.length, bestTxHash: winners.length ? winners[0][0] : null }
      };
    }
    case 'wallet_connected':
      // Reaching this handler IS the attestation: the caller signed a message
      // with the wallet they are claiming for.
      return { ok: true, reason: 'Wallet signed the registration message.', evidence: { attested: true } };

    case 'share_win':
      // Recorded, but explicitly NOT treated as verified. The payout status
      // says so, so an unproven claim can never be displayed as a win.
      return {
        ok: true,
        reason: 'Recorded as an unverified self-report.',
        evidence: { attested: true, verified: false }
      };

    case 'join_discord':
    case 'follow_twitter':
      return {
        ok: false,
        reason: 'This task needs a third-party API that is not configured on this server. It is not claimable.',
        evidence: null
      };

    default:
      return { ok: false, reason: 'Task has no verification rule.', evidence: null };
  }
}

/**
 * Whether on-chain payouts are possible right now.
 *
 * Checked rather than assumed, so the UI can state the truth instead of
 * promising a reward the server has no way to send.
 */
function payoutConfiguration() {
  const missing = [];
  if (!process.env.PAYOUT_MANAGER_ADDRESS) missing.push('PAYOUT_MANAGER_ADDRESS');
  if (!process.env.REWARD_TOKEN_ADDRESS) missing.push('REWARD_TOKEN_ADDRESS');
  if (!process.env.PAYOUT_PRIVATE_KEY) missing.push('PAYOUT_PRIVATE_KEY');
  return {
    enabled: missing.length === 0,
    missing,
    detail: missing.length === 0
      ? 'On-chain payouts are configured.'
      : `On-chain payouts are NOT configured; missing ${missing.join(', ')}. ` +
        'Verified claims are recorded but no tokens are sent.'
  };
}

module.exports = {
  TASKS, TASK_IDS, getTask, verifyTask, payoutConfiguration, volumeUsdFor,
  MAX_CLAIMS_PER_ADDRESS_PER_DAY
};

