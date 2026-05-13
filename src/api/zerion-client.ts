// src/api/zerion-client.ts
import axios, { AxiosInstance } from "axios";
import { logger } from "../security/logger.js";

const BASE_URL = "https://api.zerion.io/v1";

function makeAuthHeader(apiKey: string): string {
  return "Basic " + Buffer.from(`${apiKey}:`).toString("base64");
}

export interface SwapOffer {
  id: string;
  transaction: { to: string; from: string; chain_id: string; gas: number; data: string; value: string; };
  estimation: { input_quantity: { float: number; numeric: string }; output_quantity: { float: number; numeric: string }; gas: number; };
  output_quantity_min: { float: number; numeric: string };
  fee: { protocol: { percent: number } };
}

export interface WalletPosition {
  fungibleId: string; symbol: string; valueUSD: number; quantity: number; priceUSD: number;
}

export class ZerionClient {
  private http: AxiosInstance;

  constructor(apiKey: string) {
    this.http = axios.create({
      baseURL: BASE_URL,
      timeout: 15_000,
      headers: { Authorization: makeAuthHeader(apiKey), "Content-Type": "application/json", Accept: "application/json" },
    });
  }

  async getSwapOffers(params: {
    inputChain: string; outputChain: string;
    inputFungibleId: string; outputFungibleId: string;
    inputQuantity: string; walletAddress: string; slippagePercent: number;
  }): Promise<SwapOffer | null> {
    // Zerion fungible IDs must be short alphanumeric slugs e.g. "usd-coin", "ethereum"
    const queryParams = {
      "input[chain_id]": params.inputChain,
      "output[chain_id]": params.outputChain,
      "input[fungible_id]": params.inputFungibleId,
      "output[fungible_id]": params.outputFungibleId,
      "input[quantity]": params.inputQuantity,
      "input[address]": params.walletAddress,
      slippage_percent: params.slippagePercent,
      sort: "amount",
    };

    logger.info("ZerionClient", "Calling swap offers", {
      input: params.inputFungibleId, output: params.outputFungibleId,
      qty: params.inputQuantity, wallet: params.walletAddress,
    });

    for (let attempt = 0; attempt <= 2; attempt++) {
      try {
        const resp = await this.http.get("/swap/offers/", { params: queryParams });
        const offers = resp.data?.data;
        logger.info("ZerionClient", "Swap offers response", {
          count: Array.isArray(offers) ? offers.length : 0,
          raw: !Array.isArray(offers) ? JSON.stringify(resp.data).slice(0, 400) : "ok",
        });
        if (!Array.isArray(offers) || offers.length === 0) return null;
        const best = offers[0];
        return {
          id: best.id,
          transaction: best.attributes.transaction,
          estimation: best.attributes.estimation,
          output_quantity_min: best.attributes.output_quantity_min,
          fee: best.attributes.fee,
        };
      } catch (err: unknown) {
        const e = err as { response?: { status?: number; data?: unknown } };
        const status = e.response?.status;
        const data = JSON.stringify(e.response?.data ?? "").slice(0, 400);
        logger.warn("ZerionClient", "getSwapOffers failed", { attempt, status, data });
        if (attempt === 2 || status === 401 || status === 400) break;
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
    return null;
  }

  async getWalletPositions(walletAddress: string): Promise<WalletPosition[]> {
    try {
      const resp = await this.http.get(`/wallets/${walletAddress}/positions/`, {
        params: { "filter[position_types]": "wallet", currency: "usd" },
      });
      return (resp.data?.data ?? []).map((item: Record<string, unknown>) => {
        const attr = item.attributes as Record<string, unknown>;
        const qty = attr.quantity as { float: number } | undefined;
        const val = attr.value as number | undefined;
        return {
          fungibleId: "",
          symbol: (attr.symbol as string) ?? "",
          valueUSD: val ?? 0,
          quantity: qty?.float ?? 0,
          priceUSD: qty?.float && val ? val / qty.float : 0,
        };
      });
    } catch { return []; }
  }

  async getFungible(fungibleId: string): Promise<{ decimals: number; priceUSD: number } | null> {
    try {
      const resp = await this.http.get(`/fungibles/${fungibleId}/`);
      const attr = resp.data?.data?.attributes;
      return { decimals: attr?.implementations?.[0]?.decimals ?? 18, priceUSD: attr?.market_data?.price ?? 0 };
    } catch { return null; }
  }
}
