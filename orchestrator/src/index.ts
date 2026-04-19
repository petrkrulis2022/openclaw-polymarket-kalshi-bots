import "dotenv/config";
import express from "express";
import { metricsRouter } from "./routes/metrics.js";
import { portfolioRouter } from "./routes/portfolio.js";
import { chatRouter } from "./routes/chat.js";

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true }));
app.use("/metrics", metricsRouter);
app.use("/portfolio", portfolioRouter);
app.use("/chat", chatRouter);

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
app.listen(PORT, () =>
  console.log(`Orchestrator listening on http://localhost:${PORT}`),
);
