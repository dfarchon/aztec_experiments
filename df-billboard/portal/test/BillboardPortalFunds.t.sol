// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.27;

import {BillboardPortal} from "../src/BillboardPortal.sol";
import {Inbox, MIN_BUCKET_RING_SIZE} from "@aztec/core/messagebridge/Inbox.sol";
import {Outbox} from "@aztec/core/messagebridge/Outbox.sol";
import {IInbox} from "@aztec/core/interfaces/messagebridge/IInbox.sol";
import {IOutbox} from "@aztec/core/interfaces/messagebridge/IOutbox.sol";
import {DataStructures} from "@aztec/core/libraries/DataStructures.sol";
import {Errors} from "@aztec/core/libraries/Errors.sol";
import {Hash} from "@aztec/core/libraries/crypto/Hash.sol";
import {Epoch} from "@aztec/core/libraries/TimeLib.sol";
import {IERC20} from "@oz/token/ERC20/IERC20.sol";

interface FundsVm {
    function deal(address account, uint256 amount) external;
    function prank(address sender) external;
}

/// @dev Exercises both rejected transfers and a second claim during the refund callback.
contract FundsRecipient {
    BillboardPortal public immutable portal;
    bool public rejectRefund;
    bool public reenter;
    bool public attemptedReentry;
    bool public reentrySucceeded;
    uint256 private amount;
    uint256 private epoch;
    bytes32[] private proof;

    constructor(BillboardPortal target) {
        portal = target;
    }

    function stake() external payable {
        portal.deposit{value: msg.value}(bytes32(uint256(99)));
    }

    function setRejectRefund(bool value) external {
        rejectRefund = value;
    }

    function claim(uint256 value, uint256 exitEpoch, bytes32[] calldata path, bool tryReentry) external {
        amount = value;
        epoch = exitEpoch;
        proof = path;
        reenter = tryReentry;
        portal.withdraw(value, exitEpoch, 1, 0, path);
    }

    receive() external payable {
        require(!rejectRefund, "Recipient rejected refund");
        if (reenter) {
            reenter = false;
            attemptedReentry = true;
            (reentrySucceeded,) = address(portal).call(abi.encodeCall(portal.withdraw, (amount, epoch, 1, 0, proof)));
        }
    }
}

