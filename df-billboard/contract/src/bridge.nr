use aztec::protocol::address::EthAddress;
use aztec::protocol::hash::sha256_to_field;
use aztec::protocol::traits::ToField;

// Matches the portal's abi.encodeWithSignature("claim_deposit(bytes32,uint256)", ...).
pub fn deposit_message(depositor: EthAddress, amount: u128) -> Field {
    let mut bytes = [0; 68];
    let selector: [u8; 4] = [0x95, 0x03, 0x86, 0x33];
    let address: [u8; 32] = depositor.to_field().to_be_bytes();
    let value: [u8; 32] = (amount as Field).to_be_bytes();
    for i in 0..4 { bytes[i] = selector[i]; }
    for i in 0..32 {
        bytes[4 + i] = address[i];
        bytes[36 + i] = value[i];
    }
    sha256_to_field(bytes)
}

// Matches the portal's abi.encodePacked(bytes32(depositor), uint256(amount)).
pub fn withdrawal_message(depositor: EthAddress, amount: u128) -> Field {
    let mut bytes = [0; 64];
    let address: [u8; 32] = depositor.to_field().to_be_bytes();
    let value: [u8; 32] = (amount as Field).to_be_bytes();
    for i in 0..32 {
        bytes[i] = address[i];
        bytes[32 + i] = value[i];
    }
    sha256_to_field(bytes)
}
