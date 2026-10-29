// Historical UI and token-bridge helpers.
// Requires helpers.js, wallet-runtime.js and the Aztec SDK bundle.

(function setupRpcAuth() {
  const cfg = window.RPC_CONFIG;
  if (!cfg || !cfg.apiKey) return;
  const origFetch = window.fetch.bind(window);
  window.fetch = function(input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (url && url.includes('aztec-labs.com')) {
      init = init || {};
      init.headers = { ...(init.headers || {}), 'x-aztec-api-key': cfg.apiKey };
      if (typeof input === 'string') {
        return origFetch(input, init);
      } else {
        input = new Request(input, init);
        return origFetch(input);
      }
    }
    return origFetch(input, init);
  };
})();

async function showAddress(statusId) {
  const S = statusId;
  try {
    const a = A();
    const sk = document.getElementById('secretKey').value.trim();
    const saltVal = BigInt(document.getElementById('salt').value.trim() || '0');
    if (!sk || !sk.startsWith('0x')) return;
    if (!a || !a.Fr) return;

    clearStatus(S);
    const w = log('Deriving account address...', 'working', S);
    const result = await deriveAccountAddress(sk, saltVal);
    if (w && w.parentNode) w.remove();
    log('Account address: ' + result.address.toString() +
        '\nPartial address: ' + result.partialAddress.toString(), 'success', S);
    return result;
  } catch (e) {
    const w = document.querySelector('#' + S + ' .status.working');
    if (w) w.remove();
    log('Error deriving address: ' + e.message, 'error', S);
    return null;
  }
}

function setupWalletFileInput(fileInputId, statusId, onLoaded) {
  const el = document.getElementById(fileInputId);
  if (!el) return;
  el.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      await loadWalletFile(file, statusId);
      if (onLoaded) await onLoaded();
    } catch (err) {
      log('Failed to load wallet.json: ' + err.message, 'error', statusId);
    }
  });
}

async function loadWalletFile(file, statusId) {
  const text = await file.text();
  const w = JSON.parse(text);
  if (w.secretKey) document.getElementById('secretKey').value = w.secretKey;
  // Only set salt from wallet.json if the user hasn't already entered a
  // non-zero value. This lets the user override the salt for redeployment.
  if (w.salt !== undefined) {
    const currentSalt = parseInt(document.getElementById('salt').value) || 0;
    if (currentSalt === 0) {
      const s = typeof w.salt === 'string' ? parseInt(w.salt, 16) : w.salt;
      document.getElementById('salt').value = (isNaN(s) ? 0 : s);
    }
  }
  log('Loaded wallet.json', 'success', statusId);
}

function pickWalletFile(fileInputId, statusId) {
  return new Promise((resolve, reject) => {
    const input = document.getElementById(fileInputId || 'walletFile');
    if (!input) { reject(new Error('File input not found')); return; }
    const handler = async (e) => {
      input.removeEventListener('change', handler);
      const file = e.target.files[0];
      if (!file) { reject(new Error('No file selected')); return; }
      try {
        await loadWalletFile(file, statusId);
        resolve();
      } catch (err) {
        reject(new Error('Failed to load wallet.json: ' + err.message));
      }
    };
    input.addEventListener('change', handler);
    input.click();
  });
}

function loadWallet(fileInputId) {
  const id = fileInputId || 'walletFile';
  document.getElementById(id).click();
}

function extractErrorMessage(err) {
  if (!err) return 'Unknown error';
  let msg = err.message || String(err);
  // PXE errors often wrap the real message in nested structures.
  // Try to find the most specific assertion message.
  const patterns = [
    /Assertion failed: '([^']+)'/,
    /"message"\s*:\s*"([^"]+)"/,
    /revert: (.+)/,
    /Failed to solve.*?"([^"]{5,200})"/,
    /Error: (.+)/,
  ];
  for (const p of patterns) {
    const m = msg.match(p);
    if (m && m[1]) return m[1];
  }
  if (msg.length > 300) msg = msg.substring(0, 300) + '...';
  return msg;
}

async function getL2Timestamp(aztecNode) {
  const node = aztecNode || (state && state.aztecNode);
  if (!node) throw new Error('No Aztec node available');
  const blockNum = await node.getBlockNumber();
  const block = await node.getBlock(blockNum);
  // v5 L2Block has a .timestamp getter = header.globalVariables.timestamp
  const ts = block.timestamp || block.header?.globalVariables?.timestamp || block.header?.timestamp;
  if (ts === undefined || ts === null) throw new Error('Could not get L2 timestamp from block');
  return Number(ts);
}

