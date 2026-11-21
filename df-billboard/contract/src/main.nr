pub mod bridge;

use aztec::macros::aztec;

// Five six-byte timestamps fit in one field without overflowing its modulus.
fn read_time(packed: [Field; 4], index: u32) -> u64 {
    let bytes: [u8; 32] = packed[index / 5].to_be_bytes();
    let start = 2 + (index % 5) * 6;
    let mut time: u64 = 0;
    for i in 0..6 { time = time * 256 + bytes[start + i] as u64; }
    time
}

fn write_time(mut packed: [Field; 4], index: u32, time: u64) -> [Field; 4] {
    assert(time < 281474976710656, "Timestamp out of range");
    let mut bytes: [u8; 32] = packed[index / 5].to_be_bytes();
    let start = 2 + (index % 5) * 6;
    bytes[start] = (time >> 40) as u8;
    bytes[start + 1] = (time >> 32) as u8;
    bytes[start + 2] = (time >> 24) as u8;
    bytes[start + 3] = (time >> 16) as u8;
    bytes[start + 4] = (time >> 8) as u8;
    bytes[start + 5] = time as u8;
    let mut value: Field = 0;
    for i in 0..32 { value = value * 256 + bytes[i] as Field; }
    packed[index / 5] = value;
    packed
}

fn recent_posts(packed_times: [Field; 4], count: u32, now: u64) -> u32 {
    let mut used: u32 = 0;
    for i in 0..20 {
        if i < count {
            let time = read_time(packed_times, i);
            if now >= time & now - time < 86400 { used += 1; }
        }
    }
    used
}

