// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IFlashLoanSimpleReceiver} from "@aave/core-v3/contracts/flashloan/interfaces/IFlashLoanSimpleReceiver.sol";
import {IPoolAddressesProvider} from "@aave/core-v3/contracts/interfaces/IPoolAddressesProvider.sol";
import {IPool} from "@aave/core-v3/contracts/interfaces/IPool.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title FlashloanArbitrage
 * @notice Atomic cross-DEX arbitrage funded by an Aave v3 flash loan.
 *
 * SECURITY MODEL — READ BEFORE DEPLOYING
 * --------------------------------------
 * This contract executes ARBITRARY calldata against ARBITRARY targets while
 * holding borrowed funds. That is inherent to atomic arbitrage (the swap route
 * is only known at execution time), but it means:
 *
 *   1. The contract MUST hold no funds of its own between transactions. Any
 *      balance left here is theft waiting to happen, because the next
 *      `executeOperation` will route it through whatever targets are
 *      allowlisted. Profit is therefore swept out every execution.
 *
 *   2. `executeOperation` is reentrancy-guarded. Aave's callback re-enters this
 *      contract and every action is an untrusted external call that can call
 *      back in.
 *
 *   3. Profit is verified in the SAME transaction, after all actions. An
 *      unprofitable route reverts the whole thing, so the loan is returned and
 *      the only cost is gas. There is no way to "succeed" while owing Aave.
 *
 *   4. Actions are capped and targets must be allowlisted by the owner. An
 *      unbounded action list or arbitrary target turns a bounded risk into an
 *      unbounded one.
 */
