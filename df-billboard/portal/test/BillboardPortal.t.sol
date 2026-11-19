// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.27;

import {BillboardPortal} from "../src/BillboardPortal.sol";
import {Inbox, MIN_BUCKET_RING_SIZE} from "@aztec/core/messagebridge/Inbox.sol";
import {IInbox} from "@aztec/core/interfaces/messagebridge/IInbox.sol";
import {IOutbox} from "@aztec/core/interfaces/messagebridge/IOutbox.sol";
import {DataStructures} from "@aztec/core/libraries/DataStructures.sol";
import {Hash} from "@aztec/core/libraries/crypto/Hash.sol";
import {Epoch} from "@aztec/core/libraries/TimeLib.sol";
import {IERC20} from "@oz/token/ERC20/IERC20.sol";

interface PortalVm {
    function deal(address account, uint256 amount) external;
}

contract PortalOutbox {
    bytes32 public expectedContent;
    bool public used;

    function setExpectedContent(bytes32 content) external {
        expectedContent = content;
        used = false;
    }

    function consume(
        DataStructures.L2ToL1Msg calldata message,
        Epoch,
        uint256,
        uint256,
        bytes32[] calldata
    ) external {
        require(!used && message.content == expectedContent, "Invalid exit proof");
        used = true;
    }
}

contract BillboardPortalTest {
    Inbox private inbox;
    PortalOutbox private outbox;
    BillboardPortal private portal;
    PortalVm private constant vm = PortalVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    receive() external payable {}

    function setUp() public {
        inbox = new Inbox(address(this), IERC20(address(1)), 7, MIN_BUCKET_RING_SIZE);
        outbox = new PortalOutbox();
        portal = new BillboardPortal(address(this), 7);
        portal.bindBoard(bytes32(uint256(123)));
        vm.deal(address(this), 1 ether);
    }

    function getInbox() external view returns (IInbox) { return inbox; }
    function getOutbox() external view returns (IOutbox) { return IOutbox(address(outbox)); }

    function testTopUpsAccumulateAndEachCreatesAClaim() public {
        (bytes32 first, uint256 firstIndex) = portal.deposit{value: 0.0005 ether}(bytes32(uint256(1)));
        (bytes32 second, uint256 secondIndex) = portal.deposit{value: 0.001 ether}(bytes32(uint256(2)));
        require(first != second && secondIndex == firstIndex + 1, "Missing distinct claim");
        require(portal.deposits(address(this)) == 0.0015 ether, "Wrong wallet total");
        require(portal.totalDeposited() == 0.0015 ether, "Wrong escrow total");
        require(inbox.getTotalMessagesInserted() == 2, "Wrong message count");
    }

    function testRejectsOverCapAndFractionalStake() public {
        portal.deposit{value: 0.002 ether}(bytes32(uint256(1)));
        (bool ok,) = address(portal).call{value: 0.0005 ether}(
            abi.encodeCall(portal.deposit, (bytes32(uint256(2))))
        );
        require(!ok, "Exceeded wallet cap");
        (ok,) = address(portal).call{value: 1}(
            abi.encodeCall(portal.deposit, (bytes32(uint256(3))))
        );
        require(!ok, "Accepted fractional stake");
        require(portal.deposits(address(this)) == 0.002 ether, "Changed wallet total");
        require(portal.totalDeposited() == 0.002 ether, "Changed escrow total");
    }

    function testBindingIsOneTime() public {
        (bool ok,) = address(portal).call(
            abi.encodeCall(portal.bindBoard, (bytes32(uint256(456))))
        );
        require(!ok && portal.board() == bytes32(uint256(123)), "Board changed");
    }

    function testWithdrawRequiresOutboxAndPreservesLaterTopUp() public {
        portal.deposit{value: 0.001 ether}(bytes32(uint256(1)));
        bytes32 content = Hash.sha256ToField(
            abi.encodePacked(bytes32(uint256(uint160(address(this)))), uint256(0.001 ether))
        );
        outbox.setExpectedContent(content);
        (bool ok,) = address(portal).call(
            abi.encodeCall(portal.withdraw, (0.0005 ether, 1, 1, 0, new bytes32[](0)))
        );
        require(!ok && portal.deposits(address(this)) == 0.001 ether, "Unproven exit succeeded");

        portal.deposit{value: 0.0005 ether}(bytes32(uint256(2)));
        portal.withdraw(0.001 ether, 1, 1, 0, new bytes32[](0));
        require(portal.deposits(address(this)) == 0.0005 ether, "Later top-up was lost");
        require(portal.totalDeposited() == 0.0005 ether, "Wrong escrow after exit");
        (ok,) = address(portal).call(
            abi.encodeCall(portal.withdraw, (0.001 ether, 1, 1, 0, new bytes32[](0)))
        );
        require(!ok, "Exit proof was reused");
    }
}
