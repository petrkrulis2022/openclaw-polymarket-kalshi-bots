/**
 * attribution.ts — tell the orchestrator which positions belong to this bot.
 *
 * The bot shares one Polymarket proxy wallet with the user's other bots, so the
 * orchestrator can't infer ownership from the wallet alone. We POST an
 * attribution record whenever we take/hold a position so the portfolio view can
 * label it correctly. Fire-and-forget — never block quoting on this.
 */
import { config } from "./config.js";

export function recordAttribution(
  conditionId: string,
  tokenId: string,
  outcomeIndex: number,
  side: "YES" | "NO",
  marketQuestion: string,
): void {
  const userAddress = process.env["USER_METAMASK_ADDRESS"] ?? "";
  if (!userAddress) return;
  fetch(`${config.orchestratorUrl}/positions/attribute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      userAddress,
      conditionId,
      outcomeIndex,
      tokenId,
      botName: "market-maker",
      marketQuestion,
      side,
    }),
    signal: AbortSignal.timeout(3000),
  }).catch(() => {});
}
