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
      args: "run dev",
      watch: false,
      autorestart: true,
    },
    {
      name: "tunnel",
      script: "/home/petrunix/.local/bin/cloudflared",
      args: "tunnel run --token eyJhIjoiNGNlZTQwYmJjODQ0YzNiMDdiNTNiMTJjODg5YTJjMGEiLCJ0IjoiYzUzOGI1NGEtNjg3OC00MWQ0LWI4NmItYWRkMjlhNjE4MWY2IiwicyI6Ik56TTJNbUV6TVRNdE1HWTBaQzAwTlRaa0xUa3dZMk10TURNNU16a3hZbVpqTnpOayJ9",
      watch: false,
      autorestart: true,
    },
  ],
};
