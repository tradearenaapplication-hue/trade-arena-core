// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {FlashloanArbitrage} from "../src/FlashloanArbitrage.sol";
import {IPoolAddressesProvider} from "@aave/core-v3/contracts/interfaces/IPoolAddressesProvider.sol";
import {DeploySepolia} from "../script/DeploySepolia.s.sol";

/// @dev Mirror of the on-chain Aave v3 Base Sepolia addresses, so the deploy
/// script's guards can be tested without broadcasting anything.
contract MockSepoliaProvider {
    address public pool;

    constructor(address _pool) {
        pool = _pool;
    }

    function getPool() external view returns (address) {
        return pool;
    }
}

/// @dev Testable copy of DeploySepolia with the chain check, key lookup and
/// broadcast stripped out. The AAVE WIRING LOGIC is identical to the real
/// script - that logic is the part that has to be proven, because a provider
/// address with no code deploys fine and then fails on every single trade.
contract DeploySepoliaHarness {
    address public constant EXPECTED_POOL =
        0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27;
    address public constant PROVIDER =
        0xE4C23309117Aa30342BFaae6c95c6478e0A4Ad00;
    address public constant WRONG_POOL =
        0x1111111111111111111111111111111111111111;

    MockSepoliaProvider public mockProvider;

    /// @dev Deploys against an explicit provider/pool pair so tests can force
    /// both the "no code" and "wrong pool" failure modes.
    function _deploy(address provider, address pool)
        internal
        returns (FlashloanArbitrage)
    {
        // Guard: a provider with no code is the failure this whole script
        // exists to prevent - deployment succeeds, every later trade reverts.
        require(
            provider.code.length > 0,
            "PROVIDER has no code: it is not a contract on this chain"
        );

        // Guard: the address book and the chain must agree.
        (bool ok, bytes memory ret) = provider.staticcall(
            abi.encodeWithSignature("getPool()")
        );
        require(ok && ret.length == 32, "getPool() failed on provider");
        address resolved = abi.decode(ret, (address));
        require(
            resolved == EXPECTED_POOL,
            "UNEXPECTED POOL: address book and chain disagree"
        );

        FlashloanArbitrage deployed = new FlashloanArbitrage(provider);
        require(
            address(deployed.POOL()) == EXPECTED_POOL,
            "CONTRACT NOT WIRED TO AAVE POOL"
        );
        deployed.setProfitRecipient(msg.sender);
        return deployed;
    }

    /// Happy path: the mock provider reports the real Aave pool address.
    function runHappy() public returns (FlashloanArbitrage) {
        mockProvider = new MockSepoliaProvider(EXPECTED_POOL);
        return _deploy(address(mockProvider), EXPECTED_POOL);
    }

    /// Failure: the provider reports a different pool.
    function runWrongPool() public returns (FlashloanArbitrage) {
        mockProvider = new MockSepoliaProvider(WRONG_POOL);
        return _deploy(address(mockProvider), WRONG_POOL);
    }

    /// Failure: the provider address has no code at all.
    function runNoCode(address provider) public returns (FlashloanArbitrage) {
        return _deploy(provider, EXPECTED_POOL);
    }
}


/// @dev Minimal ERC20 so profit arithmetic is exactly observable.
contract MockToken is ERC20 {
    constructor() ERC20("Mock", "MCK") {}

    function mint(address to, uint256 amt) external {
        _mint(to, amt);
    }
}

/// @dev Returns our mock pool from getPool(), so the contract's immutable POOL
/// (set in the constructor) points somewhere we control.
contract MockAddressesProvider {
    address public pool;

    constructor(address _pool) {
        pool = _pool;
    }

    function setPool(address _pool) external {
        pool = _pool;
    }

    function getPool() external view returns (address) {
        return pool;
    }
}

