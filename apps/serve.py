#!/usr/bin/env python3
"""
serve.py — HTTP server with COOP/COEP headers for Aztec WASM multi-threading.

Serves all four billboard web apps from the apps/dist directory.
The Aztec bundle uses SharedArrayBuffer for multi-threaded WASM, which
requires crossOriginIsolated. This server sets the necessary headers:

    Cross-Origin-Opener-Policy: same-origin
    Cross-Origin-Embedder-Policy: credentialless

(credentialless instead of require-corp because the CRS files are loaded
from a cross-origin CDN that doesn't set CORP headers as a fallback.)

Usage:
    python3 serve.py [port]

If no port given, defaults to 5000 (the project-wide convention for
local web servers — see AGENTS.md).
Serves from apps/dist/ directory.

To check if multi-threading is working, open the app and look for
"shared memory: true" in the console output, or check:
    window.crossOriginIsolated  // should be true

Build the apps first:
    node apps/build.mjs
"""

import sys
import os
import http.server
import functools

class COOPCOEPHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'credentialless')
        # Allow range requests for CRS files
        self.send_header('Accept-Ranges', 'bytes')
        super().end_headers()

def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5000
    # Default to apps/dist relative to this file
    script_dir = os.path.dirname(os.path.abspath(__file__))
    directory = os.path.join(script_dir, 'dist')

    if not os.path.exists(directory):
        print(f'Error: Directory {directory} does not exist.')
        print('Run: node apps/build.mjs first')
        sys.exit(1)

    os.chdir(directory)

    handler = functools.partial(COOPCOEPHandler, directory=directory)
    with http.server.HTTPServer(('127.0.0.1', port), handler) as httpd:
        print(f'''
╔══════════════════════════════════════════════════════════════════╗
║   Aztec Billboard — Web Apps Server                              ║
╚══════════════════════════════════════════════════════════════════╝

  Serving from:  {directory}
  URL:           http://localhost:{port}
  COOP:          same-origin
  COEP:          credentialless
  WASM threads:  enabled (SharedArrayBuffer)

  ────────────────────────────────────────────────────────────────
  Apps (open in browser):
  ────────────────────────────────────────────────────────────────

    1. Fee Juice   http://localhost:{port}/fee-juice.html
       Bridge L1 AZTEC → L2 Fee Juice. Deposit AZTEC tokens via the
       FeeJuicePortal on Ethereum, then claim them on L2. Needed
       before posting/flagging (L2 gas).

    2. Deploy      http://localhost:{port}/deploy.html
       Deploy the Billboard contract system: L1 portal (Ethereum)
       + L2 contract (Aztec). Sets min deposit, cooldown, censor
       address, and K multiplier at init time.

    3. User        http://localhost:{port}/user.html
       The main billboard app. Deposit ETH → post anonymous messages
       → withdraw ETH. Includes a censor panel (visible only if the
       loaded wallet is the censor). Censored posts are hidden by
       default with an opt-in "View censored posts" confirmation.

    4. Censor      http://localhost:{port}/censor.html
       Dedicated censor panel. Flag posts as immoral, transfer
       censor rights to another address. Shows ALL posts (including
       censored). No ETH wallet needed — only L2 Fee Juice.

  ────────────────────────────────────────────────────────────────
  Typical workflow:
  ────────────────────────────────────────────────────────────────

    a. Fee Juice app  → fund your L2 wallet with Fee Juice
    b. Deploy app     → deploy the billboard (if not already deployed)
    c. User app       → deposit ETH, post messages, withdraw
    c. Censor app     → flag posts, manage censor rights

  ────────────────────────────────────────────────────────────────
  CLI equivalents (same engines, different interface):
  ────────────────────────────────────────────────────────────────

    node apps/src/fee-juice/cli.mjs --action auto
    node apps/src/billboard/deploy/cli.mjs --contract-salt 2028
    node apps/src/billboard/user/cli.mjs status
    node apps/src/billboard/user/cli.mjs post --msg "Hello"
    node apps/src/billboard/user/cli.mjs declare-immoral --post-index 0
    node apps/src/billboard/user/cli.mjs transfer-censor --new-censor 0x...

  Press Ctrl+C to stop.
''')
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print('\nShutting down.')

if __name__ == '__main__':
    main()
