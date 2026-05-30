/**
 * index.ts — Resolution Lag Buyer Bot (Bot 5)
 *
 * Every 5 minutes, fetches markets that Gamma has resolved but the CLOB has
 * not yet settled. Buys the winning token at the stale ask price and holds
 * until the CLOB resolves to $1.
 */

import express, { type Request, type Response } from "express";
import {
  createWalletClient,
  createPublicClient,
  http,
  parseAbi,
  zeroHash,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { config } from "./config.js";
import { fetchClosedUnresolvedMarkets } from "./monitor.js";
import {
  findResolutionOpportunities,
  type ResolutionOpportunity,
} from "./oracle.js";
import { enterPosition } from "./executor.js";
import {
  getAllPositions,
  getTotalRealizedPnl,
  hasOpenPosition,
  getOpenPositionsCount,
  loadPersistedState,
} from "./inventory.js";
import { reportMetrics, buildSnapshot, getLastSnapshot } from "./metrics.js";
import { getCollateralBalance, cancelOrder, getOpenOrders } from "./clob.js";
import { loadAnalysis, scheduleAnalysisRefresh } from "./analysis.js";

// ── CTF redeem helpers ────────────────────────────────────────────────────────

const POLYGON_RPC = "https://polygon-bor-rpc.publicnode.com";
const CTF_CONTRACT_ADDRESS =
  "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045" as const;
const PUSD_TOKEN_ADDRESS =
  "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB" as const;
const USDCE_TOKEN_ADDRESS =
  "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174" as const;

const CTF_ABI = parseAbi([
  "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] calldata indexSets) external",
  "function getCollectionId(bytes32 parentCollectionId, bytes32 conditionId, uint256 indexSet) view returns (bytes32)",
  "function getPositionId(address collateralToken, bytes32 collectionId) view returns (uint256)",
]);

let lastOpportunities: ResolutionOpportunity[] = [];
let lastScanAt: string | null = null;

// ── Equity helper ─────────────────────────────────────────────────────────────

async function fetchAllocatedEquity(): Promise<number> {
  try {
    const res = await fetch(
      `${config.treasuryUrl}/allocations/${config.botId}`,
      { signal: AbortSignal.timeout(3_000) },
    );
    if (res.ok) {
      const data = (await res.json()) as { allocatedUsd: number };
      return data.allocatedUsd ?? 0;
    }
  } catch {
    // fall back
  }
  try {
    const botCount = parseInt(process.env["BOT_COUNT"] ?? "1", 10);
    return (await getCollateralBalance()) / botCount;
  } catch {
    return 0;
  }
}

// ── Main monitor cycle ────────────────────────────────────────────────────────

async function runMonitorCycle(): Promise<void> {
  if (getOpenPositionsCount() >= config.maxOpenPositions) {
    console.log("[lag] Max open positions reached — skipping scan");
    return;
  }

  const closedMarkets = await fetchClosedUnresolvedMarkets();
  const opportunities = await findResolutionOpportunities(closedMarkets);

  lastOpportunities = opportunities;
  lastScanAt = new Date().toISOString();

  // Filter by yield threshold and no existing position
  const actionable = opportunities.filter(
    (o) =>
      o.expectedYield * 100 >= config.minYieldPct &&
      !hasOpenPosition(o.market.id),
  );

  if (actionable.length === 0) {
    console.log("[lag] No actionable resolution-lag opportunities");
    return;
  }

  // Sort by highest yield first
  actionable.sort((a, b) => b.expectedYield - a.expectedYield);

  for (const opp of actionable) {
    if (getOpenPositionsCount() >= config.maxOpenPositions) break;
    console.log(
      `[lag] Opportunity: ${opp.market.question} | ` +
        `ask=${opp.currentAsk.toFixed(4)} yield=${(opp.expectedYield * 100).toFixed(2)}%`,
    );
    await enterPosition(opp).catch((err) =>
      console.error("[lag] enterPosition error:", (err as Error).message),
    );
  }
}

// ── Self-rescheduling loops ───────────────────────────────────────────────────

async function scheduleMonitor(): Promise<void> {
  try {
    await runMonitorCycle();
  } catch (err) {
    console.error("[lag] Monitor error:", (err as Error).message);
  }
  setTimeout(scheduleMonitor, config.monitorIntervalMs);
}

async function scheduleMetrics(): Promise<void> {
  try {
    const eq = await fetchAllocatedEquity();
    await reportMetrics(eq);
  } catch (err) {
    console.error("[lag] Metrics error:", (err as Error).message);
  }
  setTimeout(scheduleMetrics, 30_000);
}

// ── Express API ───────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

app.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true, botId: config.botId, name: "resolution-lag" });
});

app.get("/diagnostics", async (_req: Request, res) => {
  const eq = await fetchAllocatedEquity();
  const positions = getAllPositions();

  res.json({
    ok: true,
    botId: config.botId,
    name: "resolution-lag",
    healthy: true,
    allocatedEquity: eq,
    lastScanAt,
    metrics: getLastSnapshot() ?? buildSnapshot(eq),
    reconciliation: {
      openPositions: getOpenPositionsCount(),
      lastOpportunities: lastOpportunities.length,
      trackedPositions: positions.length,
    },
  });
});

