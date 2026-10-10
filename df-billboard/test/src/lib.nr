use aztec::{protocol::address::AztecAddress, test::helpers::test_environment::TestEnvironment};
use df_billboard::DFBillboard;
use player::PlayerStorage;
use types::storage::player::Player;

unconstrained fn setup(
    joined: bool,
) -> (TestEnvironment, AztecAddress, AztecAddress, AztecAddress, AztecAddress, Player) {
    let mut env = TestEnvironment::new();
    let admin = env.create_light_account();
    let owner = env.create_light_account();
    let source = env.deploy("@player/PlayerStorage").with_public_initializer(
        admin,
        PlayerStorage::interface().constructor(admin),
    );
    let board = env.deploy("@df_billboard/DFBillboard").with_public_initializer(
        admin,
        DFBillboard::interface().constructor(source),
    );
    let mut state = Player::zero();
    if joined {
        state.init_timestamp = 1;
        state.home_planet_id = 42;
        // Real DF storage contract and Player type, not a mocked membership bool.
        // Core.initialize_player gameplay/ZK validation is outside this fixture.
        env.call_public(admin, PlayerStorage::at(source).set(owner, state));
    }
    (env, source, board, admin, owner, state)
}

fn hello() -> [u8; 512] {
    let mut text = [0; 512];
    text[0] = 104;
    text[1] = 105;
    text
}

#[test]
unconstrained fn joined_player_claims_and_posts() {
    let (env, source, board, _, owner, state) = setup(true);
    assert(env.view_public(DFBillboard::at(board).get_player_storage()) == source);
    env.call_private(owner, DFBillboard::at(board).claim(state));
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

#[test(should_fail_with = "Player not registered")]
unconstrained fn unregistered_player_cannot_claim() {
    let (env, _, board, _, owner, state) = setup(false);
    env.call_private(owner, DFBillboard::at(board).claim(state));
}

#[test(should_fail_with = "Invalid DF player state")]
unconstrained fn forged_player_state_cannot_claim() {
    let (env, _, board, _, owner, mut state) = setup(true);
    state.score = 100;
    env.call_private(owner, DFBillboard::at(board).claim(state));
}

#[test(should_fail_with = "Player has not joined")]
unconstrained fn nonzero_root_without_initialization_cannot_claim() {
    let (env, source, board, admin, owner, mut state) = setup(false);
    state.score = 1;
    env.call_public(admin, PlayerStorage::at(source).set(owner, state));
    env.call_private(owner, DFBillboard::at(board).claim(state));
}

#[test(should_fail_with = "duplicate nullifiers")]
unconstrained fn duplicate_claim_rejected() {
    let (env, _, board, _, owner, state) = setup(true);
    env.call_private(owner, DFBillboard::at(board).claim(state));
    env.call_private(owner, DFBillboard::at(board).claim(state));
}

#[test(should_fail_with = "No posting permit")]
unconstrained fn permit_cannot_be_used_twice() {
    let (env, _, board, _, owner, state) = setup(true);
    env.call_private(owner, DFBillboard::at(board).claim(state));
    env.call_private(owner, DFBillboard::at(board).post(hello(), 2));
    env.call_private(owner, DFBillboard::at(board).post(hello(), 2));
}

#[test(should_fail_with = "No posting permit")]
unconstrained fn posting_without_claim_rejected() {
    let (env, _, board, _, owner, _) = setup(true);
    env.call_private(owner, DFBillboard::at(board).post(hello(), 2));
}

#[test(should_fail_with = "Function _publish can only be called by the same contract")]
unconstrained fn direct_public_publish_rejected() {
    let (env, _, board, _, owner, _) = setup(true);
    env.call_public(owner, DFBillboard::at(board)._publish([0; 17], 1));
}

#[test(should_fail_with = "Player not registered")]
unconstrained fn another_account_cannot_claim_players_state() {
    let (env, _, board, admin, _, state) = setup(true);
    env.call_private(admin, DFBillboard::at(board).claim(state));
}

#[test(should_fail_with = "No posting permit")]
unconstrained fn another_account_cannot_use_permit() {
    let (env, _, board, admin, owner, state) = setup(true);
    env.call_private(owner, DFBillboard::at(board).claim(state));
    env.call_private(admin, DFBillboard::at(board).post(hello(), 2));
}

#[test(should_fail_with = "Message too long")]
unconstrained fn overlength_rejected() {
    let (env, _, board, _, owner, state) = setup(true);
    env.call_private(owner, DFBillboard::at(board).claim(state));
    env.call_private(owner, DFBillboard::at(board).post(hello(), 513));
}

#[test(should_fail_with = "Empty message")]
unconstrained fn empty_rejected() {
    let (env, _, board, _, owner, state) = setup(true);
    env.call_private(owner, DFBillboard::at(board).claim(state));
    env.call_private(owner, DFBillboard::at(board).post([0; 512], 0));
}

#[test(should_fail_with = "Nonzero padding")]
unconstrained fn hidden_trailing_bytes_rejected() {
    let (env, _, board, _, owner, state) = setup(true);
    env.call_private(owner, DFBillboard::at(board).claim(state));
    env.call_private(owner, DFBillboard::at(board).post(hello(), 1));
}

#[test]
unconstrained fn maximum_length_round_trip() {
    let (env, _, board, _, owner, state) = setup(true);
    env.call_private(owner, DFBillboard::at(board).claim(state));
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

#[test(should_fail_with = "duplicate nullifiers")]
unconstrained fn updated_player_state_cannot_refresh_claim() {
    let (env, source, board, admin, owner, mut state) = setup(true);
    env.call_private(owner, DFBillboard::at(board).claim(state));
    env.call_private(owner, DFBillboard::at(board).post(hello(), 2));
    state.score = 10;
    env.call_public(admin, PlayerStorage::at(source).set(owner, state));
    env.call_private(owner, DFBillboard::at(board).claim(state));
}

#[test(should_fail_with = "Player not registered")]
unconstrained fn registration_in_other_storage_does_not_count() {
    let (mut env, _, _, admin, owner, state) = setup(true);
    let other_source = env.deploy("@player/PlayerStorage").with_public_initializer(
        admin,
        PlayerStorage::interface().constructor(admin),
    );
    let other_board = env.deploy("@df_billboard/DFBillboard").with_public_initializer(
        admin,
        DFBillboard::interface().constructor(other_source),
    );
    env.call_private(owner, DFBillboard::at(other_board).claim(state));
}

#[test]
unconstrained fn two_players_have_independent_permits() {
    let (env, source, board, admin, owner, state) = setup(true);
    env.call_public(admin, PlayerStorage::at(source).set(admin, state));
    env.call_private(owner, DFBillboard::at(board).claim(state));
    env.call_private(admin, DFBillboard::at(board).claim(state));
    env.call_private(owner, DFBillboard::at(board).post(hello(), 2));
    env.call_private(admin, DFBillboard::at(board).post(hello(), 2));
    assert(env.view_public(DFBillboard::at(board).get_post_count()) == 2);
}

#[test(should_fail_with = "PlayerStorage cannot be zero")]
unconstrained fn zero_source_rejected() {
    let mut env = TestEnvironment::new();
    let admin = env.create_light_account();
    let _ = env.deploy("@df_billboard/DFBillboard").with_public_initializer(
        admin,
        DFBillboard::interface().constructor(AztecAddress::zero()),
    );
}
