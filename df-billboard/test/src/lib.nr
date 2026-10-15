use aztec::{
    keys::getters::get_public_keys,
    protocol::{address::AztecAddress, hash::poseidon2_hash_with_separator, traits::ToField},
    test::helpers::test_environment::TestEnvironment,
};
use df_billboard::DFBillboard;

unconstrained fn setup() -> (TestEnvironment, AztecAddress, AztecAddress, AztecAddress) {
    let mut env = TestEnvironment::new();
    let deployer = env.create_light_account();
    let owner = env.create_light_account();
    let board = env.deploy("@df_billboard/DFBillboard").with_public_initializer(
        deployer,
        DFBillboard::interface().constructor(),
    );
    (env, board, deployer, owner)
}

fn hello() -> [u8; 512] {
    let mut text = [0; 512];
    text[0] = 104;
    text[1] = 105;
    text
}

#[test]
unconstrained fn new_account_posts_without_registration_or_deposit() {
    let (env, board, _, owner) = setup();
    env.call_private(owner, DFBillboard::at(board).post(hello(), 2));
    assert(env.view_public(DFBillboard::at(board).get_post_count()) == 1);
    let (data, length) = env.view_public(DFBillboard::at(board).get_post(0));
    let mut expected: Field = 104 * 256 + 105;
    for _ in 0..29 {
        expected = expected * 256;
    }
    assert(length == 2);
    assert(data[0] == expected);
    for i in 1..17 {
        assert(data[i] == 0);
    }
}

#[test]
unconstrained fn account_created_after_deployment_can_post() {
    let (mut env, board, _, _) = setup();
    let newcomer = env.create_light_account();
    env.call_private(newcomer, DFBillboard::at(board).post(hello(), 2));
    assert(env.view_public(DFBillboard::at(board).get_post_count()) == 1);
}

#[test]
unconstrained fn ten_posts_allowed_in_one_window() {
    let (env, board, _, owner) = setup();
    for _ in 0..10 {
        env.call_private(owner, DFBillboard::at(board).post(hello(), 2));
    }
    assert(env.view_public(DFBillboard::at(board).get_post_count()) == 10);
}

#[test(should_fail_with = "24-hour post limit reached")]
unconstrained fn eleventh_post_inside_rolling_window_rejected() {
    let (env, board, _, owner) = setup();
    for _ in 0..11 {
        env.call_private(owner, DFBillboard::at(board).post(hello(), 2));
    }
}

#[test(should_fail_with = "24-hour post limit reached")]
unconstrained fn one_second_before_expiry_is_still_limited() {
    let (env, board, _, owner) = setup();
    let first_time = env.last_block_timestamp();
    for _ in 0..10 {
        env.call_private(owner, DFBillboard::at(board).post(hello(), 2));
    }
    env.mine_block_at(first_time + 86399);
    env.call_private(owner, DFBillboard::at(board).post(hello(), 2));
}

#[test]
unconstrained fn only_expired_post_frees_one_slot_at_exact_boundary() {
    let (env, board, _, owner) = setup();
    let first_time = env.last_block_timestamp();
    env.call_private(owner, DFBillboard::at(board).post(hello(), 2));
    env.mine_block_at(first_time + 3600);
    for _ in 0..9 {
        env.call_private(owner, DFBillboard::at(board).post(hello(), 2));
    }
    env.mine_block_at(first_time + 86400);
    env.call_private(owner, DFBillboard::at(board).post(hello(), 2));
    assert(env.view_public(DFBillboard::at(board).get_post_count()) == 11);
}

#[test(should_fail_with = "24-hour post limit reached")]
unconstrained fn expired_oldest_does_not_reset_other_nine() {
    let (env, board, _, owner) = setup();
    let first_time = env.last_block_timestamp();
    env.call_private(owner, DFBillboard::at(board).post(hello(), 2));
    env.mine_block_at(first_time + 3600);
    for _ in 0..9 {
        env.call_private(owner, DFBillboard::at(board).post(hello(), 2));
    }
    env.mine_block_at(first_time + 86400);
    env.call_private(owner, DFBillboard::at(board).post(hello(), 2));
    env.call_private(owner, DFBillboard::at(board).post(hello(), 2));
}