app.get("/metrics", async (_req: Request, res: Response) => {
  const eq = await fetchAllocatedEquity();
  res.json(getLastSnapshot() ?? buildSnapshot(eq));
});

app.get("/positions", (_req: Request, res: Response) => {
  res.json({
    positions: getAllPositions(),
    totalRealizedPnl: getTotalRealizedPnl(),
  });
});

app.get("/opportunities", (_req: Request, res: Response) => {
  res.json({ opportunities: lastOpportunities, scannedAt: lastScanAt });
});

app.get("/config", (_req: Request, res: Response) => {
  res.json({
    botId: config.botId,
    walletAddress: config.polymarket.walletAddress,
    monitorIntervalMs: config.monitorIntervalMs,
    minYieldPct: config.minYieldPct,
    minAskPrice: config.minAskPrice,
    maxAskPrice: config.maxAskPrice,
    minPostEndMinutes: config.minPostEndMinutes,
    requiredResolutionConfirmations: config.requiredResolutionConfirmations,
    requireClobWinnerConfirmation: config.requireClobWinnerConfirmation,
    maxPositionUsd: config.maxPositionUsd,
    maxOpenPositions: config.maxOpenPositions,
  });
});

// POST /redeem — redeem resolved ERC-1155 shares from the bot's proxy wallet.
// Uses BOT_SIGNER_KEY to sign a direct on-chain call to CTF.redeemPositions.
app.post("/redeem", async (req: Request, res: Response) => {
  try {
    const { conditionId, outcomeIndex, tokenId } = req.body as {
      conditionId?: unknown;
      outcomeIndex?: unknown;
      tokenId?: unknown;
    };

    if (
      typeof conditionId !== "string" ||
      !/^0x[0-9a-fA-F]{64}$/.test(conditionId)
    ) {
      res
        .status(400)
        .json({ error: "conditionId must be a valid bytes32 hex" });
      return;
    }
    if (
      typeof outcomeIndex !== "number" ||
      !Number.isInteger(outcomeIndex) ||
      outcomeIndex < 0
    ) {
      res
        .status(400)
        .json({ error: "outcomeIndex must be a non-negative integer" });
      return;
    }

    const key = config.polymarket.signerKey;
    if (!key) {
      res.status(500).json({ error: "BOT_SIGNER_KEY not configured" });
      return;
    }

    const account = privateKeyToAccount(
      (key.startsWith("0x") ? key : `0x${key}`) as `0x${string}`,
    );
    const publicClient = createPublicClient({
      chain: polygon,
      transport: http(POLYGON_RPC),
    });
    const walletClient = createWalletClient({
      account,
      chain: polygon,
      transport: http(POLYGON_RPC),
    });

    const indexSet = BigInt(1) << BigInt(outcomeIndex);

    // Detect collateral token (pUSD or USDC.e) from tokenId when provided.
    let collateralToken: `0x${string}` = PUSD_TOKEN_ADDRESS;
    if (typeof tokenId === "string" && tokenId.length > 0) {
      const collectionId = await publicClient.readContract({
        address: CTF_CONTRACT_ADDRESS,
        abi: CTF_ABI,
        functionName: "getCollectionId",
        args: [zeroHash, conditionId as `0x${string}`, indexSet],
      });
      const usdcePosId = await publicClient.readContract({
        address: CTF_CONTRACT_ADDRESS,
        abi: CTF_ABI,
        functionName: "getPositionId",
        args: [USDCE_TOKEN_ADDRESS, collectionId],
      });
      if (usdcePosId === BigInt(tokenId)) {
        collateralToken = USDCE_TOKEN_ADDRESS;
      }
    }

    console.log(
      `[lag/redeem] Redeeming conditionId=${conditionId} outcomeIndex=${outcomeIndex} from ${account.address}`,
    );

    const txHash = await walletClient.writeContract({
      address: CTF_CONTRACT_ADDRESS,
      abi: CTF_ABI,
      functionName: "redeemPositions",
      args: [
        collateralToken,
        zeroHash,
        conditionId as `0x${string}`,
        [indexSet],
      ],
    });

    console.log(`[lag/redeem] tx submitted: ${txHash}`);
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
    });
    console.log(`[lag/redeem] confirmed in block ${receipt.blockNumber}`);

    res.json({
      txHash,
      walletAddress: account.address,
      conditionId,
      outcomeIndex,
    });
  } catch (err) {
    console.error("[lag/redeem] error:", (err as Error).message);
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post("/orders/cancel-all", async (_req: Request, res: Response) => {
  const orders = await getOpenOrders();
  let cancelled = 0;
  const errors: string[] = [];
  for (const order of orders) {
    try {
      await cancelOrder(order.id);
      cancelled++;
    } catch (err) {
      errors.push(`${order.id}: ${(err as Error).message}`);
    }
  }
  res.json({ ok: true, cancelled, total: orders.length, errors });
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(config.port, () => {
  console.log(
    `[lag] Resolution Lag Bot (id=${config.botId}) listening on :${config.port}`,
  );
  loadPersistedState();
  loadAnalysis()
    .then(() => scheduleAnalysisRefresh())
    .catch(() => {});
  scheduleMonitor();
  scheduleMetrics();
});