async function preflightL1ToL2Message(aztecNode, recipientAddress, claimAmount, claimSecretFr, messageLeafIndex, statusId) {
  const a = A();
  const S = statusId;

  // Init BarretenbergSync for poseidon2 (lightweight, no CRS needed)
  await a.BarretenbergSync.initSingleton();
  const bb = a.BarretenbergSync.getSingleton();

  // Get chainId + version from node
  const nodeInfo = await aztecNode.getNodeInfo();
  const chainId = BigInt(nodeInfo.l1ChainId);
  const version = BigInt(nodeInfo.rollupVersion);

  // Constants (from @aztec-labs/constants and Inbox.sol)
  const FEE_JUICE = 3n;                   // ProtocolContractAddress.FeeJuice
  const SECRET_HASH_DOMAIN = 4199652938n; // DomainSeparator.SECRET_HASH
  // keccak256("claim(bytes32,uint256)")[0:4]
  const CLAIM_SELECTOR = new Uint8Array([0x63, 0xf4, 0x49, 0x68]);

  // -- Helpers --
  function be32(n) {
    const b = new Uint8Array(32);
    let x = n;
    for (let i = 31; i >= 0; i--) { b[i] = Number(x & 0xffn); x >>= 8n; }
    return b;
  }
  function hexFromBytes(u8) {
    return Array.from(u8).map(b => b.toString(16).padStart(2, '0')).join('');
  }
  async function sha256ToField(fields) {
    const buf = new Uint8Array(fields.length * 32);
    for (let i = 0; i < fields.length; i++) buf.set(be32(fields[i]), i * 32);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
    return BigInt('0x00' + hexFromBytes(digest.slice(0, 31)));
  }
  async function sha256BytesToField(buf) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
    return BigInt('0x00' + hexFromBytes(digest.slice(0, 31)));
  }
  function poseidon2(fields) {
    const response = bb.poseidon2Hash({
      inputs: fields.map(x => new a.Fr(x).toBuffer())
    });
    return BigInt(a.Fr.fromString('0x' + hexFromBytes(response.hash)).toString());
  }

  const toField = BigInt(recipientAddress.toString());
  const secretField = BigInt(claimSecretFr.toString());

  // 1. Content hash
  const contentBuf = new Uint8Array(4 + 32 + 32);
  contentBuf.set(CLAIM_SELECTOR, 0);
  contentBuf.set(be32(toField), 4);
  contentBuf.set(be32(claimAmount), 36);
  const contentHash = await sha256BytesToField(contentBuf);

  // 2. Secret hash
  const secretHash = poseidon2([SECRET_HASH_DOMAIN, secretField]);

  // 3. Message hash (sender=5, recipient=5 for FeeJuice)
  const msgHash = await sha256ToField([FEE_JUICE, chainId, FEE_JUICE, version, contentHash, secretHash, messageLeafIndex]);
  const msgHex = '0x' + msgHash.toString(16).padStart(64, '0');

  // 4. Nullifier -- use the bundle's computeFeeJuiceMessageNullifier
  //    (guaranteed to match PXE's computation)
  const msgHashFr = new a.Fr(msgHash);
  const secretFrObj = new a.Fr(secretField);
  const nullifierFr = await a.computeFeeJuiceMessageNullifier(msgHashFr, secretFrObj);
  const nullifier = BigInt(nullifierFr.toString());
  const nullHex = '0x' + nullifier.toString(16).padStart(64, '0');

  log('  Computed message hash: ' + msgHex, 'info', S);
  log('  Computed nullifier:    ' + nullHex, 'info', S);

  // 5. Query node: is the message in the tree?
  log('  Checking L1->L2 message availability on node...', 'info', S);
  let witness = null;
  try {
    witness = await aztecNode.getL1ToL2MessageMembershipWitness('latest', new a.Fr(msgHash));
  } catch (e) { /* not in tree */ }
  const inTree = witness !== null && witness !== undefined;

  // 6. Check checkpoint
  let checkpoint = null;
  try {
    checkpoint = await aztecNode.getL1ToL2MessageCheckpoint(new a.Fr(msgHash));
  } catch (e) { /* not checkpointed */ }

  // 7. Check nullifier (already claimed?) -- NULLIFIER_TREE = 0
  // The nullifier must be SILOED with the FeeJuice contract address (3)
  // before looking it up in the nullifier tree, because the PXE silos it.
  let consumed = false;
  try {
    const siloedNull = await a.siloNullifier(new a.Fr(FEE_JUICE), new a.Fr(nullifier));
    const nullIdx = await aztecNode.findLeavesIndexes('latest', 0, [siloedNull]);
    consumed = nullIdx !== null && nullIdx !== undefined && nullIdx[0] !== null && nullIdx[0] !== undefined;
    if (consumed) {
      log('  Nullifier found in tree at block ' + nullIdx[0].l2BlockNumber + ', leaf ' + nullIdx[0].data, 'info', S);
    }
  } catch (e) {
    log('  Warning: nullifier check failed: ' + (e.message || e), 'warn', S);
  }

  if (consumed) {
    log('  X  This deposit has already been claimed (nullifier consumed).', 'error', S);
    log('  You need to make a new deposit to get more Fee Juice.', 'error', S);
    throw new Error('Deposit already claimed. Make a new deposit.');
  }

  if (!inTree) {
    log('  X  L1->L2 message not found in the inbox tree.', 'error', S);
    log('  Possible causes:', 'error', S);
    log('    1. The L1 deposit has not been checkpointed yet (wait ~5-10 min after L1 confirmation).', 'error', S);
    log('    2. Wrong leaf index, amount, or claim secret.', 'error', S);
    throw new Error('L1->L2 message not available. Wait for checkpoint or verify parameters.');
  }

  // Check if checkpoint is available
  const latestCheckpoint = await aztecNode.getCheckpointNumber();
  const available = checkpoint !== null && checkpoint !== undefined && BigInt(latestCheckpoint) >= BigInt(checkpoint);

  if (!available) {
    log('  Message is in the tree but waiting for checkpoint.', 'warn', S);
    log('  Checkpoint ' + checkpoint + ' needed, latest is ' + latestCheckpoint, 'info', S);
    log('  Wait a few more minutes and try again.', 'info', S);
    throw new Error('Message not yet checkpointed. Wait a few more minutes.');
  }

  log('  OK  L1->L2 message confirmed available!', 'success', S);
  log('  Leaf index in tree: ' + witness[0], 'info', S);
  log('  Checkpoint: ' + checkpoint + ' (latest: ' + latestCheckpoint + ')', 'info', S);
}

