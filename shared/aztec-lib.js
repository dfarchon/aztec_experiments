// ============================================================
// aztec-lib.js -- Shared Aztec wallet/PXE/CRS infrastructure
// ============================================================
// Used by all apps that need PXE/wallet/CRS: fee-juice, billboard/deploy,
// billboard/user. (L1-only pages within apps use ethers directly.)
//
// This file is injected via the AZTEC_LIB build placeholder.
// It depends on helpers.js (log, withBtn, clearStatus, toAztec)
// and the aztec_bundle.js (window.__aztec).

const A = () => window.__aztec;

// ============================================================
// RPC config -- injected by build system from shared/rpc-config.json
// Monkey-patches fetch to add x-aztec-api-key header for all requests
// to the Aztec RPC endpoint.
// ============================================================
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

// Helper: get the node URL from RPC_CONFIG, falling back to the DOM input
function getNodeUrl() {
  const cfg = window.RPC_CONFIG;
  if (cfg && cfg.nodeUrl) return cfg.nodeUrl;
  const el = document.getElementById('nodeUrl');
  return el ? el.value.trim() : '';
}

// CRS configuration
const CRS_HOSTS = ["https://crs.aztec-cdn.foundation", "https://crs.aztec-labs.com"];
const SRS_NUM_POINTS = 2 ** 20 + 1;
const GRUMPKIN_NUM_POINTS = 2 ** 16 + 1;

// Transient error detection regex (used by multiple retry helpers)
const TRANSIENT_RE = /temporary internal error|please retry|timeout|fetch|network|connection|ECONNRESET|socket/i;

// ============================================================
// createRetryFn -- returns a retry helper that logs to statusId
// ============================================================
function createRetryFn(statusId, label, maxRetries = 5) {
  return async function retry(fn) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try { return await fn(); }
      catch (err) {
        const isTransient = TRANSIENT_RE.test(err.message || '');
        if (!isTransient || attempt === maxRetries) throw err;
        const delay = 2000 * attempt;
        if (label) log('  [' + label + '] transient error (attempt ' + attempt + '/' + maxRetries + '), retrying in ' + delay/1000 + 's...', 'warn', statusId);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  };
}

// ============================================================
// wrapWithRetry -- wraps an aztecNode client in a retrying Proxy
// ============================================================
function wrapWithRetry(obj, label, statusId) {
  return new Proxy(obj, {
    get(target, prop) {
      const val = target[prop];
      if (typeof val !== 'function') return val;
      return async (...args) => {
        const maxRetries = 8;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          try { return await val.apply(target, args); }
          catch (err) {
            const isTransient = TRANSIENT_RE.test(err.message || '');
            if (!isTransient || attempt === maxRetries) throw err;
            const delay = 2000 * attempt;
            if (label) log('  [' + label + '.' + String(prop) + '] transient error (attempt ' + attempt + '/' + maxRetries + '), retrying in ' + delay/1000 + 's...', 'warn', statusId);
            await new Promise(r => setTimeout(r, delay));
          }
        }
      };
    }
  });
}

