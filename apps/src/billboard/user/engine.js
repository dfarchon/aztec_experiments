// ============================================================
// engine.js -- Billboard User Engine (Deposit -> Post -> Withdraw)
// ============================================================
// Fully abstracted from the interface. Takes an `env` object
// (providing aztec SDK, ethers, logging, CRS init, store
// creation, ETH signer) and a `config` object. Runs any single
// action or the full autonomous flow:
//
//   deposit   -> make a new ETH deposit into the L1 portal
//   claim     -> claim the deposit on L2 (consume L1->L2 msg)
//   post      -> post an anonymous message to the billboard
//   list      -> list all posts on the billboard
//   withdraw  -> withdraw on L2 (send L2->L1 message)
//   claim-l1  -> claim ETH on L1 (consume Outbox message)
//   status    -> auto-resolve current state and print it
//   auto      -> deposit -> claim -> post (if msg) -> withdraw -> claim-l1
//
// Works in: browser (bundle), CLI (bundle + fake-indexeddb)
//
// Defines: globalThis.runBillboardUser(env, config) -> Promise<result>
// ============================================================

;(function() {
  const g = typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this);

  // ============================================================
  // Constants
  // ============================================================
  const TRANSIENT_RE = /temporary internal error|please retry|timeout|fetch|network|connection|ECONNRESET|socket/i;

  const MSG_FIELDS = 32;
  const MSG_BYTES = MSG_FIELDS * 31; // 31 bytes per field

  const CREATE2_PROXY = '0x4e59b44847b379578588920cA78FbF26c0B4956C';

  const PORTAL_ABI = [
    "constructor(address rollup, bytes32 l2Contract, uint256 version, uint256 minDeposit)",
    "function deposit(bytes32 secretHash) payable returns (bytes32, uint256)",
    "function withdraw(uint256 epoch, uint256 numCheckpointsInEpoch, uint256 leafIndex, bytes32[] path)",
    "function deposits(address) view returns (uint256)",
    "function getDeposit(address) view returns (uint256)",
    "function MIN_DEPOSIT() view returns (uint256)",
    "function L2_CONTRACT() view returns (bytes32)",
    "function ROLLUP() view returns (address)",
    "function VERSION() view returns (uint256)",
    "function totalDeposited() view returns (uint256)",
    "event Deposited(address indexed depositor, uint256 amount, bytes32 secretHash, bytes32 key, uint256 index)",
    "event Withdrawn(address indexed depositor, uint256 amount)",
  ];

  const OUTBOX_ABI = [
    "function hasMessageBeenConsumedAtEpoch(uint256 epoch, uint256 leafId) view returns (bool)",
  ];

  // keccak256("Deposited(address,uint256,bytes32,bytes32,uint256)") topic
  const DEPOSIT_TOPIC = '0x6e50ccff862b48a5a6a7775b6472fc6e3ba8761a7b131fcf7b46ebda668896aa';

  // ============================================================
  // Helpers
  // ============================================================
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function extractErrorMessage(err) {
    if (!err) return 'Unknown error';
    let msg = err.message || String(err);
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

  function toAztec(bi, decimals = 4) {
    const factor = 10n ** BigInt(decimals);
    return (Number(bi * factor / 10n ** 18n) / Number(factor)).toFixed(decimals);
  }

  function toEther(wei) {
    return toEtherStr(wei);
  }
  function toEtherStr(wei) {
    // 18 decimals
    const factor = 10n ** 18n;
    const whole = wei / factor;
    const frac = wei % factor;
    return whole.toString() + '.' + frac.toString().padStart(18, '0').replace(/0+$/, '');
  }

  // Retry wrapper for transient errors
  async function retry(fn, label, log, maxRetries = 8) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try { return await fn(); }
      catch (err) {
        const isTransient = TRANSIENT_RE.test(err.message || '');
        if (!isTransient || attempt === maxRetries) throw err;
        const delay = 2000 * attempt;
        if (label) log('  [' + label + '] transient error (attempt ' + attempt + '/' + maxRetries + '), retrying in ' + delay/1000 + 's...', 'warn');
        await sleep(delay);
      }
    }
  }

  // Wrap a node client with retry proxy
  function wrapWithRetry(obj, label, log) {
    return new Proxy(obj, {
      get(target, prop) {
        const val = target[prop];
        if (typeof val !== 'function') return val;
        return async (...args) => {
          for (let attempt = 1; attempt <= 8; attempt++) {
            try { return await val.apply(target, args); }
            catch (err) {
              const isTransient = TRANSIENT_RE.test(err.message || '');
              if (!isTransient || attempt === 8) throw err;
              const delay = 2000 * attempt;
              if (label) log('  [' + label + '.' + String(prop) + '] transient error (attempt ' + attempt + '/8), retrying in ' + delay/1000 + 's...', 'warn');
              await sleep(delay);
            }
          }
        };
      }
    });
  }

  // Retry a user-rejected signing/transaction action.
  // When the user rejects a personal_sign or eth_sendTransaction in their wallet,
  // ethers throws an error with code ACTION_REJECTED (4001). Instead of crashing,
  // we log a message and retry indefinitely until the user accepts or cancels the whole flow.
  const REJECT_RE = /ACTION_REJECTED|user rejected|4001|user-denied|rejected the request/i;
  async function withUserRetry(fn, label) {
    for (;;) {
      try {
        return await fn();
      } catch (err) {
        const msg = err && (err.message || String(err));
        if (REJECT_RE.test(msg)) {
          log('  ' + label + ' was rejected in your wallet. Please try again (or accept the request to continue).', 'warn');
          // Brief pause so we don't hammer the wallet if it auto-rejects
          await sleep(1500);
          continue;
        }
        throw err;
      }
    }
  }

  // Deterministic claim secret for billboard deposits.
  // secret = first 32 bytes of personal_sign(message), where
  //   message = 'Aztec Billboard Deposit Secret\nAddress: <addr>\nNonce: <nonce>'
  // ethSigner.signMessage() replicates personal_sign in both Node.js and browser.
  async function generateSecret(ethSigner, address, nonce) {
    const msg = 'Aztec Billboard Deposit Secret\nAddress: ' + address + '\nNonce: ' + nonce;
    const sig = await withUserRetry(() => ethSigner.signMessage(msg), 'Sign deposit secret');
    // Take first 32 bytes and reduce mod p to ensure it's a valid Fr
    const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
    const raw = BigInt('0x' + sig.slice(2, 66));
    const reduced = raw % P;
    return '0x' + reduced.toString(16).padStart(64, '0');
  }

  // Find all deposit events for an address on the portal by scanning L1 logs.
  // Returns array of { amount, secretHash, key, index, txHash, nonce } sorted by index ascending.
  // Scans newest-to-oldest. Once deposits are found, continues scanning a few more chunks
  // for any other recent deposits, then stops (avoiding a 2+ minute scan of empty history).
  async function findAllDeposits(ethers, provider, portalAddr, l1Account, log) {
    const paddedAddr = '0x000000000000000000000000' + l1Account.toLowerCase().replace(/^0x/, '');
    log('  Searching for Deposited events from ' + l1Account + '...', 'info');
    log('  Portal: ' + portalAddr, 'info');

    const currentBlock = await provider.getBlockNumber();
    const CHUNK = 10000;
    const MAX_LOOKBACK = 200000;
    const EXTRA_AFTER_FIND = 3; // extra chunks to scan after first find
    let logs = [];
    let chunksSinceFind = 0;
    let foundAny = false;
    let scanned = 0;
    for (let end = currentBlock; end >= Math.max(0, currentBlock - MAX_LOOKBACK); end -= CHUNK) {
      const from = Math.max(0, end - CHUNK + 1);
      scanned++;
      try {
        const chunk = await provider.getLogs({
          address: portalAddr,
          topics: [DEPOSIT_TOPIC, paddedAddr],
          fromBlock: from,
          toBlock: end,
        });
        if (chunk.length > 0) {
          logs = logs.concat(chunk);
          log('  Found ' + chunk.length + ' event(s) in blocks ' + from + '-' + end, 'info');
          foundAny = true;
          chunksSinceFind = 0;
        } else if (foundAny) {
          chunksSinceFind++;
          if (chunksSinceFind >= EXTRA_AFTER_FIND) {
            log('  No more deposits in recent history. Stopping scan.', 'info');
            break;
          }
        }
      } catch (e) {
        log('  Range ' + from + '-' + end + ' failed: ' + (e.message || e).substring(0, 80), 'warn');
      }
    }
    log('  Scanned ' + scanned + ' chunk(s), total ' + logs.length + ' deposit event(s).', 'info');
    if (logs.length === 0) return [];

    const deposits = [];
    for (const logEntry of logs) {
      const data = logEntry.data;
      const amount = BigInt('0x' + data.slice(2, 66));
      const secretHash = '0x' + data.slice(66, 130);
      const key = '0x' + data.slice(130, 194);
      const index = BigInt('0x' + data.slice(194, 258));
      const txHash = logEntry.transactionHash;
      const txData = await provider.getTransaction(txHash);
      const nonce = txData ? txData.nonce : 0;
      deposits.push({ amount, secretHash, key, index, txHash, nonce });
    }
    deposits.sort((a, b) => Number(a.index - b.index));
    return deposits;
  }

  // Compute the L2->L1 message leaf hash for a withdrawal.
  // Matches Noir's compute_l2_to_l1_message_hash and the app's computeWithdrawMessageLeaf.
  //   content = sha256ToField([depositor.toBuffer32(), amount.toBuffer()])
  //   leaf = sha256ToField([sender.toBuffer(32), version.toBuffer(32), recipient.toBuffer(20), chainId.toBuffer(32), content.toBuffer(32)])
  function computeWithdrawMessageLeaf(a, ethers, l2Addr, portalAddr, l1Account, amount, version, chainId) {
    const sender = l2Addr; // AztecAddress
    const recipient = a.EthAddress.fromString(portalAddr);
    const depositor = a.EthAddress.fromString(l1Account);
    const amountFr = new a.Fr(amount);
    const content = a.sha256ToField([depositor.toBuffer32(), amountFr.toBuffer()]);
    const versionFr = new a.Fr(BigInt(version));
    const chainIdFr = new a.Fr(BigInt(chainId));
    return a.sha256ToField([
      sender.toBuffer(),     // 32 bytes
      versionFr.toBuffer(),  // 32 bytes
      recipient.toBuffer(),  // 20 bytes
      chainIdFr.toBuffer(),  // 32 bytes
      content.toBuffer(),    // 32 bytes
    ]);
  }

  // Scan L2 blocks for a withdrawal tx matching the message leaf.
  // Returns { txHash, messageIndexInTx } or null.
  async function findWithdrawTxHash(aztecNode, messageLeaf, fromBlock, toBlock, log) {
    const batchSize = 10;
    const targetBigInt = messageLeaf.toBigInt();
    log('  Scanning L2 blocks ' + fromBlock + '-' + toBlock + ' for withdrawal tx...', 'info');
    log('  Looking for message leaf: 0x' + targetBigInt.toString(16), 'info');
    for (let start = fromBlock; start >= toBlock; start -= batchSize) {
      const from = Math.max(start - batchSize + 1, toBlock);
      const count = start - from + 1;
      let blocks;
      try {
        blocks = await aztecNode.getBlocks(BigInt(from), count, { includeTransactions: true });
      } catch (e) {
        log('  Warning: could not fetch blocks ' + from + '-' + start + ': ' + extractErrorMessage(e).substring(0, 60), 'warn');
        continue;
      }
      for (const block of blocks) {
        if (!block || !block.body) continue;
        for (const txEffect of block.body.txEffects) {
          if (!txEffect.l2ToL1Msgs) continue;
          for (let mi = 0; mi < txEffect.l2ToL1Msgs.length; mi++) {
            const msg = txEffect.l2ToL1Msgs[mi];
            const msgBigInt = typeof msg.toBigInt === 'function' ? msg.toBigInt() : (msg.asBigInt || 0n);
            if (msgBigInt === 0n) continue;
            if (msgBigInt === targetBigInt) {
              const txHashStr = txEffect.txHash ? txEffect.txHash.toString() : '?';
              log('  Found matching L2->L1 message in tx ' + txHashStr, 'success');
              return { txHash: txHashStr, messageIndexInTx: mi };
            }
          }
        }
      }
      log('  ...scanned blocks ' + from + '-' + start, 'info');
    }
    return null;
  }

  // ============================================================
  // Aztec Wallet (gas estimation + prove/submit split, with retry)
  // ============================================================
  function createAztecWallet(a, pxe, aztecNode, rawNode, log, secretKey, opts = {}) {
    class AztecWallet extends a.BaseWallet {
      constructor(pxe, aztecNode) {
        super(pxe, aztecNode);
        this._accountManager = null;
        this._account = null;
        this._estimatedGasPadding = 0.1;
        this._secretKey = null;
      }
      async registerContract(instance, artifact, secretKeyOrKeys) {
        return super.registerContract(instance, artifact, secretKeyOrKeys ?? this._secretKey);
      }
      async getAccountFromAddress() {
        if (!this._account) this._account = await this._accountManager.getAccount();
        return this._account;
      }
      getAccounts() {
        return this._accountManager ? Promise.resolve([this._accountManager.address]) : Promise.resolve([]);
      }

      async sendTx(executionPayload, opts) {
        log('  Estimating gas (simulating tx)...', 'info');
        const feeOptions = await this.completeFeeOptions({
          from: opts.from,
          feePayer: executionPayload.feePayer,
          gasSettings: opts.fee?.gasSettings,
          forEstimation: true,
        });

        const simResult = await retry(
          () => this.simulateViaEntrypoint(executionPayload, {
            from: opts.from, feeOptions, skipTxValidation: true, skipFeeEnforcement: true,
            additionalScopes: opts.additionalScopes, sendMessagesAs: opts.sendMessagesAs,
          }),
          'simulation', log, 5
        );

        const gu = simResult.gasUsed;
        const pad = 1 + this._estimatedGasPadding;
        const gasLimits = gu.totalGas.mul(pad);
        const teardownGasLimits = gu.teardownGas.mul(pad);
        const maxFee = gasLimits.computeFee(feeOptions.gasSettings.maxFeesPerGas).toBigInt();

        log('  Estimated gas: L2=' + gasLimits.l2Gas.toLocaleString() + ' DA=' + gasLimits.daGas.toLocaleString(), 'info');
        log('  Max fee: ' + maxFee.toLocaleString() + ' Fee Juice (' + toAztec(maxFee, 4) + ' AZTEC)', 'info');

        if (this._preProveHook) {
          await this._preProveHook({ gasLimits, maxFee, feeOptions, teardownGasLimits });
        }

        const finalGasSettings = a.GasSettings.from({
          gasLimits: opts.fee?.gasSettings?.gasLimits ?? gasLimits,
          teardownGasLimits: opts.fee?.gasSettings?.teardownGasLimits ?? teardownGasLimits,
          maxFeesPerGas: feeOptions.gasSettings.maxFeesPerGas,
          maxPriorityFeesPerGas: feeOptions.gasSettings.maxPriorityFeesPerGas,
        });

        log('  Proving tx (can take minutes)...', 'info');

        const feeOpts2 = await this.completeFeeOptions({
          from: opts.from, feePayer: executionPayload.feePayer, gasSettings: finalGasSettings,
        });
        const txRequest = await this.createTxExecutionRequestFromPayloadAndFee(executionPayload, opts.from, feeOpts2);
        const provenTx = await this.pxe.proveTx(txRequest, {
          scopes: this.scopesFrom(opts.from, opts.additionalScopes),
          senderForTags: this.senderForTagsFrom(opts.from, opts.sendMessagesAs),
        });
        const tx = await provenTx.toTx();
        const txHash = tx.getTxHash();
        log('  Proving complete. Submitting to node...', 'success');

        const ALREADY_EXISTS_RE = /existing nullifier|already exists|duplicate.*tx|tx.*duplicate/i;
        let submitted = false;
        const submitRetry = async (fn, maxRetries = 20) => {
          for (let i = 1; i <= maxRetries; i++) {
            try { await fn(); submitted = true; return; }
            catch (err) {
              const msg = err.message || '';
              if (ALREADY_EXISTS_RE.test(msg)) {
                log('  Tx may have already been submitted (got: ' + msg + '). Checking receipt...', 'warn');
                return;
              }
              const isTransient = TRANSIENT_RE.test(msg);
              if (!isTransient || i === maxRetries) throw err;
              const delay = Math.min(5000 * i, 30000);
              log('  Node busy (attempt ' + i + '/' + maxRetries + '), retrying in ' + (delay/1000) + 's...', 'warn');
              await sleep(delay);
            }
          }
        };

        await submitRetry(() => rawNode.sendTx(tx));
        if (submitted) log('  Tx submitted! Hash: ' + txHash.toString(), 'success');

        const waitOpts = typeof opts.wait === 'object' ? opts.wait : undefined;
        const timeout = waitOpts?.timeout ?? 600;
        const interval = waitOpts?.interval ?? 5;
        const deadline = Date.now() + timeout * 1000;
        let receipt = null;
        let pollCount = 0;
        while (Date.now() < deadline) {
          try {
            const r = await rawNode.getTxReceipt(txHash);
            if (r && !r.isPending()) { receipt = r; break; }
          } catch (err) {
            if (!TRANSIENT_RE.test(err.message || '')) throw err;
          }
          pollCount++;
          if (pollCount % 4 === 0) {
            const elapsed = Math.round((Date.now() - (deadline - timeout * 1000)) / 1000);
            log('  Waiting for confirmation... (' + elapsed + 's elapsed)', 'info');
          }
          await sleep(interval * 1000);
        }
        if (!receipt) throw new Error('Tx ' + txHash.toString() + ' not confirmed within ' + timeout + 's');
        log('  Tx confirmed! Block: ' + receipt.blockNumber + ', Status: ' + receipt.status, 'success');
        return { receipt };
      }
    }

    const wallet = new AztecWallet(pxe, aztecNode);
    wallet._preProveHook = opts.preProveHook || null;
    wallet._secretKey = secretKey;
    return wallet;
  }

  // ============================================================
  // CREATE2 portal address computation
  // ============================================================
  function portalCreationBytecode(ethers, portalBytecode, rollup, l2AddrHex, version, minDeposit) {
    const iface = new ethers.Interface(PORTAL_ABI);
    const encodedArgs = iface.encodeDeploy([rollup, l2AddrHex, BigInt(version), BigInt(minDeposit)]);
    return ethers.concat([portalBytecode, encodedArgs]);
  }

  function computePortalAddress(ethers, portalBytecode, l2AddrHex, rollup, version, minDeposit) {
    const creation = portalCreationBytecode(ethers, portalBytecode, rollup, l2AddrHex, version, minDeposit);
    const salt = ethers.getBytes(l2AddrHex);
    const initCodeHash = ethers.keccak256(creation);
    return ethers.getCreate2Address(CREATE2_PROXY, salt, initCodeHash);
  }

  // ============================================================
  // Value extraction from simulation results
  // ============================================================
  function extractInt(simResult) {
    let val = simResult;
    if (simResult && simResult.result !== undefined) val = simResult.result;
    else if (simResult && simResult.value !== undefined) val = simResult.value;
    if (val && val.toString) val = val.toString();
    return Number(BigInt(val));
  }

  function extractFieldArray(simResult) {
    let val = simResult;
    if (simResult && simResult.result !== undefined) val = simResult.result;
    else if (simResult && simResult.value !== undefined) val = simResult.value;
    if (!Array.isArray(val)) return [];
    return val.map(v => {
      if (v && v.toString) return BigInt(v.toString());
      return BigInt(v);
    });
  }

  function extractDepositInfo(simResult) {
    let val = simResult;
    if (simResult && simResult.result !== undefined) val = simResult.result;
    else if (simResult && simResult.value !== undefined) val = simResult.value;
    if (!Array.isArray(val)) return { amount: 0n, nextAllowedTime: 0n, l1Depositor: '0x0', postChainHead: 0n, lastScreenedLink: 0n, lastScreenedIndex: 0n, lastRealPostIndex: 0n };
    // New format: [amount, l1_depositor, post_chain_head, last_screened_link,
    //             last_screened_index, last_real_post_index, next_allowed_time]
    const amount = BigInt(val[0]?.toString?.() ?? val[0]);
    let depositor = val[1];
    if (depositor && depositor.inner !== undefined) depositor = depositor.inner;
    if (depositor && depositor.toString) depositor = depositor.toString();
    const l1Depositor = '0x' + BigInt(depositor).toString(16).padStart(40, '0');
    const postChainHead = val[2] !== undefined ? BigInt(val[2]?.toString?.() ?? val[2]) : 0n;
    const lastScreenedLink = val[3] !== undefined ? BigInt(val[3]?.toString?.() ?? val[3]) : 0n;
    const lastScreenedIndex = val[4] !== undefined ? BigInt(val[4]?.toString?.() ?? val[4]) : 0n;
    const lastRealPostIndex = val[5] !== undefined ? BigInt(val[5]?.toString?.() ?? val[5]) : 0n;
    const nextAllowedTime = val[6] !== undefined ? BigInt(val[6]?.toString?.() ?? val[6]) : 0n;
    return { amount, nextAllowedTime, l1Depositor, postChainHead, lastScreenedLink, lastScreenedIndex, lastRealPostIndex };
  }

  // ============================================================
  // Setup cache — avoids re-doing expensive CRS/PXE/sync on
  // repeated calls with the same config (used by web app pages)
  // ============================================================
  const _setupCache = new Map();
  function _setupKey(config) {
    return (config.aztecNodeUrl || '') + '|' +
           (config.aztecWallet?.secretKey || '') + '|' +
           (config.portalAddress || config.contractSalt || 0);
  }

  // ============================================================
  // Main entry point
  // ============================================================
  g.runBillboardUser = async function(env, config) {
    const { aztec: a, ethers, log, initCRS, createStore, portalBytecode, artifact } = env;

    let aztecWallet = config.aztecWallet;
    if (!aztecWallet || !aztecWallet.secretKey) {
      throw new Error('Aztec wallet with secretKey is required.');
    }

    const saltVal = typeof aztecWallet.salt === 'string' ? parseInt(aztecWallet.salt, 16) : (aztecWallet.salt || 0);
    const contractSalt = config.contractSalt || 1;
    const secretKeyHex = aztecWallet.secretKey;
    const action = config.action || 'status';

    // ============================================================
    // Step 1: Derive account keys
    // ============================================================
    log('Step 1: Deriving account keys...', 'info');
    const secretKey = a.Fr.fromHexString(secretKeyHex);
    const signingKey = a.deriveSigningKey(secretKey);
    const accountContract = new a.SchnorrInitializerlessAccountContract(signingKey);
    const { publicKeys } = await a.deriveKeys(secretKey);
    const accountArtifact = await accountContract.getContractArtifact();
    const immutablesHash = await accountContract.getImmutablesHash();
    const instance = await a.getContractInstanceFromInstantiationParams(accountArtifact, {
      constructorArtifact: undefined, constructorArgs: undefined,
      salt: new a.Fr(saltVal), publicKeys, immutablesHash,
    });
    const partialAddress = await a.computePartialAddress(instance);
    const address = instance.address;
    log('  Address: ' + address.toString(), 'success');

    // ============================================================
    // Step 2: Connect to Aztec node
    // ============================================================
    log('Step 2: Connecting to Aztec node...', 'info');
    const nodeUrl = config.aztecNodeUrl;
    const rawNode = a.createAztecNodeClient(nodeUrl);
    const aztecNode = wrapWithRetry(rawNode, 'node', log);
    const nodeInfo = await aztecNode.getNodeInfo();
    log('  Chain ID: ' + nodeInfo.l1ChainId, 'info');
    log('  Rollup version: ' + nodeInfo.rollupVersion, 'info');

    const l1Contracts = await aztecNode.getL1ContractAddresses();
    const rollupAddr = l1Contracts.rollupAddress.toString();
    const version = nodeInfo.rollupVersion;
    log('  L1 Rollup: ' + rollupAddr, 'info');

    try {
      const blockNum = await aztecNode.getBlockNumber();
      log('  Current L2 block: ' + blockNum, 'info');
    } catch (e) { /* non-critical */ }

    // Check fee juice balance
    log('Checking Fee Juice balance...', 'info');
    let feeJuiceBalance = 0n;
    try {
      const slot = await a.deriveStorageSlotInMap(new a.Fr(1), address);
      const value = await aztecNode.getPublicStorageAt('latest', a.FeeJuiceAddress, slot);
      feeJuiceBalance = value ? BigInt(value.toString()) : 0n;
      log('  Fee Juice balance: ' + toAztec(feeJuiceBalance, 6) + ' AZTEC', feeJuiceBalance > 0n ? 'success' : 'warn');
    } catch (e) {
      log('  Could not check balance: ' + extractErrorMessage(e), 'warn');
    }

    // ============================================================
    // Step 3: Compute L2 + portal addresses
    // ============================================================
    log('Step 3: Computing contract addresses...', 'info');
    const contractArtifact = a.loadContractArtifact(artifact);
    // Use universalDeploy + fixed public keys (derived from zero secret key)
    // so the contract address is deterministic — depends only on salt + artifact,
    // not on the deployer's wallet. Aztec CREATE2 equivalent.
    const universalPublicKeys = (await a.deriveKeys(a.Fr.ZERO)).publicKeys;
    // Constructor args must match what deploy used — min_deposit, base_cooldown, censor, k
    // affect the initialization hash and thus the contract address.
    const minDepositWei = config.minDepositWei || ethers.parseEther('0.001');
    const baseCooldown = config.baseCooldown || 3600;
    const censorAddr = config.censor ? a.AztecAddress.fromFieldUnsafe(a.Fr.fromHexString(config.censor)) : a.AztecAddress.zero();
    const kMultiplier = config.kMultiplier || 64;
    // Pack moderation policy into Fields (must match deploy-time args for address computation)
    const policyText = config.moderationPolicy !== undefined ? config.moderationPolicy : (g.DEFAULT_MODERATION_POLICY || '');
    const packFn = g.packStringToFields;
    if (!packFn) throw new Error('packStringToFields not available (load moderation-policy.js)');
    const { fields: policyFields, len: policyLen } = packFn(policyText);
    const initArgs = [
      new a.Fr(BigInt(minDepositWei)),
      new a.Fr(BigInt(baseCooldown)),
      censorAddr.toField(),
      new a.Fr(BigInt(kMultiplier)),
      new a.Fr(BigInt(config.censorWindow || 3600)),
      new a.Fr(BigInt(config.maxSaveUp || 16)),
      policyFields.map(f => new a.Fr(f)),
      new a.Fr(BigInt(policyLen)),
    ];
    const deployMethod = a.Contract.deploy(/*wallet*/ null, contractArtifact, initArgs, undefined, {
      salt: new a.Fr(contractSalt),
      publicKeys: universalPublicKeys,
      universalDeploy: true,
    });
    // getAddress() doesn't need the wallet
    let l2Addr, l2AddrHex;
    if (config.portalAddress) {
      // Derive L2 address from the portal's L2_CONTRACT() read on L1
      log('  Deriving L2 address from portal ' + config.portalAddress + '...', 'info');
      const _provider = new ethers.JsonRpcProvider(config.ethRpcUrl);
      const _portal = new ethers.Contract(config.portalAddress, PORTAL_ABI, _provider);
      const _code = await _provider.getCode(config.portalAddress);
      if (_code === '0x') throw new Error('No contract deployed at portal address ' + config.portalAddress);
      const _l2Bytes = await _portal.L2_CONTRACT();
      l2AddrHex = '0x' + _l2Bytes.slice(2).toLowerCase().padStart(64, '0');
      l2Addr = a.AztecAddress.fromFieldUnsafe(a.Fr.fromHexString(l2AddrHex));
      log('  L2 billboard: ' + l2AddrHex + ' (from portal)', 'success');
    } else {
      l2Addr = await deployMethod.getAddress();
      l2AddrHex = l2Addr.toString();
      log('  L2 billboard: ' + l2AddrHex, 'info');
    }

    const portalAddr = config.portalAddress
      ? config.portalAddress
      : computePortalAddress(ethers, portalBytecode, l2AddrHex, rollupAddr, version, config.minDepositWei || ethers.parseEther('0.001'));
    log('  L1 portal:    ' + portalAddr, 'info');

    // Check if L2 contract is deployed
    let l2Deployed = false;
    let existingInstance = null;
    try { existingInstance = await aztecNode.getContract(l2Addr); } catch (e) { /* not deployed */ }
    if (existingInstance) {
      l2Deployed = true;
      log('  Billboard contract IS deployed on L2.', 'success');
    } else {
      log('  WARNING: Billboard contract NOT deployed on L2 at this address.', 'warn');
      log('  The contract must be deployed first (use the deploy CLI or aztec-wallet).', 'warn');
    }

    // Check portal on L1
    let ethSigner = null, l1Account = null, provider = null;
    let portalL1Balance = 0n; // deposits[l1Account]
    let portalDeployed = false;
    try {
      if (config.ethWallet && config.ethWallet.privateKey) {
        provider = new ethers.JsonRpcProvider(config.ethRpcUrl);
        ethSigner = new ethers.Wallet(config.ethWallet.privateKey, provider);
        l1Account = ethSigner.address;
      } else if (env.getBrowserSigner) {
        ethSigner = await env.getBrowserSigner();
        l1Account = ethSigner.address;
        provider = ethSigner.provider;
      } else {
        throw new Error('No ETH wallet.');
      }
      log('  L1 account:  ' + l1Account, 'info');
      const code = await provider.getCode(portalAddr);
      portalDeployed = code !== '0x';
      if (portalDeployed) {
        const portal = new ethers.Contract(portalAddr, PORTAL_ABI, provider);
        try {
          const l2Contract = await portal.L2_CONTRACT();
          const onchainHex = '0x' + l2Contract.slice(2).toLowerCase().padStart(64, '0');
          const expectedHex = l2AddrHex.toLowerCase().replace(/^0x/, '').padStart(64, '0');
          if (onchainHex !== '0x' + expectedHex) {
            log('  WARNING: Portal L2_CONTRACT mismatch!', 'warn');
            log('  Portal says: ' + onchainHex, 'warn');
            log('  Expected:    ' + ('0x' + expectedHex), 'warn');
            portalDeployed = false;
          } else {
            log('  Portal verified on L1.', 'success');
          }
        } catch (e) {
          log('  Warning: could not read L2_CONTRACT from portal: ' + extractErrorMessage(e), 'warn');
        }
        try { portalL1Balance = await portal.deposits(l1Account); } catch (e) {}
      } else {
        log('  WARNING: Portal not deployed at ' + portalAddr, 'warn');
      }
    } catch (e) {
      log('  Could not get L1 signer: ' + extractErrorMessage(e), 'warn');
    }

    // ============================================================
    // Determine current state (auto-resolve)
    // ============================================================
    // Three possible states:
    //   "postable"                         -- have a deposit note on L2, can post/withdraw
    //   "withdrawn_l2_claimable_l1"        -- no note on L2, but portal has balance + withdrawal msg exists
    //   "zero_balance_need_deposit"        -- no note, no portal balance (or portal balance but not claimed yet)
    //
    // For "zero_balance_need_deposit" with portalL1Balance > 0, the deposit was made on L1
    // but not yet claimed on L2 -- the user should run 'claim'.

    let stateStatus = 'unknown';
    let l2NoteInfo = null;

    // We can check the L2 note only if the contract is deployed AND we set up PXE.
    // For 'status' we do a lightweight check (no PXE) if possible, but get_deposit_info
    // requires the PXE. So we'll set up PXE for all actions that need it.
    // For 'status' we'll do a best-effort without PXE first.

    // Determine state from L1 info alone (no PXE needed):
    //   portalL1Balance > 0  -> deposit exists on L1 (either not claimed, or withdrawn but not yet claimed on L1)
    //   portalL1Balance == 0 -> no active L1 deposit (either never deposited, or already claimed on L1)

    if (portalL1Balance > 0n) {
      log('  L1 portal deposit balance: ' + toEtherStr(portalL1Balance) + ' ETH', 'info');
    } else {
      log('  L1 portal deposit balance: 0 ETH', 'info');
    }

    // ============================================================
    // Decide if we need full PXE setup
    // ============================================================
    const needsPXE = ['status', 'claim', 'post', 'list', 'withdraw', 'declare-immoral', 'transfer-censor', 'auto'].includes(action);
    const needsCRS = needsPXE;

    let pxe = null, wallet = null, contract = null;

    if (needsPXE) {
      if (!l2Deployed) {
        throw new Error('Billboard contract not deployed on L2 at ' + l2AddrHex + '. Deploy it first (use the deploy CLI or aztec-wallet).');
      }
      if (feeJuiceBalance === 0n && (action === 'claim' || action === 'post' || action === 'withdraw' || action === 'auto')) {
        log('  WARNING: No Fee Juice! You need some to pay for L2 tx fees.', 'warn');
        log('  Run the fee-juice CLI first to fund your account.', 'warn');
      }

      // Check setup cache
      const sKey = _setupKey(config);
      const cached = _setupCache.get(sKey);
      if (cached) {
        log('  Reusing cached PXE/wallet setup.', 'success');
        pxe = cached.pxe;
        wallet = cached.wallet;
        contract = cached.contract;
        // Re-sync to pick up latest state
        try { await pxe.sync(); } catch (e) {}
      } else {
        // ============================================================
        // Step 4: Initialize CRS
        // ============================================================
        log('Step 4: Initializing CRS...', 'info');
        await initCRS();
        log('  CRS ready.', 'success');

        // ============================================================
        // Step 5: Create PXE
        // ============================================================
        log('Step 5: Creating PXE...', 'info');
        const dataDirPrefix = (config.dataDirPrefix || 'pxe_bb_') + address.toString().slice(0, 16) + '_';
        const storeConfig = { ...l1Contracts, l1ChainId: nodeInfo.l1ChainId, dataDirectory: dataDirPrefix + l1Contracts.rollupAddress };
        const store = await createStore(storeConfig);
        pxe = await a.createPXE(aztecNode, {
          proverEnabled: true, autoSync: true,
          dataDirectory: dataDirPrefix + l1Contracts.rollupAddress,
        }, { store });
        log('  PXE created.', 'success');

        // ============================================================
        // Step 6: Register account + sync
        // ============================================================
        log('Step 6: Registering account with PXE...', 'info');
        const derivedKeys = await a.deriveKeys(secretKey);
        await pxe.registerAccount(derivedKeys, partialAddress);
        log('  Account registered.', 'success');

        log('  Registering Schnorr initializerless account contract...', 'info');
        await retry(() => pxe.registerContractClass(a.SchnorrInitializerlessAccountContractArtifact), 'register', log, 5);
        await retry(() => pxe.registerContract(instance), 'register', log, 5);
        log('  Contract registered.', 'success');

        log('  Registering billboard contract with PXE...', 'info');
        await retry(() => pxe.registerContractClass(contractArtifact), 'register-bb', log, 5);
        await retry(() => pxe.registerContract(existingInstance), 'register-bb', log, 5);
        log('  Billboard contract registered.', 'success');

        log('  Syncing PXE with node...', 'info');
        await pxe.sync();
        log('  PXE synced.', 'success');

        // ============================================================
        // Step 7: Create wallet
        // ============================================================
        log('Step 7: Creating wallet...', 'info');
        wallet = createAztecWallet(a, pxe, aztecNode, rawNode, log, secretKey, { preProveHook: config.preProveHook });
        const accountManager = await a.AccountManager.create(wallet, secretKey, accountContract, { salt: new a.Fr(saltVal) });
        wallet._accountManager = accountManager;
        log('  Wallet ready.', 'success');

        // Re-create the deploy method with the real wallet (for getInstance if needed)
        // and create the contract handle.
        contract = await a.Contract.at(l2Addr, contractArtifact, wallet);

        // Store signing key capsule
        log('  Storing signing key capsule...', 'info');
        const signingPublicKey = await accountContract.getSigningPublicKey();
        const constructorArtifact = accountArtifact.functions.find(f => f.name === 'constructor');
        if (constructorArtifact) {
          const storeCall = new a.ContractFunctionInteraction(
            wallet, instance.address, constructorArtifact,
            [signingPublicKey.x, signingPublicKey.y]
          );
          await storeCall.simulate({ from: instance.address });
          log('  Capsule stored.', 'success');
        }

        // Cache the setup for reuse by subsequent engine calls
        _setupCache.set(sKey, { pxe, wallet, contract, aztecNode, rawNode });
      }

      // Now check the L2 deposit note (always re-check, state may have changed)
      log('  Checking L2 deposit note...', 'info');
      try {
        const r = await contract.methods.get_deposit_info(address).simulate({ from: address });
        l2NoteInfo = extractDepositInfo(r);
        if (l2NoteInfo.amount > 0n) {
          log('  L2 deposit note found: amount=' + l2NoteInfo.amount.toString() + ' wei, nextAllowedTime=' + l2NoteInfo.nextAllowedTime.toString(), 'success');
        } else {
          log('  No L2 deposit note found.', 'info');
        }
      } catch (e) {
        log('  Could not check L2 note: ' + extractErrorMessage(e), 'warn');
      }
    }

    // ============================================================
    // Resolve state
    // ============================================================
    if (l2NoteInfo && l2NoteInfo.amount > 0n) {
      stateStatus = 'postable';
    } else if (portalL1Balance > 0n) {
      // Could be: deposit made but not claimed, OR withdrawn on L2 but not claimed on L1.
      // Check for a withdrawal L2->L1 message to distinguish.
      if (needsPXE && l2Deployed) {
        try {
          const messageLeaf = computeWithdrawMessageLeaf(a, ethers, l2Addr, portalAddr, l1Account, portalL1Balance, version, nodeInfo.l1ChainId);
          const latestBlock = await aztecNode.getBlockNumber();
          const found = await findWithdrawTxHash(aztecNode, messageLeaf, latestBlock, Math.max(0, latestBlock - 500), log);
          if (found) {
            stateStatus = 'withdrawn_l2_claimable_l1';
            log('  Withdrawal tx found: ' + found.txHash, 'success');
          } else {
            stateStatus = 'deposited_l1_not_claimed_l2';
          }
        } catch (e) {
          stateStatus = 'deposited_l1_not_claimed_l2';
        }
      } else {
        stateStatus = 'deposited_l1_not_claimed_l2';
      }
    } else {
      stateStatus = 'zero_balance_need_deposit';
    }

    log('', 'info');
    log('========================================', 'info');
    log('  STATE: ' + stateStatus, 'success');
    log('========================================', 'info');
    log('  L2 address:  ' + l2AddrHex, 'info');
    log('  L1 portal:   ' + portalAddr, 'info');
    if (l1Account) log('  L1 account:  ' + l1Account, 'info');
    log('  Fee Juice:   ' + toAztec(feeJuiceBalance, 6) + ' AZTEC', 'info');
    if (l2NoteInfo && l2NoteInfo.amount > 0n) {
      log('  L2 note:     ' + l2NoteInfo.amount.toString() + ' wei (' + toEtherStr(l2NoteInfo.amount) + ' ETH)', 'info');

      // Show posts-available info (point 3: CLI shows how many posts you can make and when)
      try {
        let baseCooldown = 3600n;
        let minDepositL2 = ethers.parseEther('0.001');
        let maxSaveUp = 16;
        if (contract) {
          const cdR = await contract.methods.get_base_cooldown().simulate({ from: address });
          baseCooldown = BigInt(extractInt(cdR));
          const mdR = await contract.methods.get_min_deposit().simulate({ from: address });
          minDepositL2 = BigInt(extractInt(mdR));
          const msuR = await contract.methods.get_max_save_up().simulate({ from: address });
          maxSaveUp = Number(extractInt(msuR));
        }
        const userCd = Number((baseCooldown * minDepositL2) / l2NoteInfo.amount);
        const l2Now = await getL2Timestamp(a, aztecNode);
        const nextAllowed = Number(l2NoteInfo.nextAllowedTime);
        const remaining = nextAllowed - l2Now;
        if (remaining <= 0) {
          const postsAvail = Math.min(Math.floor(-remaining / userCd) + 1, maxSaveUp);
          log('  Posts available: ' + postsAvail + ' (capped at max_save_up=' + maxSaveUp + ')', 'success');
          log('  Cooldown: ' + userCd + 's per post', 'info');
        } else {
          const mm = Math.floor(remaining / 60);
          const ss = remaining % 60;
          log('  Posts available: 0 — next post in ' + mm + ':' + String(ss).padStart(2, '0'), 'info');
          log('  Cooldown: ' + userCd + 's per post (max_save_up=' + maxSaveUp + ')', 'info');
        }
        // Show screening status
        const lastScreened = Number(l2NoteInfo.lastScreenedIndex);
        const lastReal = Number(l2NoteInfo.lastRealPostIndex);
        const NO_IDX = 0xFFFFFFFF;
        if (lastReal !== NO_IDX) {
          if (lastScreened >= lastReal) {
            log('  Screening: all posts screened (eligible to withdraw)', 'success');
          } else {
            const unscreened = lastReal - lastScreened;
            log('  Screening: ' + unscreened + ' real post' + (unscreened > 1 ? 's' : '') + ' unscreened — make dummy posts before withdrawal', 'warn');
          }
        }
      } catch (e) {
        log('  (Could not fetch posts-available info: ' + extractErrorMessage(e).substring(0, 80) + ')', 'warn');
      }
    }
    log('  L1 deposit:  ' + toEtherStr(portalL1Balance) + ' ETH', 'info');
    log('', 'info');

    // ============================================================
    // Handle 'status' action (just print and return)
    // ============================================================
    if (action === 'status') {
      return { ok: true, state: stateStatus, l2Addr: l2AddrHex, portalAddr, l1Account, feeJuiceBalance: feeJuiceBalance.toString(), portalL1Balance: portalL1Balance.toString(), l2Note: l2NoteInfo, handles: { pxe, wallet, contract, aztecNode, rawNode, address, l2Addr, contractSalt, version, nodeInfo } };
    }

    // ============================================================
    // DEPOSIT action
    // ============================================================
    // depositInfo to be populated: { amount, leafIndex, secret, txHash, nonce }
    let depositInfo = null;

    async function doDeposit() {
      if (!ethSigner) throw new Error('L1 signer required for deposit.');
      if (!portalDeployed) throw new Error('Portal not deployed at ' + portalAddr + '. Check your contract salt.');

      // Check for existing active L2 deposit note (contract bans re-deposit)
      // Note: L1 portal balance may be non-zero from a previous withdrawn-but-not-yet-claimed deposit
      if (l2NoteInfo && l2NoteInfo.amount > 0n) {
        log('  You already have an active L2 deposit: ' + toEtherStr(l2NoteInfo.amount) + ' ETH', 'warn');
        log('  Withdraw your existing deposit first, then re-deposit.', 'warn');
        throw new Error('Already have an active deposit. Withdraw first.');
      }

      const amountStr = config.depositAmount;
      if (!amountStr) throw new Error('Deposit amount required (use --amount <eth>).');
      const amountWei = ethers.parseEther(amountStr);

      const portal = new ethers.Contract(portalAddr, PORTAL_ABI, ethSigner);

      // Read min deposit from the portal (deployer-configured)
      let minDepositWei = ethers.parseEther('0.001');
      try {
        minDepositWei = await portal.MIN_DEPOSIT();
      } catch (e) {}
      if (amountWei < minDepositWei) throw new Error('Amount below minimum (' + ethers.formatEther(minDepositWei) + ' ETH).');

      // Read base cooldown from the L2 contract (deployer-configured)
      let baseCooldown = 3600n;
      let minDepositL2 = ethers.parseEther('0.001');
      try {
        if (contract) {
          const cdResult = await contract.methods.get_base_cooldown().simulate({ from: address });
          baseCooldown = BigInt(extractInt(cdResult));
          const mdResult = await contract.methods.get_min_deposit().simulate({ from: address });
          minDepositL2 = BigInt(extractInt(mdResult));
        }
      } catch (e) {}

      // Cooldown estimate
      const cooldownSec = (baseCooldown * minDepositL2) / amountWei;
      log('  Estimated cooldown: ' + cooldownSec.toString() + 's between posts', 'info');

      // Generate deterministic claim secret
      log('Generating claim secret...', 'info');
      const nonce = await provider.getTransactionCount(l1Account, 'pending');
      const secretHex = await generateSecret(ethSigner, l1Account, nonce);
      const secret = BigInt(secretHex);
      const secretHash = await a.computeSecretHash(secret);
      const secretHashHex = '0x' + secretHash.toBigInt().toString(16).padStart(64, '0');

      log('  Claim secret: ' + secretHex, 'info');
      log('  Secret hash:  ' + secretHashHex, 'info');
      log('  Nonce:        ' + nonce, 'info');

      const secretHashBytes = ethers.hexlify(secretHash.toBuffer());

      log('Sending deposit tx (' + amountStr + ' ETH)...', 'info');
      const tx = await withUserRetry(() => portal.deposit(secretHashBytes, { value: amountWei, nonce }), 'L1 deposit tx');
      log('  Tx sent: ' + tx.hash, 'info');
      log('  Waiting for confirmation...', 'info');
      const rc = await tx.wait();
      if (rc.status !== 1) throw new Error('Deposit tx reverted in block ' + rc.blockNumber);
      log('  Confirmed in block ' + rc.blockNumber + '.', 'success');

      // Extract deposit info from event
      const iface = portal.interface;
      for (const ev of rc.logs) {
        try {
          const parsed = iface.parseLog(ev);
          if (parsed && parsed.name === 'Deposited') {
            depositInfo = {
              amount: parsed.args.amount,
              leafIndex: parsed.args.index,
              secret: secretHex,
              txHash: tx.hash,
              nonce,
            };
            log('  Amount:     ' + toEtherStr(parsed.args.amount) + ' ETH', 'info');
            log('  Leaf index: ' + parsed.args.index.toString(), 'info');
            break;
          }
        } catch (e) { /* not our event */ }
      }
      if (!depositInfo) throw new Error('Could not parse deposit event.');

      log('Deposit complete!', 'success');
      log('  Wait ~5-10 min for L2 to ingest the L1 deposit before claiming.', 'info');
    }

    async function doReuseDeposit() {
      if (!ethSigner) throw new Error('L1 signer required for deposit recovery.');
      if (!portalDeployed) throw new Error('Portal not deployed at ' + portalAddr + '.');

      // If a specific tx hash was provided, use it
      if (config.reuseTxHash) {
        log('Recovering deposit from tx hash ' + config.reuseTxHash.substring(0, 20) + '...', 'info');
        const txData = await provider.getTransaction(config.reuseTxHash);
        if (!txData) throw new Error('Tx not found.');
        if (txData.from.toLowerCase() !== l1Account.toLowerCase()) {
          throw new Error('This tx was sent from a different account (' + txData.from + ').');
        }
        if (txData.to && txData.to.toLowerCase() !== portalAddr.toLowerCase()) {
          throw new Error('Deposit was sent to a different portal (' + txData.to + '). Check your contract salt.');
        }
        const nonce = txData.nonce;
        const receipt = await provider.getTransactionReceipt(config.reuseTxHash);
        if (!receipt) throw new Error('No receipt found.');
        if (receipt.status !== 1) throw new Error('The L1 tx reverted.');

        let amount = null, secretHash = null, index = null;
        for (const logEntry of receipt.logs) {
          if (logEntry.address.toLowerCase() === portalAddr.toLowerCase() &&
              logEntry.topics[0] === DEPOSIT_TOPIC) {
            const data = logEntry.data;
            amount = BigInt('0x' + data.slice(2, 66));
            secretHash = '0x' + data.slice(66, 130);
            index = BigInt('0x' + data.slice(194, 258));
            break;
          }
        }
        if (amount === null) throw new Error('No Deposited event found in this tx.');

        log('  Amount:     ' + toEtherStr(amount) + ' ETH', 'info');
        log('  Leaf index: ' + index.toString(), 'info');
        log('  Nonce:      ' + nonce, 'info');

        const secretHex = await generateSecret(ethSigner, l1Account, nonce);
        const computedHash = '0x' + (await a.computeSecretHash(BigInt(secretHex))).toBigInt().toString(16).padStart(64, '0');
        if (computedHash.toLowerCase() !== secretHash.toLowerCase()) {
          log('  WARNING: Secret hash mismatch!', 'warn');
          log('  Computed:  ' + computedHash, 'warn');
          log('  On-chain:  ' + secretHash, 'warn');
        } else {
          log('  Secret hash matches!', 'success');
        }
        depositInfo = { amount, leafIndex: index, secret: secretHex, txHash: config.reuseTxHash, nonce };
        return;
      }

      // Otherwise, scan L1 logs for the latest deposit
      log('Scanning L1 for existing deposits...', 'info');
      const deposits = await findAllDeposits(ethers, provider, portalAddr, l1Account, log);
      if (deposits.length === 0) {
        throw new Error('No deposits found for ' + l1Account + ' on portal ' + portalAddr + '. Make a new deposit with --amount.');
      }

      // Greedily pick the latest deposit (highest leaf index) that hasn't been consumed.
      // We check from newest to oldest. A deposit is "consumed" if the L1->L2 message
      // nullifier has been spent (i.e., already claimed on L2). We can check this by
      // simulating claim_deposit -- but that requires PXE. Since we're in the deposit
      // step (before PXE), we'll just pick the latest and let the claim step handle
      // the "already claimed" case.
      const latest = deposits[deposits.length - 1];
      log('  Using latest deposit: leaf ' + latest.index + ', amount ' + toEtherStr(latest.amount) + ' ETH', 'info');

      const secretHex = await generateSecret(ethSigner, l1Account, latest.nonce);
      const computedHash = '0x' + (await a.computeSecretHash(BigInt(secretHex))).toBigInt().toString(16).padStart(64, '0');
      if (computedHash.toLowerCase() !== latest.secretHash.toLowerCase()) {
        log('  WARNING: Secret hash mismatch for nonce ' + latest.nonce + '!', 'warn');
      } else {
        log('  Secret hash matches!', 'success');
      }
      depositInfo = { amount: latest.amount, leafIndex: latest.index, secret: secretHex, txHash: latest.txHash, nonce: latest.nonce };
    }

    // ============================================================
    // CLAIM action (claim deposit on L2)
    // ============================================================
    async function doClaim() {
      if (!contract) throw new Error('PXE setup required for claim.');
      if (!ethSigner) throw new Error('L1 signer required for claim.');

      // If we don't have depositInfo yet, try to reuse an existing deposit
      if (!depositInfo) {
        log('No deposit info from this session. Searching L1 for existing deposits...', 'info');
        await doReuseDeposit();
      }

      const depositorField = a.Fr.fromHexString(l1Account);
      const amount = depositInfo.amount;
      const secret = new a.Fr(BigInt(depositInfo.secret) % a.Fr.MODULUS);
      const leafIndex = depositInfo.leafIndex;
      const portalField = a.Fr.fromHexString(portalAddr);

      log('Claiming deposit on L2...', 'info');
      log('  Depositor:    ' + l1Account, 'info');
      log('  Amount:       ' + amount.toString() + ' wei', 'info');
      log('  Leaf index:   ' + leafIndex.toString(), 'info');
      log('  Portal:       ' + portalAddr, 'info');

      // Check if note already exists (fast utility call — no PXE sync needed)
      log('  Checking deposit note status...', 'info');
      await new Promise(r => setTimeout(r, 0)); // yield to UI thread

      let noteInfo = { amount: 0n, nextAllowedTime: 0n, l1Depositor: '0x0' };
      try {
        const r = await contract.methods.get_deposit_info(address).simulate({ from: address });
        noteInfo = extractDepositInfo(r);
      } catch (e) {}

      if (noteInfo.amount > 0n) {
        log('  Deposit note already exists on L2!', 'success');
        log('  Amount: ' + noteInfo.amount.toString() + ' wei', 'info');
        log('  Next allowed time: ' + noteInfo.nextAllowedTime.toString(), 'info');
        log('  No claim needed. You can post or withdraw.', 'success');
        return;
      }

      // No note — send the claim tx directly.
      // Skip pre-flight simulation: it triggers expensive PXE contract sync that can hang for 30+ min.
      // If the L1→L2 message isn't ready, the tx itself will fail and we retry.
      log('  No existing note. Sending claim tx directly...', 'info');
      log('  (If L1→L2 message is not yet ingested, this will retry automatically.)', 'info');

      // Retry loop: send claim tx, retry if it fails (message may not be ingested yet)
      let claimDone = false;
      for (let i = 0; i < 30; i++) {
        try {
          await new Promise(r => setTimeout(r, 0)); // yield to UI thread
          const result = await withUserRetry(() => contract.methods.claim_deposit(
            depositorField, amount, secret, leafIndex, portalField
          ).send({ from: address }), 'Claim deposit tx');
          const receipt = result.receipt;
          log('  TX confirmed! Block: ' + receipt.blockNumber + ', Status: ' + receipt.status, 'success');
          if (receipt.transactionFee !== undefined) {
            log('  Fee paid: ' + toAztec(BigInt(receipt.transactionFee), 6) + ' AZTEC', 'info');
          }
          claimDone = true;

          // Wait for PXE to sync the new note
          log('  Waiting for PXE to sync the deposit note...', 'info');
          for (let j = 0; j < 10; j++) {
            await sleep(5000);
            await new Promise(r => setTimeout(r, 0));
            try {
              const r2 = await contract.methods.get_deposit_info(address).simulate({ from: address });
              const info2 = extractDepositInfo(r2);
              if (info2.amount > 0n) {
                log('  Deposit note synced! Amount: ' + info2.amount.toString() + ' wei', 'success');
                log('  Next allowed time: ' + info2.nextAllowedTime.toString(), 'info');
                break;
              }
            } catch (e) {}
            log('  Still syncing note...', 'info');
          }
          break;
        } catch (e) {
          const errMsg = extractErrorMessage(e).substring(0, 200);
          // Check if note appeared (maybe already claimed by another run)
          try {
            const r = await contract.methods.get_deposit_info(address).simulate({ from: address });
            const info = extractDepositInfo(r);
            if (info.amount > 0n) {
              log('  Deposit note already exists on L2!', 'success');
              log('  No claim needed. You can post or withdraw.', 'success');
              return;
            }
          } catch (e2) {}

          if (i < 29) {
            log('  [' + (i+1) + '/30] Claim failed, retrying in 20s... (' + errMsg.substring(0, 120) + ')', 'warn');
            await sleep(20000);
          } else {
            // Final failure — check if already withdrawn
            log('  Could not claim after 10 min. Checking for a previous withdrawal...', 'info');
            try {
              const messageLeaf = computeWithdrawMessageLeaf(a, ethers, l2Addr, portalAddr, l1Account, amount, version, nodeInfo.l1ChainId);
              const latestBlock = await aztecNode.getBlockNumber();
              const found = await findWithdrawTxHash(aztecNode, messageLeaf, latestBlock, Math.max(0, latestBlock - 1000), log);
              if (found) {
                log('  Withdrawal tx found: ' + found.txHash, 'success');
                log('  The deposit was already claimed and withdrawn.', 'info');
                log('  Run the claim-l1 action to claim your ETH on L1.', 'success');
                return;
              }
            } catch (e3) {}
            throw new Error('Could not claim deposit after 10 min. ' + errMsg);
          }
        }
      }

      if (!claimDone) return; // already returned from a special case
    }

    // ============================================================
    // POST action
    // ============================================================
    async function doPost() {
      if (!contract) throw new Error('PXE setup required for post.');

      const isDummy = !!config.isDummy;
      const msgText = isDummy ? '' : (config.message || '');
      if (!isDummy && !msgText) throw new Error('Message required (use --msg <text>).');

      if (isDummy) {
        log('Making dummy post (advances screening, stores no content)...', 'info');
        // Pre-flight: check note exists + time lock expired
        let infoResult = null;
        for (let i = 0; i < 3; i++) {
          try {
            infoResult = await contract.methods.get_deposit_info(address).simulate({ from: address });
            const { amount } = extractDepositInfo(infoResult);
            if (amount > 0n) break;
          } catch (e) {}
          if (i < 2) await sleep(5000);
        }
        if (!infoResult) throw new Error('Could not read deposit info.');
        const { amount, nextAllowedTime } = extractDepositInfo(infoResult);
        if (amount === 0n) throw new Error('No deposit note found. Claim a deposit first.');
        let now = BigInt(await getL2Timestamp(a, aztecNode));
        if (nextAllowedTime > now) {
          const waitSec = Number(nextAllowedTime - now);
          throw new Error('Too early for dummy post. Wait ' + waitSec + ' more seconds.');
        }
        log('  Time lock check passed.', 'success');
        await doDummyPost();
        log('  Dummy post complete — screening advanced.', 'success');
        return;
      }

      const encoder = new TextEncoder();
      const bytes = encoder.encode(msgText);
      if (bytes.length > MSG_BYTES - 1) throw new Error('Message too long (max ' + (MSG_BYTES - 1) + ' bytes, got ' + bytes.length + ').');

      const padded = new Uint8Array(MSG_FIELDS * 31);
      padded.set(bytes);
      const fields = [];
      for (let i = 0; i < MSG_FIELDS; i++) {
        let val = 0n;
        for (let j = 0; j < 31; j++) val = (val << 8n) | BigInt(padded[i * 31 + j]);
        fields.push(val);
      }

      log('Posting message (' + bytes.length + ' bytes)...', 'info');

      // Pre-flight: check note exists + time lock expired
      let infoResult = null;
      for (let i = 0; i < 3; i++) {
        try {
          infoResult = await contract.methods.get_deposit_info(address).simulate({ from: address });
          const { amount } = extractDepositInfo(infoResult);
          if (amount > 0n) break;
        } catch (e) {}
        if (i < 2) await sleep(5000);
      }
      if (!infoResult) throw new Error('Could not read deposit info.');
      const { amount, nextAllowedTime } = extractDepositInfo(infoResult);
      if (amount === 0n) throw new Error('No deposit note found. Claim a deposit first.');
      let now = BigInt(await getL2Timestamp(a, aztecNode));
      if (nextAllowedTime > now) {
        const waitSec = Number(nextAllowedTime - now);
        // In auto mode, wait for the cooldown. Otherwise, throw with a helpful message.
        if (config.action === 'auto') {
          log('  Cooldown: ' + waitSec + 's remaining (~' + Math.ceil(waitSec / 60) + ' min). Waiting...', 'info');
          while (true) {
            const n = BigInt(await getL2Timestamp(a, aztecNode));
            if (nextAllowedTime <= n) break;
            const rem = Number(nextAllowedTime - n);
            log('  [' + rem + 's remaining] Waiting for cooldown...', 'info');
            await sleep(Math.min(rem * 1000, 30000));
          }
          log('  Cooldown expired!', 'success');
        } else {
          throw new Error('Too early to post. Wait ' + waitSec + ' more seconds (~' + Math.ceil(waitSec / 60) + ' min).');
        }
      }
      log('  Time lock check passed.', 'success');

      // Fetch screening hints (child + grandchild PostNotes for the screening proof)
      log('  Fetching screening hints...', 'info');
      let childHint = null, grandchildHint = null;
      try {
        const hintsResult = await contract.methods.get_screen_hints(address).simulate({ from: address });
        let hv = hintsResult;
        if (hv && hv.result !== undefined) hv = hv.result;
        if (hv && hv.value !== undefined) hv = hv.value;
        if (Array.isArray(hv)) {
          childHint = hv[0];
          grandchildHint = hv[1];
        }
      } catch (e) {
        throw new Error('Could not fetch screening hints: ' + extractErrorMessage(e));
      }
      log('  Screening hints fetched: child=' + (childHint ? 'yes' : 'no') + ', grandchild=' + (grandchildHint ? 'yes' : 'no'), 'info');
      log('  Pre-flight passed.', 'success');

      const result = await withUserRetry(() => contract.methods.post(
        fields.map(f => new a.Fr(f)),
        false, // is_dummy
        childHint,
        grandchildHint
      ).send({ from: address }), 'Post tx');
      const receipt = result.receipt;
      log('  TX confirmed! Block: ' + receipt.blockNumber + ', Status: ' + receipt.status, 'success');
      if (receipt.transactionFee !== undefined) {
        log('  Fee paid: ' + toAztec(BigInt(receipt.transactionFee), 6) + ' AZTEC', 'info');
      }
      log('  Message posted anonymously!', 'success');
    }

    // ============================================================
    // DUMMY POST (internal helper — advances screening without storing content)
    // ============================================================
    async function doDummyPost() {
      if (!contract) throw new Error('PXE setup required for dummy post.');

      // Fetch screening hints
      let childHint = null, grandchildHint = null;
      try {
        const hintsResult = await contract.methods.get_screen_hints(address).simulate({ from: address });
        let hv = hintsResult;
        if (hv && hv.result !== undefined) hv = hv.result;
        if (hv && hv.value !== undefined) hv = hv.value;
        if (Array.isArray(hv)) {
          childHint = hv[0];
          grandchildHint = hv[1];
        }
      } catch (e) {
        throw new Error('Could not fetch screening hints for dummy post: ' + extractErrorMessage(e));
      }

      const dummyFields = new Array(32).fill(0).map(() => new a.Fr(0));
      const result = await withUserRetry(() => contract.methods.post(
        dummyFields,
        true, // is_dummy = true
        childHint,
        grandchildHint
      ).send({ from: address }), 'Dummy post tx');
      const receipt = result.receipt;
      log('  Dummy post TX confirmed! Block: ' + receipt.blockNumber + ', Status: ' + receipt.status, 'info');
      if (receipt.transactionFee !== undefined) {
        log('  Fee paid: ' + toAztec(BigInt(receipt.transactionFee), 6) + ' AZTEC', 'info');
      }
    }

    // ============================================================
    // LIST action
    // ============================================================
    async function doList() {
      if (!contract) throw new Error('PXE setup required for list.');

      const jsonOutput = !!config.jsonOutput;

      if (!jsonOutput) log('Loading posts...', 'info');
      const countResult = await contract.methods.get_post_count().simulate({ from: address });
      const count = extractInt(countResult);
      if (!jsonOutput) log('  Post count: ' + count, 'info');

      // Check censor config
      let censorAddr = null, kMult = 64;
      try {
        const censorResult = await contract.methods.get_censor().simulate({ from: address });
        let cv = censorResult;
        if (cv && cv.result !== undefined) cv = cv.result;
        if (cv && cv.value !== undefined) cv = cv.value;
        censorAddr = cv && cv.toString ? cv.toString() : (cv ? '0x' + BigInt(cv).toString(16).padStart(64, '0') : null);
      } catch (e) {}
      try {
        const kResult = await contract.methods.get_k_multiplier().simulate({ from: address });
        kMult = extractInt(kResult);
      } catch (e) {}
      const censorActive = censorAddr && !censorAddr.endsWith('0000000000000000000000000000000000000000');
      if (censorActive && !jsonOutput) log('  Censor: ACTIVE (K=' + kMult + ')', 'warn');

      // Read censor_window and max_save_up
      let censorWindow = 0, maxSaveUp = 0;
      try {
        const cwResult = await contract.methods.get_censor_window().simulate({ from: address });
        censorWindow = Number(extractInt(cwResult));
      } catch (e) {}
      try {
        const msuResult = await contract.methods.get_max_save_up().simulate({ from: address });
        maxSaveUp = Number(extractInt(msuResult));
      } catch (e) {}
      if (censorWindow > 0 && !jsonOutput) log('  Censor window: ' + censorWindow + 's', 'info');
      if (maxSaveUp > 0 && !jsonOutput) log('  Max save-up: ' + maxSaveUp, 'info');

      // Read moderation policy from contract
      let policyText = null;
      try {
        const policyResult = await contract.methods.get_moderation_policy().simulate({ from: address });
        let policyFields = policyResult;
        let policyLen = 0;
        if (policyResult && policyResult.result !== undefined) {
          policyFields = policyResult.result[0] || policyResult.result;
          policyLen = Number(policyResult.result[1] !== undefined ? policyResult.result[1] : 0);
        }
        if (policyLen > 0 && g.unpackFieldsToString) {
          policyText = g.unpackFieldsToString(policyFields, policyLen);
          if (policyText && !jsonOutput) {
            log('  --- Moderation Policy ---', 'info');
            for (const line of policyText.split('\n')) log('  | ' + line, 'info');
            log('  -------------------------', 'info');
          }
        }
      } catch (e) {}

      if (count === 0) {
        if (jsonOutput) { console.log(JSON.stringify({ count: 0, posts: [], censor: censorAddr, kMultiplier: kMult })); }
        else { log('  No posts yet.', 'info'); }
        return;
      }

      const _jsonPosts = [];

      for (let i = 0; i < count; i++) {
        try {
          const postResult = await contract.methods.get_post(BigInt(i)).simulate({ from: address });
          const vals = extractFieldArray(postResult);
          let bytes = [];
          for (let f = 0; f < MSG_FIELDS; f++) {
            let val = vals[f];
            let fieldBytes = [];
            for (let b = 0; b < 31; b++) {
              fieldBytes.unshift(Number(val & 0xffn));
              val >>= 8n;
            }
            bytes = bytes.concat(fieldBytes);
          }
          let len = bytes.length;
          for (let b = 0; b < bytes.length; b++) {
            if (bytes[b] === 0) { len = b; break; }
          }
          const msg = new TextDecoder().decode(new Uint8Array(bytes.slice(0, len)));

          // Check if flagged
          let flagged = false;
          try {
            const flagResult = await contract.methods.is_post_flagged(BigInt(i)).simulate({ from: address });
            let fv = flagResult;
            if (fv && fv.result !== undefined) fv = fv.result;
            if (fv && fv.value !== undefined) fv = fv.value;
            flagged = fv && (fv === true || BigInt(fv.toString ? fv.toString() : fv) > 0n);
          } catch (e) {}

          // Collect censor response and flagged_by for flagged posts
          let censorResponse = null, flaggedBy = null;
          if (flagged) {
            try {
              const respResult = await contract.methods.get_censor_response(BigInt(i)).simulate({ from: address });
              const respVals = extractFieldArray(respResult);
              let rBytes = [];
              for (let f = 0; f < MSG_FIELDS; f++) {
                let val = respVals[f];
                let fieldBytes = [];
                for (let b = 0; b < 31; b++) {
                  fieldBytes.unshift(Number(val & 0xffn));
                  val >>= 8n;
                }
                rBytes = rBytes.concat(fieldBytes);
              }
              let rLen = rBytes.length;
              for (let b = 0; b < rBytes.length; b++) {
                if (rBytes[b] === 0) { rLen = b; break; }
              }
              censorResponse = new TextDecoder().decode(new Uint8Array(rBytes.slice(0, rLen)));
            } catch (e) {}
            try {
              const fbResult = await contract.methods.get_post_flagged_by(BigInt(i)).simulate({ from: address });
              let fbv = fbResult;
              if (fbv && fbv.result !== undefined) fbv = fbv.result;
              if (fbv && fbv.value !== undefined) fbv = fbv.value;
              flaggedBy = fbv?.inner ? fbv.inner.toString() : (fbv?.toString ? fbv.toString() : fbv);
            } catch (e) {}
          }

          // Read post timestamp (for censor window calculations)
          let timestamp = 0;
          try {
            const timeResult = await contract.methods.get_post_time(BigInt(i)).simulate({ from: address });
            timestamp = Number(extractInt(timeResult));
          } catch (e) {}

          if (jsonOutput) {
            _jsonPosts.push({ index: i, text: msg || '', flagged, censorResponse, flaggedBy, timestamp });
          } else if (flagged) {
            log('  [' + i + '] [FLAGGED] ' + (msg || '(binary data)'), 'warn');
            if (censorResponse) log('         ↳ Censor: ' + censorResponse, 'warn');
            if (flaggedBy) log('         ↳ Flagged by: ' + flaggedBy, 'warn');
          } else {
            log('  [' + i + '] ' + (msg || '(binary data)'), 'info');
          }
        } catch (err) {
          if (jsonOutput) {
            _jsonPosts.push({ index: i, text: '', flagged: false, error: extractErrorMessage(err) });
          } else {
            log('  [' + i + '] Error: ' + extractErrorMessage(err), 'error');
          }
        }
      }
      if (jsonOutput) {
        console.log(JSON.stringify({ count, posts: _jsonPosts, censor: censorAddr, kMultiplier: kMult, censorWindow, maxSaveUp, policy: policyText || '' }));
      } else {
        log('  All ' + count + ' posts loaded.', 'success');
      }
    }

    // ============================================================
    // WITHDRAW action (L2)
    // ============================================================
    async function doWithdraw() {
      if (!contract) throw new Error('PXE setup required for withdraw.');

      // Check if already withdrawn (note consumed)
      let noteInfo = null;
      try {
        const r = await contract.methods.get_deposit_info(address).simulate({ from: address });
        noteInfo = extractDepositInfo(r);
        if (noteInfo.amount === 0n) {
          log('No deposit note found -- already withdrawn in a previous session.', 'info');
          log('  Run claim-l1 to claim your ETH on L1.', 'info');
          return;
        }
        log('  Deposit note found: ' + noteInfo.amount.toString() + ' wei', 'info');
      } catch (e) {
        log('  Could not read deposit note (proceeding anyway): ' + extractErrorMessage(e).substring(0, 80), 'warn');
      }

      // The contract checks withdrawal eligibility based on screening state:
      //   last_screened_index >= last_real_post_index (all real posts screened)
      //   OR no real posts → check initial lock (next_allowed_time)
      // We use the deposit info to pre-flight this for the user.
      if (noteInfo) {
        const NO_SCREENED = 0xFFFFFFFFn;
        const NO_REAL_POST = 0xFFFFFFFFn;
        const noRealPosts = noteInfo.lastRealPostIndex === NO_REAL_POST;
        const nothingScreened = noteInfo.lastScreenedIndex === NO_SCREENED;
        let canWithdraw = false;
        let waitReason = '';
        if (noRealPosts) {
          // No real posts — check initial lock
          let now = BigInt(await getL2Timestamp(a, aztecNode));
          if (noteInfo.nextAllowedTime > now) {
            const waitSec = Number(noteInfo.nextAllowedTime - now);
            waitReason = 'initial lock: ' + waitSec + 's remaining';
          } else {
            canWithdraw = true;
          }
        } else if (nothingScreened) {
          waitReason = 'real posts exist but none screened yet';
        } else if (noteInfo.lastScreenedIndex >= noteInfo.lastRealPostIndex) {
          canWithdraw = true;
        } else {
          const unscreened = noteInfo.lastRealPostIndex - noteInfo.lastScreenedIndex;
          waitReason = unscreened.toString() + ' real post(s) not yet screened';
        }

        if (!canWithdraw) {
          if (config.action === 'auto') {
            log('  Withdraw not ready: ' + waitReason + '. Will make dummy posts to advance screening.', 'info');
            // Read censor_window to know how long to wait before screening is possible
            let censorWindow = 3600n;
            try {
              const cwResult = await contract.methods.get_censor_window().simulate({ from: address });
              censorWindow = BigInt(extractInt(cwResult));
            } catch (e) {}
            // Make dummy posts until screening catches up
            for (let attempt = 0; attempt < 20; attempt++) {
              // Wait until next_allowed_time (so we can make a dummy post)
              let info3 = null;
              try {
                const r3 = await contract.methods.get_deposit_info(address).simulate({ from: address });
                info3 = extractDepositInfo(r3);
              } catch (e) { break; }
              if (info3.amount === 0n) { canWithdraw = true; break; }
              if (info3.lastRealPostIndex === NO_REAL_POST) {
                let now3 = BigInt(await getL2Timestamp(a, aztecNode));
                if (info3.nextAllowedTime <= now3) { canWithdraw = true; break; }
                const waitSec = Number(info3.nextAllowedTime - now3);
                log('  Waiting ' + waitSec + 's for initial lock to expire...', 'info');
                await sleep(Math.min(waitSec * 1000 + 5000, 60000));
                continue;
              }
              if (info3.lastScreenedIndex !== NO_SCREENED && info3.lastScreenedIndex >= info3.lastRealPostIndex) {
                canWithdraw = true; break;
              }
              // Need to make a dummy post, but first wait for next_allowed_time
              let now4 = BigInt(await getL2Timestamp(a, aztecNode));
              if (info3.nextAllowedTime > now4) {
                const waitSec = Number(info3.nextAllowedTime - now4);
                log('  Waiting ' + waitSec + 's for cooldown before dummy post...', 'info');
                await sleep(Math.min(waitSec * 1000 + 5000, 60000));
              }
              // Also wait for censor_window to pass (so child post is old enough to screen)
              // The child post's timestamp must be <= now - censor_window
              // We don't know exact child timestamp, but it's the most recent real post
              // In practice, waiting for next_allowed_time + censor_window should suffice
              log('  Making dummy post #' + (attempt + 1) + ' to advance screening...', 'info');
              try {
                await doDummyPost();
              } catch (e) {
                log('  Dummy post failed: ' + extractErrorMessage(e).substring(0, 100), 'warn');
                // If it's a timing issue, wait and retry
                await sleep(30000);
              }
              // Check if we can withdraw now
              await sleep(5000);
            }
            if (!canWithdraw) throw new Error('Withdraw timed out: could not advance screening with dummy posts. ' + waitReason);
            log('  Withdraw ready!', 'success');
          } else {
            throw new Error('Too early to withdraw: ' + waitReason + '. Make dummy posts to advance screening (use --action post --dummy).');
          }
        } else {
          log('  Withdraw eligibility confirmed.', 'success');
        }
      }

      log('Withdrawing (sending L2->L1 message)...', 'info');
      const portalField = a.Fr.fromHexString(portalAddr);

      // New API: withdraw only needs the portal address (no chain walk)
      const result = await withUserRetry(() => contract.methods.withdraw(portalField).send({ from: address }), 'Withdraw tx');
      const receipt = result.receipt;
      log('  TX confirmed! Block: ' + receipt.blockNumber + ', Status: ' + receipt.status, 'success');
      if (receipt.transactionFee !== undefined) {
        log('  Fee paid: ' + toAztec(BigInt(receipt.transactionFee), 6) + ' AZTEC', 'info');
      }
      log('  L2->L1 message sent. Tx hash: ' + receipt.txHash, 'success');
      log('', 'info');
      log('  ═══════════════════════════════════════════', 'success');
      log('  L2 block: ' + receipt.blockNumber, 'success');
      log('  Tx hash:  ' + receipt.txHash, 'success');
      log('  ═══════════════════════════════════════════', 'success');
      log('', 'info');
      log('  The epoch proof must land on L1 before you can claim.', 'info');
      log('  This typically takes ~40 minutes on mainnet.', 'info');
      log('  You can monitor progress on an Aztec block explorer.', 'info');
      log('  Run: node cli.mjs claim-l1 --contract-salt <salt>', 'info');
      log('  The claim-l1 action will wait automatically and claim', 'info');
      log('  as soon as the epoch proof is available.', 'info');
    }

    // ============================================================
    // CLAIM-L1 action (consume Outbox message via portal.withdraw)
    // ============================================================
    async function doClaimL1() {
      if (!ethSigner) throw new Error('L1 signer required for claim-l1.');
      if (!portalDeployed) throw new Error('Portal not deployed at ' + portalAddr + '.');

      const network = await provider.getNetwork();
      const chainId = network.chainId;

      log('Claiming ETH on L1...', 'info');
      log('  Portal:     ' + portalAddr, 'info');
      log('  Depositor:  ' + l1Account, 'info');
      log('  Chain ID:   ' + chainId.toString(), 'info');

      // Find the withdrawal tx hash
      let withdrawTxHash = config.withdrawTxHash || null;
      let messageIndexInTx = undefined;

      // Get deposit amount from portal
      let withdrawAmount = portalL1Balance;
      if (!withdrawAmount) {
        const portalTmp = new ethers.Contract(portalAddr, PORTAL_ABI, provider);
        try { withdrawAmount = await portalTmp.deposits(l1Account); } catch (e) {}
      }
      // If portal balance is 0, the L2 withdraw already happened (portal deposits[msg.sender] was zeroed
      // on L2). We need the amount to compute the message leaf. If we have a withdraw tx hash, we can
      // scan L2 blocks to find the l2ToL1Msg and match it against candidate amounts.
      if (!withdrawAmount && config.withdrawTxHash) {
        log('  Portal balance is 0 (L2 withdraw already processed).', 'info');
        log('  Scanning L2 blocks for withdrawal tx to recover amount...', 'info');
        withdrawTxHash = config.withdrawTxHash;
        // Try to find the tx effect and extract the l2ToL1Msg
        const latestBlock = await aztecNode.getBlockNumber();
        let foundAmount = null;
        let foundMsgIndex = null;
        const batchSize = 10;
        for (let start = latestBlock; start >= Math.max(0, latestBlock - 500); start -= batchSize) {
          const from = Math.max(start - batchSize + 1, 0);
          const count = start - from + 1;
          let blocks;
          try { blocks = await aztecNode.getBlocks(BigInt(from), count, { includeTransactions: true }); } catch (e) { continue; }
          for (const block of blocks) {
            if (!block || !block.body) continue;
            for (const txEffect of block.body.txEffects) {
              const txHashStr = txEffect.txHash ? txEffect.txHash.toString() : '?';
              if (txHashStr.toLowerCase() !== withdrawTxHash.toLowerCase()) continue;
              log('  Found withdrawal tx in L2 block ' + block.header?.number, 'success');
              if (!txEffect.l2ToL1Msgs || txEffect.l2ToL1Msgs.length === 0) { break; }
              // For each l2ToL1Msg, try candidate amounts until one matches the message leaf
              for (let mi = 0; mi < txEffect.l2ToL1Msgs.length; mi++) {
                const msg = txEffect.l2ToL1Msgs[mi];
                const msgBigInt = typeof msg.toBigInt === 'function' ? msg.toBigInt() : (msg.asBigInt || 0n);
                if (msgBigInt === 0n) continue;
                // Try common deposit amounts
                const candidates = [1000000000000000n, 500000000000000n, 100000000000000n, 10000000000000000n];
                for (const cand of candidates) {
                  const leaf = computeWithdrawMessageLeaf(a, ethers, l2Addr, portalAddr, l1Account, cand, version, chainId);
                  if (leaf.toBigInt() === msgBigInt) {
                    foundAmount = cand;
                    foundMsgIndex = mi;
                    break;
                  }
                }
                if (foundAmount) break;
              }
              break;
            }
            if (foundAmount) break;
          }
          if (foundAmount) break;
        }
        if (foundAmount) {
          withdrawAmount = foundAmount;
          messageIndexInTx = foundMsgIndex;
          log('  Recovered withdrawal amount: ' + toEtherStr(withdrawAmount) + ' ETH', 'success');
        } else {
          throw new Error('Could not recover withdrawal amount from L2 tx. Portal balance is 0 and no matching message found.');
        }
      }
      if (!withdrawAmount) throw new Error('No active deposit in portal. Nothing to claim on L1. If you already withdrew on L2, provide --withdraw-tx <hash>.');

      if (!withdrawTxHash) {
        log('  No withdrawal tx hash provided. Scanning L2 blocks...', 'info');
        const messageLeaf = computeWithdrawMessageLeaf(a, ethers, l2Addr, portalAddr, l1Account, withdrawAmount, version, chainId);
        log('  Message leaf: 0x' + messageLeaf.toBigInt().toString(16), 'info');
        const latestBlock = await aztecNode.getBlockNumber();
        const found = await findWithdrawTxHash(aztecNode, messageLeaf, latestBlock, Math.max(0, latestBlock - 500), log);
        if (!found) {
          log('  Could not find a withdrawal tx in the last 500 blocks.', 'error');
          log('  Make sure you have withdrawn on L2 first.', 'error');
          throw new Error('Withdrawal tx not found. Withdraw on L2 first.');
        }
        withdrawTxHash = found.txHash;
        messageIndexInTx = found.messageIndexInTx;
      }

      log('  Withdrawal tx: ' + withdrawTxHash, 'info');

      const messageLeaf = computeWithdrawMessageLeaf(a, ethers, l2Addr, portalAddr, l1Account, withdrawAmount, version, chainId);
      log('  Message leaf: ' + messageLeaf.toString(), 'info');

      // Get L2->L1 membership witness (retry until epoch is proven)
      // On mainnet, epoch proofs typically take ~40 minutes to land on L1.
      log('  Waiting for epoch proof to land on L1...', 'info');
      log('  This typically takes ~40 minutes. Will check every 30s...', 'info');
      let witness = null;
      const MAX_EPOCH_WAIT = 180; // up to 90 min at 30s intervals
      const epochStart = Date.now();
      for (let i = 0; i < MAX_EPOCH_WAIT; i++) {
        try {
          const w = await aztecNode.getL2ToL1MembershipWitness(
            a.TxHash.fromString(withdrawTxHash),
            messageLeaf,
            messageIndexInTx
          );
          if (w) { witness = w; break; }
        } catch (e) {}
        const elapsed = Math.floor((Date.now() - epochStart) / 1000);
        const elapsedMin = Math.floor(elapsed / 60);
        const elapsedSec = elapsed % 60;
        if (i === 0) {
          log('  Epoch proof not ready yet. Retrying every 30s...', 'info');
        } else if (i % 4 === 0) {
          const estRemaining = Math.max(0, 40 - elapsedMin);
          log('  [' + elapsedMin + 'm' + String(elapsedSec).padStart(2, '0') + 's elapsed] Still waiting for epoch proof... (~' + estRemaining + ' min remaining)', 'info');
        }
        await sleep(30000);
      }

      if (!witness) {
        log('  Epoch proof not available after 90 min.', 'error');
        log('  The proof may still be processing. Try again later:', 'info');
        log('  node cli.mjs claim-l1 --contract-salt <salt> --withdraw-tx ' + withdrawTxHash, 'info');
        throw new Error('Epoch proof not available. Try again later.');
      }

      const epochNumber = witness.epochNumber;
      const numCheckpointsInEpoch = witness.numCheckpointsInEpoch;
      const leafIndex = witness.leafIndex;
      const siblingPath = witness.siblingPath;

      log('  Epoch proof found!', 'success');
      log('  Epoch: ' + epochNumber, 'info');
      log('  Checkpoints in epoch: ' + numCheckpointsInEpoch, 'info');
      log('  Leaf index: ' + leafIndex.toString(), 'info');
      log('  Sibling path size: ' + siblingPath.pathSize, 'info');

      // Check if already consumed
      const outboxAddress = ethers.getAddress(l1Contracts.outboxAddress.toString());
      const outbox = new ethers.Contract(outboxAddress, OUTBOX_ABI, provider);
      const messageLeafId = (1n << BigInt(siblingPath.pathSize)) + BigInt(leafIndex);
      let alreadyConsumed = false;
      try {
        alreadyConsumed = await outbox.hasMessageBeenConsumedAtEpoch(BigInt(epochNumber), messageLeafId);
      } catch (e) {
        log('  Warning: could not check consumed status: ' + extractErrorMessage(e).substring(0, 80), 'warn');
      }
      if (alreadyConsumed) {
        log('  This withdrawal has already been claimed on L1!', 'success');
        log('  The ETH was already sent to your address.', 'info');
        return;
      }

      log('  Deposit balance in portal: ' + toEtherStr(withdrawAmount) + ' ETH', 'info');

      // Call portal.withdraw on L1
      log('  Sending L1 withdrawal tx...', 'info');
      const pathHex = siblingPath.toBufferArray().map(buf => ethers.hexlify(buf));
      const portalWithSigner = new ethers.Contract(portalAddr, PORTAL_ABI, ethSigner);

      try {
        const tx = await withUserRetry(() => portalWithSigner.withdraw(
          BigInt(epochNumber),
          BigInt(numCheckpointsInEpoch),
          BigInt(leafIndex),
          pathHex
        ), 'L1 withdrawal tx');
        log('  L1 tx sent: ' + tx.hash, 'success');
        log('  Waiting for confirmation...', 'info');
        const rc = await tx.wait();
        if (rc.status !== 1) throw new Error('L1 withdrawal tx reverted in block ' + rc.blockNumber);
        log('  L1 tx confirmed! Block: ' + rc.blockNumber, 'success');
        log('  ETH claimed successfully!', 'success');
        log('  Check your L1 wallet balance.', 'info');
      } catch (e) {
        const msg = extractErrorMessage(e);
        if (msg.includes('already') || msg.includes('consumed') || msg.includes('MessageAlreadyConsumed')) {
          log('  This message was already consumed.', 'info');
          log('  The ETH was already claimed in a previous tx.', 'info');
          return;
        }
        throw new Error('L1 withdrawal failed: ' + msg.substring(0, 200));
      }
    }

    // ============================================================
    // L2 timestamp helper
    // ============================================================
    async function getL2Timestamp(a, aztecNode) {
      const blockNum = await aztecNode.getBlockNumber();
      const block = await aztecNode.getBlock(blockNum);
      const ts = block.timestamp || block.header?.globalVariables?.timestamp || block.header?.timestamp;
      if (ts === undefined || ts === null) throw new Error('Could not get L2 timestamp from block');
      return Number(ts);
    }

    // ============================================================
    // Wait for L1->L2 message to become claimable (simulates claim_deposit)
    // ============================================================
    async function waitForL2Ingest() {
      if (!contract) return;
      if (!depositInfo) return;
      log('  Waiting for L2 to ingest the L1 deposit (usually ~5-10 min)...', 'info');
      const depositorField = a.Fr.fromHexString(l1Account);
      const secret = new a.Fr(BigInt(depositInfo.secret) % a.Fr.MODULUS);
      const portalField = a.Fr.fromHexString(portalAddr);
      const deadline = Date.now() + 15 * 60 * 1000; // 15 min max
      while (Date.now() < deadline) {
        try {
          await contract.methods.claim_deposit(
            depositorField, depositInfo.amount, secret, depositInfo.leafIndex, portalField
          ).simulate({ from: address });
          log('  L1->L2 message is available!', 'success');
          return;
        } catch (e) {
          const msg = (e.message || '').toLowerCase();
          if (msg.includes('message') || msg.includes('l1') || msg.includes('membership') || msg.includes('not found')) {
            log('  Not ready yet, waiting 20s...', 'info');
            await sleep(20000);
          } else {
            log('  Check failed: ' + extractErrorMessage(e).substring(0, 100), 'warn');
            await sleep(20000);
          }
        }
      }
      throw new Error('L1->L2 message not available after 15 min. Try claiming later.');
    }

    // ============================================================
    // Helper: load censor wallet + create censor-bound contract
    // ============================================================
    async function _loadCensorWalletAndContract() {
      let censorWalletJson = config.censorWalletJson || null;
      if (!censorWalletJson && config.censorWalletPath) {
        const censorWalletPath = config.censorWalletPath;
        if (fs.existsSync(censorWalletPath)) {
          censorWalletJson = JSON.parse(fs.readFileSync(censorWalletPath, 'utf8'));
          log('Loaded censor wallet from ' + censorWalletPath, 'success');
        } else {
          throw new Error('Censor wallet file not found: ' + censorWalletPath);
        }
      }
      if (!censorWalletJson) throw new Error('Censor wallet required.');
      if (!censorWalletJson.secretKey) throw new Error('Censor wallet JSON missing secretKey.');

      const censorSk = a.Fr.fromHexString(censorWalletJson.secretKey);
      const censorSigningKey = a.deriveSigningKey(censorSk);
      const censorAccountContract = new a.SchnorrInitializerlessAccountContract(censorSigningKey);
      const { publicKeys: censorPublicKeys } = await a.deriveKeys(censorSk);
      const censorAccountArtifact = await censorAccountContract.getContractArtifact();
      const censorImmutablesHash = await censorAccountContract.getImmutablesHash();
      const censorSaltVal = typeof censorWalletJson.salt === 'string' ? parseInt(censorWalletJson.salt, 16) : (censorWalletJson.salt || 0);
      const censorInstance = await a.getContractInstanceFromInstantiationParams(censorAccountArtifact, {
        constructorArtifact: undefined, constructorArgs: undefined,
        salt: new a.Fr(censorSaltVal), publicKeys: censorPublicKeys, immutablesHash: censorImmutablesHash,
      });
      const censorPartialAddress = await a.computePartialAddress(censorInstance);
      const censorAddress = censorInstance.address;
      log('  Censor address: ' + censorAddress.toString(), 'info');

      log('  Registering censor account with PXE...', 'info');
      const censorDerivedKeys = await a.deriveKeys(censorSk);
      await pxe.registerAccount(censorDerivedKeys, censorPartialAddress);
      await retry(() => pxe.registerContract(censorInstance), 'register-censor', log, 5);
      log('  Censor account registered.', 'success');

      const censorWallet = createAztecWallet(a, pxe, aztecNode, rawNode, log, censorSk);
      const censorAccountManager = await a.AccountManager.create(censorWallet, censorSk, censorAccountContract, { salt: new a.Fr(censorSaltVal) });
      censorWallet._accountManager = censorAccountManager;

      log('  Storing censor signing key capsule...', 'info');
      const censorSigningPublicKey = await censorAccountContract.getSigningPublicKey();
      const censorConstructorArtifact = censorAccountArtifact.functions.find(f => f.name === 'constructor');
      if (censorConstructorArtifact) {
        const storeCall = new a.ContractFunctionInteraction(
          censorWallet, censorInstance.address, censorConstructorArtifact,
          [censorSigningPublicKey.x, censorSigningPublicKey.y]
        );
        await storeCall.simulate({ from: censorInstance.address });
        log('  Censor capsule stored.', 'success');
      }

      const censorContract = await a.Contract.at(l2Addr, contractArtifact, censorWallet);
      await pxe.sync();
      return { censorWallet, censorAddress, censorContract };
    }

    // ============================================================
    // SET-MODERATION-POLICY action (censor updates the policy text)
    // ============================================================
    async function doSetModerationPolicy() {
      if (!contract) throw new Error('PXE setup required for set-moderation-policy.');

      const policyText = config.moderationPolicy !== undefined ? config.moderationPolicy : (g.DEFAULT_MODERATION_POLICY || '');
      if (!policyText || !policyText.trim()) throw new Error('Policy text required (use --moderation-policy <text>).');

      const packFn = g.packStringToFields;
      if (!packFn) throw new Error('packStringToFields not available (load moderation-policy.js)');
      const { fields: policyFields, len: policyLen } = packFn(policyText);

      const { censorAddress, censorContract } = await _loadCensorWalletAndContract();

      log('Setting moderation policy (' + policyLen + ' bytes)...', 'info');
      const result = await withUserRetry(() => censorContract.methods.set_moderation_policy(
        policyFields.map(f => new a.Fr(f)),
        new a.Fr(BigInt(policyLen))
      ).send({ from: censorAddress }), 'Set moderation policy tx');
      const receipt = result.receipt;
      log('  TX confirmed! Block: ' + receipt.blockNumber + ', Status: ' + receipt.status, 'success');
      if (receipt.transactionFee !== undefined) {
        log('  Fee paid: ' + toAztec(BigInt(receipt.transactionFee), 6) + ' AZTEC', 'info');
      }
      log('  Moderation policy updated.', 'success');
    }

    // ============================================================
    // DECLARE-IMMORAL action (censor flags a post)
    // ============================================================
    async function doDeclareImmoral() {
      if (!contract) throw new Error('PXE setup required for declare-immoral.');

      const postIndex = config.postIndex;
      if (postIndex === undefined || postIndex === null) throw new Error('Post index required (use --post-index <num>).');
      const responseText = config.censorResponse || '';

      // Load censor wallet — accept JSON object (browser) or file path (CLI)
      let censorWalletJson = config.censorWalletJson || null;
      if (!censorWalletJson && config.censorWalletPath) {
        const censorWalletPath = config.censorWalletPath;
        if (fs.existsSync(censorWalletPath)) {
          censorWalletJson = JSON.parse(fs.readFileSync(censorWalletPath, 'utf8'));
          log('Loaded censor wallet from ' + censorWalletPath, 'success');
        } else {
          throw new Error('Censor wallet file not found: ' + censorWalletPath);
        }
      }
      if (!censorWalletJson) {
        throw new Error('Censor wallet required for declare-immoral.');
      }
      if (!censorWalletJson.secretKey) throw new Error('Censor wallet JSON missing secretKey.');

      // Derive censor account
      const censorSk = a.Fr.fromHexString(censorWalletJson.secretKey);
      const censorSigningKey = a.deriveSigningKey(censorSk);
      const censorAccountContract = new a.SchnorrInitializerlessAccountContract(censorSigningKey);
      const { publicKeys: censorPublicKeys } = await a.deriveKeys(censorSk);
      const censorAccountArtifact = await censorAccountContract.getContractArtifact();
      const censorImmutablesHash = await censorAccountContract.getImmutablesHash();
      const censorSaltVal = typeof censorWalletJson.salt === 'string' ? parseInt(censorWalletJson.salt, 16) : (censorWalletJson.salt || 0);
      const censorInstance = await a.getContractInstanceFromInstantiationParams(censorAccountArtifact, {
        constructorArtifact: undefined, constructorArgs: undefined,
        salt: new a.Fr(censorSaltVal), publicKeys: censorPublicKeys, immutablesHash: censorImmutablesHash,
        });
      const censorPartialAddress = await a.computePartialAddress(censorInstance);
      const censorAddress = censorInstance.address;
      log('  Censor address: ' + censorAddress.toString(), 'info');

      // Register censor account with PXE
      log('  Registering censor account with PXE...', 'info');
      const censorDerivedKeys = await a.deriveKeys(censorSk);
      await pxe.registerAccount(censorDerivedKeys, censorPartialAddress);
      await retry(() => pxe.registerContract(censorInstance), 'register-censor', log, 5);
      log('  Censor account registered.', 'success');

      // Create censor wallet
      const censorWallet = createAztecWallet(a, pxe, aztecNode, rawNode, log, censorSk);
      const censorAccountManager = await a.AccountManager.create(censorWallet, censorSk, censorAccountContract, { salt: new a.Fr(censorSaltVal) });
      censorWallet._accountManager = censorAccountManager;

      // Store censor's signing key capsule
      log('  Storing censor signing key capsule...', 'info');
      const censorSigningPublicKey = await censorAccountContract.getSigningPublicKey();
      const censorConstructorArtifact = censorAccountArtifact.functions.find(f => f.name === 'constructor');
      if (censorConstructorArtifact) {
        const storeCall = new a.ContractFunctionInteraction(
          censorWallet, censorInstance.address, censorConstructorArtifact,
          [censorSigningPublicKey.x, censorSigningPublicKey.y]
        );
        await storeCall.simulate({ from: censorInstance.address });
        log('  Censor capsule stored.', 'success');
      }

      // Create contract instance bound to censor's wallet
      const censorContract = await a.Contract.at(l2Addr, contractArtifact, censorWallet);

      // Sync PXE
      await pxe.sync();

      const encoder = new TextEncoder();
      const bytes = encoder.encode(responseText);
      if (bytes.length > MSG_BYTES - 1) throw new Error('Response too long (max ' + (MSG_BYTES - 1) + ' bytes).');

      const padded = new Uint8Array(MSG_FIELDS * 31);
      padded.set(bytes);
      const fields = [];
      for (let i = 0; i < MSG_FIELDS; i++) {
        let val = 0n;
        for (let j = 0; j < 31; j++) val = (val << 8n) | BigInt(padded[i * 31 + j]);
        fields.push(val);
      }

      log('Declaring post ' + postIndex + ' as immoral...', 'info');
      if (responseText) log('  Response: "' + responseText.substring(0, 60) + '"', 'info');

      const result = await withUserRetry(() => censorContract.methods.declare_immoral(
        BigInt(postIndex),
        fields.map(f => new a.Fr(f))
      ).send({ from: censorAddress }), 'Declare immoral tx');
      const receipt = result.receipt;
      log('  TX confirmed! Block: ' + receipt.blockNumber + ', Status: ' + receipt.status, 'success');
      if (receipt.transactionFee !== undefined) {
        log('  Fee paid: ' + toAztec(BigInt(receipt.transactionFee), 6) + ' AZTEC', 'info');
      }
      log('  Post ' + postIndex + ' flagged as immoral.', 'success');

      // Verify: read back the flagged_by record
      try {
        const flaggedByResult = await contract.methods.get_post_flagged_by(BigInt(postIndex)).simulate({ from: address });
        let fbv = flaggedByResult;
        if (fbv && fbv.result !== undefined) fbv = fbv.result;
        if (fbv && fbv.value !== undefined) fbv = fbv.value;
        const flaggedBy = fbv?.inner ? fbv.inner.toString() : (fbv?.toString ? fbv.toString() : fbv);
        log('  Public record: flagged by ' + flaggedBy, 'info');
      } catch (e) {
        log('  Could not read flagged_by record: ' + extractErrorMessage(e).substring(0, 80), 'warn');
      }
    }

    // ============================================================
    // TRANSFER-CENSOR action (censor transfers rights to new address)
    // ============================================================
    async function doTransferCensor() {
      if (!contract) throw new Error('PXE setup required for transfer-censor.');

      const newCensorStr = config.newCensor;
      if (!newCensorStr) throw new Error('New censor address required (use --new-censor <addr>).');

      // Load censor wallet — accept JSON object (browser) or file path (CLI)
      let censorWalletJson = config.censorWalletJson || null;
      if (!censorWalletJson && config.censorWalletPath) {
        const censorWalletPath = config.censorWalletPath;
        if (fs.existsSync(censorWalletPath)) {
          censorWalletJson = JSON.parse(fs.readFileSync(censorWalletPath, 'utf8'));
          log('Loaded censor wallet from ' + censorWalletPath, 'success');
        } else {
          throw new Error('Censor wallet file not found: ' + censorWalletPath);
        }
      }
      if (!censorWalletJson) {
        throw new Error('Censor wallet required for transfer-censor.');
      }
      if (!censorWalletJson.secretKey) throw new Error('Censor wallet JSON missing secretKey.');

      // Derive censor account
      const censorSk = a.Fr.fromHexString(censorWalletJson.secretKey);
      const censorSigningKey = a.deriveSigningKey(censorSk);
      const censorAccountContract = new a.SchnorrInitializerlessAccountContract(censorSigningKey);
      const { publicKeys: censorPublicKeys } = await a.deriveKeys(censorSk);
      const censorAccountArtifact = await censorAccountContract.getContractArtifact();
      const censorImmutablesHash = await censorAccountContract.getImmutablesHash();
      const censorSaltVal = typeof censorWalletJson.salt === 'string' ? parseInt(censorWalletJson.salt, 16) : (censorWalletJson.salt || 0);
      const censorInstance = await a.getContractInstanceFromInstantiationParams(censorAccountArtifact, {
        constructorArtifact: undefined, constructorArgs: undefined,
        salt: new a.Fr(censorSaltVal), publicKeys: censorPublicKeys, immutablesHash: censorImmutablesHash,
      });
      const censorPartialAddress = await a.computePartialAddress(censorInstance);
      const censorAddress = censorInstance.address;
      log('  Censor address: ' + censorAddress.toString(), 'info');

      // Register censor account with PXE
      log('  Registering censor account with PXE...', 'info');
      const censorDerivedKeys = await a.deriveKeys(censorSk);
      await pxe.registerAccount(censorDerivedKeys, censorPartialAddress);
      await retry(() => pxe.registerContract(censorInstance), 'register-censor', log, 5);
      log('  Censor account registered.', 'success');

      // Create censor wallet
      const censorWallet = createAztecWallet(a, pxe, aztecNode, rawNode, log, censorSk);
      const censorAccountManager = await a.AccountManager.create(censorWallet, censorSk, censorAccountContract, { salt: new a.Fr(censorSaltVal) });
      censorWallet._accountManager = censorAccountManager;

      // Store censor's signing key capsule
      log('  Storing censor signing key capsule...', 'info');
      const censorSigningPublicKey = await censorAccountContract.getSigningPublicKey();
      const censorConstructorArtifact = censorAccountArtifact.functions.find(f => f.name === 'constructor');
      if (censorConstructorArtifact) {
        const storeCall = new a.ContractFunctionInteraction(
          censorWallet, censorInstance.address, censorConstructorArtifact,
          [censorSigningPublicKey.x, censorSigningPublicKey.y]
        );
        await storeCall.simulate({ from: censorInstance.address });
        log('  Censor capsule stored.', 'success');
      }

      // Create contract instance bound to censor's wallet
      const censorContract = await a.Contract.at(l2Addr, contractArtifact, censorWallet);
      await pxe.sync();

      const newCensorAddr = a.AztecAddress.fromFieldUnsafe(a.Fr.fromHexString(newCensorStr));
      log('Transferring censor rights to ' + newCensorAddr.toString() + '...', 'info');

      const result = await withUserRetry(() => censorContract.methods.transfer_censor(newCensorAddr).send({ from: censorAddress }), 'Transfer censor tx');
      const receipt = result.receipt;
      log('  TX confirmed! Block: ' + receipt.blockNumber + ', Status: ' + receipt.status, 'success');
      if (receipt.transactionFee !== undefined) {
        log('  Fee paid: ' + toAztec(BigInt(receipt.transactionFee), 6) + ' AZTEC', 'info');
      }

      // Verify
      try {
        const newCensorResult = await contract.methods.get_censor().simulate({ from: address });
        let ncv = newCensorResult;
        if (ncv && ncv.result !== undefined) ncv = ncv.result;
        if (ncv && ncv.value !== undefined) ncv = ncv.value;
        const newCensorOnChain = ncv?.inner ? ncv.inner.toString() : (ncv?.toString ? ncv.toString() : ncv);
        log('  New censor on-chain: ' + newCensorOnChain, 'success');
      } catch (e) {
        log('  Could not read new censor: ' + extractErrorMessage(e).substring(0, 80), 'warn');
      }
    }

    // ============================================================
    // Action dispatch
    // ============================================================
    let result = { ok: true, state: stateStatus };

    if (action === 'deposit') {
      if (config.reuseTxHash || config.reuse === 'true' || config.reuse === true) {
        await doReuseDeposit();
        log('', 'success');
        log('Deposit recovered. Run the claim action to claim it on L2.', 'success');
        if (depositInfo) {
          log('  Amount:     ' + toEtherStr(depositInfo.amount) + ' ETH', 'info');
          log('  Leaf index: ' + depositInfo.leafIndex.toString(), 'info');
          log('  Secret:     ' + depositInfo.secret, 'info');
        }
      } else {
        await doDeposit();
      }
      result.depositInfo = depositInfo;
    } else if (action === 'claim') {
      await doClaim();
    } else if (action === 'post') {
      await doPost();
    } else if (action === 'list') {
      await doList();
    } else if (action === 'declare-immoral') {
      await doDeclareImmoral();
    } else if (action === 'transfer-censor') {
      await doTransferCensor();
    } else if (action === 'set-moderation-policy') {
      await doSetModerationPolicy();
    } else if (action === 'withdraw') {
      await doWithdraw();
    } else if (action === 'claim-l1') {
      await doClaimL1();
    } else if (action === 'auto') {
      // Full flow: deposit -> claim -> post (if msg) -> withdraw -> claim-l1
      log('', 'info');
        log('========================================', 'info');
        log('  AUTO MODE: Full user journey', 'info');
        log('========================================', 'info');

      // 1. Deposit (or reuse)
      if (stateStatus === 'zero_balance_need_deposit') {
        log('\n--- Phase 1: Deposit ---', 'info');
        if (!config.depositAmount) throw new Error('Deposit amount required for auto mode (use --amount <eth>).');
        await doDeposit();
        // Wait for L2 ingest
        log('\n--- Waiting for L2 to ingest L1 deposit (~5-10 min) ---', 'info');
        await waitForL2Ingest();
      } else if (stateStatus === 'deposited_l1_not_claimed_l2') {
        log('\n--- Phase 1: Reusing existing L1 deposit ---', 'info');
        await doReuseDeposit();
      } else if (stateStatus === 'postable') {
        log('\n--- Phase 1: Already have L2 deposit note, skipping deposit ---', 'info');
      } else if (stateStatus === 'withdrawn_l2_claimable_l1') {
        log('\n--- Already withdrawn on L2. Skipping to L1 claim. ---', 'info');
        await doClaimL1();
        result.done = true;
      }

      if (!result.done) {
        // 2. Claim on L2
        if (stateStatus !== 'postable') {
          log('\n--- Phase 2: Claim deposit on L2 ---', 'info');
          await doClaim();
        }

        // 3. Post (if message provided)
        if (config.message) {
          log('\n--- Phase 3: Post message ---', 'info');
          await doPost();
        }

        // 4. Withdraw on L2
        log('\n--- Phase 4: Withdraw on L2 ---', 'info');
        await doWithdraw();

        // 5. Claim on L1
        log('\n--- Phase 5: Claim ETH on L1 ---', 'info');
        await doClaimL1();
      }

      log('', 'success');
      log('========================================', 'success');
      log('  AUTO MODE COMPLETE!', 'success');
      log('========================================', 'success');
    } else {
      throw new Error('Unknown action: ' + action + '. Valid: status, deposit, claim, post, list, withdraw, claim-l1, auto');
    }

    result.state = stateStatus;
    result.l2Addr = l2AddrHex;
    result.portalAddr = portalAddr;
    // Expose handles for web app live UI (billboard feed, countdown, etc.)
    result.handles = { pxe, wallet, contract, aztecNode, rawNode, address, l2Addr, contractSalt, version, nodeInfo };
    return result;
  };

})();
