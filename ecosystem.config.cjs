const tunnelToken = process.env.CLOUDFLARE_TUNNEL_TOKEN;

const apps = [
  {
    name: "treasury",
    cwd: "./wdk-treasury",
    script: "npm",
    args: "run dev",
    watch: false,
    autorestart: true,
  },
  {
    name: "orchestrator",
    cwd: "./orchestrator",
    script: "npm",
    args: "run dev",
    watch: false,
    autorestart: true,
  },
  {
    name: "dashboard",
    cwd: "./web-dashboard",
    script: "npm",
    args: "run preview",
    watch: false,
    autorestart: true,
  },
];

if (tunnelToken) {
  apps.push({
    name: "tunnel",
    script: "/home/petrunix/.local/bin/cloudflared",
    args: `tunnel run --token ${tunnelToken}`,
    watch: false,
    autorestart: true,
  });
} else {
  console.warn(
    "[pm2] CLOUDFLARE_TUNNEL_TOKEN not set; skipping tunnel app in ecosystem",
  );
}

// ── Base trading bots (user 0) ──────────────────────────────────────
apps.push(
  {
    name: "copy-trader",
    cwd: "./bots/copy-trader",
    script: "npm",
    args: "run dev",
    watch: false,
    autorestart: true,
  },
  {
    name: "market-maker",
    cwd: "./bots/market-maker",
    script: "npm",
    args: "run dev",
    watch: false,
    autorestart: true,
  },
  {
    name: "in-market-arb",
    cwd: "./bots/in-market-arb",
    script: "npm",
    args: "run dev",
    watch: false,
    autorestart: true,
  },
  {
    name: "resolution-lag",
    cwd: "./bots/resolution-lag",
    script: "npm",
    args: "run dev",
    watch: false,
    autorestart: true,
  },
  {
    name: "microstructure",
    cwd: "./bots/microstructure",
    script: "npm",
    args: "run dev",
    watch: false,
    autorestart: true,
  },
  {
    name: "btc-lag",
    cwd: "./bots/btc-lag",
    script: "npm",
    args: "run dev",
    watch: false,
    autorestart: true,
  },
  {
    name: "sports-bot",
    cwd: "./bots/sports-bot",
    script: "npm",
    args: "run dev",
    watch: false,
    autorestart: true,
  },
);

// ── User-slot trading bots (user 5) ──────────────────────────────────
apps.push(
  {
    name: "copy-trader-u5",
    cwd: "./bots/copy-trader",
    script: "npm",
    args: "run dev",
    watch: false,
    autorestart: true,
    env: { BOT_WALLET_INDEX: "15" },
  },
  {
    name: "market-maker-u5",
    cwd: "./bots/market-maker",
    script: "npm",
    args: "run dev",
    watch: false,
    autorestart: true,
    env: { BOT_WALLET_INDEX: "15" },
  },
  {
    name: "in-market-arb-u5",
    cwd: "./bots/in-market-arb",
    script: "npm",
    args: "run dev",
    watch: false,
    autorestart: true,
    env: { BOT_WALLET_INDEX: "15" },
  },
  {
    name: "resolution-lag-u5",
    cwd: "./bots/resolution-lag",
    script: "npm",
    args: "run dev",
    watch: false,
    autorestart: true,
    env: { BOT_WALLET_INDEX: "15" },
  },
  {
    name: "microstructure-u5",
    cwd: "./bots/microstructure",
    script: "npm",
    args: "run dev",
    watch: false,
    autorestart: true,
    env: { BOT_WALLET_INDEX: "15" },
  },
);

// ── User-slot trading bots (user 7) ──────────────────────────────────
apps.push(
  {
    name: "copy-trader-u7",
    cwd: "./bots/copy-trader",
    script: "npm",
    args: "run dev",
    watch: false,
    autorestart: true,
    env: { BOT_WALLET_INDEX: "17" },
  },
  {
    name: "market-maker-u7",
    cwd: "./bots/market-maker",
    script: "npm",
    args: "run dev",
    watch: false,
    autorestart: true,
    env: { BOT_WALLET_INDEX: "17" },
  },
  {
    name: "in-market-arb-u7",
    cwd: "./bots/in-market-arb",
    script: "npm",
    args: "run dev",
    watch: false,
    autorestart: true,
    env: { BOT_WALLET_INDEX: "17" },
  },
  {
    name: "resolution-lag-u7",
    cwd: "./bots/resolution-lag",
    script: "npm",
    args: "run dev",
    watch: false,
    autorestart: true,
    env: { BOT_WALLET_INDEX: "17" },
  },
  {
    name: "microstructure-u7",
    cwd: "./bots/microstructure",
    script: "npm",
    args: "run dev",
    watch: false,
    autorestart: true,
    env: { BOT_WALLET_INDEX: "17" },
  },
);

// ── User-slot trading bots (user 0) ──────────────────────────────────
apps.push(
  {
    name: "copy-trader-u0",
    cwd: "./bots/copy-trader",
    script: "npm",
    args: "run dev",
    watch: false,
    autorestart: true,
    env: { BOT_WALLET_INDEX: "10" },
  },
  {
    name: "market-maker-u0",
    cwd: "./bots/market-maker",
    script: "npm",
    args: "run dev",
    watch: false,
    autorestart: true,
    env: { BOT_WALLET_INDEX: "10" },
  },
  {
    name: "in-market-arb-u0",
    cwd: "./bots/in-market-arb",
    script: "npm",
    args: "run dev",
    watch: false,
    autorestart: true,
    env: { BOT_WALLET_INDEX: "10" },
  },
  {
    name: "resolution-lag-u0",
    cwd: "./bots/resolution-lag",
    script: "npm",
    args: "run dev",
    watch: false,
    autorestart: true,
    env: { BOT_WALLET_INDEX: "10" },
  },
  {
    name: "microstructure-u0",
    cwd: "./bots/microstructure",
    script: "npm",
    args: "run dev",
    watch: false,
    autorestart: true,
    env: { BOT_WALLET_INDEX: "10" },
  },
);

// ── Sports bots — user slot 15 (bot_wallet_index 15) ──────────────────────────────────────
// Port formula: 4010 + (botWalletIndex - 10) * 10 + portOffset
// slot 15 → base port 4060; hockey portOffset=5 → 4065; football portOffset=6 → 4066
apps.push(
  {
    name: "hockey-bot-u5",
    cwd: "./bots/hockey",
    script: "npx",
    args: "tsx scripts/hockey-bot.ts",
    watch: false,
    autorestart: true,
    env: {
      PORT: "4065",
      ORCHESTRATOR_URL: "http://localhost:3002",
    },
  },
  {
    name: "football-bot-u5",
    cwd: "./bots/football",
    script: "npx",
    args: "tsx scripts/football-bot.ts",
    watch: false,
    autorestart: true,
    env: {
      PORT: "4066",
      ORCHESTRATOR_URL: "http://localhost:3002",
    },
  },
);

module.exports = {
  apps,
};
