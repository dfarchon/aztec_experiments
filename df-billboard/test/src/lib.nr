use aztec::{
    protocol::{address::{AztecAddress, EthAddress}, traits::ToField},
    test::helpers::test_environment::TestEnvironment,
    state_vars::{OwnedStateVariable, PrivateMutable},
    note::{ConfirmedNote, lifecycle::destroy_note, note_getter::get_note},
};
use df_billboard::DFBillboard;
use df_billboard::DFBillboard::AccountState;

global UNIT: u128 = 500000000000000;
global WINDOW: u64 = 86400;

fn hello() -> [u8; 512] {
    let mut text = [0; 512];
    text[0] = 104;
    text[1] = 105;
    text
}

unconstrained fn setup() -> (TestEnvironment, AztecAddress, AztecAddress, EthAddress, EthAddress) {
    let mut env = TestEnvironment::new();
    let owner = env.create_light_account();
    let portal = EthAddress::from_field(123);
    let depositor = EthAddress::from_field(456);
    let board = env.deploy("@df_billboard/DFBillboard").with_public_initializer(
        owner, DFBillboard::interface().constructor_with_portal(portal),
    );
    (env, board, owner, portal, depositor)
}

unconstrained fn add_stake(
    env: &mut TestEnvironment,
    board: AztecAddress,
    owner: AztecAddress,
    portal: EthAddress,
    depositor: EthAddress,
    amount: u128,
    secret: Field,
) {
    let content = df_billboard::bridge::deposit_message(depositor, amount);
    let leaf = env.send_l1_to_l2_message(content, secret, portal, board);
    env.call_private(owner, DFBillboard::at(board).claim_deposit(depositor, amount, secret, leaf));
}

#[test]
unconstrained fn first_stake_posts_without_cooldown() {
    let (mut env, board, owner, portal, depositor) = setup();
    add_stake(&mut env, board, owner, portal, depositor, UNIT, 9);
    env.call_private(owner, DFBillboard::at(board).post(hello(), 2));
    assert(env.view_public(DFBillboard::at(board).get_post_count()) == 1);
    let (data, length) = env.view_public(DFBillboard::at(board).get_post(0));
    assert(length == 2);
    assert(data[0] != 0);
}

#[test(should_fail_with = "Failed to get a note")]
unconstrained fn unstaked_account_cannot_post() {
    let (env, board, owner, _, _) = setup();
    env.call_private(owner, DFBillboard::at(board).post(hello(), 2));
}

#[test]
unconstrained fn all_four_stake_tiers_unlock_immediately() {
    let (mut env, board, owner, portal, depositor) = setup();
    for tier in 0..4 {
        add_stake(&mut env, board, owner, portal, depositor, UNIT, (tier + 1) as Field);
        for _ in 0..5 {
            env.call_private(owner, DFBillboard::at(board).post(hello(), 2));
        }
        assert(env.view_public(DFBillboard::at(board).get_post_count()) == (tier + 1) * 5);
    }
}

#[test(should_fail_with = "24-hour post limit reached")]
unconstrained fn twenty_first_post_rejected() {
    let (mut env, board, owner, portal, depositor) = setup();
    add_stake(&mut env, board, owner, portal, depositor, 4 * UNIT, 9);
    for _ in 0..21 {
        env.call_private(owner, DFBillboard::at(board).post(hello(), 2));
    }
}

#[test(should_fail_with = "Stake exceeds account cap")]
unconstrained fn l2_stake_cap_is_checked() {
    let (mut env, board, owner, portal, depositor) = setup();
    add_stake(&mut env, board, owner, portal, depositor, 4 * UNIT, 9);
    add_stake(&mut env, board, owner, portal, depositor, UNIT, 10);
}

#[test(should_fail_with = "Stake belongs to another L1 address")]
unconstrained fn another_depositor_cannot_top_up_the_same_account() {
    let (mut env, board, owner, portal, depositor) = setup();
    add_stake(&mut env, board, owner, portal, depositor, UNIT, 9);
    add_stake(&mut env, board, owner, portal, EthAddress::from_field(789), UNIT, 10);
}

#[test]
unconstrained fn expired_post_frees_only_its_slot() {
    let (mut env, board, owner, portal, depositor) = setup();
    add_stake(&mut env, board, owner, portal, depositor, UNIT, 9);
    let start = env.last_block_timestamp();
    env.call_private(owner, DFBillboard::at(board).post(hello(), 2));
    env.mine_block_at(start + 3600);
    for _ in 0..4 { env.call_private(owner, DFBillboard::at(board).post(hello(), 2)); }
    env.mine_block_at(start + WINDOW);
    env.call_private(owner, DFBillboard::at(board).post(hello(), 2));
    assert(env.view_public(DFBillboard::at(board).get_post_count()) == 6);
}

