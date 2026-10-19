// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.27;

import {IRollup} from "@aztec/core/interfaces/IRollup.sol";
import {IOutbox} from "@aztec/core/interfaces/messagebridge/IOutbox.sol";
import {Hash} from "@aztec/core/libraries/crypto/Hash.sol";
import {DataStructures} from "@aztec/core/libraries/DataStructures.sol";
import {Epoch} from "@aztec/core/libraries/TimeLib.sol";

/// @notice Publishes authenticated Aztec posts on Ethereum. No deposit, author
/// registry or admin. Anyone may submit a valid message and pay its L1 gas.
/// The submitting EVM address is public and is not treated as the author.
contract BillboardPublisher {
    bytes32 public constant DOMAIN = bytes32(uint256(0x444642425f4c315f504f53545f5631));
    uint256 public constant MAX_BYTES = 512;
    bytes32 public immutable L2_BOARD;
    uint256 public immutable ROLLUP_VERSION;
    IOutbox public immutable OUTBOX;
    uint256 public postCount;
    mapping(uint32 => bytes) private posts;

    error InvalidSource();
    error InvalidLength();
    error AlreadyPublished();
    error UnknownPost();

    event PostPublished(uint32 indexed sourcePostId, bytes32 contentHash, bytes text);

    constructor(address rollup, bytes32 l2Board, uint256 rollupVersion) {
        if (rollup == address(0) || l2Board == bytes32(0) || rollupVersion == 0) revert InvalidSource();
        L2_BOARD = l2Board;
        ROLLUP_VERSION = rollupVersion;
        OUTBOX = IRollup(rollup).getOutbox();
    }

    function computeContentHash(uint32 sourcePostId, bytes calldata text) public pure returns (bytes32) {
        if (text.length == 0 || text.length > MAX_BYTES) revert InvalidLength();
        bytes32[17] memory packed;
        for (uint256 i = 0; i < text.length; i++) {
            packed[i / 31] |= bytes32(uint256(uint8(text[i])) << (8 * (30 - i % 31)));
        }
        return Hash.sha256ToField(abi.encode(DOMAIN, uint256(sourcePostId), uint256(text.length), packed));
    }

    function publish(
        uint32 sourcePostId,
        bytes calldata text,
        uint256 epoch,
        uint256 numCheckpointsInEpoch,
        uint256 leafIndex,
        bytes32[] calldata path
    ) external {
        if (isPublished(sourcePostId)) revert AlreadyPublished();
        bytes32 content = computeContentHash(sourcePostId, text);
        DataStructures.L2ToL1Msg memory message = DataStructures.L2ToL1Msg({
            sender: DataStructures.L2Actor(L2_BOARD, ROLLUP_VERSION),
            recipient: DataStructures.L1Actor(address(this), block.chainid),
            content: content
        });
        OUTBOX.consume(message, Epoch.wrap(epoch), numCheckpointsInEpoch, leafIndex, path);
        posts[sourcePostId] = text;
        postCount++;
        emit PostPublished(sourcePostId, content, text);
    }

    function isPublished(uint32 sourcePostId) public view returns (bool) {
        return posts[sourcePostId].length != 0;
    }

    function getPost(uint32 sourcePostId) external view returns (bytes memory) {
        if (!isPublished(sourcePostId)) revert UnknownPost();
        return posts[sourcePostId];
    }
}