async function computeL1ToL2MsgHash(aztecNode, recipientAddress, claimAmount, claimSecretFr, messageLeafIndex) {
  const a = A();
  await a.BarretenbergSync.initSingleton();
  const bb = a.BarretenbergSync.getSingleton();
  const nodeInfo = await aztecNode.getNodeInfo();
  const chainId = BigInt(nodeInfo.l1ChainId);
  const version = BigInt(nodeInfo.rollupVersion);
  const FEE_JUICE = 3n;
  const SECRET_HASH_DOMAIN = 4199652938n;
  const CLAIM_SELECTOR = new Uint8Array([0x63, 0xf4, 0x49, 0x68]);
  function be32(n) {
    const b = new Uint8Array(32);
    let x = n;
    for (let i = 31; i >= 0; i--) { b[i] = Number(x & 0xffn); x >>= 8n; }
    return b;
  }
  function hexFromBytes(u8) {
    return Array.from(u8).map(b => b.toString(16).padStart(2, '0')).join('');
  }
  async function sha256ToField(fields) {
    const buf = new Uint8Array(fields.length * 32);
    for (let i = 0; i < fields.length; i++) buf.set(be32(fields[i]), i * 32);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
    return BigInt('0x00' + hexFromBytes(digest.slice(0, 31)));
  }
  async function sha256BytesToField(buf) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
    return BigInt('0x00' + hexFromBytes(digest.slice(0, 31)));
  }
  function poseidon2(fields) {
    const response = bb.poseidon2Hash({
      inputs: fields.map(x => new a.Fr(x).toBuffer())
    });
    return BigInt(a.Fr.fromString('0x' + hexFromBytes(response.hash)).toString());
  }
  const toField = BigInt(recipientAddress.toString());
  const secretField = BigInt(claimSecretFr.toString());
  const contentBuf = new Uint8Array(4 + 32 + 32);
  contentBuf.set(CLAIM_SELECTOR, 0);
  contentBuf.set(be32(toField), 4);
  contentBuf.set(be32(claimAmount), 36);
  const contentHash = await sha256BytesToField(contentBuf);
  const secretHash = poseidon2([SECRET_HASH_DOMAIN, secretField]);
  const msgHash = await sha256ToField([FEE_JUICE, chainId, FEE_JUICE, version, contentHash, secretHash, messageLeafIndex]);
  return new a.Fr(msgHash);
}