/// @dev Uses the production Outbox implementation. The fixture acts as the Rollup
/// only to insert authenticated message roots; it does not simulate Rollup SNARK verification.
contract BillboardPortalFundsTest {
    uint256 private constant UNIT = 0.0005 ether;
    uint256 private constant VERSION = 7;
    bytes32 private constant BOARD = bytes32(uint256(123));
    bytes32 private constant SIBLING = bytes32(uint256(456));
    address private constant ALICE = address(0xA11CE);
    address private constant BOB = address(0xB0B);
    FundsVm private constant vm = FundsVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    Inbox private inbox;
    Outbox private outbox;
    BillboardPortal private portal;

    function setUp() public {
        inbox = new Inbox(address(this), IERC20(address(1)), VERSION, MIN_BUCKET_RING_SIZE);
        outbox = new Outbox(address(this), VERSION);
        portal = new BillboardPortal(address(this), VERSION);
        portal.bindBoard(BOARD);
        vm.deal(ALICE, 1 ether);
        vm.deal(BOB, 1 ether);
        vm.deal(address(this), 1 ether);
    }

    function getInbox() external view returns (IInbox) {
        return inbox;
    }

    function getOutbox() external view returns (IOutbox) {
        return outbox;
    }

    function stake(address payer, uint256 amount) private {
        vm.prank(payer);
        portal.deposit{value: amount}(bytes32(uint256(99)));
    }

    function message(address payer, uint256 amount) private view returns (DataStructures.L2ToL1Msg memory) {
        return DataStructures.L2ToL1Msg({
            sender: DataStructures.L2Actor(BOARD, VERSION),
            recipient: DataStructures.L1Actor(address(portal), block.chainid),
            content: Hash.sha256ToField(abi.encodePacked(bytes32(uint256(uint160(payer))), amount))
        });
    }

    function path() private pure returns (bytes32[] memory result) {
        result = new bytes32[](1);
        result[0] = SIBLING;
    }

    function publish(DataStructures.L2ToL1Msg memory exitMessage, uint256 epoch, uint256 checkpoints) private {
        bytes32 leaf = Hash.sha256ToField(exitMessage);
        outbox.insert(Epoch.wrap(epoch), checkpoints, Hash.sha256ToField(abi.encodePacked(leaf, SIBLING)));
    }

    function claim(address payer, uint256 amount, uint256 epoch) private {
        vm.prank(payer);
        portal.withdraw(amount, epoch, 1, 0, path());
    }

    function rejectedClaim(
        address payer,
        uint256 amount,
        uint256 epoch,
        uint256 checkpoints,
        uint256 index,
        bytes32[] memory proof,
        bytes4 expectedError
    ) private {
        uint256 balance = payer.balance;
        uint256 deposit = portal.deposits(payer);
        uint256 total = portal.totalDeposited();
        uint256 escrow = address(portal).balance;
        vm.prank(payer);
        (bool ok, bytes memory reason) =
            address(portal).call(abi.encodeCall(portal.withdraw, (amount, epoch, checkpoints, index, proof)));
        require(!ok && bytes4(reason) == expectedError, "Wrong rejection reason");
        require(payer.balance == balance, "Failed claim paid ETH");
        require(portal.deposits(payer) == deposit, "Failed claim changed deposit");
        require(portal.totalDeposited() == total, "Failed claim changed total");
        require(address(portal).balance == escrow, "Failed claim changed escrow");
    }

    function testRefundPaysExactPrincipalToOriginalPayer() public {
        stake(ALICE, UNIT);
        publish(message(ALICE, UNIT), 1, 1);
        uint256 before = ALICE.balance;
        claim(ALICE, UNIT, 1);
        require(ALICE.balance == before + UNIT, "Incorrect refund");
        require(portal.deposits(ALICE) == 0 && portal.totalDeposited() == 0, "Uncleared liability");
        require(address(portal).balance == 0, "ETH left in escrow");
        require(outbox.hasMessageBeenConsumedAtEpoch(Epoch.wrap(1), 2), "Message not consumed");
    }

    function testCompetingClaimsOnlyOneRefundEvenWithEnoughRemainingBalance() public {
        stake(ALICE, 2 * UNIT);
        publish(message(ALICE, UNIT), 1, 1);
        uint256 before = ALICE.balance;
        claim(ALICE, UNIT, 1);
        // Competing L1 transactions execute in order. Enough stake remains for the
        // second request to reach the real Outbox's replay check, rather than the balance guard.
        rejectedClaim(ALICE, UNIT, 1, 1, 0, path(), Errors.Outbox__AlreadyNullified.selector);
        require(ALICE.balance == before + UNIT, "Duplicate refund");
        require(portal.deposits(ALICE) == UNIT && portal.totalDeposited() == UNIT, "Remaining stake lost");
    }

    function testConsumedProofCannotReplayAgainstExtendedEpochRoot() public {
        stake(ALICE, 2 * UNIT);
        publish(message(ALICE, UNIT), 1, 1);
        publish(message(ALICE, UNIT), 1, 2);
        claim(ALICE, UNIT, 1);
        rejectedClaim(ALICE, UNIT, 1, 2, 0, path(), Errors.Outbox__AlreadyNullified.selector);
    }

    function testFuzzTopUpDuringExitCanBeWithdrawnLater(uint8 oldUnits, uint8 addedUnits) public {
        uint256 oldAmount = (uint256(oldUnits) % 3 + 1) * UNIT;
        uint256 addedAmount = (uint256(addedUnits) % (4 - oldAmount / UNIT) + 1) * UNIT;
        stake(ALICE, oldAmount);
        publish(message(ALICE, oldAmount), 1, 1);
        // The first exit is already proven, but the user tops up before claiming it.
        stake(ALICE, addedAmount);
        uint256 before = ALICE.balance;
        claim(ALICE, oldAmount, 1);
        require(ALICE.balance == before + oldAmount, "Old refund incorrect");
        require(portal.deposits(ALICE) == addedAmount, "Top-up lost");
        require(portal.totalDeposited() == addedAmount && address(portal).balance == addedAmount, "Escrow mismatch");
        publish(message(ALICE, addedAmount), 2, 1);
        claim(ALICE, addedAmount, 2);
        require(ALICE.balance == before + oldAmount + addedAmount, "Top-up not refunded");
        require(portal.deposits(ALICE) == 0 && portal.totalDeposited() == 0, "Residual liability");
        require(address(portal).balance == 0, "Residual ETH");
    }

    function testOtherWalletCannotUseProofEvenWhenItHasItsOwnStake() public {
        stake(ALICE, UNIT);
        stake(BOB, UNIT);
        publish(message(ALICE, UNIT), 1, 1);
        rejectedClaim(BOB, UNIT, 1, 1, 0, path(), Errors.MerkleLib__InvalidRoot.selector);
        require(!outbox.hasMessageBeenConsumedAtEpoch(Epoch.wrap(1), 2), "Victim proof burned");
        claim(ALICE, UNIT, 1);
        require(portal.deposits(BOB) == UNIT && address(portal).balance == UNIT, "Other stake changed");
    }

    function testWrongAmountOrSiblingCannotConsumeValidExit() public {
        stake(ALICE, 2 * UNIT);
        publish(message(ALICE, UNIT), 1, 1);
        rejectedClaim(ALICE, 2 * UNIT, 1, 1, 0, path(), Errors.MerkleLib__InvalidRoot.selector);
        bytes32[] memory wrongPath = path();
        wrongPath[0] = bytes32(uint256(SIBLING) + 1);
        rejectedClaim(ALICE, UNIT, 1, 1, 0, wrongPath, Errors.MerkleLib__InvalidRoot.selector);
        require(!outbox.hasMessageBeenConsumedAtEpoch(Epoch.wrap(1), 2), "Invalid proof burned exit");
        claim(ALICE, UNIT, 1);
    }

    function testMissingEpochOrCheckpointRootCannotReleaseFunds() public {
        stake(ALICE, UNIT);
        publish(message(ALICE, UNIT), 1, 1);
        rejectedClaim(ALICE, UNIT, 2, 1, 0, path(), Errors.Outbox__NothingToConsumeAtEpoch.selector);
        rejectedClaim(ALICE, UNIT, 1, 2, 0, path(), Errors.Outbox__NothingToConsumeAtEpoch.selector);
        claim(ALICE, UNIT, 1);
    }

    function testWrongLeafIndexCannotReleaseFunds() public {
        stake(ALICE, UNIT);
        publish(message(ALICE, UNIT), 1, 1);
        rejectedClaim(ALICE, UNIT, 1, 1, 1, path(), Errors.MerkleLib__InvalidRoot.selector);
        rejectedClaim(ALICE, UNIT, 1, 1, 2, path(), Errors.Outbox__LeafIndexOutOfBounds.selector);
        claim(ALICE, UNIT, 1);
    }

    function testMessageFromAnotherBoardCannotReleaseFunds() public {
        stake(ALICE, UNIT);
        DataStructures.L2ToL1Msg memory wrongMessage = message(ALICE, UNIT);
        wrongMessage.sender.actor = bytes32(uint256(124));
        publish(wrongMessage, 1, 1);
        rejectedClaim(ALICE, UNIT, 1, 1, 0, path(), Errors.MerkleLib__InvalidRoot.selector);
    }

    function testMessageForAnotherPortalOrChainCannotReleaseFunds() public {
        stake(ALICE, UNIT);
        DataStructures.L2ToL1Msg memory wrongPortal = message(ALICE, UNIT);
        wrongPortal.recipient.actor = BOB;
        publish(wrongPortal, 1, 1);
        rejectedClaim(ALICE, UNIT, 1, 1, 0, path(), Errors.MerkleLib__InvalidRoot.selector);
        DataStructures.L2ToL1Msg memory wrongChain = message(ALICE, UNIT);
        wrongChain.recipient.chainId = block.chainid + 1;
        publish(wrongChain, 2, 1);
        rejectedClaim(ALICE, UNIT, 2, 1, 0, path(), Errors.MerkleLib__InvalidRoot.selector);
    }

    function testRefundFailureRollsBackAccountingAndProofConsumption() public {
        FundsRecipient recipient = new FundsRecipient(portal);
        recipient.stake{value: UNIT}();
        publish(message(address(recipient), UNIT), 1, 1);
        recipient.setRejectRefund(true);
        (bool ok, bytes memory reason) =
            address(recipient).call(abi.encodeCall(recipient.claim, (UNIT, 1, path(), false)));
        require(!ok && bytes4(reason) == BillboardPortal.TransferFailed.selector, "Refund did not fail");
        require(portal.deposits(address(recipient)) == UNIT && portal.totalDeposited() == UNIT, "Lost liability");
        require(address(portal).balance == UNIT && address(recipient).balance == 0, "ETH changed on failure");
        require(!outbox.hasMessageBeenConsumedAtEpoch(Epoch.wrap(1), 2), "Failed transfer burned proof");
        recipient.setRejectRefund(false);
        recipient.claim(UNIT, 1, path(), false);
        require(address(recipient).balance == UNIT && address(portal).balance == 0, "Retry failed");
        require(portal.totalDeposited() == 0, "Liability not cleared");
    }

    function testRefundCallbackCannotReenterWithConsumedProof() public {
        FundsRecipient recipient = new FundsRecipient(portal);
        recipient.stake{value: 2 * UNIT}();
        publish(message(address(recipient), UNIT), 1, 1);
        recipient.claim(UNIT, 1, path(), true);
        require(recipient.attemptedReentry() && !recipient.reentrySucceeded(), "Reentry not rejected");
        require(address(recipient).balance == UNIT, "Paid more than one refund");
        require(portal.deposits(address(recipient)) == UNIT, "Remaining deposit lost");
        require(portal.totalDeposited() == UNIT && address(portal).balance == UNIT, "Escrow mismatch");
    }

    function testOnlyRollupCanPublishExitRoots() public {
        vm.prank(BOB);
        (bool ok, bytes memory reason) =
            address(outbox).call(abi.encodeCall(outbox.insert, (Epoch.wrap(1), 1, bytes32(uint256(789)))));
        require(!ok && bytes4(reason) == Errors.Outbox__Unauthorized.selector, "Untrusted root accepted");
        require(outbox.getRootData(Epoch.wrap(1), 1) == bytes32(0), "Root changed");
    }
}
