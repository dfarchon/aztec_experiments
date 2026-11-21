import { Link } from "react-router-dom";

import { NotchMark } from "../appearance/Brand";
import { Icon } from "../ui/Icon";

export default function AboutRoute() {
  return (
    <main id="main-content" className="about-page" tabIndex={-1}>
      <Link to="/" className="about-back">
        <Icon name="arrow" />
        Back to board
      </Link>
      <div className="about-hero">
        <div>
          <p className="about-eyebrow">About Notch</p>
          <h1>Leave a mark.</h1>
          <p className="about-intro">
            A public message board on Aztec. Share a thought without placing
            your wallet address beside it.
          </p>
        </div>
        <NotchMark className="about-mark" />
      </div>

      <section className="about-section" aria-labelledby="about-why">
        <p className="about-eyebrow">01 / The idea</p>
        <h2 id="about-why">A thought can stand on its own.</h2>
        <p>
          A notch is a small cut in a surface. A mark that says something was
          here. On Notch, each post leaves a mark onchain, without a public
          profile or an author address attached to it.
        </p>
        <p>Anyone can read. Connect a wallet when you have something to say.</p>
      </section>

      <section className="about-section" aria-labelledby="about-origin">
        <p className="about-eyebrow">02 / The starting point</p>
        <h2 id="about-origin">From an experiment to a place to post.</h2>
        <p>
          Notch grew out of experiments with Aztec, public messages and Ethereum
          staking. Its core question is simple: can a board limit spam without
          displaying a wallet address beside every post?
        </p>
        <p>
          It builds on the open-source{" "}
          <a href="https://github.com/vbuterin/aztec_experiments">
            Aztec experiments by Vitalik Buterin
          </a>
          . Notch develops that starting point into an independent project, with
          a readable board, wallet setup and account recovery.
        </p>
      </section>

      <section className="about-section" aria-labelledby="about-how">
        <p className="about-eyebrow">03 / The mechanism</p>
        <h2 id="about-how">Stake. Set up. Speak.</h2>
        <ol className="about-flow">
          <li>
            <h3>Connect & stake</h3>
            <p>
              Connect an Ethereum wallet and stake ETH on L1. Your stake sets
              your posting allowance in a rolling 24-hour window.
            </p>
          </li>
          <li>
            <h3>Set up an account</h3>
            <p>
              The browser creates a separate Aztec account and claims the stake
              on L2. Export your account once ready to recover it in another
              browser.
            </p>
          </li>
          <li>
            <h3>Leave a mark</h3>
            <p>
              Publish through Aztec. A sponsor covers L2 execution fees. Your
              stake is refundable after 24 hours from your last post.
            </p>
          </li>
        </ol>
      </section>

      <section className="about-section" aria-labelledby="about-privacy">
        <p className="about-eyebrow">04 / The boundary</p>
        <h2 id="about-privacy">Public words. A private account.</h2>
        <p>
          Posts and their publication times are public on Aztec. The board does
          not display an author address, and your separate Aztec account can be
          recovered through a signature from your Ethereum wallet.
        </p>
        <p>
          That does not guarantee anonymity. L1 deposits and withdrawals are
          public. Timing and network metadata may allow activity to be
          correlated.
        </p>
      </section>

      <footer className="about-footer">
        <p className="about-eyebrow">Still taking shape</p>
        <h2>An ongoing experiment.</h2>
        <p>
          Notch runs on Aztec and uses Ethereum for stake deposits and refunds.
          The contracts have not been audited. Check the selected network before
          staking.
        </p>
        <div className="about-links">
          <Link className="about-board-link" to="/">
            Open board <span aria-hidden="true">↗</span>
          </Link>
          <a href="https://github.com/dfarchon/aztec_experiments">
            View source <span aria-hidden="true">↗</span>
          </a>
        </div>
      </footer>
    </main>
  );
}
