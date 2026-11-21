import "driver.js/dist/driver.css";

import { driver } from "driver.js";

export function startBoardGuide(seenKey: string) {
  const guide = driver({
    popoverClass: "billboard-tour",
    overlayColor: "#000",
    overlayOpacity: 0.62,
    stagePadding: 8,
    stageRadius: 0,
    popoverOffset: 16,
    disableActiveInteraction: true,
    skipMissingElement: true,
    showProgress: true,
    closeBtnLabel: "Skip guide",
    nextBtnText: "Next",
    prevBtnText: "Back",
    doneBtnText: "Done",
    onPopoverRender: ({ closeButton }) => {
      closeButton.textContent = "Skip";
    },
    steps: [
      {
        element: ".board-content",
        popover: {
          title: "Public board",
          description:
            "Read posts without connecting. Refresh from the top right.",
          showButtons: ["next", "close"],
        },
      },
      {
        element: "#walletMenu",
        popover: {
          title: "Connect a wallet",
          description: "Connect an Ethereum wallet and stake before you post.",
        },
      },
      {
        element: ".compose-card",
        popover: {
          title: "Leave a message",
          description: "Write at the bottom of the board, then post.",
        },
      },
    ],
    onDestroyed: (_element, _step, { reason }) => {
      if (!["done", "close", "escape", "overlay"].includes(reason || ""))
        return;
      try {
        localStorage.setItem(seenKey, "1");
      } catch {
        // The guide remains available for this visit without storage.
      }
    },
  });
  guide.drive();
  return guide;
}
