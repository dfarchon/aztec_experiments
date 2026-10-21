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
