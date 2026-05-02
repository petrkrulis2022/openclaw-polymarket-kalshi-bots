import "dotenv/config";
import express from "express";
import { metricsRouter } from "./routes/metrics.js";
import { portfolioRouter } from "./routes/portfolio.js";
import { chatRouter } from "./routes/chat.js";
import usersRouter from "./routes/users.js";
import adminRouter from "./routes/admin.js";
import { getAllUsers } from "./user-store.js";

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true }));
app.use("/metrics", metricsRouter);
app.use("/portfolio", portfolioRouter);
app.use("/chat", chatRouter);
app.use("/users", usersRouter);
app.use("/admin", adminRouter);

app.use((_req, res) => res.status(404).json({ error: "Not found" }));

app.use(
  (
    err: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    console.error("Unhandled error", err);
    res.status(500).json({ error: "Internal server error" });
  },
);

const PORT = process.env["PORT"] ?? 3002;
const WDK_TREASURY_URL =
  process.env["WDK_TREASURY_URL"] ?? "http://localhost:3001";

// ── Autonomous USDT→USDC.e swap job ──────────────────────────────────────────
// Every 5 minutes: for each user with autonomous_mode=1, check USDT balance.
// If > 1 USDT, trigger a swap via the treasury service.

const AUTO_SWAP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const AUTO_SWAP_MIN_USDT = 1.0; // minimum balance (in USDT) to trigger swap

async function runAutoSwap(): Promise<void> {
  let users: ReturnType<typeof getAllUsers>;
  try {
    users = getAllUsers();
  } catch {
    return;
  }

  for (const user of users) {
    if (!user.autonomous_mode || !user.bot_wallet_address) continue;

    try {
      // Check balance first
      const balRes = await fetch(`${WDK_TREASURY_URL}/balance`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ index: user.bot_wallet_index }),
      });
      if (!balRes.ok) continue;

      const { usdt } = (await balRes.json()) as { usdt: string };
      if (parseFloat(usdt) < AUTO_SWAP_MIN_USDT) continue;

      console.log(
        `[auto-swap] Swapping ${usdt} USDT for user ${user.metamask_address} (wallet index ${user.bot_wallet_index})`,
      );

      const swapRes = await fetch(`${WDK_TREASURY_URL}/swap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ index: user.bot_wallet_index }),
      });

      if (swapRes.ok) {
        const result = (await swapRes.json()) as {
          usdtSwapped: string;
          usdceReceived: string;
          txHash: string;
        };
        console.log(
          `[auto-swap] ✓ ${result.usdtSwapped} USDT → ${result.usdceReceived} USDC.e  tx:${result.txHash}`,
        );
      } else {
        const body = await swapRes.text();
        console.error(
          `[auto-swap] Swap failed for ${user.metamask_address}: ${body}`,
        );
      }
    } catch (err) {
      console.error(
        `[auto-swap] Error for ${user.metamask_address}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

setInterval(() => {
  runAutoSwap().catch((err) =>
    console.error("[auto-swap] Unexpected error:", err),
  );
}, AUTO_SWAP_INTERVAL_MS);

app.listen(PORT, () =>
  console.log(`Orchestrator listening on http://localhost:${PORT}`),
);
