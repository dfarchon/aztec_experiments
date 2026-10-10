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
    global CLAIM_DOMAIN: u32 = 1145455153;
    global MAX_BYTES: u32 = 512;
    global TEXT_FIELDS: u32 = 17;

    #[derive(Deserialize, Eq, Serialize, Packable)]
    #[note]
    pub struct PostingPermit {
        pub uses: u32,
    }

    #[storage]
    struct Storage<Context> {
        // Written by initializer only. No address migration/admin setter.
        player_storage: PublicMutable<AztecAddress, Context>,
        permits: Owned<PrivateSet<PostingPermit, Context>, Context>,
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
    fn claim(player: Player) {
        // The caller is authenticated by the private call stack. Never accept an
        // arbitrary address as a claim argument or enqueue it to public execution.
        let owner = self.msg_sender();
        let header = self.context.get_anchor_block_header();
        let board = self.context.this_address();
        let source = AztecAddress::from_field(public_storage_historical_read(
            header,
            self.storage.player_storage.get_storage_slot(),
            board,
        ));
        let slot = derive_storage_slot_in_map(PLAYER_ROOTS_SLOT, owner);
        let root = public_storage_historical_read(header, slot, source);
        assert(root != 0, "Player not registered");
        assert(root == poseidon2_hash(player.serialize()), "Invalid DF player state");
        assert(player.init_timestamp > 0, "Player has not joined");

        // Kernel-validated, app-siloed secret: not a freely selectable witness.
        let secret = self.context.request_nhk_app(get_public_keys(owner).npk_m_hash);
        let claim_id = poseidon2_hash_with_separator(
            [board.to_field(), source.to_field(), owner.to_field(), secret],
            CLAIM_DOMAIN,
        );
        // Safe use of the low-level API: secret-bearing, domain-separated and
        // deterministic for this owner/board/source. Protocol rejects duplicates.
        self.context.push_nullifier_unsafe(claim_id);
        self.storage.permits.at(owner).insert(PostingPermit { uses: 1 }).deliver(
            MessageDelivery::onchain_constrained(),
        );
    }

    #[external("private")]
    fn post(text: [u8; MAX_BYTES], length: u32) {
        assert(length > 0, "Empty message");
        assert(length <= MAX_BYTES, "Message too long");
        let notes = self.storage.permits.at(self.msg_sender()).pop_notes(
            NoteGetterOptions::<PostingPermit, 1, Field, Field>::new().set_limit(1),
        );
        assert(notes.len() == 1, "No posting permit");
        assert(notes.get_unchecked(0).uses == 1, "Invalid posting permit");
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
