import { Interface, keccak256 } from "ethers";

import { environment, validateRpc } from "../../app/network.ts";
import { portalABI } from "../wallet/portal.ts";
import { MAX_STAKE } from "../wallet/stake-policy.ts";
import type { NotchDeployment } from "../wallet/wallet-types.ts";

const portal = new Interface(portalABI);

export async function testL1RpcConnection(
  deployment: NotchDeployment,
  url: string,
  signal?: AbortSignal
) {
  const endpoint = url.trim();
  validateRpc(endpoint, environment(deployment.environment), true);
  const timeout = AbortSignal.timeout(15_000);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let id = 0;

  async function rpc(method: string, params: unknown[] = []) {
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: ++id,
          method,
          params,
        }),
        signal: requestSignal,
      });
    } catch {
      if (requestSignal.aborted)
        throw new Error(
          "Connection cancelled or timed out. Check the L1 RPC and browser access."
        );
      throw new Error(
        "Cannot reach this L1 RPC. Check its URL, CORS and browser permissions."
      );
    }
    if (!response.ok)
      throw new Error(`L1 RPC connection failed (HTTP ${response.status}).`);
    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error("This URL did not return a JSON-RPC response.");
    }
    if (
      data?.id !== id ||
      data.error ||
      !Object.prototype.hasOwnProperty.call(data, "result")
    )
      throw new Error(
        data?.error?.message || "L1 RPC returned an invalid response."
      );
    return data.result;
  }

  async function call(name: string) {
    const data = await rpc("eth_call", [
      {
        to: deployment.l1Stake.portal,
        data: portal.encodeFunctionData(name),
      },
      "latest",
    ]);
    return portal.decodeFunctionResult(name, data)[0];
  }

  const chainId = BigInt(await rpc("eth_chainId"));
  if (chainId !== BigInt(deployment.l1Stake.chainId))
    throw new Error(
      `L1 chain mismatch: expected ${deployment.l1Stake.chainId}, received ${chainId}.`
    );
  const blockNumber = BigInt(await rpc("eth_blockNumber"));
  if (
    deployment.l1Stake.deploymentBlock !== undefined &&
    blockNumber < BigInt(deployment.l1Stake.deploymentBlock)
  )
    throw new Error("This L1 RPC is behind the configured deployment block.");
  const code = await rpc("eth_getCode", [deployment.l1Stake.portal, "latest"]);
  if (code === "0x")
    throw new Error("The configured Notch Portal is missing on this L1 RPC.");
  if (
    deployment.l1Stake.runtimeCodeHash &&
    keccak256(code).toLowerCase() !==
      deployment.l1Stake.runtimeCodeHash.toLowerCase()
  )
    throw new Error("Portal bytecode does not match the Notch deployment.");

  const board = await call("board");
  const inbox = await call("INBOX");
  const version = await call("ROLLUP_VERSION");
  const maximum = await call("MAX_STAKE");
  if (String(board).toLowerCase() !== deployment.board.toLowerCase())
    throw new Error("This Portal is linked to a different Notch board.");
  if (String(inbox).toLowerCase() !== deployment.l1Stake.inbox.toLowerCase())
    throw new Error("This Portal uses a different Aztec Inbox.");
  if (String(version) !== String(deployment.rollupVersion))
    throw new Error("The Portal Rollup version does not match Notch.");
  if (BigInt(maximum) !== MAX_STAKE)
    throw new Error("The Portal stake policy does not match this frontend.");
  return endpoint;
}
