// src/agent/dca-agent.ts

import cron from "node-cron";
import { randomUUID } from "crypto";
import { ZerionClient } from "../api/zerion-client.js";
import { EVMSigner } from "../api/evm-signer.js";
import { checkPolicy, buildPolicySnapshot, DEFAULT_POLICY, type Policy } from "../policies/policy-engine.js";
import {
  saveJob, getJob, listActiveJobs, setJobStatus, updateLastRun,
  getPolicy, saveLog, getLogsByJob, getTodaySpend,
  type DCAJob, type ExecutionLog,
} from "../db/database.js";
import { acquireLock, releaseLock } from "../security/execution-lock.js";
import { logger, safeErrorMessage } from "../security/logger.js";
import { validateAmountUSD, sanitizeUserInput, MAX_ACTIVE_JOBS, type SupportedChain } from "../security/validator.js";
import { runConsensus, type ConsensusResult } from "./consensus-engine.js";

// Stable USD price — no API needed for stablecoins
const STABLE_PRICE: Record<string, number> = {
  USDC: 1.0, USDT: 1.0, DAI: 1.0,
};

// Token decimals — standard ERC-20
const TOKEN_DECIMALS: Record<string, number> = {
  USDC: 6, USDT: 6, DAI: 18, ETH: 18, WETH: 18, MATIC: 18,
};

// Zerion global fungible ID slugs — must match ^[A-Za-z\d]{3,44}$

const FUNGIBLE_SLUGS: Record<string, string> = {
  USDC: "usdcoin", ETH: "ethereum", WETH: "wrappedether",
  DAI: "dai", USDT: "tether", MATIC: "maticnetwork", WBTC: "wrappedbitcoin",
};
function getFungibleId(symbol: string): string {
  return FUNGIBLE_SLUGS[symbol.toUpperCase()] ?? symbol.toLowerCase();
}

export interface CreateJobParams {
  name: string; fromToken: string; toToken: string;
  amountUSD: number; chain: SupportedChain; cron: string;
  slippage?: number; maxPriceUSD?: number; minPriceUSD?: number;
  requireConsensus?: boolean; policy?: Partial<Policy>;
}

export interface SimulateResult {
  policyResult: { allowed: boolean; reason?: string };
  estimatedOutputToken: number | null;
  estimatedGasUSD: number;
  inputUSD: number;
  todaySpentUSD: number;
  remainingDailyUSD: number;
  priceGateStatus: string | null;
}

type NotifyFn = (msg: string) => void;

export class DCAAgent {
  private zerion: ZerionClient;
  private signer: EVMSigner;
  private anthropicApiKey: string;
  private scheduledJobs = new Map<string, cron.ScheduledTask>();
  private notifyFn: NotifyFn = () => {};

  constructor(zerionApiKey: string, privateKey: string, anthropicApiKey = "") {
    this.zerion = new ZerionClient(zerionApiKey);
    this.signer = new EVMSigner(privateKey);
    this.anthropicApiKey = anthropicApiKey;
  }

  setNotify(fn: NotifyFn): void { this.notifyFn = fn; }
  getWalletAddress(): string { return this.signer.address; }

  async boot(): Promise<void> {
    const jobs = listActiveJobs();
    for (const job of jobs) this.scheduleJob(job);
    logger.info("DCAAgent", "Booted", { activeJobs: jobs.length });
  }

  async createJob(params: CreateJobParams): Promise<DCAJob> {
    const nameCheck = sanitizeUserInput(params.name);
    if (!nameCheck.ok) throw new Error(nameCheck.reason);
    const amtCheck = validateAmountUSD(params.amountUSD);
    if (!amtCheck.ok) throw new Error(amtCheck.reason);
    const active = listActiveJobs();
    if (active.length >= MAX_ACTIVE_JOBS) throw new Error(`Max ${MAX_ACTIVE_JOBS} active jobs`);

    const job: DCAJob = {
      id: randomUUID(), name: params.name,
      fromToken: params.fromToken.toUpperCase(),
      toToken: params.toToken.toUpperCase(),
      amountUSD: params.amountUSD, chain: params.chain,
      cron: params.cron, slippage: params.slippage ?? 2,
      maxPriceUSD: params.maxPriceUSD ?? null,
      minPriceUSD: params.minPriceUSD ?? null,
      status: "active", createdAt: Date.now(), lastRunAt: null,
    };

    const policy: Policy = {
      ...DEFAULT_POLICY, chain: params.chain,
      maxPerExecutionUSD: params.amountUSD * 1.1,
      ...(params.policy ?? {}),
    };

    saveJob(job, policy);
    this.scheduleJob(job);
    logger.audit("DCAAgent", "job_created", { jobId: job.id, name: job.name });
    return job;
  }

  async executeNow(jobId: string): Promise<ExecutionLog> {
    const job = getJob(jobId);
    if (!job) throw new Error("Job not found");
    return this.doExecution(job);
  }

