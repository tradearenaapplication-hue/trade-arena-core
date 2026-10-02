// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {FlashloanArbitrage} from "../src/FlashloanArbitrage.sol";

/**
 * @notice Deploys FlashloanArbitrage to Base Sepolia (chainId 84532).
 *
 * This script REFUSES to run on any other chain. The constructor takes an
 * addresses provider and immediately calls getPool() on it, so pointing this at
 * mainnet addresses while broadcasting to Sepolia produces a contract that can
 * never take a flash loan - a failure that is easy to miss because deployment
 * itself still succeeds.
 */
contract DeploySepolia is Script {
    /// @dev Base Sepolia. Anything else is a mistake.
    uint256 constant CHAIN_ID = 84532;

    /// @dev Aave v3 on Base Sepolia, verified on-chain:
    ///   provider.getPool() == POOL, POOL.ADDRESSES_PROVIDER() == PROVIDER
    address constant PROVIDER = 0xE4C23309117Aa30342BFaae6c95c6478e0A4Ad00;
    address constant EXPECTED_POOL = 0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27;

    /// @dev Optional profit sweep destination. Defaults to the deployer.
    address profitRecipient;

    function run() external returns (FlashloanArbitrage deployed) {
        // ── Guard 1: chain id ────────────────────────────────────────────
        uint256 chain = block.chainid;
        require(
            chain == CHAIN_ID,
            "WRONG CHAIN: this script targets Base Sepolia (84532) only"
        );
        console.log("chainid  =", chain);
        console.log("network  = Base Sepolia");

        // ── Guard 2: provider is a real contract and returns the right pool ──
        // A provider address with no code makes getPool() return address(0),
        // which would deploy successfully and then revert on every trade.
        uint256 providerCode = PROVIDER.code.length;
        require(
            providerCode > 0,
            "PROVIDER has no code: it is not a contract on this chain"
        );
        console.log("provider code size =", providerCode);

        address pool = _getPool(PROVIDER);
        console.log("provider.getPool() =", pool);
        require(
            pool == EXPECTED_POOL,
            "UNEXPECTED POOL: address book and chain disagree"
        );
        console.log("Aave v3 pool verified");

        // ── Key ──────────────────────────────────────────────────────────
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        require(pk != 0, "DEPLOYER_PRIVATE_KEY missing or zero");
        address deployer = vm.addr(pk);
        vm.startBroadcast(pk);
        console.log("deployer =", deployer);
        console.log("balance  =", deployer.balance);

        // ── Deploy ───────────────────────────────────────────────────────
        deployed = new FlashloanArbitrage(PROVIDER);
        console.log("FlashloanArbitrage =", address(deployed));

        // Read the value back out of the contract rather than trusting the
        // constructor: this is what proves the contract can reach Aave.
        address wired = address(deployed.POOL());
        console.log("contract POOL =", wired);
        require(wired == EXPECTED_POOL, "CONTRACT NOT WIRED TO AAVE POOL");

        // ── Profit routing ───────────────────────────────────────────────
        if (profitRecipient == address(0)) {
            profitRecipient = deployer;
        }
        deployed.setProfitRecipient(profitRecipient);
        console.log("profitRecipient =", profitRecipient);

        // ── Safety: the allowlist must start EMPTY ────────────────────────
        // Nothing is callable until the owner explicitly allowlists a target.
        // A contract that could route borrowed funds anywhere the moment it
        // is deployed is one compromised key away from draining the loan.
        require(
            deployed.allowedTarget(address(0)) == false,
            "allowlist should be empty"
        );
        console.log("allowlist = empty (safe default)");

        vm.stopBroadcast();
        console.log("DEPLOYED OK");
    }

    function _getPool(address provider) internal view returns (address) {
        (bool ok, bytes memory ret) = provider.staticcall(
            abi.encodeWithSignature("getPool()")
        );
        require(ok && ret.length == 32, "getPool() failed on provider");
        return abi.decode(ret, (address));
    }
}
