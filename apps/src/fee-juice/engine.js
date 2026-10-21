// ============================================================
// engine.js — Fee Juice Fund & Claim Engine
// ============================================================
// Fully abstracted from the interface. Takes an `env` object
// (providing aztec SDK, ethers, logging, CRS init, store
// creation, ETH signer) and a `config` object. Runs the entire
// flow: swap ETH→AZTEC (if needed), deposit to L2, wait for
// checkpoint, claim on L2.
//
// Works in: browser (bundle), CLI (npm SDK), file:// (single-thread)
//
// Defines: globalThis.runFeeJuiceFlow(env, config) → Promise<result>
// ============================================================

;(function() {
  const g = typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this);

  // ============================================================
  // Constants
  // ============================================================
  const TRANSIENT_RE = /temporary internal error|please retry|timeout|fetch|network|connection|ECONNRESET|socket/i;

  const FEE_JUICE_PORTAL_ADDR = '0xaf73dd51d1eb8a079bb097f39c832cdd00ac691c';
  const AZTEC_TOKEN_ADDR = '0xa27ec0006e59f245217ff08cd52a7e8b169e62d2';
  const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
  const SWAP_ROUTER = '0xe592427a0aece92de3edee1f18e0157c05861564';
  const QUOTER_V1 = '0xb27308f9f90d607463bb33ea1bebb41c27ce5ab6';

  const FEE_JUICE_PORTAL_ABI = [
    'function depositToAztecPublic(bytes32 to, uint256 amount, bytes32 secretHash) returns (bytes32 key, uint256 index)',
    'function VERSION() view returns (uint256)',
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
  const ROUTER_ABI = [
    'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)',
  ];
  const QUOTER_ABI = [
    'function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) external returns (uint256 amountOut)',
  ];

  const FEE_JUICE_SIGN_MSG = 'Aztec fee-juice deposit claim secret v1\n\n' +
    'Signing this message derives (and recovers) your L1->L2 claim secret. ' +
    'It does not authorize any transaction.';

  const SECRET_HASH_DOMAIN = 4199652938n;
  const FEE_JUICE = 3n; // ProtocolContractAddress.FeeJuice

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

  function frToHex(x) {
    if (typeof x === 'bigint') return '0x' + x.toString(16).padStart(64, '0');
    return x.toString();
  }

  function be32(n) {
    const b = new Uint8Array(32);
    let x = n;
    for (let i = 31; i >= 0; i--) { b[i] = Number(x & 0xffn); x >>= 8n; }
    return b;
  }

  function hexFromBytes(u8) {
    return Array.from(u8).map(b => b.toString(16).padStart(2, '0')).join('');
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

  // Compute poseidon2 hash of [domain, secret] using bundle's BarretenbergSync
  async function computeSecretHashBundle(a, secretBigInt) {
    await a.BarretenbergSync.initSingleton();
    const bb = a.BarretenbergSync.getSingleton();
    const response = bb.poseidon2Hash({
      inputs: [new a.Fr(SECRET_HASH_DOMAIN).toBuffer(), new a.Fr(secretBigInt).toBuffer()]
    });
    return BigInt(new a.Fr(Buffer.from(response.hash)).toString());
  }

  // Derive deterministic claim secret
  // Same as browser app: keccak256(domain | account_lower | nonce_be32 | sig_bytes) mod p
  function deriveSecretFromInputs(ethers, account, nonce, sigHex) {
    const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
    const sigBytes = ethers.getBytes(sigHex);
    const nonceBe = new Uint8Array(32);
    let n = BigInt(nonce);
    for (let i = 31; i >= 0; i--) { nonceBe[i] = Number(n & 0xffn); n >>= 8n; }
    const buf = ethers.concat([
      ethers.toUtf8Bytes('Aztec fee-juice deposit claim secret v1|'),
      ethers.toUtf8Bytes(account.toLowerCase()),
      ethers.toUtf8Bytes('|'),
      nonceBe,
      sigBytes,
    ]);
    const x = BigInt(ethers.keccak256(buf)) % P;
    return '0x' + x.toString(16).padStart(64, '0');
  }

  // Compute L1→L2 message hash (same as preflightL1ToL2Message in aztec-lib.js)
  async function computeL1ToL2MsgHash(a, ethers, aztecNode, recipientAddress, claimAmount, claimSecretFr, messageLeafIndex) {
    await a.BarretenbergSync.initSingleton();
    const bb = a.BarretenbergSync.getSingleton();
    const nodeInfo = await aztecNode.getNodeInfo();
    const chainId = BigInt(nodeInfo.l1ChainId);
    const version = BigInt(nodeInfo.rollupVersion);
    const CLAIM_SELECTOR = new Uint8Array([0x63, 0xf4, 0x49, 0x68]);

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
      return BigInt(new a.Fr(Buffer.from(response.hash)).toString());
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

  // ============================================================
  // Aztec Wallet (same as deploy engine, with gas estimation + retry)
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
  // Setup cache — avoids re-doing expensive CRS/PXE/sync on
  // repeated calls with the same config (used by web app pages)
  // ============================================================
  const _setupCache = new Map();
  function _setupKey(config) {
    return (config.aztecNodeUrl || '') + '|' +
           (config.aztecWallet?.secretKey || '');
  }

  // ============================================================
  // Main entry point
  // ============================================================
  g.runFeeJuiceFlow = async function(env, config) {
    const { aztec: a, ethers, log, initCRS, createStore } = env;
    const action = config.action || (config.claimOnly ? 'claim' : 'auto');

    // ============================================================
    // Step 1: Load Aztec wallet & derive keys
    // ============================================================
    let aztecWallet = config.aztecWallet;
    if (!aztecWallet || !aztecWallet.secretKey) {
      throw new Error('Aztec wallet with secretKey is required.');
    }

    const saltVal = typeof aztecWallet.salt === 'string' ? parseInt(aztecWallet.salt, 16) : (aztecWallet.salt || 0);
    const secretKeyHex = aztecWallet.secretKey;

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

    try {
      const blockNum = await aztecNode.getBlockNumber();
      log('  Current L2 block: ' + blockNum, 'info');
    } catch (e) { /* non-critical */ }

    // Check current L2 fee juice balance
    log('Checking current L2 Fee Juice balance...', 'info');
    try {
      const slot = await a.deriveStorageSlotInMap(new a.Fr(1), address);
      const value = await aztecNode.getPublicStorageAt('latest', a.FeeJuiceAddress, slot);
      const balance = value ? BigInt(value.toString()) : 0n;
      log('  Fee Juice balance: ' + toAztec(balance, 6) + ' AZTEC', balance > 0n ? 'success' : 'warn');
    } catch (e) {
      log('  Could not check balance: ' + extractErrorMessage(e), 'warn');
    }

    // Early return for 'status' action
    if (action === 'status') {
      let balance = 0n;
      try {
        const slot = await a.deriveStorageSlotInMap(new a.Fr(1), address);
        const value = await aztecNode.getPublicStorageAt('latest', a.FeeJuiceAddress, slot);
        balance = value ? BigInt(value.toString()) : 0n;
      } catch (e) {}
      return {
        ok: true,
        address: address.toString(),
        feeJuiceBalance: balance.toString(),
        handles: { aztecNode, rawNode, address, nodeInfo, l1Contracts },
      };
    }

    // ============================================================
    // Step 3: Get ETH signer (not needed for 'claim' action)
    // ============================================================
    let ethSigner = null;
    let provider = null;
    let ethAddr = null;
    if (action !== 'claim') {
      log('Step 3: Setting up ETH signer...', 'info');
      if (config.ethWallet && config.ethWallet.privateKey) {
        provider = new ethers.JsonRpcProvider(config.ethRpcUrl);
        ethSigner = new ethers.Wallet(config.ethWallet.privateKey, provider);
        log('  ETH address: ' + ethSigner.address, 'success');
      } else if (env.getBrowserSigner) {
        ethSigner = await env.getBrowserSigner();
        log('  ETH address: ' + ethSigner.address, 'success');
      } else {
        throw new Error('ETH wallet with privateKey is required (or provide getBrowserSigner).');
      }
      provider = ethSigner.provider;
      ethAddr = ethSigner.address;
    }



    // ============================================================
    // Scan action: scan L1 for existing deposits, return first unclaimed
    // ============================================================
    if (action === 'scan') {
      log('Scanning L1 for existing FeeJuice deposits...', 'info');
      const depositTopic = ethers.id('DepositToAztecPublic(bytes32,uint256,bytes32,bytes32,uint256)');

      // Sign ONCE — the signature is deterministic and reused for all deposits
      log('  Signing message to derive claim secrets...', 'info');
      const sig = await ethSigner.signMessage(FEE_JUICE_SIGN_MSG);
      if (!ethers.isHexString(sig, 65)) {
        throw new Error('Unexpected signature format.');
      }
      log('  Signature obtained.', 'success');

      // Helper: process a single deposit log entry → depositInfo or null
      // Uses secret-hash matching instead of sender-address filtering.
      // The hash match proves the deposit belongs to this wallet's key.
      async function processDepositLog(logEntry) {
        let txData;
        try { txData = await provider.getTransaction(logEntry.transactionHash); } catch { return null; }
        if (!txData) return null;

        const nonce = txData.nonce;
        const amount = BigInt('0x' + logEntry.data.slice(2, 66));
        const onChainSecretHash = '0x' + logEntry.data.slice(66, 130).toLowerCase();
        const onChainKey = '0x' + logEntry.data.slice(130, 194).toLowerCase(); // actual L1→L2 message hash
        const idx = BigInt('0x' + logEntry.data.slice(194, 258));

        // Derive claim secret using the tx nonce + our signature
        const secret = deriveSecretFromInputs(ethers, ethAddr, nonce, sig);
        const secretHashBigInt = await computeSecretHashBundle(a, BigInt(secret));
        const computedHash = frToHex(secretHashBigInt).toLowerCase();

        // If hash doesn't match, this deposit doesn't belong to us
        if (computedHash !== onChainSecretHash) return null;

        // Check that the deposit's `to` address matches our Aztec wallet address.
        // The `to` field is an indexed event parameter (topics[1]).
        // A deposit to a different Aztec account can't be claimed by us.
        const onChainTo = logEntry.topics[1].toLowerCase();
        const ourAddrHex = '0x' + BigInt(address.toString()).toString(16).padStart(64, '0');
        if (onChainTo !== ourAddrHex.toLowerCase()) {
          log('  Secret matches but deposit is to a different Aztec address — skipping.', 'warn');
          log('  Deposit to: ' + onChainTo.substring(0, 18) + '...', 'info');
          log('  Our address: ' + ourAddrHex.substring(0, 18) + '...', 'info');
          return null;
        }

        log('  Match found! tx ' + logEntry.transactionHash.substring(0, 12) + '...', 'success');
        log('  Nonce: ' + nonce + ', Amount: ' + toAztec(amount, 6) + ' AZTEC, Leaf: ' + idx.toString(), 'info');

        // Use the on-chain key as the message hash — it's the actual leaf in the inbox tree.
        // This is more reliable than recomputing it (which depends on chainId, version, etc).
        const claimSecretFr = new a.Fr(BigInt(secret));
        const msgHashFr = new a.Fr(BigInt(onChainKey));
        const nullifierFr = await a.computeFeeJuiceMessageNullifier(msgHashFr, claimSecretFr);
        let consumed = false;
        try {
          const siloed = await a.siloNullifier(new a.Fr(FEE_JUICE), nullifierFr);
          const nullIdx = await aztecNode.findLeavesIndexes('latest', 0, [siloed]);
          consumed = nullIdx !== null && nullIdx !== undefined && nullIdx[0] !== null && nullIdx[0] !== undefined;
        } catch (e) {}

        if (consumed) {
          log('  Already claimed.', 'warn');
          return null;
        }

        // Check if message is available (in tree = checkpointed)
        let isAvailable = false;
        try {
          const witness = await aztecNode.getL1ToL2MessageMembershipWitness('latest', msgHashFr);
          // If witness exists, the message is in the tree and checkpointed.
          // The only thing that could prevent claiming is a consumed nullifier,
          // which we already checked above.
          isAvailable = !!witness;
        } catch (e) {}

        log('  Found unclaimed deposit! Available: ' + isAvailable, 'success');
        return {
          amount: amount.toString(),
          secret: secret,
          leafIndex: idx.toString(),
          txHash: logEntry.transactionHash,
          available: isAvailable,
          messageHash: onChainKey,
        };
      }

      let foundInfo = null;

      // Targeted recovery: if reuseTxHash provided, fetch that specific tx's logs
      if (config.reuseTxHash) {
        log('  Targeted recovery for tx ' + config.reuseTxHash.substring(0, 12) + '...', 'info');
        const receipt = await provider.getTransactionReceipt(config.reuseTxHash);
        if (!receipt) throw new Error('No transaction found for hash: ' + config.reuseTxHash);
        const iface = new ethers.Interface(DEPOSIT_EVENT_ABI);
        for (const l of receipt.logs) {
          try {
            const parsed = iface.parseLog(l);
            if (parsed && parsed.name === 'DepositToAztecPublic') {
              foundInfo = await processDepositLog(l);
              if (foundInfo) break;
            }
          } catch {}
        }
      } else {
        // Backward scan in 5000-block chunks
        const currentBlock = await provider.getBlockNumber();
        const CHUNK = 5000;
        const MAX_BLOCKS = 50000;
        log('  Scanning blocks ' + (currentBlock - MAX_BLOCKS) + ' to ' + currentBlock + '...', 'info');

        for (let end = currentBlock; end >= Math.max(0, currentBlock - MAX_BLOCKS); end -= CHUNK) {
          const from = Math.max(0, end - CHUNK + 1);
          log('  Scanning blocks ' + from + '–' + end + '...', 'info');
          let logs;
          try {
            logs = await provider.getLogs({
              address: FEE_JUICE_PORTAL_ADDR,
              topics: [depositTopic],
              fromBlock: from,
              toBlock: end,
            });
          } catch (e) {
            log('  Range ' + from + '-' + end + ' failed: ' + (e.message || e).substring(0, 80), 'warn');
            continue;
          }
          if (logs.length === 0) continue;

          log('  Found ' + logs.length + ' deposit event(s) in this range — checking for match...', 'info');
          // Process logs newest to oldest
          for (let i = logs.length - 1; i >= 0; i--) {
            foundInfo = await processDepositLog(logs[i]);
            if (foundInfo) break;
          }
          if (foundInfo) break;
        }
      }

      if (!foundInfo) {
        log('  No unclaimed FeeJuice deposits found.', 'info');
        return { ok: false, reason: 'No unclaimed deposits found' };
      }
      return { ok: true, depositInfo: foundInfo, handles: { aztecNode, address } };
    }

    // ============================================================
    // Step 4: Check AZTEC token balance on L1 & swap if needed
    // (skipped for 'claim' action)
    // ============================================================
    let totalAztec = 0n;
    let aztecDecimals = 18;
    const token = new ethers.Contract(AZTEC_TOKEN_ADDR, ERC20_ABI, provider);
    if (action !== 'claim') {
    try { aztecDecimals = await token.decimals(); } catch {}
    log('  AZTEC token decimals: ' + aztecDecimals, 'info');

    const currentBalance = await token.balanceOf(ethAddr);
    log('  Current AZTEC token balance on L1: ' + ethers.formatUnits(currentBalance, aztecDecimals) + ' (' + currentBalance.toString() + ' raw)', 'info');

    totalAztec = currentBalance;

    // Step 4: Swap ETH → AZTEC via Uniswap V3 (if requested)
    // If ethForSwap is provided, always swap (regardless of current balance)
    if (config.ethForSwap && parseFloat(config.ethForSwap) > 0) {
      // Swap ETH → AZTEC via Uniswap V3
      const ethIn = ethers.parseEther(config.ethForSwap);
      log('Step 4: Swapping ' + config.ethForSwap + ' ETH for AZTEC via Uniswap V3...', 'info');

      const ethBal = await provider.getBalance(ethAddr);
      log('  ETH balance: ' + ethers.formatEther(ethBal), 'info');
      if (ethBal < ethIn) {
        throw new Error('Insufficient ETH balance. Need ' + config.ethForSwap + ' ETH, have ' + ethers.formatEther(ethBal));
      }

      // Get a quote — try multiple fee tiers
      const quoter = new ethers.Contract(QUOTER_V1, QUOTER_ABI, provider);
      const tiers = [10000, 3000, 500, 100];
      let amountOut = null;
      let feeTier = null;
      let lastErr = null;
      for (const t of tiers) {
        try {
          amountOut = await quoter.quoteExactInputSingle.staticCall(WETH, AZTEC_TOKEN_ADDR, t, ethIn, 0);
          feeTier = t;
          break;
        } catch (e) { lastErr = e; }
      }
      if (amountOut === null) {
        throw new Error('No Uniswap V3 WETH/AZTEC pool found at any fee tier. ' + (lastErr?.message || ''));
      }

      log('  Pool fee tier: ' + (feeTier/10000) + '%', 'info');
      log('  Expected output: ' + ethers.formatUnits(amountOut, aztecDecimals) + ' AZTEC', 'info');

      // Slippage: 5% default
      const slippagePct = parseFloat(config.slippage || '5');
      const slippageBps = BigInt(Math.round(slippagePct * 100));
      const amountOutMin = (amountOut * (10000n - slippageBps)) / 10000n;

      const deadline = BigInt(Math.floor(Date.now() / 1000) + 600); // 10 min
      const router = new ethers.Contract(SWAP_ROUTER, ROUTER_ABI, ethSigner);

      const params = {
        tokenIn: WETH,
        tokenOut: AZTEC_TOKEN_ADDR,
        fee: feeTier,
        recipient: ethAddr,
        deadline: deadline,
        amountIn: ethIn,
        amountOutMinimum: amountOutMin,
        sqrtPriceLimitX96: 0,
      };

      log('  Sending swap tx...', 'info');
      const tx = await router.exactInputSingle(params, { value: ethIn });
      log('  Swap tx sent: ' + tx.hash, 'info');
      log('  Waiting for L1 confirmation...', 'info');
      const rc = await tx.wait();
      if (rc.status !== 1) throw new Error('Swap tx reverted in block ' + rc.blockNumber);
      log('  Swap confirmed in block ' + rc.blockNumber, 'success');

      // Check new balance
      totalAztec = await token.balanceOf(ethAddr);
      log('  New AZTEC balance: ' + ethers.formatUnits(totalAztec, aztecDecimals), 'success');
    } else {
      log('Step 4: No ETH swap requested. Using existing balance only.', 'info');
    }
    } // end if (action !== 'claim')

    // ============================================================
    // Step 5: Deposit AZTEC to L2 via FeeJuicePortal (or skip if claim-only)
    // ============================================================
    let depositAmount, claimSecretHex, leafIndex;
    let depositTxHash = '';
    let parsedKey = null;

    if (action === 'claim') {
      // Claim-only mode: use provided deposit info, skip swap/deposit
      log('Step 5: Claim mode — using provided deposit info.', 'info');
      depositAmount = BigInt(config.depositAmount);
      claimSecretHex = config.depositSecret;
      leafIndex = BigInt(config.depositLeafIndex);
      log('  Amount: ' + depositAmount.toString() + ' wei (' + toAztec(depositAmount, 6) + ' AZTEC)', 'info');
      log('  Leaf index: ' + leafIndex.toString(), 'info');
      log('  Secret: ' + claimSecretHex, 'info');
    } else {
      // Normal mode: deposit specified amount or ALL AZTEC we have
      depositAmount = config.depositAmount ? ethers.parseEther(config.depositAmount) : totalAztec;
      if (depositAmount === 0n) {
        throw new Error('No AZTEC tokens to deposit. Provide --eth-for-swap to swap ETH for AZTEC.');
      }

      log('Step 5: Depositing ' + ethers.formatUnits(depositAmount, aztecDecimals) + ' AZTEC to L2...', 'info');

    const portal = new ethers.Contract(FEE_JUICE_PORTAL_ADDR, FEE_JUICE_PORTAL_ABI, ethSigner);

    // 5a: Approve
    const allow = await token.allowance(ethAddr, FEE_JUICE_PORTAL_ADDR);
    if (allow < depositAmount) {
      log('  Approving AZTEC to FeeJuicePortal...', 'info');
      const ap = await token.connect(ethSigner).approve(FEE_JUICE_PORTAL_ADDR, depositAmount);
      log('  Approve tx sent: ' + ap.hash, 'info');
      await ap.wait();
      log('  Approval confirmed.', 'success');
    } else {
      log('  Sufficient allowance already set.', 'info');
    }

    // 5b: Derive claim secret (deterministic from wallet signature + nonce)
    const depNonce = await provider.getTransactionCount(ethAddr, 'pending');
    log('  Deriving claim secret (nonce: ' + depNonce + ')...', 'info');
    const sig = await ethSigner.signMessage(FEE_JUICE_SIGN_MSG);
    if (!ethers.isHexString(sig, 65)) {
      throw new Error('Unexpected signature format.');
    }
    const secret = deriveSecretFromInputs(ethers, ethAddr, depNonce, sig);
    claimSecretHex = secret;
    const secretBigInt = BigInt(secret);
    const secretHashBigInt = await computeSecretHashBundle(a, secretBigInt);
    const secretHash = frToHex(secretHashBigInt);

    // Sanity: secretHash must be < field modulus (254 bits)
    const topByte = parseInt(secretHash.slice(2, 4), 16);
    if ((topByte & 0xc0) !== 0) {
      throw new Error('Derived secretHash is > 254 bits (rare statistical fluke). Send any tx to bump your nonce and try again.');
    }

    log('  Claim secret: ' + secret, 'info');
    log('  Secret hash:  ' + secretHash, 'info');

    // 5c: Deposit (pinned nonce)
    const aztecRecipient = address.toString();
    const aztecRecipientHex = '0x' + BigInt(aztecRecipient).toString(16).padStart(64, '0');
    log('  Recipient: ' + aztecRecipient, 'info');

    log('  Sending deposit tx (pinned nonce ' + depNonce + ')...', 'info');
    const tx = await portal.depositToAztecPublic(aztecRecipientHex, depositAmount, secretHash, { nonce: depNonce });
    log('  Deposit tx sent: ' + tx.hash, 'info');
    log('  Waiting for L1 confirmation...', 'info');

    const startTime = Date.now();
    let rc = null;
    while (!rc) {
      try { rc = await provider.getTransactionReceipt(tx.hash); } catch (e) {}
      if (rc) break;
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      log('  [L1 pending, ' + elapsed + 's] Not yet mined...', 'info');
      await sleep(12000);
    }
    if (rc.status !== 1) {
      throw new Error('L1 deposit tx reverted in block ' + rc.blockNumber);
    }
    log('  Deposit confirmed in L1 block ' + rc.blockNumber + ' (' + Math.floor((Date.now() - startTime) / 1000) + 's).', 'success');

    // 5d: Parse event for (key, leafIndex)
    let parsedLeafIndex = null;
    try {
      const iface = new ethers.Interface(DEPOSIT_EVENT_ABI);
      for (const l of rc.logs) {
        try {
          const parsed = iface.parseLog(l);
          if (parsed && parsed.name === 'DepositToAztecPublic') { parsedLeafIndex = parsed.args.index; parsedKey = parsed.args.key; break; }
        } catch {}
      }
    } catch {}
    if (parsedLeafIndex === null) throw new Error('Could not parse leaf index from deposit event.');
    leafIndex = BigInt(parsedLeafIndex.toString());
    log('  Leaf index: ' + leafIndex.toString(), 'info');
    log('  L1 tx hash: ' + tx.hash, 'info');
    depositTxHash = tx.hash;
    } // end else (non-claim-only)

    // ============================================================
    // Step 6: Wait for L1→L2 message to be checkpointed
    // ============================================================
    log('Step 6: Waiting for L1→L2 message to be checkpointed on L2...', 'info');
    log('  This takes ~5-10 minutes after L1 confirmation.', 'info');

    const claimSecretFr = new a.Fr(BigInt(claimSecretHex));
    // Use on-chain message hash if available (from event log or scan), otherwise compute it
    let msgHashFr;
    if (config.depositMessageHash) {
      msgHashFr = new a.Fr(BigInt(config.depositMessageHash));
    } else if (parsedKey) {
      msgHashFr = new a.Fr(BigInt(parsedKey));
    } else {
      msgHashFr = await computeL1ToL2MsgHash(a, ethers, aztecNode, address, depositAmount, claimSecretFr, BigInt(leafIndex.toString()));
    }
    const msgHex = '0x' + BigInt(msgHashFr.toString()).toString(16).padStart(64, '0');
    log('  Message hash: ' + msgHex, 'info');

    const pollInterval = 20000;
    const maxWait = 900000; // 15 min
    const waitStart = Date.now();
    let msgReady = false;
    let pollAttempt = 0;

    while (Date.now() - waitStart < maxWait) {
      pollAttempt++;
      const elapsed = Math.floor((Date.now() - waitStart) / 1000);
      log('  [poll ' + pollAttempt + ', ' + elapsed + 's] Checking message availability...', 'info');

      let witness = null;
      try { witness = await aztecNode.getL1ToL2MessageMembershipWitness('latest', msgHashFr); } catch (e) {}

      if (witness !== null && witness !== undefined) {
        log('  Message is in tree and available!', 'success');
        log('  Leaf index: ' + witness[0], 'info');
        msgReady = true;
        break;
      } else {
        log('  Not in tree yet...', 'info');
      }
      await sleep(pollInterval);
    }

    if (!msgReady) {
      throw new Error('Timed out waiting for L1→L2 message to be checkpointed. Try again later.');
    }

    // Early return for 'deposit' action
    if (action === 'deposit') {
      log('Deposit complete and checkpointed!', 'success');
      return {
        ok: true,
        depositInfo: {
          amount: depositAmount.toString(),
          secret: claimSecretHex,
          leafIndex: leafIndex.toString(),
          txHash: depositTxHash,
          messageHash: parsedKey ? ('0x' + BigInt(parsedKey).toString(16).padStart(64, '0')) : undefined,
        },
        handles: { aztecNode, address },
      };
    }

    // ============================================================
    // Steps 7-9: CRS + PXE + Wallet (with setup cache)
    // ============================================================
    const sKey = _setupKey(config);
    const cached = _setupCache.get(sKey);
    let pxe, wallet;
    let accountManager = null;
    if (cached) {
      log('  Reusing cached PXE/wallet setup.', 'success');
      pxe = cached.pxe;
      wallet = cached.wallet;
      accountManager = cached.accountManager;
      try { await pxe.sync(); } catch (e) {}
    } else {
      log('Step 7: Initializing CRS...', 'info');
      await initCRS();
      log('  CRS ready.', 'success');

      log('Step 8: Creating PXE...', 'info');
      const dataDirPrefix = (config.dataDirPrefix || 'pxe_fj_') + address.toString().slice(0, 16) + '_';
      const storeConfig = { ...l1Contracts, l1ChainId: nodeInfo.l1ChainId, dataDirectory: dataDirPrefix + l1Contracts.rollupAddress };
      const store = await createStore(storeConfig);
      pxe = await a.createPXE(aztecNode, {
        proverEnabled: true, autoSync: true,
        dataDirectory: dataDirPrefix + l1Contracts.rollupAddress,
      }, { store });
      log('  PXE created.', 'success');

      log('  Registering account with PXE...', 'info');
      const derivedKeys = await a.deriveKeys(secretKey);
      await pxe.registerAccount(derivedKeys, partialAddress);
      log('  Account registered.', 'success');

      log('  Registering Schnorr initializerless account contract...', 'info');
      await retry(() => pxe.registerContractClass(a.SchnorrInitializerlessAccountContractArtifact), 'register', log, 5);
      await retry(() => pxe.registerContract(instance), 'register', log, 5);
      log('  Contract registered.', 'success');

      log('  Syncing PXE with node...', 'info');
      await pxe.sync();
      log('  PXE synced.', 'success');

      // ============================================================
      // Step 9: Create wallet + store signing key capsule
      // ============================================================
      log('Step 9: Creating wallet...', 'info');
      wallet = createAztecWallet(a, pxe, aztecNode, rawNode, log, secretKey, {
        preProveHook: async ({ maxFee }) => {
          log('  Claim amount: ' + depositAmount.toLocaleString() + ' (' + toAztec(depositAmount, 4) + ' AZTEC)', 'info');
          if (maxFee > depositAmount) {
            const deficit = maxFee - depositAmount;
            log('  ABORTED: Claim amount insufficient to cover fee.', 'error');
            log('  Need ' + toAztec(maxFee, 4) + ' AZTEC, have ' + toAztec(depositAmount, 4) + ' AZTEC', 'error');
            log('  Shortfall: ' + toAztec(deficit, 4) + ' AZTEC', 'error');
            throw new Error('Insufficient claim amount for fee.');
          }
          log('  Claim amount sufficient for fee. Proceeding.', 'success');
        },
      });
      accountManager = await a.AccountManager.create(wallet, secretKey, accountContract, { salt: new a.Fr(saltVal) });
      wallet._accountManager = accountManager;
      log('  Wallet ready.', 'success');

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

      // Cache the setup
      _setupCache.set(sKey, { pxe, wallet, accountManager });
    }

    // ============================================================
    // Step 9: Check if account is already deployed on L2
    // ============================================================
    // Use aztecNode.getContract(address) — the most reliable check.
    // (getContractInstance is not available in the v5 bundle, and
    //  instance.initializationHash may be 0 for initializerless contracts,
    //  making the nullifier-based check unreliable.)
    log('Step 10: Checking if account is deployed on L2...', 'info');
    let isDeployed = false;
    try {
      const existing = await aztecNode.getContract(address);
      if (existing && existing.originalContractClassId) {
        isDeployed = true;
        log('  Account IS already deployed (contract found on L2).', 'success');
      }
    } catch (e) {
      // getContract throws if not found
    }
    if (!isDeployed) {
      log('  Account NOT deployed. Will deploy + claim in one tx.', 'info');
    }

    // ============================================================
    // Step 10: Pre-flight check — verify L1→L2 message is claimable
    // ============================================================
    log('Step 11: Pre-flight check — verifying L1→L2 message is claimable...', 'info');
    // Use on-chain message hash if available (from event log or scan), otherwise compute it
    let msgHashFr2;
    if (config.depositMessageHash) {
      msgHashFr2 = new a.Fr(BigInt(config.depositMessageHash));
    } else if (parsedKey) {
      msgHashFr2 = new a.Fr(BigInt(parsedKey));
    } else {
      msgHashFr2 = await computeL1ToL2MsgHash(a, ethers, aztecNode, address, depositAmount, claimSecretFr, BigInt(leafIndex.toString()));
    }
    const nullifierFr = await a.computeFeeJuiceMessageNullifier(msgHashFr2, claimSecretFr);
    let consumed = false;
    try {
      const siloedNull = await a.siloNullifier(new a.Fr(FEE_JUICE), nullifierFr);
      const nullIdx = await aztecNode.findLeavesIndexes('latest', 0, [siloedNull]);
      consumed = nullIdx !== null && nullIdx !== undefined && nullIdx[0] !== null && nullIdx[0] !== undefined;
    } catch (e) {}
    if (consumed) {
      log('  This deposit has already been claimed (nullifier consumed).', 'error');
      throw new Error('Deposit already claimed.');
    }
    log('  Pre-flight OK — message is claimable.', 'success');

    // ============================================================
    // Step 11: Claim fee juice on L2
    // ============================================================
    log('Step 12: Claiming Fee Juice on L2...', 'info');

    const feePaymentMethod = new a.FeeJuicePaymentMethodWithClaim(address, {
      claimAmount: depositAmount,
      claimSecret: claimSecretFr,
      messageLeafIndex: BigInt(leafIndex.toString()),
    });
    log('  Claim: amount=' + depositAmount + ', leafIndex=' + leafIndex.toString(), 'info');

    try {
      if (!isDeployed) {
        log('  Deploying account + claiming fee juice in one tx...', 'info');
        log('  The wallet will simulate (seconds), then prove (~14 min).', 'info');
        const account = await accountManager.getAccount();
        const deployArtifact = await accountManager.getAccountContract().getContractArtifact();

        const signingPublicKey = await accountManager.getAccountContract().getSigningPublicKey();
        const pubKeySlot = await a.poseidon2HashBytes(Buffer.from('INITIALIZERLESS_ACCOUNT_PUB_KEY', 'utf8'));
        const signingKeyCapsule = new a.Capsule(
          address,
          pubKeySlot,
          [signingPublicKey.x, signingPublicKey.y],
          address
        );
        log('  Built signing key capsule for tx.', 'info');

        const deployMethod = new a.DeployAccountMethod(
          accountManager.getPublicKeys(),
          wallet,
          deployArtifact,
          (instance) => a.Contract.at(instance.address, deployArtifact, wallet),
          accountManager.instance.salt,
          accountManager.instance.immutablesHash,
          account,
          [],
          undefined,
          [],
          [signingKeyCapsule]
        );
        log('  Got deploy method. Sending tx...', 'info');

        const result = await deployMethod.send({
          from: address,
          fee: { paymentMethod: feePaymentMethod },
          skipClassPublication: false,
          skipInstancePublication: false,
        });
        const receipt = result.receipt;
        log('  TX CONFIRMED!', 'success');
        log('  Tx hash: ' + receipt.txHash, 'success');
        log('  Block: ' + receipt.blockNumber + ', Status: ' + receipt.status, 'info');
        if (receipt.transactionFee !== undefined) {
          log('  Fee paid: ' + toAztec(BigInt(receipt.transactionFee), 6) + ' AZTEC', 'info');
        }
      } else {
        log('  Claiming fee juice (account already deployed)...', 'info');
        log('  The wallet will simulate (seconds), then prove (~14 min).', 'info');

        const claimPayload = await feePaymentMethod.getExecutionPayload();
        log('  Got claim payload. Sending tx...', 'info');

        const result = await wallet.sendTx(claimPayload, {
          from: address,
        });
        const receipt = result.receipt;
        log('  TX CONFIRMED!', 'success');
        log('  Tx hash: ' + receipt.txHash, 'success');
        log('  Block: ' + receipt.blockNumber + ', Status: ' + receipt.status, 'info');
        if (receipt.transactionFee !== undefined) {
          log('  Fee paid: ' + toAztec(BigInt(receipt.transactionFee), 6) + ' AZTEC', 'info');
        }
      }

      log('', 'success');
      log('========================================', 'success');
      log('  Fee Juice claimed successfully!', 'success');
      log('  Your L2 account now has Fee Juice for paying tx fees.', 'success');
      log('========================================', 'success');
    } catch (err) {
      const msg = err.message || String(err);
      log('  Original error: ' + (msg.length > 300 ? msg.substring(0, 300) + '...' : msg), 'warn');
      if (/duplicate.*nullifier|nullifier.*duplicate|already.*claim/i.test(msg)) {
        log('  This deposit has already been claimed.', 'error');
        throw new Error('Deposit already claimed.');
      }
      throw err;
    }

    // ============================================================
    // Step 12: Verify final L2 balance
    // ============================================================
    log('Step 13: Verifying final L2 Fee Juice balance...', 'info');
    // Wait a bit for the node to index the new balance
    await sleep(10000);
    try {
      const slot = await a.deriveStorageSlotInMap(new a.Fr(1), address);
      const value = await aztecNode.getPublicStorageAt('latest', a.FeeJuiceAddress, slot);
      const balance = value ? BigInt(value.toString()) : 0n;
      log('  Final Fee Juice balance: ' + toAztec(balance, 6) + ' AZTEC', 'success');
      if (balance > 0n) {
        log('', 'success');
        log('========================================', 'success');
        log('  CONFIRMED: Fee Juice is ready on L2!', 'success');
        log('  Balance: ' + toAztec(balance, 6) + ' AZTEC', 'success');
        log('========================================', 'success');
        return { ok: true, balance: balance.toString() };
      } else {
        log('  Balance is 0 — the claim tx may still be settling.', 'warn');
        log('  Wait a few minutes and check again.', 'warn');
        return { ok: false, reason: 'Balance not yet visible' };
      }
    } catch (e) {
      log('  Could not verify balance: ' + extractErrorMessage(e), 'warn');
      return { ok: false, reason: extractErrorMessage(e) };
    }
  };
})();
