export const POLYGON_CHAIN_ID = 137;
export const POLYGON_RPC_URL =
  process.env.POLYGON_RPC_URL || "https://polygon-bor-rpc.publicnode.com";

export const GAMMA_API_URL = "https://gamma-api.polymarket.com";
export const CLOB_API_URL = "https://clob.polymarket.com";

export const CONTRACTS = Object.freeze({
  pUsd: "0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb",
  ctf: "0x4d97dcd97ec945f40cf65f87097ace5ea0476045",
  standardExchangeV2: "0xe111180000d2663c0091e4f400237545b87b996b",
});

export const TOPICS = Object.freeze({
  erc20Transfer:
    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
  erc1155TransferSingle:
    "0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62",
  orderFilled:
    "0xd543adfd945773f1a62f74f0ee55a5e3b9b1a28262980ba90b1a89f2ea84d8ee",
});

