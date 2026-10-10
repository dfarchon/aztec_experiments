export const MAX_DF_MESSAGE_BYTES = 512;
export const DF_MESSAGE_FIELDS = 17;

// The contract wire format is a byte array plus its length, not JS string.length.
export function encodeDFMessage(message) {
  if (typeof message !== 'string' || !message.isWellFormed()) throw new Error('Invalid Unicode text');
  const bytes = new TextEncoder().encode(message);
  if (!bytes.length || bytes.length > MAX_DF_MESSAGE_BYTES) throw new Error('Message must be 1–512 UTF-8 bytes');
  const text = Array(MAX_DF_MESSAGE_BYTES).fill(0);
  text.splice(0, bytes.length, ...bytes);
  return { text, length: bytes.length };
}

// On-chain fields each contain 31 bytes, big-endian; final field has 15 padding bytes.
export function decodeDFMessage(fields, length) {
  length = Number(length);
  if (!Number.isInteger(length) || length < 1 || length > MAX_DF_MESSAGE_BYTES || fields.length !== DF_MESSAGE_FIELDS) {
    throw new Error('Invalid message shape');
  }
  const bytes = new Uint8Array(DF_MESSAGE_FIELDS * 31);
  fields.forEach((field, i) => {
    let value = BigInt(field.toString());
    if (value < 0n || value >= (1n << 248n)) throw new Error('Invalid packed field');
    for (let j = 30; j >= 0; j--) {
      bytes[i * 31 + j] = Number(value & 255n);
      value >>= 8n;
    }
  });
  if (bytes.slice(length).some(byte => byte !== 0)) throw new Error('Nonzero padding');
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.slice(0, length));
}
