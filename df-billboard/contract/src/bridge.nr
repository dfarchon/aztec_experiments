use aztec::protocol::hash::sha256_to_field;

// "DFBB_L1_REQUEST_V1". The salt hides both the text and the account binding.
pub fn request_commitment(text: [u8; 512], length: u32, salt: Field, owner: Field) -> Field {
    let mut words = [0; 21];
    words[0] = 0x444642425f4c315f524551554553545f5631;
    words[1] = length as Field;
    for i in 0..17 {
        let mut value: Field = 0;
        for j in 0..31 {
            let index = i * 31 + j;
            let byte = if index < 512 { text[index] } else { 0 };
            value = value * 256 + byte as Field;
        }
        words[i + 2] = value;
    }
    words[19] = salt;
    words[20] = owner;
    let mut bytes = [0; 672];
    for i in 0..21 {
        let word: [u8; 32] = words[i].to_be_bytes();
        for j in 0..32 {
            bytes[i * 32 + j] = word[j];
        }
    }
    sha256_to_field(bytes)
}

// "DFBB_L1_POST_V1", left-padded to one ABI word. Keep in sync with Solidity.
global DOMAIN: Field = 0x444642425f4c315f504f53545f5631;

// sha256ToField(abi.encode(DOMAIN, uint256(id), uint256(length), bytes32[17](text))).
// The cross-chain envelope separately authenticates source board/version and
// recipient address/chain. No author or fee-paying address enters this hash.
pub fn content_hash(id: u32, length: u32, text: [Field; 17]) -> Field {
    let mut words = [0; 20];
    words[0] = DOMAIN;
    words[1] = id as Field;
    words[2] = length as Field;
    for i in 0..17 {
        words[i + 3] = text[i];
    }
    let mut bytes = [0; 640];
    for i in 0..20 {
        let word: [u8; 32] = words[i].to_be_bytes();
        for j in 0..32 {
            bytes[i * 32 + j] = word[j];
        }
    }
    sha256_to_field(bytes)
}