#[aztec]
pub contract DFBillboard {
    use crate::{recent_posts, write_time};
    use crate::bridge::{deposit_message, withdrawal_message};
    use aztec::{
        macros::{
            events::event,
            functions::{external, initializer, internal, only_self, view},
            notes::note,
            storage::storage,
        },
        messages::delivery::MessageDelivery,
        history::storage::public_storage_historical_read,
        protocol::{
            address::{AztecAddress, EthAddress},
            traits::{Deserialize, Packable, Serialize, ToField},
        },
        state_vars::{Map, Owned, PrivateMutable, PublicMutable, StateVariable},
    };
    global POST_LIMIT: u32 = 20;
    global POST_WINDOW_SECONDS: u64 = 86400;
    global STAKE_UNIT: u128 = 500000000000000;
    global MAX_STAKE: u128 = 2000000000000000;
    global MAX_BYTES: u32 = 512;
    global TEXT_FIELDS: u32 = 17;

    #[event]
    struct PostPublished {
        id: u32,
    }

    #[derive(Deserialize, Eq, Serialize, Packable)]
    #[note]
    pub struct AccountState {
        pub amount: u128,
        pub depositor: EthAddress,
        pub last_post: u64,
        pub packed_times: [Field; 4],
        // count * POST_LIMIT + next_index fits one field within the 8-field note limit.
        pub cursor: u32,
    }

    #[storage]
    struct Storage<Context> {
        // Each owner has one state chain; even an omitted note cannot reinitialize it.
        accounts: Owned<PrivateMutable<AccountState, Context>, Context>,
        post_count: PublicMutable<u32, Context>,
        post_lengths: Map<u32, PublicMutable<u32, Context>, Context>,
        post_data: Map<u32, PublicMutable<Field, Context>, Context>,
        l1_portal: PublicMutable<EthAddress, Context>,
        post_timestamps: Map<u32, PublicMutable<u64, Context>, Context>,
    }

    #[external("public")]
    #[initializer]
    fn constructor() {
        self.storage.post_count.write(0);
        self.storage.l1_portal.write(EthAddress::zero());
    }

    #[external("public")]
    #[initializer]
    fn constructor_with_portal(portal: EthAddress) {
        assert(portal.to_field() != 0, "L1 portal cannot be zero");
        self.storage.post_count.write(0);
        self.storage.l1_portal.write(portal);
    }

    #[external("private")]
    fn claim_deposit(
        depositor: EthAddress,
        amount: u128,
        secret: Field,
        message_leaf_index: Field,
    ) {
        let header = self.context.get_anchor_block_header();
        let portal_field = public_storage_historical_read(
            header, self.storage.l1_portal.get_storage_slot(), self.context.this_address(),
        );
        assert(portal_field != 0, "L1 portal disabled");
        assert((amount > 0) & (amount % STAKE_UNIT == 0) & (amount <= MAX_STAKE), "Invalid stake amount");
        let portal = EthAddress::from_field(portal_field);
        self.context.consume_l1_to_l2_message(
            deposit_message(depositor, amount), [secret], portal, message_leaf_index,
        );
        let owner = self.msg_sender();
        self.storage.accounts.at(owner).initialize_or_replace(|previous: Option<AccountState>| {
            let mut state = if previous.is_none() {
                AccountState { amount: 0, depositor, last_post: 0, packed_times: [0; 4], cursor: 0 }
            } else {
                previous.unwrap_unchecked()
            };
            assert(state.depositor == depositor, "Stake belongs to another L1 address");
            assert(state.amount + amount <= MAX_STAKE, "Stake exceeds account cap");
            state.amount += amount;
            state
        }).deliver(MessageDelivery::onchain_constrained());
    }

    #[external("public")]
    #[view]
    fn get_l1_portal() -> pub EthAddress {
        self.storage.l1_portal.read()
    }

    #[external("utility")]
    unconstrained fn get_stake_info(owner: AztecAddress) -> pub [Field; 4] {
        let account = self.storage.accounts.at(owner);
        if !account.is_initialized() { [0, 0, 0, 0] }
        else {
            let state = account.view_note();
            let quota = ((state.amount / STAKE_UNIT) as u32) * 5;
            let used = recent_posts(state.packed_times, state.cursor / POST_LIMIT, self.context.timestamp());
            // A zero-balance state is retained after withdrawal, including its history.
            let remaining = if used < quota { quota - used } else { 0 };
            [state.amount as Field, state.depositor.to_field(), state.last_post as Field, remaining as Field]
        }
    }

    #[external("private")]
    fn post(text: [u8; MAX_BYTES], length: u32) {
        self.internal.post_inner(text, length);
    }

    #[internal("private")]
    fn post_inner(text: [u8; MAX_BYTES], length: u32) {
        assert(length > 0, "Empty message");
        assert(length <= MAX_BYTES, "Message too long");
        let owner = self.msg_sender();
        let header = self.context.get_anchor_block_header();
        let now = header.timestamp();
        self.storage.accounts.at(owner).replace(|mut state: AccountState| {
            assert(state.amount >= STAKE_UNIT & state.amount <= MAX_STAKE, "Stake required");
            let quota = ((state.amount / STAKE_UNIT) as u32) * 5;
            assert(now >= state.last_post, "Posting time moved backwards");
            let count = state.cursor / POST_LIMIT;
            let next_index = state.cursor % POST_LIMIT;
            assert(count <= POST_LIMIT, "Invalid posting history");
            let used = recent_posts(state.packed_times, count, now);
            assert(used < quota, "24-hour post limit reached");
            state.last_post = now;
            state.packed_times = write_time(state.packed_times, next_index, now);
            let new_count = if count < POST_LIMIT { count + 1 } else { count };
            state.cursor = new_count * POST_LIMIT + (next_index + 1) % POST_LIMIT;
            state
        }).deliver(MessageDelivery::onchain_constrained());
        // Fixed-size canonical bytes: callers cannot hide content in padding.
        for i in 0..MAX_BYTES {
            if i >= length {
                assert(text[i] == 0, "Nonzero padding");
            }
        }
        let mut packed = [0; TEXT_FIELDS];
        for i in 0..TEXT_FIELDS {
            let mut value: Field = 0;
            for j in 0..31 {
                let index = i * 31 + j;
                let byte = if index < MAX_BYTES { text[index] } else { 0 };
                value = value * 256 + byte as Field;
            }
            packed[i] = value;
        }
        self.enqueue_self._publish(packed, length);
    }

    #[external("private")]
    fn withdraw() {
        let owner = self.msg_sender();
        let now = self.context.get_anchor_block_header().timestamp();
        let header = self.context.get_anchor_block_header();
        let portal_field = public_storage_historical_read(
            header, self.storage.l1_portal.get_storage_slot(), self.context.this_address(),
        );
        let portal = EthAddress::from_field(portal_field);
        let current = self.storage.accounts.at(owner).get_note();
        let state = current.get_note();
        current.deliver(MessageDelivery::onchain_constrained());
        assert(state.amount > 0, "No stake to withdraw");
        assert(now >= state.last_post, "Posting time moved backwards");
        assert((state.last_post == 0) | (now - state.last_post >= POST_WINDOW_SECONDS),
            "Wait 24 hours after the last post");
        self.storage.accounts.at(owner).replace(|mut note: AccountState| {
            note.amount = 0;
            note
        }).deliver(MessageDelivery::onchain_constrained());
        self.enqueue_self._withdraw_public(portal, withdrawal_message(state.depositor, state.amount));
    }

    #[external("public")]
    #[only_self]
    fn _withdraw_public(portal: EthAddress, content: Field) {
        assert(portal == self.storage.l1_portal.read(), "Wrong portal");
        self.context.message_portal(portal, content);
    }

    #[external("public")]
    #[only_self]
    fn _publish(text: [Field; TEXT_FIELDS], length: u32) {
        let id = self.storage.post_count.read();
        for i in 0..TEXT_FIELDS {
            self.storage.post_data.at(id * TEXT_FIELDS + i).write(text[i]);
        }
        self.storage.post_lengths.at(id).write(length);
        self.storage.post_timestamps.at(id).write(self.context.timestamp());
        self.storage.post_count.write(id + 1);
        self.emit(PostPublished { id });
    }

    #[external("public")]
    #[view]
    fn get_post_count() -> pub u32 {
        self.storage.post_count.read()
    }

    #[external("public")]
    #[view]
    fn get_post_timestamp(id: u32) -> pub u64 {
        assert(id < self.storage.post_count.read(), "Unknown post");
        self.storage.post_timestamps.at(id).read()
    }

    #[external("public")]
    #[view]
    fn get_post(id: u32) -> pub ([Field; TEXT_FIELDS], u32) {
        assert(id < self.storage.post_count.read(), "Unknown post");
        let mut packed = [0; TEXT_FIELDS];
        for i in 0..TEXT_FIELDS {
            packed[i] = self.storage.post_data.at(id * TEXT_FIELDS + i).read();
        }
        (packed, self.storage.post_lengths.at(id).read())
    }
}