#[test(should_fail_with = "24-hour post limit reached")]
unconstrained fn future_inclusion_time_does_not_advance_anchor_quota() {
    let (env, board, _, owner) = setup();
    let first_time = env.last_block_timestamp();
    for _ in 0..10 {
        env.call_private(owner, DFBillboard::at(board).post(hello(), 2));
    }
    // Moving the pending block clock alone must not free quota at the old anchor.
    env.set_next_block_timestamp(first_time + 86400);
    env.call_private(owner, DFBillboard::at(board).post(hello(), 2));
}

#[test]
unconstrained fn rolling_history_survives_multiple_ring_wraps() {
    let (env, board, _, owner) = setup();
    let first_time = env.last_block_timestamp();
    for day in 0..3 {
        env.mine_block_at(first_time + day as u64 * 86400);
        for _ in 0..10 {
            env.call_private(owner, DFBillboard::at(board).post(hello(), 2));
        }
    }
    assert(env.view_public(DFBillboard::at(board).get_post_count()) == 30);
}

#[test]
unconstrained fn accounts_have_independent_full_quotas() {
    let (env, board, deployer, owner) = setup();
    for _ in 0..10 {
        env.call_private(owner, DFBillboard::at(board).post(hello(), 2));
    }
    for _ in 0..10 {
        env.call_private(deployer, DFBillboard::at(board).post(hello(), 2));
    }
    assert(env.view_public(DFBillboard::at(board).get_post_count()) == 20);
}

#[test]
unconstrained fn boards_have_independent_full_quotas() {
    let (mut env, board, deployer, owner) = setup();
    let other_board = env.deploy("@df_billboard/DFBillboard").with_public_initializer(
        deployer,
        DFBillboard::interface().constructor(),
    );
    for _ in 0..10 {
        env.call_private(owner, DFBillboard::at(board).post(hello(), 2));
    }
    for _ in 0..10 {
        env.call_private(owner, DFBillboard::at(other_board).post(hello(), 2));
    }
    assert(env.view_public(DFBillboard::at(board).get_post_count()) == 10);
    assert(env.view_public(DFBillboard::at(other_board).get_post_count()) == 10);
}

#[test(should_fail_with = "duplicate siloed nullifier")]
unconstrained fn missing_history_cannot_reinitialize_quota() {
    let (env, board, _, owner) = setup();
    // Model an absent private history with its first-post nullifier already
    // settled. A wallet omitting its history must not get a fresh quota.
    env.private_context_at(board, |context| {
        let secret = context.request_nhk_app(get_public_keys(owner).npk_m_hash);
        let first_post_id = poseidon2_hash_with_separator(
            [board.to_field(), owner.to_field(), secret],
            1145455153,
        );
        context.push_nullifier_unsafe(first_post_id);
    });
    env.call_private(owner, DFBillboard::at(board).post(hello(), 2));
}

#[test(should_fail_with = "Function _publish can only be called by the same contract")]
unconstrained fn direct_public_publish_rejected() {
    let (env, board, _, owner) = setup();
    env.call_public(owner, DFBillboard::at(board)._publish([0; 17], 1));
}

#[test(should_fail_with = "Message too long")]
unconstrained fn overlength_rejected() {
    let (env, board, _, owner) = setup();
    env.call_private(owner, DFBillboard::at(board).post(hello(), 513));
}

#[test(should_fail_with = "Empty message")]
unconstrained fn empty_rejected() {
    let (env, board, _, owner) = setup();
    env.call_private(owner, DFBillboard::at(board).post([0; 512], 0));
}

#[test(should_fail_with = "Nonzero padding")]
unconstrained fn hidden_trailing_bytes_rejected() {
    let (env, board, _, owner) = setup();
    env.call_private(owner, DFBillboard::at(board).post(hello(), 1));
}

#[test]
unconstrained fn maximum_length_round_trip() {
    let (env, board, _, owner) = setup();
    env.call_private(owner, DFBillboard::at(board).post([97; 512], 512));
    let (fields, length) = env.view_public(DFBillboard::at(board).get_post(0));
    assert(length == 512);
    let mut expected: Field = 0;
    for _ in 0..16 {
        expected = expected * 256 + 97;
    }
    for _ in 0..15 {
        expected = expected * 256;
    }
    assert(fields[16] == expected);
}

#[test(should_fail_with = "Unknown post")]
unconstrained fn unpublished_post_cannot_be_read() {
    let (env, board, _, _) = setup();
    let _ = env.view_public(DFBillboard::at(board).get_post(0));
}
