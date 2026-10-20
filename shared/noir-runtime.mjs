// Embed Noir's browser WASM in the shared bundle: the same bundle is also
// evaluated by the Node CLIs, where document/import.meta URL resolution is absent.
import initAbi from '@aztec-foundation/noir-noirc_abi/web/noirc_abi_wasm.js';
import initAcvm from '@aztec-foundation/noir-acvm_js/web/acvm_js.js';
import abiBytes from '@aztec-foundation/noir-noirc_abi/web/noirc_abi_wasm_bg.wasm';
import acvmBytes from '@aztec-foundation/noir-acvm_js/web/acvm_js_bg.wasm';

let initialization;
export function initializeNoirRuntime() {
  initialization ??= Promise.all([
    initAbi({ module_or_path: abiBytes }),
    initAcvm({ module_or_path: acvmBytes }),
  ]).then(() => undefined);
  return initialization;
}
