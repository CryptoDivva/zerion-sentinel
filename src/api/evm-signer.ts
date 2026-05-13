// src/api/evm-signer.ts
import {
  createWalletClient,
  createPublicClient,
  http,
  type Hex,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, mainnet, arbitrum, optimism, polygon } from "viem/chains";
import { logger } from "../security/logger.js";

const CHAIN_MAP: Record<string, { chain: typeof base; rpc: string }> = {
  base:      { chain: base,     rpc: "https://mainnet.base.org" },
  ethereum:  { chain: mainnet,  rpc: "https://eth.llamarpc.com" },
  arbitrum:  { chain: arbitrum, rpc: "https://arb1.arbitrum.io/rpc" },
  optimism:  { chain: optimism, rpc: "https://mainnet.optimism.io" },
  polygon:   { chain: polygon,  rpc: "https://polygon-rpc.com" },
};

export interface TxRequest {
  to: Address; from: Address; data: Hex;
  value: bigint; gas: bigint; chainName: string;
}
export interface TxResult { txHash: Hex; gasUsed?: bigint; }

export class EVMSigner {
  private privateKey: Hex;
  constructor(privateKey: string) {
    if (!privateKey.startsWith("0x") || privateKey.length !== 66)
      throw new Error("Invalid private key format");
    this.privateKey = privateKey as Hex;
  }
  get address(): Address { return privateKeyToAccount(this.privateKey).address; }

  async sendTransaction(tx: TxRequest): Promise<TxResult> {
    const cfg = CHAIN_MAP[tx.chainName];
    if (!cfg) throw new Error(`Unsupported chain: ${tx.chainName}`);
    const account = privateKeyToAccount(this.privateKey);
    const transport = http(cfg.rpc, { timeout: 20_000 });
    const walletClient = createWalletClient({ account, chain: cfg.chain, transport });
    const publicClient = createPublicClient({ chain: cfg.chain, transport });
    logger.info("EVMSigner", "Sending tx", { chain: tx.chainName });
    const txHash = await walletClient.sendTransaction({
      to: tx.to, data: tx.data, value: tx.value, gas: tx.gas,
    });
    logger.audit("EVMSigner", "tx_sent", { txHash, chain: tx.chainName });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
    if (receipt.status === "reverted") throw new Error(`Transaction reverted: ${txHash}`);
    return { txHash, gasUsed: receipt.gasUsed };
  }

  async estimateGasUSD(tx: TxRequest): Promise<number> {
    const cfg = CHAIN_MAP[tx.chainName];
    if (!cfg) return 0;
    try {
      const publicClient = createPublicClient({ chain: cfg.chain, transport: http(cfg.rpc, { timeout: 10_000 }) });
      const gasPrice = await publicClient.getGasPrice();
      const gasCostETH = Number(tx.gas * gasPrice) / 1e18;
      return gasCostETH * 3000;
    } catch { return 0; }
  }
}
