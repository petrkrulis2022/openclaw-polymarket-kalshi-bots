const tunnelToken = process.env.CLOUDFLARE_TUNNEL_TOKEN;

if (!tunnelToken) {
  throw new Error(
    "CLOUDFLARE_TUNNEL_TOKEN is required to start the Cloudflare tunnel",
  );
}

module.exports = {
  apps: [
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
    {
      name: "tunnel",
      script: "/home/petrunix/.local/bin/cloudflared",
      args: `tunnel run --token ${tunnelToken}`,
      watch: false,
      autorestart: true,
    },
  ],
};
