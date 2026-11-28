import {
  environment,
  networkPolicy,
  SDK_VERSION,
  validateChain,
  validateRpc,
} from "../../app/network.ts";
import type { NotchDeployment } from "../wallet/wallet-types.ts";

export async function testNodeConnection(
  deployment: NotchDeployment,
  url: string,
  signal?: AbortSignal
) {
  const endpoint = url.trim();
  const env = environment(deployment.environment);
  validateRpc(endpoint, env, true);
  const timeout = AbortSignal.timeout(15_000);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let id = 0;
  async function rpc(method: string, params: unknown[] = []) {
    let response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: ++id,
          method: `node_${method}`,
          params,
        }),
        signal: requestSignal,
      });
    } catch {
      if (requestSignal.aborted)
        throw new Error(
          "Connection cancelled or timed out. Check that your node is running."
        );
      throw new Error(
        "Cannot reach this node. Check its URL, CORS and browser local-network permissions."
      );
    }
    if (!response.ok)
      throw new Error(`Node connection failed (HTTP ${response.status}).`);
    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error("This URL did not return an Aztec RPC response.");
    }
    if (data?.id !== id || data.error || !data.result)
      throw new Error("Node returned an invalid Aztec RPC response.");
    return data.result;
  }
  const info = await rpc("getNodeInfo");
  try {
    validateChain(
      env,
      deployment,
      info,
      String(info.l1ContractAddresses?.rollupAddress ?? "")
    );
  } catch {
    const policy = networkPolicy(env);
    const fields = [
      ["L1 chain ID", Number(info.l1ChainId), policy.chainId],
      ["version", info.nodeVersion, SDK_VERSION],
      ["proof mode", info.realProofs, policy.realProofs],
      [
        "Rollup address",
        String(info.l1ContractAddresses?.rollupAddress ?? "").toLowerCase(),
        deployment.rollupAddress.toLowerCase(),
      ],
      [
        "Rollup version",
        String(info.rollupVersion),
        String(deployment.rollupVersion),
      ],
    ];
    const mismatch = fields.find(([, actual, expected]) => actual !== expected);
    if (mismatch) {
      const [field, actual, expected] = mismatch;
      const display = (value: unknown) =>
        value === undefined || value === ""
          ? "missing"
          : String(value).slice(0, 100);
      throw new Error(
        `Node ${field} mismatch: expected ${display(expected)}, received ${display(actual)}.`
      );
    }
    throw new Error("This node does not match the selected Notch network.");
  }

  if (
    String(info.l1ContractAddresses?.inboxAddress ?? "").toLowerCase() !==
    deployment.l1Stake.inbox.toLowerCase()
  )
    throw new Error("This node is connected to a different Inbox.");
  const contract = await rpc("getContract", [deployment.board]);
  if (
    String(contract.currentContractClassId).toLowerCase() !==
    deployment.boardClassId.toLowerCase()
  )
    throw new Error("This node does not have the expected Notch contract.");
  return endpoint;
}
