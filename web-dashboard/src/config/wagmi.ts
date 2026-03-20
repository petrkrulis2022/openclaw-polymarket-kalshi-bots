import { createConfig, http } from "wagmi";
import { polygon } from "wagmi/chains";
import { injected } from "wagmi/connectors";

export const config = createConfig({
  chains: [polygon],
  connectors: [injected()],
  transports: {
    [polygon.id]: http(),
  },
});

export const USDT_ADDRESS =
  "0xc2132D05D31c914a87C6611C10748AEb04B58e8F" as const;
export const USDT_DECIMALS = 6;