// ============================================================
// initCRS -- load SRS data into BarretenbergSync
// ============================================================
async function initCRS(statusId) {
  const a = A();
  const S = statusId;

  log('Initializing CRS (loading SRS data)...', 'info', S);
  await a.BarretenbergSync.initSingleton();
  const bb = a.BarretenbergSync.getSingleton();

  async function fetchCRS(filename, options = {}) {
    try {
      const res = await fetch('/crs/' + filename, options);
      if (res.ok || res.status === 206) {
        log('  Loaded ' + filename + ' from local file.', 'info', S);
        return res;
      }
      throw new Error('HTTP ' + res.status);
    } catch (localErr) {
      log('  Local ' + filename + ' unavailable (' + localErr.message + '), falling back to CDN...', 'warn', S);
      let lastErr;
      for (const host of CRS_HOSTS) {
        try {
          const res = await fetch(host + '/' + filename, options);
          if (res.ok || res.status === 206) {
            log('  Loaded ' + filename + ' from ' + host + '.', 'info', S);
            return res;
          }
          lastErr = new Error('HTTP ' + res.status + ' from ' + host);
        } catch (e) { lastErr = e; }
      }
      throw lastErr;
    }
  }

  log('  Loading BN254 G1 data...', 'info', S);
  const g1End = SRS_NUM_POINTS * 64 - 1;
  const g1Res = await fetchCRS('g1.dat', { headers: { Range: 'bytes=0-' + g1End } });
  const g1Data = new Uint8Array(await g1Res.arrayBuffer());

  log('  Loading BN254 G2 data...', 'info', S);
  const g2Res = await fetchCRS('g2.dat');
  const g2Data = new Uint8Array(await g2Res.arrayBuffer());

  log('  Loading Grumpkin G1 data...', 'info', S);
  const grumpkinEnd = GRUMPKIN_NUM_POINTS * 64 - 1;
  const grumpkinRes = await fetchCRS('grumpkin_g1.dat', { headers: { Range: 'bytes=0-' + grumpkinEnd } });
  const grumpkinG1Data = new Uint8Array(await grumpkinRes.arrayBuffer());

  log('  Loading BN254 SRS into wasm...', 'info', S);
  bb.srsInitSrs({ pointsBuf: g1Data, numPoints: SRS_NUM_POINTS, g2Point: g2Data });
  log('  Loading Grumpkin SRS into wasm...', 'info', S);
  bb.srsInitGrumpkinSrs({ pointsBuf: grumpkinG1Data, numPoints: GRUMPKIN_NUM_POINTS });
  log('  CRS initialized.', 'success', S);
}

// ============================================================
// deriveAccountAddress -- derive Aztec address from secret key
// ============================================================
// Returns { secretKey, signingKey, accountContract, instance, address, partialAddress }
// or throws on error.
async function deriveAccountAddress(secretKeyHex, saltVal, explicitSigningKey) {
  const a = A();
  const secretKey = a.Fr.fromHexString(secretKeyHex);
  const signingKey = explicitSigningKey || a.deriveSigningKey(secretKey);
  // v5: Use SchnorrInitializerlessAccountContract for self-deployment.
  // The regular SchnorrAccountContract stores its signing key in a private note
  // created by the constructor. But during self-deployment (deploy + claim fee
  // juice in one tx), the entrypoint runs BEFORE the constructor, so get_note()
  // fails with "Failed to get a note".
  // The initializerless variant stores the signing key in a capsule (in-memory
  // PXE store) and verifies against immutables_hash in the contract instance,
  // so it works for self-deployment.
  const accountContract = new a.SchnorrInitializerlessAccountContract(signingKey);
  const { publicKeys } = await a.deriveKeys(secretKey);
  const artifact = await accountContract.getContractArtifact();
  // Initializerless contract has no on-chain constructor; immutablesHash is
  // poseidon2Hash([pubKey.x, pubKey.y]).
  const immutablesHash = await accountContract.getImmutablesHash();
  const instance = await a.getContractInstanceFromInstantiationParams(artifact, {
    constructorArtifact: undefined,
    constructorArgs: undefined,
    salt: new a.Fr(saltVal),
    publicKeys,
    immutablesHash,
  });
  const partialAddress = await a.computePartialAddress(instance);
  const address = instance.address;
  return { secretKey, signingKey, accountContract, artifact, instance, address, partialAddress };
}

// ============================================================
// showAddress -- UI helper: derive and display account address
// ============================================================
// Reads secretKey and salt from DOM inputs, logs address to statusId.
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

// ============================================================
// setupWalletFileInput -- attach wallet.json loading to file input
// ============================================================
// Call once at script load time. When the user selects a wallet.json file,
// populates the secretKey and salt inputs and calls onLoaded().
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

// Load a wallet file object into the secretKey/salt fields
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

// Open file picker and return a promise that resolves when the wallet is loaded.
// If the user cancels the picker, the promise rejects.
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