#[test(should_fail_with = "Wait 24 hours after the last post")]
unconstrained fn exit_before_last_post_expires_rejected() {
    let (mut env, board, owner, portal, depositor) = setup();
    add_stake(&mut env, board, owner, portal, depositor, UNIT, 9);
    env.call_private(owner, DFBillboard::at(board).post(hello(), 2));
    env.call_private(owner, DFBillboard::at(board).withdraw());
}

#[test]
unconstrained fn exit_after_last_post_expires_succeeds() {
    let (mut env, board, owner, portal, depositor) = setup();
    add_stake(&mut env, board, owner, portal, depositor, UNIT, 9);
    env.call_private(owner, DFBillboard::at(board).post(hello(), 2));
    let last = env.last_block_timestamp();
    env.mine_block_at(last + WINDOW);
    env.call_private(owner, DFBillboard::at(board).withdraw());
}

#[test]
unconstrained fn unused_stake_can_exit() {
    let (mut env, board, owner, portal, depositor) = setup();
    add_stake(&mut env, board, owner, portal, depositor, UNIT, 9);
    env.call_private(owner, DFBillboard::at(board).withdraw());
}

#[test(should_fail_with = "No stake to withdraw")]
unconstrained fn withdrawn_stake_cannot_exit_twice() {
    let (mut env, board, owner, portal, depositor) = setup();
    add_stake(&mut env, board, owner, portal, depositor, UNIT, 9);
    env.call_private(owner, DFBillboard::at(board).withdraw());
    env.call_private(owner, DFBillboard::at(board).withdraw());
}

#[test(should_fail_with = "Message too long")]
unconstrained fn overlength_rejected() {
    let (mut env, board, owner, portal, depositor) = setup();
    add_stake(&mut env, board, owner, portal, depositor, UNIT, 9);
    env.call_private(owner, DFBillboard::at(board).post(hello(), 513));
}

#[test(should_fail_with = "Nonzero padding")]
unconstrained fn hidden_trailing_bytes_rejected() {
    let (mut env, board, owner, portal, depositor) = setup();
    add_stake(&mut env, board, owner, portal, depositor, UNIT, 9);
    env.call_private(owner, DFBillboard::at(board).post(hello(), 1));
}


#[test]
unconstrained fn top_up_preserves_last_post_and_used_quota() {
    let (mut env, board, owner, portal, depositor) = setup();
    add_stake(&mut env, board, owner, portal, depositor, UNIT, 9);
    for _ in 0..3 { env.call_private(owner, DFBillboard::at(board).post(hello(), 2)); }
    let before = env.execute_utility(DFBillboard::at(board).get_stake_info(owner));
    assert((before[0] == UNIT as Field) & (before[3] == 2));
    env.mine_block_at(env.last_block_timestamp() + 3600);
    add_stake(&mut env, board, owner, portal, depositor, UNIT, 10);
    let after = env.execute_utility(DFBillboard::at(board).get_stake_info(owner));
    assert((after[0] == (2 * UNIT) as Field) & (after[3] == 7));
    assert((after[1] == before[1]) & (after[2] == before[2]));
}

#[test(should_fail_with = "Wait 24 hours after the last post")]
unconstrained fn top_up_cannot_clear_the_withdrawal_lock() {
    let (mut env, board, owner, portal, depositor) = setup();
    add_stake(&mut env, board, owner, portal, depositor, UNIT, 9);
    env.call_private(owner, DFBillboard::at(board).post(hello(), 2));
    let last = env.last_block_timestamp();
    env.mine_block_at(last + 3600);
    add_stake(&mut env, board, owner, portal, depositor, UNIT, 10);
    env.mine_block_at(last + WINDOW - 1);
    env.call_private(owner, DFBillboard::at(board).withdraw());
}

