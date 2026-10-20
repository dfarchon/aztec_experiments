// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.27;

import {BillboardInbox} from "../src/BillboardInbox.sol";
import {Inbox} from "@aztec/core/messagebridge/Inbox.sol";
import {IInbox} from "@aztec/core/interfaces/messagebridge/IInbox.sol";
import {IERC20} from "@oz/token/ERC20/IERC20.sol";

interface RequestVm { function deal(address account, uint256 amount) external; }

contract BillboardInboxTest {
    Inbox private inbox;
    BillboardInbox private entry;

    function setUp() public {
        inbox = new Inbox(address(this), IERC20(address(1)), 7, 4, 1);
        entry = new BillboardInbox(address(this), 7);
    }

    function getInbox() external view returns (IInbox) { return inbox; }

    function testRequestEnqueuesWithoutReceivingETH() public {
        uint256 before = inbox.getTotalMessagesInserted();
        (bytes32 key, uint256 index) = entry.requestPost(bytes32(uint256(123)), bytes32(uint256(456)), bytes32(uint256(789)));
        require(key != bytes32(0) && index == 16, "Missing message");
        require(inbox.getTotalMessagesInserted() == before + 1, "Not enqueued");
        require(address(entry).balance == 0, "Unexpected ETH");
        require(entry.ROLLUP_VERSION() == 7 && address(entry.INBOX()) == address(inbox), "Wrong routing");
    }

    function testRejectsValueAndMalformedFields() public {
        RequestVm(address(uint160(uint256(keccak256("hevm cheat code"))))).deal(address(this), 1 ether);
        bytes memory data = abi.encodeCall(entry.requestPost, (bytes32(uint256(123)), bytes32(uint256(456)), bytes32(uint256(789))));
        (bool ok,) = address(entry).call{value: 1}(data);
        require(!ok && address(entry).balance == 0, "Accepted payment");
        (ok,) = address(entry).call(abi.encodeCall(entry.requestPost, (bytes32(0), bytes32(uint256(456)), bytes32(uint256(789)))));
        require(!ok, "Accepted zero board");
        (ok,) = address(entry).call(abi.encodeCall(entry.requestPost, (bytes32(uint256(123)), bytes32(type(uint256).max), bytes32(uint256(789)))));
        require(!ok && inbox.getTotalMessagesInserted() == 0, "Accepted invalid field");
    }

    function testSameContentGetsDistinctMessageIndices() public {
        (bytes32 first, uint256 i) = entry.requestPost(bytes32(uint256(123)), bytes32(uint256(456)), bytes32(uint256(789)));
        (bytes32 second, uint256 j) = entry.requestPost(bytes32(uint256(123)), bytes32(uint256(456)), bytes32(uint256(789)));
        require(first != second && j == i + 1, "Requests must be separate leaves");
    }
}