// ============================================================
// createAztecWallet -- create a wallet with gas estimation + prove/submit split
// ============================================================
// Returns a wallet instance (subclass of BaseWallet) that:
// 1. Simulates to estimate gas (with retry)
// 2. Pads gas by 10%
// 3. Calls optional preProveHook (can abort before wasting time on proving)
// 4. Proves the tx (slow, no retry)
// 5. Submits with extended retry (20 attempts, up to 30s delays)
// 6. Polls for receipt with retry
//
// rawNode is the unwrapped aztecNode client (for controlled retry on submit).
// statusId is the DOM element ID for logging.
// opts.preProveHook: async function({ gasLimits, maxFee, feeOptions }) called
//   after gas estimation but before proving. If it throws, proving is aborted.
function createAztecWallet(pxe, aztecNode, rawNode, statusId, opts = {}) {
  const a = A();
  const S = statusId;

  class AztecWallet extends a.BaseWallet {
    constructor(pxe, aztecNode) {
      super(pxe, aztecNode);
      this._accountManager = null;
      this._account = null;
      this._estimatedGasPadding = 0.1;
      this._secretKey = null; // set by ensureAztecSetup
      this.onTxPrepared = null; // Optional recovery hook, before network submission.
    }
    // v5: Override registerContract to also register the account with the PXE's
    // addressStore. In v5, DeployMethod.request() calls wallet.registerContract(instance,
    // artifact) WITHOUT the secretKeyOrKeys parameter, so the account never gets
    // registered in the addressStore. Without that, the simulation oracle
    // get_public_keys_and_partial_address fails with "Public keys not registered".
    // We fix this by passing the secret key so BaseWallet registers the account.
    async registerContract(instance, artifact, secretKeyOrKeys) {
      // Only the wallet's own account has these privacy keys. Passing them for
      // an unrelated application/FPC attempts to register a different address.
      const accountKey = this._accountManager?.address.equals(instance.address) ? this._secretKey : undefined;
      return super.registerContract(instance, artifact, secretKeyOrKeys ?? accountKey);
    }
    async getAccountFromAddress() {
      if (!this._account) this._account = await this._accountManager.getAccount();
      return this._account;
    }
    getAccounts() {
      return this._accountManager ? Promise.resolve([this._accountManager.address]) : Promise.resolve([]);
    }

    async sendTx(executionPayload, opts) {
      log('  Estimating gas (simulating tx)...', 'info', S);
      const feeOptions = await this.completeFeeOptions({
        from: opts.from,
        feePayer: executionPayload.feePayer,
        gasSettings: opts.fee?.gasSettings,
        forEstimation: true,
      });

      const simRetry = createRetryFn(S, 'simulation', 5);
      const simResult = await simRetry(() => this.simulateViaEntrypoint(executionPayload, {
        from: opts.from,
        feeOptions,
        skipTxValidation: true,
        skipFeeEnforcement: true,
        additionalScopes: opts.additionalScopes,
        sendMessagesAs: opts.sendMessagesAs,
      }));

      const gu = simResult.gasUsed;
      const pad = 1 + this._estimatedGasPadding;
      const gasLimits = gu.totalGas.mul(pad);
      const teardownGasLimits = gu.teardownGas.mul(pad);
      const maxFee = gasLimits.computeFee(feeOptions.gasSettings.maxFeesPerGas).toBigInt();

      log('  Estimated gas: L2=' + gasLimits.l2Gas.toLocaleString() + ' DA=' + gasLimits.daGas.toLocaleString(), 'info', S);
      log('  Max fee: ' + maxFee.toLocaleString() + ' Fee Juice (' + toAztec(maxFee, 4) + ' AZTEC)', 'info', S);

      // Optional pre-prove hook: allows callers to abort before the slow proving step.
      // Used by the Fee Juice claim app to check if claimAmount >= maxFee.
      if (this._preProveHook) {
        await this._preProveHook({ gasLimits, maxFee, feeOptions, teardownGasLimits });
      }

      const finalGasSettings = a.GasSettings.from({
        gasLimits: opts.fee?.gasSettings?.gasLimits ?? gasLimits,
        teardownGasLimits: opts.fee?.gasSettings?.teardownGasLimits ?? teardownGasLimits,
        maxFeesPerGas: feeOptions.gasSettings.maxFeesPerGas,
        maxPriorityFeesPerGas: feeOptions.gasSettings.maxPriorityFeesPerGas,
      });

      log('  Proving tx (can take minutes)...', 'info', S);

      // Split proving from submission so we can retry just the submission.
      // Re-proving would take another 13+ minutes, which is impractical.
      const feeOpts2 = await this.completeFeeOptions({
        from: opts.from,
        feePayer: executionPayload.feePayer,
        gasSettings: finalGasSettings,
      });
      const txRequest = await this.createTxExecutionRequestFromPayloadAndFee(executionPayload, opts.from, feeOpts2);
      const provenTx = await this.pxe.proveTx(txRequest, {
        scopes: this.scopesFrom(opts.from, opts.additionalScopes),
        senderForTags: this.senderForTagsFrom(opts.from, opts.sendMessagesAs),
      });
      const tx = await provenTx.toTx();
      const txHash = tx.getTxHash();
      if (this.onTxPrepared) await this.onTxPrepared(txHash.toString());
      log('  Proving complete. Submitting to node...', 'success', S);

      // Submit with extended retry (node may be temporarily overloaded).
      // Also handles the case where the first submission succeeds on the node
      // but the RPC response is lost (transient network error). In that case,
      // retries will get "Existing nullifier" or "duplicate" errors because
      // the tx is already in the mempool or already included. When we detect
      // those errors, we poll for the receipt instead of failing.
      const ALREADY_EXISTS_RE = /existing nullifier|already exists|duplicate.*tx|tx.*duplicate/i;
      let submitted = false;
      const submitRetry = async (fn, maxRetries = 20) => {
        for (let i = 1; i <= maxRetries; i++) {
          try { await fn(); submitted = true; return; }
          catch (err) {
            const msg = err.message || '';
            const isTransient = TRANSIENT_RE.test(msg);
            const isAlreadyExists = ALREADY_EXISTS_RE.test(msg);
            if (isAlreadyExists) {
              // The tx was likely already submitted successfully in a previous attempt.
              // Don't retry -- fall through to receipt polling below.
              log('  Tx may have already been submitted (got: ' + msg + '). Checking receipt...', 'warn', S);
              return;
            }
            if (!isTransient || i === maxRetries) throw err;
            const delay = Math.min(5000 * i, 30000);
            log('  Node busy (attempt ' + i + '/' + maxRetries + '), retrying in ' + (delay/1000) + 's...', 'warn', S);
            await new Promise(r => setTimeout(r, delay));
          }
        }
      };

      await submitRetry(() => rawNode.sendTx(tx));
      if (submitted) {
        log('  Tx submitted! Hash: ' + txHash.toString(), 'success', S);
      }

      // Poll for receipt (also covers the case where the tx was already
      // submitted but we didn't get confirmation due to a transient error)
      if (opts.wait === a.NO_WAIT) return { txHash };
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
          const t = TRANSIENT_RE.test(err.message || '');
          if (!t) throw err;
        }
        pollCount++;
        if (pollCount % 4 === 0) {
          const elapsed = Math.round((Date.now() - (deadline - timeout * 1000)) / 1000);
          log('  Waiting for confirmation... (' + elapsed + 's elapsed)', 'working', S);
        }
        await new Promise(r => setTimeout(r, interval * 1000));
      }
      if (!receipt) throw new Error('Tx ' + txHash.toString() + ' not confirmed within ' + timeout + 's');
      log('  Tx confirmed! Block: ' + receipt.blockNumber + ', Status: ' + receipt.status, 'success', S);
      return { receipt };
    }
  }

  const wallet = new AztecWallet(pxe, aztecNode);
  wallet._preProveHook = opts.preProveHook || null;
  return wallet;
}