#[test]
unconstrained fn top_up_does_not_extend_the_last_post_lock() {
    let (mut env, board, owner, portal, depositor) = setup();
    add_stake(&mut env, board, owner, portal, depositor, UNIT, 9);
    env.call_private(owner, DFBillboard::at(board).post(hello(), 2));
    let last = env.last_block_timestamp();
    env.mine_block_at(last + 3600);
    add_stake(&mut env, board, owner, portal, depositor, UNIT, 10);
    env.mine_block_at(last + WINDOW);
    env.call_private(owner, DFBillboard::at(board).withdraw());
    let empty = env.execute_utility(DFBillboard::at(board).get_stake_info(owner));
    assert((empty[0] == 0) & (empty[3] == 0));
    assert((empty[1] == depositor.to_field()) & (empty[2] == last as Field));
    add_stake(&mut env, board, owner, portal, depositor, UNIT, 11);
    let refilled = env.execute_utility(DFBillboard::at(board).get_stake_info(owner));
    assert((refilled[0] == UNIT as Field) & (refilled[3] == 5));
    env.call_private(owner, DFBillboard::at(board).post(hello(), 2));
}

#[test]
unconstrained fn unused_stake_can_withdraw_and_restake_without_reinitializing() {
    let (mut env, board, owner, portal, depositor) = setup();
    add_stake(&mut env, board, owner, portal, depositor, UNIT, 9);
    env.call_private(owner, DFBillboard::at(board).withdraw());
    let empty = env.execute_utility(DFBillboard::at(board).get_stake_info(owner));
    assert((empty[0] == 0) & (empty[1] == depositor.to_field()) & (empty[3] == 0));
    add_stake(&mut env, board, owner, portal, depositor, 2 * UNIT, 10);
    let refilled = env.execute_utility(DFBillboard::at(board).get_stake_info(owner));
    assert((refilled[0] == (2 * UNIT) as Field) & (refilled[3] == 10));
    env.call_private(owner, DFBillboard::at(board).withdraw());
}

#[test]
unconstrained fn separate_accounts_have_independent_state_and_quota() {
    let (mut env, board, owner, portal, depositor) = setup();
    let other = env.create_light_account();
    let other_depositor = EthAddress::from_field(789);
    add_stake(&mut env, board, owner, portal, depositor, UNIT, 9);
    add_stake(&mut env, board, other, portal, other_depositor, 2 * UNIT, 10);
    env.call_private(owner, DFBillboard::at(board).post(hello(), 2));
    let first = env.execute_utility(DFBillboard::at(board).get_stake_info(owner));
    let second = env.execute_utility(DFBillboard::at(board).get_stake_info(other));
    assert((first[0] == UNIT as Field) & (first[3] == 4));
    assert((second[0] == (2 * UNIT) as Field) & (second[3] == 10));
    assert((second[1] == other_depositor.to_field()) & (second[2] == 0));
}

#[test]
unconstrained fn history_cursor_wraps_without_resetting_quota() {
    let (mut env, board, owner, portal, depositor) = setup();
    add_stake(&mut env, board, owner, portal, depositor, 4 * UNIT, 9);
    for _ in 0..20 { env.call_private(owner, DFBillboard::at(board).post(hello(), 2)); }
    env.mine_block_at(env.last_block_timestamp() + WINDOW);
    for _ in 0..20 { env.call_private(owner, DFBillboard::at(board).post(hello(), 2)); }
    let state = env.execute_utility(DFBillboard::at(board).get_stake_info(owner));
    assert(state[3] == 0);
    assert(env.view_public(DFBillboard::at(board).get_post_count()) == 40);
}

// Exercise the underlying storage slot directly: even a dishonest oracle cannot
// initialize a second state after the real deposit created the initialization nullifier.
#[test(should_fail_with = "already present")]
unconstrained fn initialized_account_cannot_create_another_state_chain() {
    let (mut env, board, owner, portal, depositor) = setup();
    add_stake(&mut env, board, owner, portal, depositor, UNIT, 9);
    env.private_context_at(board, |context| {
        let state = PrivateMutable::new(context, 1, owner);
        let _ = state.initialize(AccountState {
            amount: UNIT, depositor, last_post: 0, packed_times: [0; 4], cursor: 0,
        });
    });
}

#[test]
unconstrained fn top_up_after_exit_keeps_only_the_new_stake_and_quota() {
    let (mut env, board, owner, portal, depositor) = setup();
    add_stake(&mut env, board, owner, portal, depositor, 2 * UNIT, 9);
    env.call_private(owner, DFBillboard::at(board).post(hello(), 2));
    let last = env.last_block_timestamp();
    env.mine_block_at(last + WINDOW);
    env.call_private(owner, DFBillboard::at(board).withdraw());
    let exited = env.execute_utility(DFBillboard::at(board).get_stake_info(owner));
    assert((exited[0] == 0) & (exited[3] == 0));
    // The old L2 exit has been emitted; its L1 claim can still be pending.
    add_stake(&mut env, board, owner, portal, depositor, UNIT, 10);
    let added = env.execute_utility(DFBillboard::at(board).get_stake_info(owner));
    assert((added[0] == UNIT as Field) & (added[3] == 5));
    assert((added[1] == depositor.to_field()) & (added[2] == last as Field));
    env.call_private(owner, DFBillboard::at(board).post(hello(), 2));
    let posted = env.execute_utility(DFBillboard::at(board).get_stake_info(owner));
    assert((posted[0] == UNIT as Field) & (posted[3] == 4));
    env.mine_block_at(env.last_block_timestamp() + WINDOW);
    env.call_private(owner, DFBillboard::at(board).withdraw());
    let final = env.execute_utility(DFBillboard::at(board).get_stake_info(owner));
    assert((final[0] == 0) & (final[3] == 0));
}

