// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.27;

import {IRollup} from "@aztec/core/interfaces/IRollup.sol";
import {IInbox} from "@aztec/core/interfaces/messagebridge/IInbox.sol";
import {IOutbox} from "@aztec/core/interfaces/messagebridge/IOutbox.sol";
import {DataStructures} from "@aztec/core/libraries/DataStructures.sol";
import {Hash} from "@aztec/core/libraries/crypto/Hash.sol";
import {Epoch} from "@aztec/core/libraries/TimeLib.sol";

/// @notice Holds refundable stake for one Aztec board. Each L1 address may
///         have at most 0.002 ETH staked, across any number of top-ups.
contract BillboardPortal {
    uint256 public constant STAKE_UNIT = 0.0005 ether;
    uint256 public constant MAX_STAKE = 0.002 ether;
    uint256 private constant FIELD_MODULUS =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    IRollup public immutable ROLLUP;
    IInbox public immutable INBOX;
    uint256 public immutable ROLLUP_VERSION;
    address private immutable deployer;
    bytes32 public board;
    mapping(address => uint256) public deposits;
    uint256 public totalDeposited;

    error InvalidConfiguration();
    error InvalidStake();
    error InsufficientStake();
    error TransferFailed();

    event BoardBound(bytes32 indexed board);
    event Deposited(address indexed depositor, uint256 amount, bytes32 indexed key, uint256 index, bytes32 indexed secretHash);
    event Withdrawn(address indexed depositor, uint256 amount);

    constructor(address rollup, uint256 version) {
        if (rollup == address(0) || version == 0) revert InvalidConfiguration();
        ROLLUP = IRollup(rollup);
        INBOX = IRollup(rollup).getInbox();
        if (address(INBOX) == address(0)) revert InvalidConfiguration();
        ROLLUP_VERSION = version;
        deployer = msg.sender;
    }

    /// @dev The L1 portal is deployed before the L2 board. This binding can
    ///      only be set once, by the deployer, after the board is deployed.
    function bindBoard(bytes32 l2Board) external {
        if (
            msg.sender != deployer || board != bytes32(0) || l2Board == bytes32(0)
                || uint256(l2Board) >= FIELD_MODULUS
        ) {
            revert InvalidConfiguration();
        }
        board = l2Board;
        emit BoardBound(l2Board);
    }

    function deposit(bytes32 secretHash) external payable returns (bytes32 key, uint256 index) {
        if (board == bytes32(0)) revert InvalidConfiguration();
        if (
            secretHash == bytes32(0) || uint256(secretHash) >= FIELD_MODULUS || msg.value == 0
                || msg.value % STAKE_UNIT != 0
        ) {
            revert InvalidStake();
        }
        uint256 newBalance = deposits[msg.sender] + msg.value;
        if (newBalance > MAX_STAKE) revert InvalidStake();
        deposits[msg.sender] = newBalance;
        totalDeposited += msg.value;

        bytes32 content = Hash.sha256ToField(
            abi.encodeWithSignature(
                "claim_deposit(bytes32,uint256)", bytes32(uint256(uint160(msg.sender))), msg.value
            )
        );
        (key, index) = INBOX.sendL2Message(
            DataStructures.L2Actor(board, ROLLUP_VERSION), content, secretHash
        );
        emit Deposited(msg.sender, msg.value, key, index, secretHash);
    }

    /// @notice Release only the amount proven by a consumed L2 exit message.
    ///         Partial accounting keeps later top-ups withdrawable when an
    ///         earlier exit was already in flight.
    function withdraw(
        uint256 amount,
        uint256 epoch,
        uint256 numCheckpointsInEpoch,
        uint256 leafIndex,
        bytes32[] calldata path
    ) external {
        if (amount == 0 || amount > deposits[msg.sender]) revert InsufficientStake();
        DataStructures.L2ToL1Msg memory message = DataStructures.L2ToL1Msg({
            sender: DataStructures.L2Actor(board, ROLLUP_VERSION),
            recipient: DataStructures.L1Actor(address(this), block.chainid),
            content: Hash.sha256ToField(
                abi.encodePacked(bytes32(uint256(uint160(msg.sender))), amount)
            )
        });
        deposits[msg.sender] -= amount;
        totalDeposited -= amount;
        IOutbox outbox = ROLLUP.getOutbox();
        outbox.consume(message, Epoch.wrap(epoch), numCheckpointsInEpoch, leafIndex, path);
        (bool sent,) = msg.sender.call{value: amount}("");
        if (!sent) revert TransferFailed();
        emit Withdrawn(msg.sender, amount);
    }
}
