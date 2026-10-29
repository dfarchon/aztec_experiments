import assert from "node:assert/strict";
import test from "node:test";

import { switchEthereumChain } from "./l1.ts";

test("MetaMask requests add an unknown local chain but never bypass rejection", async () => {
  const calls = [];
  let added = false;
  const provider = {
    async request(request) {
      calls.push(request);
      if (request.method === "eth_chainId") return "0x1";
      if (request.method === "wallet_switchEthereumChain" && !added)
        throw { code: 4902 };
      if (request.method === "wallet_addEthereumChain") added = true;
    },
  };
  await switchEthereumChain(provider, "0x7a69", "http://127.0.0.1:5954");
  assert.deepEqual(
    calls.map(({ method }) => method),
    [
      "eth_chainId",
      "wallet_switchEthereumChain",
      "wallet_addEthereumChain",
      "wallet_switchEthereumChain",
    ]
  );
  assert.deepEqual(calls[2].params[0].rpcUrls, ["http://127.0.0.1:5954"]);
  const rejected = [];
  await assert.rejects(
    () =>
      switchEthereumChain(
        {
          async request({ method }) {
            rejected.push(method);
            if (method === "eth_chainId") return "0x1";
            throw Object.assign(new Error("Rejected"), { code: 4001 });
          },
        },
        "0x7a69",
        "http://127.0.0.1:5954"
      ),
    /Rejected/
  );
  assert.deepEqual(rejected, ["eth_chainId", "wallet_switchEthereumChain"]);
});