#[test]
unconstrained fn another_account_exit_does_not_consume_the_owners_stake() {
    let (mut env, board, owner, portal, depositor) = setup();
    let other = env.create_light_account();
    let other_depositor = EthAddress::from_field(789);
    add_stake(&mut env, board, owner, portal, depositor, 2 * UNIT, 9);
    add_stake(&mut env, board, other, portal, other_depositor, UNIT, 10);
    env.call_private(other, DFBillboard::at(board).withdraw());
    let original = env.execute_utility(DFBillboard::at(board).get_stake_info(owner));
    let exited = env.execute_utility(DFBillboard::at(board).get_stake_info(other));
    assert((original[0] == (2 * UNIT) as Field) & (original[3] == 10));
    assert(original[1] == depositor.to_field());
    assert((exited[0] == 0) & (exited[1] == other_depositor.to_field()));
    env.call_private(owner, DFBillboard::at(board).withdraw());
    let final = env.execute_utility(DFBillboard::at(board).get_stake_info(owner));
    assert(final[0] == 0);
}

#[test(should_fail_with = "Stake required")]
unconstrained fn exited_stake_cannot_be_used_for_more_posts() {
    let (mut env, board, owner, portal, depositor) = setup();
    add_stake(&mut env, board, owner, portal, depositor, UNIT, 9);
    env.call_private(owner, DFBillboard::at(board).withdraw());
    env.call_private(owner, DFBillboard::at(board).post(hello(), 2));
}

#[test(should_fail_with = "Failed to get a note")]
unconstrained fn unstaked_account_cannot_exit_another_accounts_stake() {
    let (mut env, board, owner, portal, depositor) = setup();
    let other = env.create_light_account();
    add_stake(&mut env, board, owner, portal, depositor, UNIT, 9);
    env.call_private(other, DFBillboard::at(board).withdraw());
}

#[test(should_fail_with = "No non-nullified L1 to L2 message found")]
unconstrained fn consumed_deposit_cannot_be_claimed_twice() {
    let (mut env, board, owner, portal, depositor) = setup();
    let content = df_billboard::bridge::deposit_message(depositor, UNIT);
    let leaf = env.send_l1_to_l2_message(content, 9, portal, board);
    env.call_private(owner, DFBillboard::at(board).claim_deposit(depositor, UNIT, 9, leaf));
    let claimed = env.execute_utility(DFBillboard::at(board).get_stake_info(owner));
    assert(claimed[0] == UNIT as Field);
    env.call_private(owner, DFBillboard::at(board).claim_deposit(depositor, UNIT, 9, leaf));
}

// Storage-level race simulation: a second prover retains the same note before
// the winning exit replaces it. Seed and discover the application's note through
// the low-level SDK fixture so it can retain the full note metadata, not just its value.
#[test(should_fail_with = "already present")]
unconstrained fn competing_exit_cannot_consume_the_same_account_snapshot() {
    let (mut env, board, owner, portal, depositor) = setup();
    let initial = env.private_context_at(board, |context| {
        PrivateMutable::new(context, 1, owner).initialize(AccountState {
            amount: UNIT, depositor, last_post: 0, packed_times: [0; 4], cursor: 0,
        })
    });
    env.discover_note_at(board, initial);
    let pending_snapshot: ConfirmedNote<AccountState> = env.private_context_at(board, |context| {
        // Account state is storage slot 1; ownership is part of the note metadata.
        get_note(context, Option::some(owner), 1)
    });
    let replacement = env.private_context_at(board, |context| {
        PrivateMutable::new(context, 1, owner).replace(|mut state: AccountState| {
            assert(state.amount == UNIT);
            state.amount = 0;
            state
        })
    });
    assert(replacement.get_note().amount == 0);
    env.discover_note_at(board, replacement);
    env.private_context_at(board, |context| destroy_note(context, pending_snapshot));
}