// ============================================================
// ensureAztecSetup -- full setup: keys -> node -> CRS -> PXE -> wallet
// ============================================================
// Populates state.{secretKey, salt, address, partialAddress, rawNode,
// aztecNode, pxe, wallet, crsInit}. Returns true on success, false on error.
//
// state must be a mutable object. nodeId is the DOM input ID for the node URL.
// dataDirPrefix is used to namespace the PXE's IndexedDB (e.g. 'pxe_bb_').
async function ensureAztecSetup(state, statusId, opts = {}) {
  const a = A();
  const S = statusId;
  const nodeUrl = getNodeUrl();
  const sk = opts.secretKey ?? document.getElementById('secretKey')?.value.trim();
  const saltVal = BigInt(opts.salt ?? document.getElementById('salt')?.value.trim() ?? '0');
  const dataDirPrefix = opts.dataDirPrefix || 'pxe_bb_';
  const progress = (step, message) => opts.onProgress?.(step, 8, message);

  if (!sk) { log('Enter your secret key first.', 'error', S); return false; }

  // If already set up, reuse
  if (state.wallet && state.pxe) return true;

  // Step 1: Derive keys
  progress(1, '推导账号地址');
  log('Step 1: Deriving account keys...', 'info', S);
  const derived = await deriveAccountAddress(sk, saltVal, opts.signingKey);
  const { secretKey, accountContract, artifact, instance, address, partialAddress } = derived;
  log('  Address: ' + address.toString(), 'success', S);

  state.secretKey = secretKey;
  state.salt = saltVal;
  state.address = address;
  state.partialAddress = partialAddress;
  state.instance = instance;

  // Step 2: Create node client with retry
  progress(2, '连接 Aztec 节点');
  log('Step 2: Connecting to Aztec node...', 'info', S);
  const rawNode = a.createAztecNodeClient(nodeUrl);
  state.rawNode = rawNode;
  const aztecNode = wrapWithRetry(rawNode, 'node', S);
  state.aztecNode = aztecNode;
  const nodeInfo = await aztecNode.getNodeInfo();
  log('  L1 chain ID: ' + nodeInfo.l1ChainId, 'info', S);

  // Start the block monitor (top-right indicator)
  startBlockMonitor(aztecNode);

  // Step 3: Init CRS (if not done)
  progress(3, '准备证明环境');
  if (!state.crsInit && opts.proverEnabled !== false) {
    log('Step 3: Initializing CRS (one-time ~68MB download)...', 'info', S);
    await initCRS(S);
    state.crsInit = true;
  } else if (state.crsInit) {
    log('Step 3: CRS already initialized.', 'info', S);
  } else {
    log('Step 3: Skipping CRS for local synthetic-proof mode.', 'info', S);
  }

  // Step 4: Create PXE
  progress(4, '创建浏览器 PXE');
  // v5 defaults to SQLite-OPFS store which requires a Worker (./worker.js) —
  // that fails in a static IIFE bundle. Use the deprecated IndexedDB store instead,
  // which runs entirely on the main thread without Workers.
  log('Step 4: Creating in-browser PXE...', 'info', S);
  const l1Contracts = await aztecNode.getL1ContractAddresses();
  const store = await a.createIndexedDBStore('pxe_data', {
    ...l1Contracts,
    l1ChainId: (await aztecNode.getNodeInfo()).l1ChainId,
    dataDirectory: dataDirPrefix + l1Contracts.rollupAddress,
  });
  const pxe = await a.createPXE(aztecNode, {
    proverEnabled: opts.proverEnabled !== false,
    autoSync: true,
    dataDirectory: dataDirPrefix + l1Contracts.rollupAddress,
  }, { store });
  state.pxe = pxe;
  log('  PXE created.', 'success', S);

  // Step 5: Register account BEFORE syncing so the PXE discovers historical notes
  progress(5, '注册本地账号');
  // belonging to this account. If we sync first, all blocks are processed without
  // knowing about the account, and notes from previous sessions are never found.
  log('Step 5: Registering account with PXE...', 'info', S);
  const derivedKeys = await a.deriveKeys(secretKey);
  await pxe.registerAccount(derivedKeys, partialAddress);
  log('  Account registered.', 'success', S);

  // Step 6: Register account contract class
  progress(6, '注册账号合约');
  log('Step 6: Registering Schnorr initializerless account contract...', 'info', S);
  const retry = createRetryFn(S, 'register', 5);
  await retry(() => pxe.registerContractClass(a.SchnorrInitializerlessAccountContractArtifact));
  await retry(() => pxe.registerContract(instance));
  log('  Contract registered.', 'success', S);

  // Now sync -- the PXE will process all blocks with the account and contract
  // already known, so it will discover notes from previous sessions.
  log('  Syncing PXE with node (account already registered)...', 'info', S);
  await pxe.sync();
  log('  PXE synced.', 'success', S);

  // Step 7: Create wallet
  progress(7, '创建钱包');
  log('Step 7: Creating wallet...', 'info', S);
  const wallet = createAztecWallet(pxe, aztecNode, rawNode, S, { preProveHook: opts.preProveHook });
  const accountManager = await a.AccountManager.create(wallet, secretKey, accountContract, { salt: new a.Fr(saltVal) });
  wallet._accountManager = accountManager;
  wallet._secretKey = secretKey;
  state.wallet = wallet;
  log('  Wallet ready.', 'success', S);

  // Step 8: Store signing key capsule for initializerless account contract.
  progress(8, '准备签名密钥');
  // The SchnorrInitializerlessAccountContract's is_valid_impl loads the signing
  // public key from a capsule (in-memory PXE store) rather than a note. The
  // constructor utility function stores this capsule. We must simulate it here
  // so the capsule is available when the entrypoint runs during deployment.
  log('Step 8: Storing signing key capsule...', 'info', S);
  const signingPublicKey = await accountContract.getSigningPublicKey();
  const constructorArtifact = artifact.functions.find(f => f.name === 'constructor');
  if (constructorArtifact) {
    const storeCall = new a.ContractFunctionInteraction(
      wallet, instance.address, constructorArtifact,
      [signingPublicKey.x, signingPublicKey.y]
    );
    await storeCall.simulate({ from: instance.address });
    log('  Capsule stored.', 'success', S);
  } else {
    log('  WARNING: No constructor found in artifact, skipping capsule setup.', 'warn', S);
  }

  return true;
}

