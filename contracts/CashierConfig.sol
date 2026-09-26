// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

/// @notice Typed deployment arguments authorized by a compiler-produced commitment.
library CashierConfig {
    uint256 internal constant BPS = 10000;
    uint8 internal constant DECIMALS = 6;
    uint256 internal constant UNIT = 10 ** DECIMALS;

    struct ClauseIds {
        uint16 navUsd;
        uint16 subscriptionFeeBps;
        uint16 redemptionFeeBps;
        uint16 cashierSupplyCap;
        uint16 cashierExecution;
    }
    struct PoolSettings {
        uint24 fee;
        int24 tickSpacing;
    }
    struct Parameters {
        uint128 navMicroUsd;
        uint16 subscriptionFeeBps;
        uint16 redemptionFeeBps;
        uint8 shareDecimals;
        uint8 assetDecimals;
        uint256 maxSupply;
        bytes32 termsHash;
        ClauseIds clauseIds;
        PoolSettings pool;
    }

    error InvalidCashierConfiguration();
    error UnauthorizedCashierConfiguration();

    function validate(Parameters memory config, bytes32 authorizedHash) internal pure {
        if (config.navMicroUsd == 0 || config.maxSupply == 0 || config.termsHash == bytes32(0)
            || config.subscriptionFeeBps >= BPS || config.redemptionFeeBps >= BPS
            || config.shareDecimals != DECIMALS || config.assetDecimals != DECIMALS
            || config.clauseIds.navUsd == 0 || config.clauseIds.subscriptionFeeBps == 0
            || config.clauseIds.redemptionFeeBps == 0 || config.clauseIds.cashierSupplyCap == 0 || config.clauseIds.cashierExecution == 0
            // A 100% LP fee cannot produce a full-input positive-output AMM fill. Dynamic fees are not supported.
            || config.pool.fee >= LPFeeLibrary.MAX_LP_FEE
            || config.pool.tickSpacing < TickMath.MIN_TICK_SPACING || config.pool.tickSpacing > TickMath.MAX_TICK_SPACING) {
            revert InvalidCashierConfiguration();
        }
        if (keccak256(abi.encode(config)) != authorizedHash) revert UnauthorizedCashierConfiguration();
    }
}
