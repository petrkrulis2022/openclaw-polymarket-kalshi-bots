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

apps.push(
  // ── Sports bots — user slot 15 (bot_wallet_index 15) ──────────────────
  // Port formula: 4010 + (botWalletIndex - 10) * 10 + portOffset
  // slot 15 → base port 4060; hockey portOffset=5 → 4065; football portOffset=6 → 4066
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
