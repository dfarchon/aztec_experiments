// ============================================================
// engine.js — Billboard Deploy Engine
// ============================================================
// Fully abstracted from the interface. Takes an `env` object
// (providing aztec SDK, ethers, logging, pause, CRS init, store
// creation, ETH signer) and a `config` object. Runs the entire
// deploy flow autonomously, only pausing for user input when
// genuinely needed (wallet import).
//
// Works in: browser (bundle), CLI (npm SDK), file:// (single-thread)
//
// Defines: globalThis.runDeploy(env, config) → Promise<result>
// ============================================================

;(function() {
  const g = typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this);

  // ============================================================
  // Constants
  // ============================================================
  const TRANSIENT_RE = /temporary internal error|please retry|timeout|fetch|network|connection|ECONNRESET|socket/i;
  const CREATE2_PROXY = '0x4e59b44847b379578588920cA78FbF26c0B4956C';

  const PORTAL_ABI = [
    "constructor(address rollup, bytes32 l2Contract, uint256 version, uint256 minDeposit)",
    "function L2_CONTRACT() view returns (bytes32)",
    "function ROLLUP() view returns (address)",
    "function VERSION() view returns (uint256)",
    "function MIN_DEPOSIT() view returns (uint256)",
    "function totalDeposited() view returns (uint256)",
    "function deposits(address) view returns (uint256)",
    "function getDeposit(address) view returns (uint256)",
    "event Deposited(address indexed depositor, uint256 amount, bytes32 secretHash, bytes32 key, uint256 index)",
    "event Withdrawn(address indexed depositor, uint256 amount)",
  ];

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

  // CREATE2 portal address computation
  function portalCreationBytecode(portalBytecode, portalAbi, rollup, l2AddrHex, version, minDeposit, ethers) {
    const iface = new ethers.Interface(portalAbi);
    const encodedArgs = iface.encodeDeploy([rollup, l2AddrHex, BigInt(version), BigInt(minDeposit)]);
    return ethers.concat([portalBytecode, encodedArgs]);
  }

  function computePortalAddress(portalBytecode, portalAbi, l2AddrHex, rollup, version, minDeposit, ethers) {
    const creation = portalCreationBytecode(portalBytecode, portalAbi, rollup, l2AddrHex, version, minDeposit, ethers);
    const salt = ethers.getBytes(l2AddrHex);
    const initCodeHash = ethers.keccak256(creation);
    return ethers.getCreate2Address(CREATE2_PROXY, salt, initCodeHash);
  }

  // ============================================================
  // Aztec Wallet (custom BaseWallet with gas estimation + retry)
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
        // Only pass secretKeyOrKeys when the contract instance is the account
        // contract itself (address matches). For non-account contracts (like
        // the billboard), registering with keys would fail because the public
        // keys in the instance don't match the account's keys.
        if (secretKeyOrKeys || (this._account && instance.address.equals(this._account.address))) {
          return super.registerContract(instance, artifact, secretKeyOrKeys ?? this._secretKey);
        }
        return super.registerContract(instance, artifact);
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
  // Main entry point
  // ============================================================
  g.runDeploy = async function(env, config) {
    const { aztec: a, ethers, log, pause, initCRS, createStore, portalBytecode, artifact } = env;

    // ============================================================
    // Step 1: Load Aztec wallet
    // ============================================================
    let aztecWallet = config.aztecWallet;
    if (!aztecWallet || !aztecWallet.secretKey) {
      log('Aztec wallet not provided. Pausing for user to import...', 'info');
      aztecWallet = await pause('import-aztec-wallet');
      if (!aztecWallet || !aztecWallet.secretKey) throw new Error('Aztec wallet is required.');
    }

    const saltVal = typeof aztecWallet.salt === 'string' ? parseInt(aztecWallet.salt, 16) : (aztecWallet.salt || 0);
    const contractSalt = config.contractSalt || 1;
    const secretKeyHex = aztecWallet.secretKey;

    // ============================================================
    // Step 2: Derive account keys
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
    // Step 3: Connect to Aztec node
    // ============================================================
    log('Step 2: Connecting to Aztec node...', 'info');
    const nodeUrl = config.aztecNodeUrl;
    const rawNode = a.createAztecNodeClient(nodeUrl);
    const aztecNode = wrapWithRetry(rawNode, 'node', log);
    const nodeInfo = await aztecNode.getNodeInfo();
    log('  Chain ID: ' + nodeInfo.chainId, 'info');
    log('  Rollup version: ' + nodeInfo.rollupVersion, 'info');

    const l1Contracts = await aztecNode.getL1ContractAddresses();
    const rollupAddr = l1Contracts.rollupAddress.toString();
    const version = nodeInfo.rollupVersion;
    log('  L1 Rollup: ' + rollupAddr, 'info');

    // Check fee juice balance
    try {
      const blockNum = await aztecNode.getBlockNumber();
      log('  Current L2 block: ' + blockNum, 'info');
    } catch (e) { /* non-critical */ }

    log('Checking Fee Juice balance...', 'info');
    try {
      const slot = await a.deriveStorageSlotInMap(new a.Fr(1), address);
      const value = await aztecNode.getPublicStorageAt('latest', a.FeeJuiceAddress, slot);
      const balance = value ? BigInt(value.toString()) : 0n;
      log('  Fee Juice balance: ' + toAztec(balance, 6) + ' AZTEC', balance > 0n ? 'success' : 'warn');
      if (balance === 0n) {
        log('  WARNING: No Fee Juice. You need some to pay for deployment tx fees.', 'warn');
      }
    } catch (e) {
      log('  Could not check balance: ' + extractErrorMessage(e), 'warn');
    }

    // ============================================================
    // Step 4: Initialize CRS
    // ============================================================
    log('Step 3: Initializing CRS...', 'info');
    await initCRS();
    log('  CRS ready.', 'success');

    // ============================================================
    // Step 5: Create PXE
    // ============================================================
    log('Step 4: Creating PXE...', 'info');
    const dataDirPrefix = (config.dataDirPrefix || 'pxe_bb_') + address.toString().slice(0, 16) + '_';
    const storeConfig = { ...l1Contracts, l1ChainId: nodeInfo.l1ChainId, dataDirectory: dataDirPrefix + l1Contracts.rollupAddress };
    const store = await createStore(storeConfig);
    const pxe = await a.createPXE(aztecNode, {
      proverEnabled: true, autoSync: true,
      dataDirectory: dataDirPrefix + l1Contracts.rollupAddress,
    }, { store });
    log('  PXE created.', 'success');

    // ============================================================
    // Step 6: Register account + sync
    // ============================================================
    log('Step 5: Registering account with PXE...', 'info');
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
    // Step 7: Create wallet
    // ============================================================
    log('Step 6: Creating wallet...', 'info');
    const wallet = createAztecWallet(a, pxe, aztecNode, rawNode, log, secretKey, { preProveHook: config.preProveHook });
    const accountManager = await a.AccountManager.create(wallet, secretKey, accountContract, { salt: new a.Fr(saltVal) });
    wallet._accountManager = accountManager;
    log('  Wallet ready.', 'success');

    // Store signing key capsule for initializerless account contract
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

    // ============================================================
    // Step 8: Deploy L2 contract (or register if exists)
    // ============================================================
    log('Step 7: Deploying L2 contract...', 'info');
    const contractArtifact = a.loadContractArtifact(artifact);
    // Constructor args for init(min_deposit, base_cooldown, censor, k,
    //                          censor_window, max_save_up, policy, policy_len)
    const minDepositWei = config.minDepositWei || ethers.parseEther('0.001');
    const baseCooldown = config.baseCooldown || 3600;
    const censorAddr = config.censor ? a.AztecAddress.fromFieldUnsafe(a.Fr.fromHexString(config.censor)) : a.AztecAddress.zero();
    const kMultiplier = config.kMultiplier || 64;
    const censorWindow = config.censorWindow || 3600;
    const maxSaveUp = config.maxSaveUp || 16;
    // Moderation policy: pack string into Field array (48 fields, 1488 bytes max)
    const policyText = config.moderationPolicy !== undefined ? config.moderationPolicy : (g.DEFAULT_MODERATION_POLICY || '');
    const packFn = g.packStringToFields;
    if (!packFn) throw new Error('packStringToFields not available (load moderation-policy.js)');
    const { fields: policyFields, len: policyLen } = packFn(policyText);
    log('  Min deposit:    ' + ethers.formatEther(minDepositWei) + ' ETH', 'info');
    log('  Base cooldown:  ' + baseCooldown + 's (' + Math.floor(baseCooldown/60) + ' min)', 'info');
    log('  Censor:         ' + censorAddr.toString(), 'info');
    log('  K multiplier:   ' + kMultiplier, 'info');
    log('  Censor window:  ' + censorWindow + 's', 'info');
    log('  Max save up:    ' + maxSaveUp, 'info');
    log('  Policy:         ' + policyLen + ' bytes', 'info');
    const initArgs = [
      new a.Fr(BigInt(minDepositWei)),
      new a.Fr(BigInt(baseCooldown)),
      censorAddr.toField(),
      new a.Fr(BigInt(kMultiplier)),
      new a.Fr(BigInt(censorWindow)),
      new a.Fr(BigInt(maxSaveUp)),
      policyFields.map(f => new a.Fr(f)),
      new a.Fr(BigInt(policyLen)),
    ];
    // Use universalDeploy + fixed public keys (derived from zero secret key)
    const universalPublicKeys = (await a.deriveKeys(a.Fr.ZERO)).publicKeys;
    const deployMethod = a.Contract.deploy(wallet, contractArtifact, initArgs, undefined, {
      salt: new a.Fr(contractSalt),
      publicKeys: universalPublicKeys,
      universalDeploy: true,
    });

    const l2Addr = await deployMethod.getAddress();
    log('  Predicted L2 address: ' + l2Addr.toString(), 'info');

    let existingInstance = null;
    try { existingInstance = await aztecNode.getContract(l2Addr); } catch (e) { /* not deployed */ }

    if (existingInstance) {
      log('  Contract already deployed on L2!', 'success');
      const newInstance = await deployMethod.getInstance();
      const newClassId = newInstance.currentContractClassId?.toString?.() || '(unknown)';
      const existingClassId = existingInstance.currentContractClassId?.toString?.() || '(unknown)';
      log('  Class ID (new artifact):  ' + newClassId, 'info');
      log('  Class ID (on-chain):      ' + existingClassId, 'info');
      if (newClassId !== existingClassId) {
        log('  ERROR: Class IDs do NOT match!', 'error');
        log('  A contract was previously deployed at this address with an older artifact.', 'error');
        log('  -> Use a salt that was NEVER used before.', 'error');
        throw new Error('On-chain class ID (' + existingClassId + ') does not match current artifact (' + newClassId + '). Use a new salt.');
      }
      await pxe.registerContractClass(contractArtifact);
      await pxe.registerContract(existingInstance);
    } else {
      log('  Not yet deployed. Sending deploy tx...', 'info');
      try {
        const result = await deployMethod.send({ from: address });
        log('  TX confirmed! Block: ' + result.receipt.blockNumber, 'success');
        log('  L2 contract address: ' + l2Addr.toString(), 'success');
      } catch (err) {
        if (/existing nullifier|already exists|duplicate/i.test(err.message || '')) {
          log('  Deployment nullifier already consumed. Re-checking...', 'warn');
          let found = false;
          for (let i = 0; i < 10; i++) {
            await sleep(10000);
            try {
              existingInstance = await aztecNode.getContract(l2Addr);
              if (existingInstance) { found = true; break; }
            } catch (e) {}
            log('  Contract not visible yet, retrying... (' + (i+1) + '/10)', 'warn');
          }
        } else { throw err; }
      }
      const finalInstance = existingInstance || await deployMethod.getInstance();
      await pxe.registerContractClass(contractArtifact);
      await pxe.registerContract(finalInstance);
    }

    const l2Contract = await a.Contract.at(l2Addr, contractArtifact, wallet);
    log('  Contract registered with PXE.', 'success');

    // Check if portal is already set
    let portalAlreadySet = false;
    try {
      const portalSetVal = await aztecNode.getPublicStorageAt('latest', l2Addr, new a.Fr(2n));
      portalAlreadySet = portalSetVal && !portalSetVal.isZero();
      log('  Portal set on L2: ' + (portalAlreadySet ? 'yes' : 'no'), 'info');
    } catch (e) { /* non-critical */ }

    // ============================================================
    // Step 9: Deploy L1 portal (or verify if exists)
    // ============================================================
    log('Step 8: Deploying L1 portal...', 'info');
    const l2AddrHex = '0x' + BigInt(l2Addr.toString()).toString(16).padStart(64, '0');

    // Get ETH signer
    let ethSigner = null;
    if (config.ethWallet && config.ethWallet.privateKey) {
      log('  Using ETH wallet from config (local signing)...', 'info');
      const provider = new ethers.JsonRpcProvider(config.ethRpcUrl);
      ethSigner = new ethers.Wallet(config.ethWallet.privateKey, provider);
      log('  ETH address: ' + ethSigner.address, 'info');
    } else if (env.getBrowserSigner) {
      log('  Using browser wallet...', 'info');
      ethSigner = await env.getBrowserSigner();
    } else {
      log('  No ETH wallet in config and no browser wallet. Pausing for user to import...', 'info');
      const ethWalletData = await pause('import-eth-wallet');
      if (!ethWalletData || !ethWalletData.privateKey) throw new Error('ETH wallet is required.');
      const provider = new ethers.JsonRpcProvider(config.ethRpcUrl);
      ethSigner = new ethers.Wallet(ethWalletData.privateKey, provider);
      log('  ETH address: ' + ethSigner.address, 'info');
    }

    const predicted = computePortalAddress(portalBytecode, PORTAL_ABI, l2AddrHex, rollupAddr, version, minDepositWei, ethers);
    log('  Predicted portal address: ' + predicted, 'info');

    const provider = ethSigner.provider;
    const existingCode = await provider.getCode(predicted);

    if (existingCode !== '0x') {
      log('  Portal already deployed at ' + predicted + '!', 'success');
    } else {
      // Check if CREATE2 proxy exists
      const proxyCode = await provider.getCode(CREATE2_PROXY);
      if (proxyCode === '0x') {
        log('  CREATE2 proxy not found. Falling back to direct deploy...', 'warn');
        log('  WARNING: address will depend on nonce and is NOT deterministic.', 'warn');
        const factory = new ethers.ContractFactory(PORTAL_ABI, portalBytecode, ethSigner);
        const contract = await factory.deploy(rollupAddr, l2AddrHex, BigInt(version), BigInt(minDepositWei));
        log('  Tx sent: ' + contract.deploymentTransaction().hash, 'info');
        await contract.waitForDeployment();
        const addr = await contract.getAddress();
        log('  Portal deployed at ' + addr, 'success');
      } else {
        log('  Deploying via CREATE2 proxy ' + CREATE2_PROXY + '...', 'info');
        const creation = portalCreationBytecode(portalBytecode, PORTAL_ABI, rollupAddr, l2AddrHex, version, minDepositWei, ethers);
        const salt = ethers.getBytes(l2AddrHex);
        const data = ethers.concat([salt, creation]);
        const tx = await ethSigner.sendTransaction({ to: CREATE2_PROXY, data, value: 0 });
        log('  Tx sent: ' + tx.hash, 'info');
        log('  Waiting for confirmation...', 'info');
        const rc = await tx.wait();
        log('  Confirmed in block ' + rc.blockNumber, 'success');
        log('  Portal deployed at ' + predicted, 'success');
      }
    }

    // Verify portal
    const portal = new ethers.Contract(predicted, PORTAL_ABI, provider);
    try {
      const l2FromL1 = await portal.L2_CONTRACT();
      log('  L2_CONTRACT in portal: ' + l2FromL1, 'info');
      const minDeposit = await portal.MIN_DEPOSIT();
      log('  Min deposit: ' + ethers.formatEther(minDeposit) + ' ETH', 'info');
    } catch (e) {
      log('  Warning: could not verify portal: ' + extractErrorMessage(e), 'warn');
    }

    // ============================================================
    // Step 10: Link — call update_portal() on L2
    // ============================================================
    log('Step 9: Linking portal on L2...', 'info');

    if (portalAlreadySet) {
      // Check if it's set to the correct address
      try {
        const portalAddrVal = await aztecNode.getPublicStorageAt('latest', l2Addr, new a.Fr(1n));
        const currentPortal = '0x' + portalAddrVal.toBigInt().toString(16).padStart(40, '0');
        log('  Portal already set on L2: ' + currentPortal, 'info');
        if (currentPortal.toLowerCase() === predicted.toLowerCase()) {
          log('  Portal already set correctly! Skipping update_portal().', 'success');
        } else {
          throw new Error('Portal already set to a DIFFERENT address (' + currentPortal + '). ' +
            'Redeploy L2 with a different contract salt.');
        }
      } catch (e) {
        if (/DIFFERENT|immutable/i.test(e.message)) throw e;
        log('  Could not pre-check portal: ' + extractErrorMessage(e), 'warn');
      }
    } else {
      log('  Calling update_portal(' + predicted + ') on L2...', 'info');
      const portalField = a.Fr.fromHexString(predicted);
      const interaction = l2Contract.methods.update_portal(portalField);

      try {
        const result = await interaction.send({ from: address });
        log('  TX confirmed! Block: ' + result.receipt.blockNumber, 'success');
        log('  L1 portal address stored on L2 contract.', 'success');
      } catch (err) {
        if (/already set|immutable/i.test(err.message || '')) {
          log('  Portal was already set in a previous run.', 'warn');
          try {
            const portalAddrVal = await aztecNode.getPublicStorageAt('latest', l2Addr, new a.Fr(1n));
            const currentPortal = '0x' + portalAddrVal.toBigInt().toString(16).padStart(40, '0');
            if (currentPortal.toLowerCase() === predicted.toLowerCase()) {
              log('  Portal already set correctly! No action needed.', 'success');
            } else {
              throw new Error('Portal already set to a DIFFERENT address (' + currentPortal + ').');
            }
          } catch (e2) {
            if (/DIFFERENT|immutable/i.test(e2.message)) throw e2;
          }
        } else { throw err; }
      }
    }

    // ============================================================
    // Step 11: (Censor is set at init time — no post-deploy configuration)
    // ============================================================

    // ============================================================
    // Step 12: Cross-check
    // ============================================================
    log('Step 10: Cross-checking...', 'info');
    let ok = true;

    // L1 → L2
    try {
      const l2FromL1 = await portal.L2_CONTRACT();
      const l2Norm = '0x' + l2AddrHex.toLowerCase().replace(/^0x/, '').padStart(64, '0');
      const l1Norm = '0x' + l2FromL1.toLowerCase().replace(/^0x/, '').padStart(64, '0');
      if (l2Norm === l1Norm) log('  OK: L1 portal points to correct L2 contract.', 'success');
      else { log('  MISMATCH! L1 points to ' + l2FromL1 + ' but L2 is ' + l2AddrHex, 'error'); ok = false; }
    } catch (e) { log('  Cannot read L1 portal: ' + extractErrorMessage(e), 'error'); ok = false; }

    // L2 → L1
    try {
      const portalAddrVal = await aztecNode.getPublicStorageAt('latest', l2Addr, new a.Fr(1n));
      const portalFromL2 = '0x' + portalAddrVal.toBigInt().toString(16).padStart(40, '0');
      if (portalFromL2 === '0x0000000000000000000000000000000000000000') {
        log('  Portal not yet set on L2.', 'warn'); ok = false;
      } else if (portalFromL2.toLowerCase() === predicted.toLowerCase()) {
        log('  OK: L2 contract points to correct L1 portal.', 'success');
      } else {
        log('  MISMATCH! L2 points to ' + portalFromL2 + ' but L1 portal is ' + predicted, 'error'); ok = false;
      }
    } catch (e) { log('  Cannot read L2 portal from node: ' + extractErrorMessage(e), 'warn'); }

    if (ok) {
      log('', 'info');
      log('========================================', 'success');
      log('  Deployment complete!', 'success');
      log('  Salt:         ' + (config.contractSalt || 1), 'success');
      log('  L2 contract:  ' + l2Addr.toString(), 'success');
      log('  L1 portal:    ' + predicted, 'success');
      log('========================================', 'success');
    } else {
      throw new Error('Cross-check failed.');
    }

    return { l2Addr: l2Addr.toString(), portalAddr: predicted };
  };
})();
