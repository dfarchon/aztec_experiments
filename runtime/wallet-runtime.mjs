const CRS_HOSTS = [
  "https://crs.aztec-cdn.foundation",
  "https://crs.aztec-labs.com",
];
const SRS_NUM_POINTS = 2 ** 20 + 1;
const GRUMPKIN_NUM_POINTS = 2 ** 16;
const TRANSIENT_ERROR =
  /temporary internal error|please retry|timeout|fetch|network|connection|ECONNRESET|socket/i;
const ALREADY_SUBMITTED =
  /existing nullifier|already exists|duplicate.*tx|tx.*duplicate/i;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createAztecRuntime(sdk, { nodeUrl, onLog = () => {} }) {
  if (!sdk) throw new Error("Aztec SDK is not loaded");
  if (!nodeUrl) throw new Error("Aztec node URL is required");

  const log = (message, type = "info") => onLog(String(message), String(type));
  let proofEnvironment;

  function retryOperation(label, operation, maxRetries = 5) {
    return async (...args) => {
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          return await operation(...args);
        } catch (error) {
          const transient = TRANSIENT_ERROR.test(error?.message || "");
          if (!transient || attempt === maxRetries) throw error;
          const delay = 2000 * attempt;
          log(
            `${label} transient error (attempt ${attempt}/${maxRetries}); retrying in ${delay / 1000}s`,
            "warn"
          );
          await wait(delay);
        }
      }
    };
  }

  function retryNode(node) {
    return new Proxy(node, {
      get(target, property) {
        const value = target[property];
        if (typeof value !== "function") return value;
        return retryOperation(
          `node.${String(property)}`,
          (...args) => value.apply(target, args),
          8
        );
      },
    });
  }

  function prepareProofEnvironment() {
    return (proofEnvironment ||= initCRS().catch((error) => {
      proofEnvironment = undefined;
      throw error;
    }));
  }

  async function initCRS() {
    log("Initializing the proof environment (loading CRS data)…");
    await sdk.BarretenbergSync.initSingleton();
    const barretenberg = sdk.BarretenbergSync.getSingleton();

    async function fetchCRS(filename, options = {}) {
      try {
        const response = await fetch(`/crs/${filename}`, options);
        if (response.ok || response.status === 206) {
          log(`Loaded ${filename} from the local CRS cache.`);
          return response;
        }
        throw new Error(`HTTP ${response.status}`);
      } catch (localError) {
        log(
          `Local ${filename} unavailable (${localError.message}); using the CRS CDN.`,
          "warn"
        );
        let lastError;
        for (const host of CRS_HOSTS) {
          try {
            const response = await fetch(`${host}/${filename}`, options);
            if (response.ok || response.status === 206) {
              log(`Loaded ${filename} from ${host}.`);
              return response;
            }
            lastError = new Error(`HTTP ${response.status} from ${host}`);
          } catch (error) {
            lastError = error;
          }
        }
        throw lastError;
      }
    }

    const g1Response = await fetchCRS("g1.dat", {
      headers: { Range: `bytes=0-${SRS_NUM_POINTS * 64 - 1}` },
    });
    const g1Data = new Uint8Array(await g1Response.arrayBuffer());
    const g2Response = await fetchCRS("g2.dat");
    const g2Data = new Uint8Array(await g2Response.arrayBuffer());
    const grumpkinResponse = await fetchCRS("grumpkin_g1_v2.dat", {
      headers: { Range: `bytes=0-${GRUMPKIN_NUM_POINTS * 64 - 1}` },
    });
    const grumpkinData = new Uint8Array(await grumpkinResponse.arrayBuffer());

    log("Loading BN254 SRS…");
    barretenberg.srsInitSrs({
      pointsBuf: g1Data,
      numPoints: SRS_NUM_POINTS,
      g2Point: g2Data,
    });
    log("Loading Grumpkin SRS…");
    barretenberg.srsInitGrumpkinSrs({
      pointsBuf: grumpkinData,
      numPoints: GRUMPKIN_NUM_POINTS,
    });
    log("Proof environment ready.", "success");
  }

  async function deriveAccountAddress(
    secretKeyHex,
    saltValue,
    explicitSigningKey
  ) {
    const secretKey = sdk.Fr.fromHexString(secretKeyHex);
    const signingKey = explicitSigningKey || sdk.deriveSigningKey(secretKey);
    const accountContract = new sdk.SchnorrInitializerlessAccountContract(
      signingKey
    );
    const { publicKeys } = await sdk.deriveKeys(secretKey);
    const artifact = await accountContract.getContractArtifact();
    const immutablesHash = await accountContract.getImmutablesHash();
    const instance = await sdk.getContractInstanceFromInstantiationParams(
      artifact,
      {
        constructorArtifact: undefined,
        constructorArgs: undefined,
        salt: new sdk.Fr(saltValue),
        publicKeys,
        immutablesHash,
      }
    );
    const partialAddress = await sdk.computePartialAddress(instance);
    return {
      secretKey,
      signingKey,
      accountContract,
      artifact,
      instance,
      partialAddress,
      address: instance.address,
    };
  }

  function createWallet(pxe, aztecNode, rawNode, options = {}) {
    class NotchWallet extends sdk.BaseWallet {
      constructor() {
        super(pxe, aztecNode);
        this._accountManager = null;
        this._account = null;
        this._estimatedGasPadding = 0.1;
        this._secretKey = null;
        this.onTxPrepared = null;
      }

      async registerContract(instance, artifact, secretKeyOrKeys) {
        const accountKey = this._accountManager?.address.equals(
          instance.address
        )
          ? this._secretKey
          : undefined;
        return super.registerContract(
          instance,
          artifact,
          secretKeyOrKeys ?? accountKey
        );
      }

      async getAccountFromAddress() {
        if (!this._account)
          this._account = await this._accountManager.getAccount();
        return this._account;
      }

      getAccounts() {
        return this._accountManager
          ? Promise.resolve([this._accountManager.address])
          : Promise.resolve([]);
      }

      async sendTx(executionPayload, txOptions) {
        log("Estimating the Aztec transaction…");
        const feeOptions = await this.completeFeeOptions({
          from: txOptions.from,
          feePayer: executionPayload.feePayer,
          gasSettings: txOptions.fee?.gasSettings,
          forEstimation: true,
        });
        const simulation = await retryOperation("transaction simulation", () =>
          this.simulateViaEntrypoint(executionPayload, {
            from: txOptions.from,
            feeOptions,
            skipTxValidation: true,
            skipFeeEnforcement: true,
            additionalScopes: txOptions.additionalScopes,
            sendMessagesAs: txOptions.sendMessagesAs,
          })
        )();
        const gasUsed = simulation.gasUsed;
        const padding = 1 + this._estimatedGasPadding;
        const gasLimits = gasUsed.totalGas.mul(padding);
        const teardownGasLimits = gasUsed.teardownGas.mul(padding);
        const maxFee = gasLimits
          .computeFee(feeOptions.gasSettings.maxFeesPerGas)
          .toBigInt();
        log(
          `Estimated L2 gas ${gasLimits.l2Gas.toLocaleString()}, DA gas ${gasLimits.daGas.toLocaleString()}, max fee ${maxFee.toLocaleString()} Fee Juice`
        );

        if (this._preProveHook) {
          await this._preProveHook({
            gasLimits,
            maxFee,
            feeOptions,
            teardownGasLimits,
          });
        }

        const finalGasSettings = sdk.GasSettings.from({
          gasLimits: txOptions.fee?.gasSettings?.gasLimits ?? gasLimits,
          teardownGasLimits:
            txOptions.fee?.gasSettings?.teardownGasLimits ?? teardownGasLimits,
          maxFeesPerGas: feeOptions.gasSettings.maxFeesPerGas,
          maxPriorityFeesPerGas: feeOptions.gasSettings.maxPriorityFeesPerGas,
        });
        log("Proving the Aztec transaction; this can take several minutes…");
        const finalFeeOptions = await this.completeFeeOptions({
          from: txOptions.from,
          feePayer: executionPayload.feePayer,
          gasSettings: finalGasSettings,
        });
        const request = await this.createTxExecutionRequestFromPayloadAndFee(
          executionPayload,
          txOptions.from,
          finalFeeOptions
        );
        const provenTransaction = await this.pxe.proveTx(request, {
          scopes: this.scopesFrom(
            txOptions.from,
            txOptions.additionalScopes ?? [],
            txOptions.sendMessagesAs
          ),
          senderForTags: this.senderForTagsFrom(
            txOptions.from,
            txOptions.sendMessagesAs
          ),
        });
        const transaction = await provenTransaction.toTx();
        const txHash = transaction.getTxHash();
        if (this.onTxPrepared) await this.onTxPrepared(txHash.toString());
        log("Proof complete; submitting the transaction…", "success");

        let submitted = false;
        for (let attempt = 1; attempt <= 20; attempt++) {
          try {
            await rawNode.sendTx(transaction);
            submitted = true;
            break;
          } catch (error) {
            const message = error?.message || "";
            if (ALREADY_SUBMITTED.test(message)) {
              log("The transaction was already submitted; checking receipt…");
              break;
            }
            const transient = TRANSIENT_ERROR.test(message);
            if (!transient || attempt === 20) throw error;
            const delay = Math.min(5000 * attempt, 30000);
            log(
              `Node busy (attempt ${attempt}/20); retrying in ${delay / 1000}s…`,
              "warn"
            );
            await wait(delay);
          }
        }
        if (submitted)
          log(`Transaction submitted: ${txHash.toString()}`, "success");
        if (txOptions.wait === sdk.NO_WAIT) return { txHash };

        const waitOptions =
          typeof txOptions.wait === "object" ? txOptions.wait : undefined;
        const timeout = waitOptions?.timeout ?? 600;
        const interval = waitOptions?.interval ?? 5;
        const deadline = Date.now() + timeout * 1000;
        let receipt = null;
        let polls = 0;
        while (Date.now() < deadline) {
          try {
            const candidate = await rawNode.getTxReceipt(txHash);
            if (candidate && !candidate.isPending()) {
              receipt = candidate;
              break;
            }
          } catch (error) {
            if (!TRANSIENT_ERROR.test(error?.message || "")) throw error;
          }
          polls++;
          if (polls % 4 === 0)
            log("Waiting for Aztec confirmation…", "working");
          await wait(interval * 1000);
        }
        if (!receipt)
          throw new Error(
            `Transaction ${txHash.toString()} was not confirmed within ${timeout}s`
          );
        log(
          `Transaction confirmed in block ${receipt.blockNumber}.`,
          "success"
        );
        return { receipt };
      }
    }

    const wallet = new NotchWallet();
    wallet._preProveHook = options.preProveHook || null;
    return wallet;
  }

  async function setupAccount(state, options = {}) {
    if (state.wallet && state.pxe) return true;
    const secretKey = options.secretKey;
    if (!secretKey)
      throw new Error("Private account keys are required for setup");
    const saltValue = BigInt(options.salt ?? 0);
    const progress = (step, message) => options.onProgress?.(step, 8, message);

    progress(1, "Deriving the account address");
    const derived = await deriveAccountAddress(
      secretKey,
      saltValue,
      options.signingKey
    );
    state.secretKey = derived.secretKey;
    state.salt = saltValue;
    state.address = derived.address;
    state.partialAddress = derived.partialAddress;
    state.instance = derived.instance;
    log(`Private account address: ${derived.address.toString()}`, "success");

    progress(2, "Connecting to the Aztec node");
    const rawNode = sdk.createAztecNodeClient(nodeUrl);
    state.rawNode = rawNode;
    const aztecNode = retryNode(rawNode);
    state.aztecNode = aztecNode;
    const nodeInfo = await aztecNode.getNodeInfo();
    log(`Connected to Aztec on L1 chain ${nodeInfo.l1ChainId}.`);

    progress(3, "Preparing the proof environment");
    if (options.proverEnabled !== false) {
      await prepareProofEnvironment();
      state.crsInit = true;
    }

    progress(4, "Creating the browser PXE");
    const l1Contracts = await aztecNode.getL1ContractAddresses();
    const freshNodeInfo = await aztecNode.getNodeInfo();
    const dataDirectory = options.dataDirPrefix + l1Contracts.rollupAddress;
    const store = await sdk.createIndexedDBStore("pxe_data", {
      ...l1Contracts,
      l1ChainId: freshNodeInfo.l1ChainId,
      dataDirectory,
    });
    const pxe = await sdk.createPXE(
      aztecNode,
      {
        proverEnabled: options.proverEnabled !== false,
        autoSync: true,
        dataDirectory,
      },
      { store }
    );
    state.pxe = pxe;

    progress(5, "Registering the private account");
    const derivedKeys = await sdk.deriveKeys(derived.secretKey);
    await pxe.registerAccount(derivedKeys, derived.partialAddress);

    progress(6, "Registering the account contract");
    const retry = (label, operation) => retryOperation(label, operation, 5);
    await retry("account contract class registration", () =>
      pxe.registerContractClass(
        sdk.SchnorrInitializerlessAccountContractArtifact
      )
    )();
    await retry("account contract registration", () =>
      pxe.registerContract(derived.instance)
    )();

    log("Syncing private notes from Aztec…");
    await pxe.sync();

    progress(7, "Creating the wallet");
    const wallet = createWallet(pxe, aztecNode, rawNode, {
      preProveHook: options.preProveHook,
    });
    const accountManager = await sdk.AccountManager.create(
      wallet,
      derived.secretKey,
      derived.accountContract,
      { salt: new sdk.Fr(saltValue) }
    );
    wallet._accountManager = accountManager;
    wallet._secretKey = derived.secretKey;
    state.wallet = wallet;

    progress(8, "Preparing the signing key capsule");
    const signingPublicKey =
      await derived.accountContract.getSigningPublicKey();
    const constructorArtifact = derived.artifact.functions.find(
      (fn) => fn.name === "constructor"
    );
    if (constructorArtifact) {
      const storeCall = new sdk.ContractFunctionInteraction(
        wallet,
        derived.instance.address,
        constructorArtifact,
        [signingPublicKey.x, signingPublicKey.y]
      );
      await storeCall.simulate({ from: derived.instance.address });
    } else {
      log("No account constructor found; skipping capsule setup.", "warn");
    }

    return true;
  }

  return {
    ...sdk,
    sdk,
    createWallet,
    deriveAccountAddress,
    prepareProofEnvironment,
    setupAccount,
  };
}
