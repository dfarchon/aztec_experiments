// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.27;

import {BillboardPublisher} from "../src/BillboardPublisher.sol";
import {Outbox} from "@aztec/core/messagebridge/Outbox.sol";
import {IOutbox} from "@aztec/core/interfaces/messagebridge/IOutbox.sol";
import {Hash} from "@aztec/core/libraries/crypto/Hash.sol";
import {DataStructures} from "@aztec/core/libraries/DataStructures.sol";
import {Epoch} from "@aztec/core/libraries/TimeLib.sol";

contract BillboardPublisherTest {
    bytes32 private constant BOARD = bytes32(uint256(123));
    uint256 private constant VERSION = 1;
    Outbox private outbox;
    BillboardPublisher private publisher;

    function setUp() public {
        // Only the unit fixture supplies roots. The E2E obtains them from an
        // actual local Aztec epoch proof; production never trusts this fixture.
        outbox = new Outbox(address(this), VERSION);
        publisher = new BillboardPublisher(address(this), BOARD, VERSION);
    }

    function getOutbox() external view returns (IOutbox) {
        return outbox;
    }

    function message(uint32 id, bytes memory text) private view returns (DataStructures.L2ToL1Msg memory) {
        return DataStructures.L2ToL1Msg({
            sender: DataStructures.L2Actor(BOARD, VERSION),
            recipient: DataStructures.L1Actor(address(publisher), block.chainid),
            content: publisher.computeContentHash(id, text)
        });
    }

    function insert(DataStructures.L2ToL1Msg memory entry) private {
        outbox.insert(Epoch.wrap(1), 1, Hash.sha256ToField(entry));
    }

    function publish(uint32 id, bytes memory text) private {
        publisher.publish(id, text, 1, 1, 0, new bytes32[](0));
    }

    function expectFailure(uint32 id, bytes memory text) private {
        (bool ok,) = address(publisher).call(abi.encodeCall(publisher.publish, (id, text, 1, 1, 0, new bytes32[](0))));
        require(!ok, "Invalid publication accepted");
        require(publisher.postCount() == 0 && !publisher.isPublished(id), "Failed call changed posts");
        require(!outbox.hasMessageBeenConsumedAtEpoch(Epoch.wrap(1), 1), "Failed call consumed message");
    }

    function testCanonicalHashVector() public view {
        require(
            publisher.computeContentHash(7, "hi") == 0x00c719e54a29354c7a10c57707376dc9a3ddd01a0c3a01afc78bbe653b38e0a2,
            "Noir vector mismatch"
        );
    }

    function testPublishAndRejectReplay() public {
        insert(message(7, "hi"));
        publish(7, "hi");
        require(keccak256(publisher.getPost(7)) == keccak256("hi"), "Missing body");
        require(publisher.postCount() == 1, "Wrong post count");
        require(outbox.hasMessageBeenConsumedAtEpoch(Epoch.wrap(1), 1), "Message not consumed");
        (bool ok, bytes memory reason) =
            address(publisher).call(abi.encodeCall(publisher.publish, (7, bytes("hi"), 1, 1, 0, new bytes32[](0))));
        require(!ok && bytes4(reason) == BillboardPublisher.AlreadyPublished.selector, "Replay accepted");
    }

    function testNotReadyThenRetry() public {
        expectFailure(7, "hi");
        insert(message(7, "hi"));
        publish(7, "hi");
        require(publisher.isPublished(7), "Retry failed");
    }

    function testTamperedBodyAndId() public {
        insert(message(7, "hi"));
        expectFailure(7, "ho");
        expectFailure(8, "hi");
        publish(7, "hi");
    }

    function testWrongSource() public {
        DataStructures.L2ToL1Msg memory entry = message(7, "hi");
        entry.sender.actor = bytes32(uint256(456));
        insert(entry);
        expectFailure(7, "hi");
    }

    function testWrongVersion() public {
        DataStructures.L2ToL1Msg memory entry = message(7, "hi");
        entry.sender.version++;
        insert(entry);
        expectFailure(7, "hi");
    }

    function testWrongRecipient() public {
        DataStructures.L2ToL1Msg memory entry = message(7, "hi");
        entry.recipient.actor = address(456);
        insert(entry);
        expectFailure(7, "hi");
    }

    function testWrongChain() public {
        DataStructures.L2ToL1Msg memory entry = message(7, "hi");
        entry.recipient.chainId++;
        insert(entry);
        expectFailure(7, "hi");
    }

    function testWrongMerklePath() public {
        insert(message(7, "hi"));
        (bool ok,) =
            address(publisher).call(abi.encodeCall(publisher.publish, (7, bytes("hi"), 1, 1, 0, new bytes32[](1))));
        require(!ok && publisher.postCount() == 0, "Invalid proof accepted");
        publish(7, "hi");
    }

    function testInvalidLengthsAndUnknownPost() public {
        expectFailure(7, "");
        expectFailure(7, new bytes(513));
        (bool ok,) = address(publisher).staticcall(abi.encodeCall(publisher.getPost, (7)));
        require(!ok, "Unknown post readable");
    }

    function testFuzzPublishRoundTrip(uint32 id, bytes calldata text) public {
        if (text.length == 0 || text.length > 512) return;
        insert(message(id, text));
        publish(id, text);
        require(keccak256(publisher.getPost(id)) == keccak256(text), "Body changed");
    }
}
