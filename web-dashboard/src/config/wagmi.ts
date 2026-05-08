import { createConfig, http } from "wagmi";
import { polygon } from "wagmi/chains";
import { injected } from "wagmi/connectors";

// Use MetaMask's own injected provider as transport so txs go through
// the user's wallet RPC, not an unreliable public endpoint.
export const config = createConfig({
  chains: [polygon],
  connectors: [injected()],
  transports: {
    [polygon.id]: http("https://polygon-bor-rpc.publicnode.com"),
  },
});

export const USDT_ADDRESS =
  "0xc2132D05D31c914a87C6611C10748AEb04B58e8F" as const;
export const USDT_DECIMALS = 6;