async function waitForL1ToL2Message(aztecNode, recipientAddress, claimAmount, claimSecretFr, messageLeafIndex, statusId, opts = {}) {
  const a = A();
  const S = statusId;
  const pollInterval = opts.pollInterval || 20000; // 20s
  const maxWait = opts.maxWait || 600000; // 10 min
  const startTime = Date.now();

  log('Computing L1->L2 message hash...', 'info', S);
  const msgHashFr = await computeL1ToL2MsgHash(aztecNode, recipientAddress, claimAmount, claimSecretFr, messageLeafIndex);
  const msgHex = '0x' + BigInt(msgHashFr.toString()).toString(16).padStart(64, '0');
  log('  Message hash: ' + msgHex, 'info', S);

  let attempt = 0;
  while (Date.now() - startTime < maxWait) {
    attempt++;
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    log('[poll ' + attempt + ', ' + elapsed + 's] Checking if message is in inbox tree...', 'info', S);

    let witness = null;
    try {
      witness = await aztecNode.getL1ToL2MessageMembershipWitness('latest', msgHashFr);
    } catch (e) { /* not in tree yet */ }

    if (witness !== null && witness !== undefined) {
      log('  Message IS in the inbox tree. Checking checkpoint...', 'info', S);
      let checkpoint = null;
      try { checkpoint = await aztecNode.getL1ToL2MessageCheckpoint(msgHashFr); } catch (e) {}
      let latestCheckpoint = null;
      try { latestCheckpoint = await aztecNode.getCheckpointNumber(); } catch (e) {}

      if (checkpoint !== null && checkpoint !== undefined && latestCheckpoint !== null && BigInt(latestCheckpoint) >= BigInt(checkpoint)) {
        log('  OK  Message is in tree AND checkpointed!', 'success', S);
        log('  Leaf index: ' + witness[0] + ', checkpoint: ' + checkpoint + ' (latest: ' + latestCheckpoint + ')', 'info', S);
        return true;
      } else {
        log('  In tree but not yet checkpointed (need checkpoint ' + checkpoint + ', latest ' + latestCheckpoint + '). Waiting...', 'warn', S);
      }
    } else {
      log('  Not in tree yet. The L1 deposit takes ~5-10 min to be checkpointed on L2.', 'info', S);
    }

    log('  Waiting ' + (pollInterval / 1000) + 's before next poll...', 'info', S);
    await new Promise(r => setTimeout(r, pollInterval));
  }

  const waitedMin = Math.floor((Date.now() - startTime) / 60000);
  log('  X  Timed out after ' + waitedMin + ' min. The message may still arrive.', 'error', S);
  log('  You can proceed to the Claim page and try again later.', 'error', S);
  return false;
}

const FEE_JUICE_PORTAL_ADDR = '0xaf73dd51d1eb8a079bb097f39c832cdd00ac691c';

const AZTEC_TOKEN_ADDR = '0xa27ec0006e59f245217ff08cd52a7e8b169e62d2';

const FEE_JUICE_PORTAL_ABI = [
  'function depositToAztecPublic(bytes32 to, uint256 amount, bytes32 secretHash) returns (bytes32 key, uint256 index)',
  'function VERSION() view returns (uint256)',
  'function L2_TOKEN_ADDRESS() view returns (bytes32)',
];

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];

const DEPOSIT_EVENT_ABI = [
  'event DepositToAztecPublic(bytes32 indexed to, uint256 amount, bytes32 secretHash, bytes32 key, uint256 index)',
];

const FEE_JUICE_SIGN_MSG = 'Aztec fee-juice deposit claim secret v1\n\n' +
  'Signing this message derives (and recovers) your L1->L2 claim secret. ' +
  'It does not authorize any transaction.';