// ============================================================
// extractErrorMessage -- parse meaningful error from PXE/circuit errors
// ============================================================
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

// ============================================================
// getL2Timestamp -- get current L2 block timestamp
// ============================================================
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

// ============================================================
// preflightL1ToL2Message -- verify L1->L2 message exists before proving
// ============================================================
// Computes the same message hash the PXE will use, then queries the node to verify:
// 1. The message is in the inbox Merkle tree
// 2. The message has been checkpointed (available for consumption)
// 3. The nullifier has not already been spent (not already claimed)
//
// Uses Web Crypto API for SHA-256 and BarretenbergSync for Poseidon2.
// BarretenbergSync.initSingleton() is lightweight (just wasm init, no CRS download).
//
// For FeeJuice claims: the Inbox uses a "magic sender" -- when msg.sender == FEE_ASSET_PORTAL,
// it replaces the sender with address(uint160(FEE_JUICE_ADDRESS)) = 3.
// So both sender and recipient in the message hash are the FeeJuice L2 address (= 5).
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

  // Constants (from @aztec/constants and Inbox.sol)
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

// ============================================================
// waitForL1ToL2Message -- polls until the L1->L2 message is in the
// inbox tree AND checkpointed. Returns true on success, false on timeout.
// Uses the same msgHash computation as preflightL1ToL2Message.
// ============================================================
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

// ============================================================
// Fee Juice constants (Ethereum mainnet)
// ============================================================
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
// Domain-separated message for deterministic claim secret derivation
const FEE_JUICE_SIGN_MSG = 'Aztec fee-juice deposit claim secret v1\n\n' +
  'Signing this message derives (and recovers) your L1->L2 claim secret. ' +
  'It does not authorize any transaction.';
// (SECRET_HASH_DOMAIN is declared locally in preflightL1ToL2Message and in poseidon2.js)