/// @dev Stands in for the Aave Pool. The property under test is that it calls
/// back SYNCHRONOUSLY while `requestFlashLoan` is still on the stack - which is
/// exactly what made the previous double-`nonReentrant` design revert.
contract MockPool {
    uint256 public constant PREMIUM_BPS = 5; // verified on-chain: Aave v3 Base
    address public borrower;
    uint256 public lastAmount;
    uint256 public lastPremium;
    bool public callbackRan;
    bool public allowCallbacks = true;
    address public arb;

    constructor(address _arb) {
        arb = _arb;
    }

    function setArb(address _arb) external {
        arb = _arb;
    }

    function flashLoanSimple(
        address receiver,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16
    ) external {
        require(msg.sender == arb, "not arb");
        borrower = receiver;
        lastAmount = amount;
        lastPremium = (amount * PREMIUM_BPS) / 10_000;

        MockToken(asset).mint(address(this), amount);
        MockToken(asset).transfer(receiver, amount);

        if (!allowCallbacks) return; // test helper

        (bool ok, bytes memory ret) = receiver.call(
            abi.encodeWithSelector(
                bytes4(keccak256("executeOperation(address,uint256,uint256,address,bytes)")),
                asset,
                amount,
                lastPremium,
                // Aave passes `initiator` as msg.sender of flashLoanSimple,
                // which is the receiver/arb - NOT the pool.
                receiver,
                params
            )
        );
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
        require(abi.decode(ret, (bool)), "callback false");

        // Real Aave v3 PULLS the repayment via transferFrom after the callback
        // returns - the receiver only sets an allowance. Mirroring that here so
        // the contract is held to the actual Aave settlement flow.
        MockToken(asset).transferFrom(receiver, address(this), amount + lastPremium);

        require(
            MockToken(asset).balanceOf(address(this)) >= amount + lastPremium,
            "pool underpaid"
        );
        callbackRan = true;
    }
}

/// @dev Allowlisted "DEX". Mints `payout` tokens to the arb contract so a
/// profitable round trip can be simulated, and can also misbehave on demand.
contract MockSwapper {
    uint256 public payout;
    bool public shouldRevert;
    address public immutable sink;

    constructor(address _sink) {
        sink = _sink;
    }

    function setPayout(uint256 p) external {
        payout = p;
    }

    function setShouldRevert(bool r) external {
        shouldRevert = r;
    }

    function swap() external {
        require(!shouldRevert, "swapper failed");
        // Simulate the arb having received proceeds; `payout` is the net
        // amount left after repaying principal + premium is accounted for by
        // the test minting the full round-trip result.
        MockToken(sink).mint(msg.sender, payout);
    }

    /// @dev Re-entry probe: tries to call back into the arb mid-execution.
    function reenter(address payable target) external {
        FlashloanArbitrage(target).withdrawReserve(
            sink,
            type(uint256).max,
            address(this)
        );
    }
}

