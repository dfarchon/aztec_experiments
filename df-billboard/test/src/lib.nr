use aztec::{
    protocol::{address::{AztecAddress, EthAddress}, traits::ToField},
    test::helpers::test_environment::TestEnvironment,
};
use df_billboard::DFBillboard;

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

#[test(should_fail_with = "Stake required")]
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