  async simulateJob(jobId: string): Promise<SimulateResult> {
    const job = getJob(jobId);
    if (!job) throw new Error("Job not found");
    const policy = getPolicy(jobId);
    const todaySpentUSD = getTodaySpend(jobId);
    const policyResult = checkPolicy(policy, {
      chain: job.chain, amountUSD: job.amountUSD, tokenSymbol: job.toToken,
      slippagePercent: job.slippage, todaySpentUSD, lastExecutedAt: job.lastRunAt,
    });

    let priceGateStatus: string | null = null;
    if (job.maxPriceUSD !== null || job.minPriceUSD !== null) {
      priceGateStatus = "Price gate configured — checked at execution time";
    }

    let estimatedOutputToken: number | null = null;
    let estimatedGasUSD = 0;

    if (policyResult.allowed) {
      try {
        const fromPrice = STABLE_PRICE[job.fromToken] ?? 0;
        const fromDecimals = TOKEN_DECIMALS[job.fromToken] ?? 18;
        if (fromPrice > 0) {
          const inputQty = Math.floor((job.amountUSD / fromPrice) * (10 ** fromDecimals));
          const offer = await this.zerion.getSwapOffers({
            inputChain: job.chain,
            outputChain: job.chain,
            inputFungibleId: getFungibleId(job.fromToken),
            outputFungibleId: getFungibleId(job.toToken),
            inputQuantity: inputQty.toString(),
            walletAddress: this.signer.address,
            slippagePercent: job.slippage,
          });
          if (offer) {
            estimatedOutputToken = offer.estimation.output_quantity.float;
            estimatedGasUSD = await this.signer.estimateGasUSD({
              to: offer.transaction.to as `0x${string}`,
              from: offer.transaction.from as `0x${string}`,
              data: offer.transaction.data as `0x${string}`,
              value: BigInt(offer.transaction.value),
              gas: BigInt(offer.transaction.gas),
              chainName: job.chain,
            });
          }
        }
      } catch { /* non-blocking */ }
    }

    return {
      policyResult, estimatedOutputToken, estimatedGasUSD,
      inputUSD: job.amountUSD, todaySpentUSD,
      remainingDailyUSD: policy.maxDailyUSD - todaySpentUSD,
      priceGateStatus,
    };
  }

  pauseJob(jobId: string): void {
    const task = this.scheduledJobs.get(jobId);
    if (task) { task.stop(); this.scheduledJobs.delete(jobId); }
    setJobStatus(jobId, "paused");
  }

  resumeJob(jobId: string): void {
    const job = getJob(jobId);
    if (!job) throw new Error("Job not found");
    setJobStatus(jobId, "active");
    this.scheduleJob(job);
  }

  getHistory(jobId: string): ExecutionLog[] { return getLogsByJob(jobId); }
  listJobs(): DCAJob[] { return listActiveJobs(); }

  private scheduleJob(job: DCAJob): void {
    if (this.scheduledJobs.has(job.id)) return;
    const task = cron.schedule(job.cron, () => {
      this.doExecution(job).catch(err =>
        logger.error("DCAAgent", "Scheduled execution error", { jobId: job.id, err: safeErrorMessage(err) })
      );
    });
    this.scheduledJobs.set(job.id, task);
  }