contract FlashloanArbitrageTest is Test {
    FlashloanArbitrage arb;
    MockPool pool;
    MockAddressesProvider provider;
    MockToken token;
    MockSwapper swapper;

    address recipient = address(0xBEEF);

    uint256 constant AMOUNT = 1000e18;
    // 5 bps of 1000e18 = 0.5e18 (Aave v3 Base, verified on-chain)
    uint256 constant PREMIUM = 0.5e18;

    function setUp() public {
        token = new MockToken();
        swapper = new MockSwapper(address(token));

        // Circular dependency: the arb's POOL is immutable (read from the
        // provider in its constructor), but the pool needs the arb address.
        // Resolve with a two-phase deploy - pool first, then arb, then tell
        // the pool who the arb is.
        pool = new MockPool(address(0));
        provider = new MockAddressesProvider(address(pool));
        arb = new FlashloanArbitrage(address(provider));
        pool.setArb(address(arb));

        // Profit must be routed explicitly - it does NOT go to msg.sender.
        arb.setProfitRecipient(recipient);
    }

    function _params(uint256 minProfit, address target, bytes memory data)
        internal
        view
        returns (bytes memory)
    {
        FlashloanArbitrage.Action[] memory actions =
            new FlashloanArbitrage.Action[](1);
        actions[0] = FlashloanArbitrage.Action({target: target, callData: data});
        return abi.encode(
            FlashloanArbitrage.FlashParams({
                minProfit: minProfit,
                actions: actions
            })
        );
    }

    function _loanParams(uint256 minProfit)
        internal
        view
        returns (bytes memory)
    {
        return _params(minProfit, address(swapper), abi.encodeCall(MockSwapper.swap, ()));
    }

    // ---------------------------------------------------------------------
    // THE BUG THIS SUITE EXISTS TO PROVE FIXED
    // The old design put `nonReentrant` on BOTH requestFlashLoan and
    // executeOperation. Aave calls back synchronously, so the nested guard
    // reverted and EVERY flash loan failed. If this passes, the fix works.
    // ---------------------------------------------------------------------
    function test_synchronousCallbackSucceeds() public {
        arb.setTargetAllowed(address(swapper), true);
        swapper.setPayout(10e18);

        arb.requestFlashLoan(address(token), AMOUNT, _loanParams(1e18));

        assertTrue(pool.callbackRan(), "callback never ran");
        assertEq(pool.lastAmount(), AMOUNT, "wrong amount borrowed");
        assertEq(pool.lastPremium(), PREMIUM, "premium should be 5bps");
    }

    function test_profitableLoanSendsProfitToRecipient() public {
        arb.setTargetAllowed(address(swapper), true);
        uint256 profit = 10e18;
        // The premium is deducted from the payout, so to realise `profit` of
        // net, the swap must return profit + PREMIUM.
        swapper.setPayout(profit + PREMIUM);

        arb.requestFlashLoan(address(token), AMOUNT, _loanParams(profit));

        assertEq(token.balanceOf(recipient), profit, "profit not swept");
        assertEq(token.balanceOf(address(arb)), 0, "contract should hold nothing");
    }

    function test_revertsWhenProfitBelowMinimum() public {
        arb.setTargetAllowed(address(swapper), true);
        swapper.setPayout(1e18); // real profit 1e18

        vm.expectRevert("Arbitrage unprofitable");
        arb.requestFlashLoan(address(token), AMOUNT, _loanParams(50e18));
    }

    function test_revertsWhenCannotRepayPrincipalPlusPremium() public {
        arb.setTargetAllowed(address(swapper), true);
        swapper.setPayout(0); // short by exactly the premium

        vm.expectRevert("Insufficient funds to repay");
        arb.requestFlashLoan(address(token), AMOUNT, _loanParams(0));
    }

    function test_poolAlwaysRepaidOnSuccess() public {
        arb.setTargetAllowed(address(swapper), true);
        swapper.setPayout(10e18);

        uint256 poolBefore = token.balanceOf(address(pool));
        arb.requestFlashLoan(address(token), AMOUNT, _loanParams(1e18));

        assertEq(
            token.balanceOf(address(pool)) - poolBefore,
            AMOUNT + PREMIUM,
            "pool not made whole"
        );
    }

    function test_revertsOnUnauthorizedTarget() public {
        swapper.setPayout(100e18); // NOT allowlisted

        vm.expectRevert("target not allowlisted");
        arb.requestFlashLoan(address(token), AMOUNT, _loanParams(1e18));
    }

    function test_revertsWhenTargetRevoked() public {
        arb.setTargetAllowed(address(swapper), true);
        arb.setTargetAllowed(address(swapper), false);
        swapper.setPayout(100e18);

        vm.expectRevert("target not allowlisted");
        arb.requestFlashLoan(address(token), AMOUNT, _loanParams(1e18));
    }

    function test_revertsWithNoActions() public {
        FlashloanArbitrage.Action[] memory none =
            new FlashloanArbitrage.Action[](0);
        bytes memory p = abi.encode(
            FlashloanArbitrage.FlashParams({minProfit: 0, actions: none})
        );
        vm.expectRevert("no actions");
        arb.requestFlashLoan(address(token), AMOUNT, p);
    }

    function test_revertsWhenTooManyActions() public {
        FlashloanArbitrage.Action[] memory many =
            new FlashloanArbitrage.Action[](9); // MAX_ACTIONS = 8
        for (uint256 i = 0; i < many.length; i++) {
            many[i] = FlashloanArbitrage.Action({
                target: address(swapper),
                callData: abi.encodeCall(MockSwapper.swap, ())
            });
        }
        bytes memory p = abi.encode(
            FlashloanArbitrage.FlashParams({minProfit: 0, actions: many})
        );
        vm.expectRevert("too many actions");
        arb.requestFlashLoan(address(token), AMOUNT, p);
    }

    function test_revertsOnMalformedParams() public {
        vm.expectRevert();
        arb.requestFlashLoan(address(token), AMOUNT, abi.encode(uint256(1)));
    }

    function test_revertsWhenActionItselfFails() public {
        arb.setTargetAllowed(address(swapper), true);
        swapper.setShouldRevert(true);
        swapper.setPayout(100e18);

        vm.expectRevert("Action failed");
        arb.requestFlashLoan(address(token), AMOUNT, _loanParams(1e18));
    }

    function test_revertsOnZeroAmount() public {
        vm.expectRevert("zero amount");
        arb.requestFlashLoan(address(token), 0, _loanParams(0));
    }

    // ---------------- reentrancy probe ----------------------------------

    function test_reentryDuringCallbackIsBlocked() public {
        // Fund a reserve so the reentry attempt is not failing merely for lack
        // of balance - the ONLY thing that must stop it is the guard.
        token.mint(address(this), 100e18);
        token.approve(address(arb), 100e18);
        arb.addReserve(address(token), 100e18);

        arb.setTargetAllowed(address(swapper), true);

        FlashloanArbitrage.Action[] memory actions =
            new FlashloanArbitrage.Action[](1);
        actions[0] = FlashloanArbitrage.Action({
            target: address(swapper),
            callData: abi.encodeCall(MockSwapper.reenter, (payable(address(arb))))
        });
        bytes memory p = abi.encode(
            FlashloanArbitrage.FlashParams({minProfit: 0, actions: actions})
        );

        vm.expectRevert(); // nonReentrant guard must fire
        arb.requestFlashLoan(address(token), AMOUNT, p);

        assertEq(arb.reserves(address(token)), 100e18, "reserve was drained");
    }

    // ---------------- ETH / reserves ------------------------------------

    function test_rejectsStrayETH() public {
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(arb).call{value: 1 wei}("");
        assertFalse(ok, "contract should reject ETH");
    }

    function test_reserveIsNotCountedAsProfit() public {
        // 100e18 sits idle as reserves. Profit must be measured against
        // principal+premium only, and reserves must survive untouched.
        token.mint(address(this), 100e18);
        token.approve(address(arb), 100e18);
        arb.addReserve(address(token), 100e18);

        arb.setTargetAllowed(address(swapper), true);
        swapper.setPayout(5e18 + PREMIUM); // net 5e18 after premium

        arb.requestFlashLoan(address(token), AMOUNT, _loanParams(5e18));

        assertEq(arb.reserves(address(token)), 100e18, "reserves drained");
        assertEq(token.balanceOf(recipient), 5e18, "profit should be 5e18 only");
        assertEq(
            token.balanceOf(address(arb)),
            100e18,
            "only reserves should remain"
        );
    }

    function test_onlyOwnerCanRequestLoan() public {
        arb.setTargetAllowed(address(swapper), true);
        swapper.setPayout(10e18);

        vm.prank(address(0xBAD));
        vm.expectRevert();
        arb.requestFlashLoan(address(token), AMOUNT, _loanParams(1e18));
    }

    // ── Deployment guards ───────────────────────────────────────────────
    // These cover the failure mode that costs the most time to diagnose: a
    // contract that deploys cleanly but can never take a flash loan, because
    // the provider address it was given has no code on this chain.

    function test_deployWiresContractToAave() public {
        FlashloanArbitrage d = new DeploySepoliaHarness().runHappy();
        // The value that actually matters: the contract can reach Aave.
        // Compared against the same constant the harness used, so a change to
        // one without the other is caught here.
        assertEq(
            address(d.POOL()),
            0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27,
            "contract not wired to the Aave pool"
        );
        // Nothing is callable until the owner explicitly allowlists it.
        assertEq(d.allowedTarget(address(0)), false, "allowlist not empty");
        // Profit must have a real destination, never left at address(0).
        assertTrue(d.profitRecipient() != address(0), "no profit recipient");
    }

    function test_deployRevertsIfPoolAddressDisagrees() public {
        // The harness must be constructed OUTSIDE the expectRevert scope:
        // expectRevert only catches the next external call, and constructing
        // the harness is itself an external call that does not revert.
        DeploySepoliaHarness h = new DeploySepoliaHarness();
        vm.expectRevert("UNEXPECTED POOL: address book and chain disagree");
        h.runWrongPool();
    }

    function test_deployRevertsWhenProviderHasNoCode() public {
        DeploySepoliaHarness h = new DeploySepoliaHarness();
        vm.expectRevert(
            "PROVIDER has no code: it is not a contract on this chain"
        );
        h.runNoCode(address(0xDEAD));
    }

    receive() external payable {}
}
