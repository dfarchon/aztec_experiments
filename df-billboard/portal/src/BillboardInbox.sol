// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.27;

import {IRollup} from "@aztec/core/interfaces/IRollup.sol";
import {IInbox} from "@aztec/core/interfaces/messagebridge/IInbox.sol";
import {DataStructures} from "@aztec/core/libraries/DataStructures.sol";

/// @notice A gas-only L1 entry point. No deposits, tokens, author registry or admin.
/// The chosen L2 board must pin this contract as its trusted L1 message sender.
contract BillboardInbox {
    IInbox public immutable INBOX;
    uint256 public immutable ROLLUP_VERSION;
    uint256 private constant FIELD_MODULUS =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    error InvalidRequest();
    event PostRequested(bytes32 indexed board, bytes32 indexed key, uint256 index, bytes32 commitment, bytes32 secretHash);

    constructor(address rollup, uint256 version) {
        if (rollup == address(0) || version == 0) revert InvalidRequest();
        INBOX = IRollup(rollup).getInbox();
        if (address(INBOX) == address(0)) revert InvalidRequest();
        ROLLUP_VERSION = version;
    }

    // Deliberately nonpayable: the sender pays transaction gas, not a transfer.
    function requestPost(bytes32 board, bytes32 commitment, bytes32 secretHash)
        external returns (bytes32 key, uint256 index)
    {
        if (!_field(board) || !_field(commitment) || !_field(secretHash)) revert InvalidRequest();
        (key, index) = INBOX.sendL2Message(
            DataStructures.L2Actor(board, ROLLUP_VERSION), commitment, secretHash
        );
        emit PostRequested(board, key, index, commitment, secretHash);
    }

    function _field(bytes32 value) private pure returns (bool) {
        return value != bytes32(0) && uint256(value) < FIELD_MODULUS;
    }
}