contract FlashloanArbitrage is IFlashLoanSimpleReceiver, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IPoolAddressesProvider public immutable ADDRESSES_PROVIDER;
    IPool public immutable POOL;

    /// @dev Hard cap on actions per execution. A real route needs 2-3 swaps.
    uint256 public constant MAX_ACTIONS = 8;

    /// @dev Owner-curated set of callable targets. Empty means nothing callable.
    mapping(address => bool) public allowedTarget;

    /// @dev Reserves for fees. Deliberately NOT routed by arbitrage.
    mapping(address => uint256) public reserves;

    /// @notice Where realised profit is sent.
    /// @dev Must NOT be msg.sender: inside the Aave callback msg.sender is the
    /// Pool, so sweeping to it would return the profit to Aave and silently
    /// destroy the bot's entire edge.
    address public profitRecipient;

    event ActionExecuted(address indexed target, uint256 index);
    event ArbitrageCompleted(address indexed asset, uint256 netProfit);
    event TargetAllowlisted(address indexed target, bool allowed);
    event ProfitRecipientUpdated(address indexed recipient);

    struct Action {
        address target;
        bytes callData;
    }

    struct FlashParams {
        uint256 minProfit;
        Action[] actions;
    }

    constructor(address addressProvider) Ownable(msg.sender) {
        require(addressProvider != address(0), "zero provider");
        ADDRESSES_PROVIDER = IPoolAddressesProvider(addressProvider);
        POOL = IPool(ADDRESSES_PROVIDER.getPool());
        // Default to the deployer. Explicitly overridable, but never left at
        // address(0) or profit would be burned on every execution.
        profitRecipient = msg.sender;
    }

    /// @notice Sets where realised profit is sent.
    function setProfitRecipient(address recipient) external onlyOwner {
        require(recipient != address(0), "zero recipient");
        profitRecipient = recipient;
        emit ProfitRecipientUpdated(recipient);
    }

    modifier onlyAllowlistedTarget(address target) {
        require(allowedTarget[target], "target not allowlisted");
        _;
    }

    /// @notice Allow or revoke a contract this bot may call during execution.
    function setTargetAllowed(address target, bool allowed) external onlyOwner {
        require(target != address(0), "zero target");
        allowedTarget[target] = allowed;
        emit TargetAllowlisted(target, allowed);
    }

    /// @dev Deposits held for fees. These are NOT tradeable capital.
    function addReserve(address token, uint256 amount) external onlyOwner {
        reserves[token] += amount;
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @notice Withdraws reserves. Safe because reserves are never routed.
    function withdrawReserve(address token, uint256 amount, address to) external onlyOwner {
        require(to != address(0), "zero recipient");
        uint256 r = reserves[token];
        require(r >= amount, "insufficient reserve");
        reserves[token] = r - amount;
        IERC20(token).safeTransfer(to, amount);
    }

    /**
     * @notice Request an atomic flash-loan funded arbitrage.
     * @param token Asset to borrow.
     * @param amount Amount to borrow.
     * @param params abi-encoded FlashParams (minProfit + actions).
     */
    function requestFlashLoan(
        address token,
        uint256 amount,
        bytes calldata params
    ) external nonReentrant onlyOwner {
        require(amount > 0, "zero amount");
        POOL.flashLoanSimple(address(this), token, amount, params, 0);
    }

    /**
     * @notice Aave's synchronous flash-loan callback. Invoked by the Pool during
     * `flashLoanSimple`, while `requestFlashLoan` is still on the stack.
     *
     * @dev DELIBERATELY NOT `nonReentrant`. Aave calls this re-entrantly with
     * respect to `requestFlashLoan`, so guarding both entry points makes every
     * flash loan revert on the nested guard. Protection instead comes from:
     *   - `msg.sender == address(POOL)` below,
     *   - `initiator == address(this)`, and
     *   - `onlyOwner` on `requestFlashLoan`, so only the owner can originate a
     *     loan and the actions are their choice, not an attacker's.
     * The owner is the sole trusted party here; the allowlist and profit check
     * are the bounds on what their calldata can do with borrowed funds.
     */
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external override returns (bool) {
        require(msg.sender == address(POOL), "Only Pool");
        require(initiator == address(this), "Invalid initiator");

        FlashParams memory decoded = abi.decode(params, (FlashParams));
        require(decoded.actions.length > 0, "no actions");
        require(decoded.actions.length <= MAX_ACTIONS, "too many actions");

        for (uint256 i = 0; i < decoded.actions.length; i++) {
            address target = decoded.actions[i].target;
            // Not optional: allowlisting bounds what borrowed funds can be
            // routed into. Without it, any address can be called.
            //
            // Inlined rather than reusing the `onlyAllowlistedTarget` modifier,
            // which cannot be invoked as a statement mid-loop.
            require(allowedTarget[target], "target not allowlisted");

            (bool success, ) = target.call(decoded.actions[i].callData);
            require(success, "Action failed");
            emit ActionExecuted(target, i);
        }

        uint256 amountToRepay = amount + premium;

        // Profit is measured AFTER the actions, in the same transaction. A
        // shortfall reverts everything, so the loan is repaid or the whole call
        // unwinds - there is no state where Aave is left unpaid.
        uint256 balanceAfter = IERC20(asset).balanceOf(address(this));
        require(balanceAfter >= amountToRepay, "Insufficient funds to repay");

        // Idle reserves are deliberately NOT routed capital, so they must be
        // excluded or they would be counted as "profit" and swept away. This is
        // what makes `addReserve` safe to use for gas/fee funding.
        uint256 idle = reserves[asset];
        uint256 netProfit = balanceAfter - amountToRepay - idle;
        require(netProfit >= decoded.minProfit, "Arbitrage unprofitable");

        // forceApprove resets a possibly non-zero allowance left by a prior
        // call. Plain approve is a known footgun with USDT-style tokens.
        IERC20(asset).forceApprove(address(POOL), amountToRepay);

        // Sweep profit out immediately. Leaving it here would expose it to
        // the next route's arbitrary calls.
        //
        // NOTE: this must NOT be msg.sender. In the Aave callback msg.sender is
        // the Pool, so sending profit there would hand it straight back to
        // Aave and silently burn the bot's edge.
        if (netProfit > 0) {
            IERC20(asset).safeTransfer(profitRecipient, netProfit);
        }

        emit ArbitrageCompleted(asset, netProfit);
        return true;
    }

    /**
     * @notice Reject stray ETH. A native balance here would be unaccounted-for
     * capital exposed to the next route's arbitrary calls.
     * @dev `revert("...")` rather than `revert "..."`. The bare string form is
     * only valid in a modifier position, not in a function body - solc rejects
     * it here with "Expected ';' but got 'StringLiteral'".
     */
    receive() external payable {
        revert("ETH not accepted");
    }
}
