import assert from "node:assert/strict";
import test from "node:test";

import {
  listEthereumWallets,
  switchEthereumChain,
} from "../../../web/src/features/wallet/l1.ts";

test("discovers announced and legacy L1 wallets without duplicates", async (t) => {
  const previous = globalThis.window;
  const browser = new EventTarget();
  const metamask = { isMetaMask: true, request: async () => [] };
  const rabby = { isRabby: true, request: async () => [] };
  const duplicateMetaMask = { isMetaMask: true, request: async () => [] };
  browser.ethereum = { providers: [metamask, rabby] };
  browser.addEventListener("eip6963:requestProvider", () => {
    browser.dispatchEvent(
      new CustomEvent("eip6963:announceProvider", {
        detail: {
          info: { name: "MetaMask", rdns: "io.metamask", uuid: "meta" },
          provider: metamask,
        },
      })
    );
    browser.dispatchEvent(
      new CustomEvent("eip6963:announceProvider", {
        detail: {
          info: { name: "Rabby Wallet", rdns: "io.rabby", uuid: "rabby" },
          provider: rabby,
        },
      })
    );
    browser.dispatchEvent(
      new CustomEvent("eip6963:announceProvider", {
        detail: {
          info: { name: "MetaMask", rdns: "io.metamask", uuid: "duplicate" },
          provider: duplicateMetaMask,
        },
      })
    );
  });
  globalThis.window = browser;
  t.after(() => {
    globalThis.window = previous;
  });
  const wallets = await listEthereumWallets();
  assert.deepEqual(
    wallets.map(({ name }) => name),
    ["MetaMask", "Rabby"]
  );
  assert.equal(wallets[0].provider, metamask);
  assert.equal(wallets[1].provider, rabby);
});

test("returns an empty wallet list when no extension is installed", async (t) => {
  const previous = globalThis.window;
  globalThis.window = new EventTarget();
  t.after(() => {
    globalThis.window = previous;
  });
  assert.deepEqual(await listEthereumWallets(), []);
});

test("a selected wallet can add an unknown local chain but cannot bypass rejection", async () => {
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

test("an unanswered network switch releases the page after a timeout", async () => {
  const provider = {
    request: async ({ method }) => {
      if (method === "eth_chainId") return "0x1";
      return new Promise(() => {});
    },
  };
  await assert.rejects(
    switchEthereumChain(
      provider,
      "0x7a69",
      "http://127.0.0.1:5954",
      "local",
      10
    ),
    /network switch timed out/
  );
});
