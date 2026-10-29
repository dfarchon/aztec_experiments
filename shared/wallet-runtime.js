// Shared wallet/PXE runtime. Historical apps load this before aztec-lib.js.
// The React client loads only this file and provides window.log.
const A = () => window.__aztec;

function getNodeUrl() {
  const cfg = window.RPC_CONFIG;
  if (cfg && cfg.nodeUrl) return cfg.nodeUrl;
  const el = document.getElementById('nodeUrl');
  return el ? el.value.trim() : '';
}

const CRS_HOSTS = ["https://crs.aztec-cdn.foundation", "https://crs.aztec-labs.com"];

const SRS_NUM_POINTS = 2 ** 20 + 1;

// Aztec 6 uses the v2 ceremony with complete 2^16-point pinned chunks.
const GRUMPKIN_NUM_POINTS = 2 ** 16;

const TRANSIENT_RE = /temporary internal error|please retry|timeout|fetch|network|connection|ECONNRESET|socket/i;

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
  const grumpkinRes = await fetchCRS('grumpkin_g1_v2.dat', { headers: { Range: 'bytes=0-' + grumpkinEnd } });
  const grumpkinG1Data = new Uint8Array(await grumpkinRes.arrayBuffer());

  log('  Loading BN254 SRS into wasm...', 'info', S);
  bb.srsInitSrs({ pointsBuf: g1Data, numPoints: SRS_NUM_POINTS, g2Point: g2Data });
  log('  Loading Grumpkin SRS into wasm...', 'info', S);
  bb.srsInitGrumpkinSrs({ pointsBuf: grumpkinG1Data, numPoints: GRUMPKIN_NUM_POINTS });
  log('  CRS initialized.', 'success', S);
}

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
      log('  Max fee: ' + maxFee.toLocaleString() + ' Fee Juice (' + (Number(maxFee * 10000n / 10n ** 18n) / 10000).toFixed(4) + ' AZTEC)', 'info', S);

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
        scopes: this.scopesFrom(opts.from, opts.additionalScopes ?? [], opts.sendMessagesAs),
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
  progress(1, 'Deriving account address');
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
  progress(2, 'Connecting to Aztec node');
  log('Step 2: Connecting to Aztec node...', 'info', S);
  const rawNode = a.createAztecNodeClient(nodeUrl);
  state.rawNode = rawNode;
  const aztecNode = wrapWithRetry(rawNode, 'node', S);
  state.aztecNode = aztecNode;
  const nodeInfo = await aztecNode.getNodeInfo();
  log('  L1 chain ID: ' + nodeInfo.l1ChainId, 'info', S);

  // Legacy apps use the indicator; React clients can disable its DOM and polling.
  if (opts.blockMonitor !== false) startBlockMonitor(aztecNode);

  // Step 3: Init CRS (if not done)
  progress(3, 'Preparing proof environment');
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
  progress(4, 'Creating browser PXE');
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
  progress(5, 'Registering local account');
  // belonging to this account. If we sync first, all blocks are processed without
  // knowing about the account, and notes from previous sessions are never found.
  log('Step 5: Registering account with PXE...', 'info', S);
  const derivedKeys = await a.deriveKeys(secretKey);
  await pxe.registerAccount(derivedKeys, partialAddress);
  log('  Account registered.', 'success', S);

  // Step 6: Register account contract class
  progress(6, 'Registering account contract');
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
  progress(7, 'Creating wallet');
  log('Step 7: Creating wallet...', 'info', S);
  const wallet = createAztecWallet(pxe, aztecNode, rawNode, S, { preProveHook: opts.preProveHook });
  const accountManager = await a.AccountManager.create(wallet, secretKey, accountContract, { salt: new a.Fr(saltVal) });
  wallet._accountManager = accountManager;
  wallet._secretKey = secretKey;
  state.wallet = wallet;
  log('  Wallet ready.', 'success', S);

  // Step 8: Store signing key capsule for initializerless account contract.
  progress(8, 'Preparing signing keys');
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