  private async doExecution(job: DCAJob): Promise<ExecutionLog> {
    if (!acquireLock(job.id))
      return this.blocked(job.id, "execution_in_progress", "Another execution already running");

    try {
      // 1. Load policy — fail-closed
      let policy: Policy;
      try { policy = getPolicy(job.id); }
      catch {
        return this.blocked(job.id, "policy_load_failed", "Policy could not be loaded");
      }

      // 2. Policy check
      const todaySpent = getTodaySpend(job.id);
      const policyResult = checkPolicy(policy, {
        chain: job.chain, amountUSD: job.amountUSD, tokenSymbol: job.toToken,
        slippagePercent: job.slippage, todaySpentUSD: todaySpent, lastExecutedAt: job.lastRunAt,
      });
      if (!policyResult.allowed) {
        this.notifyFn(`Job "${job.name}" blocked: ${policyResult.reason}`);
        return this.blocked(job.id, "policy_blocked", policyResult.reason!);
      }

      // 3. Optional AI consensus gate
      const jobWithFlags = job as DCAJob & { requireConsensus?: boolean };
      if (jobWithFlags.requireConsensus && this.anthropicApiKey) {
        let consensus: ConsensusResult;
        try {
          consensus = await runConsensus(
            { symbol: job.toToken, priceUSD: 0, change24hPct: 0, volumeUSD24h: 0 },
            this.anthropicApiKey
          );
        } catch {
          return this.blocked(job.id, "policy_blocked", "Consensus engine unavailable");
        }
        if (!consensus.consensusReached || consensus.verdict !== "BUY") {
          this.notifyFn(` Agents voted ${consensus.verdict} — skipping cycle`);
          return this.blocked(job.id, "price_gated", `Consensus: ${consensus.verdict}`);
        }
      }

      // 4. Price gate
      const priceGate = await this.checkPriceGate(job);
      if (priceGate) {
        this.notifyFn(`⏸ Job "${job.name}" price-gated: ${priceGate}`);
        return this.blocked(job.id, "price_gated", priceGate);
      }

      // 5. Resolve token price and decimals (use stable price map first, then API)
      const fromSymbol = job.fromToken.toUpperCase();
      const fromPriceUSD = STABLE_PRICE[fromSymbol] ?? 0;
      const fromDecimals = TOKEN_DECIMALS[fromSymbol] ?? 18;

      if (fromPriceUSD === 0) throw new Error(`Unknown token price for ${job.fromToken}. Supported: USDC, USDT, DAI, ETH, WETH`);

      const inputQty = Math.floor((job.amountUSD / fromPriceUSD) * (10 ** fromDecimals));

      // 6. Get swap offer from Zerion API
      const offer = await this.zerion.getSwapOffers({
        inputChain: job.chain,
        outputChain: job.chain,
        inputFungibleId: getFungibleId(job.fromToken),
        outputFungibleId: getFungibleId(job.toToken),
        inputQuantity: inputQty.toString(),
        walletAddress: this.signer.address,
        slippagePercent: job.slippage,
      });
      if (!offer) throw new Error("No swap offer returned by Zerion API. Check your wallet has sufficient USDC balance on Base.");
	  
      logger.info("DCAAgent", "Swap request", {
        chain: job.chain,
        inputFungibleId: getFungibleId(job.fromToken),
        outputFungibleId: getFungibleId(job.toToken),
        inputQty: inputQty.toString(),
      });

  
      // 7. Sign + broadcast
      const result = await this.signer.sendTransaction({
        to: offer.transaction.to as `0x${string}`,
        from: offer.transaction.from as `0x${string}`,
        data: offer.transaction.data as `0x${string}`,
        value: BigInt(offer.transaction.value),
        gas: BigInt(offer.transaction.gas),
        chainName: job.chain,
      });

      // 8. Build receipt
      const gasUSD = await this.signer.estimateGasUSD({
        to: offer.transaction.to as `0x${string}`,
        from: offer.transaction.from as `0x${string}`,
        data: offer.transaction.data as `0x${string}`,
        value: BigInt(offer.transaction.value),
        gas: result.gasUsed ?? BigInt(offer.transaction.gas),
        chainName: job.chain,
      });

      const log: ExecutionLog = {
        id: randomUUID(), jobId: job.id, status: "success",
        txHash: result.txHash, amountInUSD: job.amountUSD,
        amountOut: offer.estimation.output_quantity.numeric,
        gasUSD, policySnapshot: buildPolicySnapshot(policy),
        message: `Swapped $${job.amountUSD} ${job.fromToken} → ${job.toToken}`,
        executedAt: Date.now(),
      };

      saveLog(log);
      updateLastRun(job.id, log.executedAt);
      logger.audit("DCAAgent", "swap_success", { jobId: job.id, txHash: result.txHash });
      this.notifyFn(` "${job.name}" executed\nTx: ${result.txHash}\nOut: ${offer.estimation.output_quantity.numeric} ${job.toToken}`);
      return log;

    } catch (err) {
      const log: ExecutionLog = {
        id: randomUUID(), jobId: job.id, status: "failed",
        message: safeErrorMessage(err), executedAt: Date.now(),
      };
      saveLog(log);
      this.notifyFn(` Job "${job.name}" failed: ${safeErrorMessage(err)}`);
      return log;
    } finally {
      releaseLock(job.id);
    }
  }

  private async checkPriceGate(job: DCAJob): Promise<string | null> {
    if (job.maxPriceUSD === null && job.minPriceUSD === null) return null;
    const positions = await this.zerion.getWalletPositions(this.signer.address);
    const pos = positions.find(p => p.symbol.toUpperCase() === job.toToken.toUpperCase());
    if (!pos || pos.priceUSD === 0) return null;
    if (job.maxPriceUSD !== null && pos.priceUSD > job.maxPriceUSD)
      return `${job.toToken} price $${pos.priceUSD.toFixed(2)} above max $${job.maxPriceUSD}`;
    if (job.minPriceUSD !== null && pos.priceUSD < job.minPriceUSD)
      return `${job.toToken} price $${pos.priceUSD.toFixed(2)} below min $${job.minPriceUSD}`;
    return null;
  }

  private blocked(jobId: string, status: ExecutionLog["status"], message: string): ExecutionLog {
    const log: ExecutionLog = { id: randomUUID(), jobId, status, message, executedAt: Date.now() };
    saveLog(log);
    return log;
  }
}
