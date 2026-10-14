use aztec::macros::aztec;

#[aztec]
pub contract DFBillboard {
    use aztec::{
        history::storage::public_storage_historical_read,
        keys::getters::get_public_keys,
        macros::{
            functions::{external, initializer, only_self, view},
            notes::note,
            storage::storage,
        },
        messages::delivery::MessageDelivery,
        note::note_getter_options::NoteGetterOptions,
        protocol::{
            address::AztecAddress,
            hash::{poseidon2_hash, poseidon2_hash_with_separator},
            storage::map::derive_storage_slot_in_map,
            traits::{Deserialize, FromField, Packable, Serialize, ToField},
        },
        state_vars::{Map, Owned, PrivateSet, PublicMutable, StateVariable},
    };
    use types::storage::player::Player;

    // DF revision pinned in scripts/prepare-df.mjs: five preceding one-slot fields.
    // This is NOT a user-supplied slot; changing the DF layout requires a new adapter.
    global PLAYER_ROOTS_SLOT: Field = 6;
    global FIRST_POST_DOMAIN: u32 = 1145455153;
    global POST_LIMIT: u32 = 10;
    global POST_WINDOW_SECONDS: u64 = 86400;
    global U64_MASK: u128 = 18446744073709551615;
    global MAX_BYTES: u32 = 512;
    global TEXT_FIELDS: u32 = 17;

    #[derive(Deserialize, Eq, Serialize, Packable)]
    #[note]
    pub struct PostingHistory {
        // Two u64 timestamps per u128 keeps the note below Aztec's 8-field cap.
        pub timestamp_pairs: [u128; 5],
        pub next_index: u32,
        pub count: u32,
    }

    #[storage]
    struct Storage<Context> {
        // Written by initializer only. No address migration/admin setter.
        player_storage: PublicMutable<AztecAddress, Context>,
        histories: Owned<PrivateSet<PostingHistory, Context>, Context>,
        post_count: PublicMutable<u32, Context>,
        post_lengths: Map<u32, PublicMutable<u32, Context>, Context>,
        post_data: Map<u32, PublicMutable<Field, Context>, Context>,
    }

    #[external("public")]
    #[initializer]
    fn constructor(player_storage: AztecAddress) {
        assert(!player_storage.is_zero(), "PlayerStorage cannot be zero");
        self.storage.player_storage.write(player_storage);
        self.storage.post_count.write(0);
    }

    #[external("private")]
    fn post(player: Player, text: [u8; MAX_BYTES], length: u32) {
        assert(length > 0, "Empty message");
        assert(length <= MAX_BYTES, "Message too long");
        let owner = self.msg_sender();
        let header = self.context.get_anchor_block_header();
        let now = header.timestamp();
        let board = self.context.this_address();
        let source = AztecAddress::from_field(public_storage_historical_read(
            header,
            self.storage.player_storage.get_storage_slot(),
            board,
        ));
        let slot = derive_storage_slot_in_map(PLAYER_ROOTS_SLOT, owner);
        let root = public_storage_historical_read(header, slot, source);
        assert(root != 0, "Player not registered");

        let notes = self.storage.histories.at(owner).pop_notes(
            NoteGetterOptions::<PostingHistory, 7, Field, Field>::new().set_limit(1),
        );
        let mut history = if notes.len() == 0 {
            // A first post proves DF entry. The one-time nullifier prevents a
            // caller from dropping its history note to reset the rolling limit.
            assert(root == poseidon2_hash(player.serialize()), "Invalid DF player state");
            assert(player.init_timestamp > 0, "Player has not joined");
            let secret = self.context.request_nhk_app(get_public_keys(owner).npk_m_hash);
            let first_post_id = poseidon2_hash_with_separator(
                [board.to_field(), source.to_field(), owner.to_field(), secret],
                FIRST_POST_DOMAIN,
            );
            self.context.push_nullifier_unsafe(first_post_id);
            PostingHistory {
                timestamp_pairs: [0; 5], next_index: 0, count: 0,
            }
        } else {
            notes.get_unchecked(0)
        };
        assert(history.count <= POST_LIMIT, "Invalid posting history");
        assert(history.next_index < POST_LIMIT, "Invalid posting history");
        let index = history.next_index as u32;
        if history.count > 0 {
            let last_index = (index + POST_LIMIT - 1) % POST_LIMIT;
            let last_pair = history.timestamp_pairs[last_index / 2];
            let last = if last_index % 2 == 0 {
                (last_pair & U64_MASK) as u64
            } else {
                (last_pair >> 64) as u64
            };
            assert(now >= last, "Posting time moved backwards");
        }
        if history.count == POST_LIMIT {
            let oldest_pair = history.timestamp_pairs[index / 2];
            let oldest = if index % 2 == 0 {
                (oldest_pair & U64_MASK) as u64
            } else {
                (oldest_pair >> 64) as u64
            };
            assert(now >= oldest, "Posting time moved backwards");
            assert(now - oldest >= POST_WINDOW_SECONDS, "24-hour post limit reached");
        } else {
            history.count += 1;
        }
        let pair = history.timestamp_pairs[index / 2];
        history.timestamp_pairs[index / 2] = if index % 2 == 0 {
            (pair & (U64_MASK << 64)) | (now as u128)
        } else {
            (pair & U64_MASK) | ((now as u128) << 64)
        };
        history.next_index = (index + 1) % POST_LIMIT;
        self.storage.histories.at(owner).insert(history).deliver(
            MessageDelivery::onchain_constrained(),
        );
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

    #[external("public")]
    #[only_self]
    fn _publish(text: [Field; TEXT_FIELDS], length: u32) {
        let id = self.storage.post_count.read();
        for i in 0..TEXT_FIELDS {
            self.storage.post_data.at(id * TEXT_FIELDS + i).write(text[i]);
        }
        self.storage.post_lengths.at(id).write(length);
        self.storage.post_count.write(id + 1);
    }

    #[external("public")]
    #[view]
    fn get_post_count() -> pub u32 {
        self.storage.post_count.read()
    }

    #[external("public")]
    #[view]
    fn get_player_storage() -> pub AztecAddress {
        self.storage.player_storage.read()
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
