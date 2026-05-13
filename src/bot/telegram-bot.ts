// src/bot/telegram-bot.ts

import { Bot, Context } from "grammy";
import { DCAAgent } from "../agent/dca-agent.js";
import { getJob, getLogByTxHash, listJobs, setJobStatus } from "../db/database.js";
import { logger, safeErrorMessage } from "../security/logger.js";
import {
  sanitizeUserInput, validateAmountUSD, safeParseChain, safeParseToken,
  MIN_AMOUNT_USD, MAX_AMOUNT_USD, SUPPORTED_CHAINS,
} from "../security/validator.js";
import type { SupportedChain } from "../security/validator.js";
import type { Policy } from "../policies/policy-engine.js";

// Rate limiter: max 20 msgs/min per user, /run max once per 30s
const msgTimestamps = new Map<number, number[]>();
const lastRunByUser = new Map<number, number>();

function rateCheck(userId: number): boolean {
  const now = Date.now();
  const times = (msgTimestamps.get(userId) ?? []).filter(t => now - t < 60_000);
  times.push(now);
  msgTimestamps.set(userId, times);
  return times.length <= 20;
}

// Block explorer URLs confirmed from chain docs
const EXPLORER: Record<string, string> = {
  base: "https://basescan.org/tx/",
  ethereum: "https://etherscan.io/tx/",
  arbitrum: "https://arbiscan.io/tx/",
  optimism: "https://optimistic.etherscan.io/tx/",
  polygon: "https://polygonscan.com/tx/",
};

// Wizard state per user
interface WizardState {
  step: number;
  name?: string;
  fromToken?: string;
  toToken?: string;
  amountUSD?: number;
  chain?: SupportedChain;
  cron?: string;
  slippage?: number;
  maxPriceUSD?: number | null;
  minPriceUSD?: number | null;
  maxPerExec?: number;
  maxDaily?: number;
}
const wizards = new Map<number, WizardState>();

export function createBot(token: string, ownerId: number, agent: DCAAgent): Bot {
  const bot = new Bot(token);

  // Auth middleware — every message
  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId || userId !== ownerId) {
      logger.audit("TelegramBot", "unauthorized_access", { userId });
      return;
    }
    if (!rateCheck(userId)) {
      await ctx.reply(" Rate limit reached. Please slow down.");
      return;
    }
    return next();
  });

  bot.command("start", async ctx => {
    await ctx.reply(
      `🛡 *ZerionSentinel* — Autonomous DCA Agent\n\n` +
      `Wallet: \`${agent.getWalletAddress()}\`\n\n` +
      `Commands:\n` +
      `/new — Create DCA job\n` +
      `/jobs — List all jobs\n` +
      `/status <id> — Job details\n` +
      `/run <id> — Execute now\n` +
      `/simulate <id> — Dry run\n` +
      `/pause <id> — Pause job\n` +
      `/resume <id> — Resume job\n` +
      `/history <id> — Execution logs\n` +
      `/verify <txhash> — Proof-of-Execution receipt\n` +
      `/policy <id> — View active policy`,
      { parse_mode: "Markdown" }
    );
  });

  // /new wizard
  bot.command("new", async ctx => {
    wizards.set(ctx.from!.id, { step: 1 });
    await ctx.reply("Step 1/7 — Job name (letters, numbers, hyphens only):");
  });

  // /jobs
  bot.command("jobs", async ctx => {
    const jobs = listJobs();
    if (jobs.length === 0) return ctx.reply("No jobs yet. Use /new to create one.");
    const lines = jobs.map(j =>
      `• *${j.name}* [\`${j.id.slice(0, 8)}\`] — ${j.status.toUpperCase()}\n  ${j.fromToken}→${j.toToken} $${j.amountUSD} on ${j.chain}`
    );
    await ctx.reply(lines.join("\n\n"), { parse_mode: "Markdown" });
  });

  // /status
  bot.command("status", async ctx => {
    const id = typeof ctx.match === "string" ? ctx.match.trim() : undefined;
    if (!id) return ctx.reply("Usage: /status <job_id>");
    const job = getJob(id);
    if (!job) return ctx.reply("Job not found.");
    await ctx.reply(
      `*${job.name}*\nID: \`${job.id}\`\nStatus: ${job.status}\n` +
      `Pair: ${job.fromToken} → ${job.toToken}\nAmount: $${job.amountUSD}\n` +
      `Chain: ${job.chain}\nCron: \`${job.cron}\`\n` +
      `Last run: ${job.lastRunAt ? new Date(job.lastRunAt).toISOString() : "Never"}`,
      { parse_mode: "Markdown" }
    );
  });

  // /run
  bot.command("run", async ctx => {
    const userId = ctx.from!.id;
    const now = Date.now();
    const lastRun = lastRunByUser.get(userId) ?? 0;
    
    lastRunByUser.set(userId, now);

    const id = typeof ctx.match === "string" ? ctx.match.trim() : undefined;
    if (!id) return ctx.reply("Usage: /run <job_id>");
    const job = getJob(id);
    if (!job) return ctx.reply("Job not found.");

    await ctx.reply(` Executing "${job.name}"...`);
    try {
      const log = await agent.executeNow(id);
      if (log.status === "success") {
        await ctx.reply(` Success!\nTx: \`${log.txHash}\`\nOut: ${log.amountOut} ${job.toToken}\n\nUse /verify ${log.txHash} for full receipt.`, { parse_mode: "Markdown" });
      } else {
        await ctx.reply(` ${log.status.replace("_", " ")}: ${log.message}`);
      }
    } catch (err) {
      await ctx.reply(` Error: ${safeErrorMessage(err)}`);
    }
  });

  // /simulate
  bot.command("simulate", async ctx => {
    const id = typeof ctx.match === "string" ? ctx.match.trim() : undefined;
    if (!id) return ctx.reply("Usage: /simulate <job_id>");
    const job = getJob(id);
    if (!job) return ctx.reply("Job not found.");
    await ctx.reply(`🔍 Simulating "${job.name}"...`);
    try {
      const sim = await agent.simulateJob(id);
      const policy = sim.policyResult.allowed ? " PASS" : ` FAIL — ${sim.policyResult.reason}`;
      const out = sim.estimatedOutputToken !== null ? `~${sim.estimatedOutputToken.toFixed(6)} ${job.toToken}` : "Unavailable";
      const gas = sim.estimatedGasUSD > 0 ? `~$${sim.estimatedGasUSD.toFixed(4)}` : "Unavailable";
      await ctx.reply(
        `*Simulation: ${job.name}*\n\n` +
        `Policy: ${policy}\n` +
        `Input: $${sim.inputUSD} ${job.fromToken}\n` +
        `Est. output: ${out}\n` +
        `Est. gas: ${gas}\n` +
        `Today spent: $${sim.todaySpentUSD.toFixed(2)}\n` +
        `Daily remaining: $${sim.remainingDailyUSD.toFixed(2)}\n` +
        (sim.priceGateStatus ? `Price gate: ${sim.priceGateStatus}` : ""),
        { parse_mode: "Markdown" }
      );
    } catch (err) {
      await ctx.reply(` Simulation error: ${safeErrorMessage(err)}`);
    }
  });

  // /verify — Proof-of-Execution receipt
  bot.command("verify", async ctx => {
    const txHash = typeof ctx.match === "string" ? ctx.match.trim() : undefined;
    if (!txHash || !/^0x[a-fA-F0-9]{64}$/.test(txHash)) return ctx.reply("Usage: /verify <0x txhash>");
    const log = getLogByTxHash(txHash);
    if (!log) return ctx.reply("No execution record found for that tx hash.");
    const job = getJob(log.jobId);
    let policy: Record<string, unknown> = {};
    try { policy = JSON.parse(log.policySnapshot ?? "{}"); } catch { /* ok */ }
    const explorer = EXPLORER[policy.chain as string ?? "base"] ?? EXPLORER.base;
    logger.audit("TelegramBot", "receipt_viewed", { txHash });
    await ctx.reply(
      ` *Proof-of-Execution Receipt*\n\n` +
      `Job: ${job?.name ?? log.jobId}\n` +
      `Tx: \`${log.txHash}\`\n` +
      `Status: ${log.status}\n` +
      `Amount in: $${log.amountInUSD}\n` +
      `Amount out: ${log.amountOut}\n` +
      `Gas cost: $${log.gasUSD?.toFixed(4) ?? "N/A"}\n` +
      `Time: ${new Date(log.executedAt).toISOString()}\n\n` +
      `Policy at execution:\n` +
      `• Chain: ${policy.chain}\n` +
      `• Max/exec: $${policy.maxPerExecutionUSD}\n` +
      `• Daily cap: $${policy.maxDailyUSD}\n` +
      `• Slippage max: ${policy.maxSlippagePercent}%\n\n` +
      `[View on explorer](${explorer}${log.txHash})`,
      { parse_mode: "Markdown" }
    );
  });

  // /history
  bot.command("history", async ctx => {
    const id = typeof ctx.match === "string" ? ctx.match.trim() : undefined;
    if (!id) return ctx.reply("Usage: /history <job_id>");
    const logs = agent.getHistory(id);
    if (logs.length === 0) return ctx.reply("No executions yet.");
    const lines = logs.slice(0, 5).map(l =>
      `${l.status === "success" ? "✅" : "⛔"} ${new Date(l.executedAt).toISOString().slice(0, 16)}\n` +
      (l.txHash ? `Tx: \`${l.txHash}\`` : `Reason: ${l.message}`)
    );
    await ctx.reply(lines.join("\n\n"), { parse_mode: "Markdown" });
  });

  // /policy
  bot.command("policy", async ctx => {
    const id = typeof ctx.match === "string" ? ctx.match.trim() : undefined;
    if (!id) return ctx.reply("Usage: /policy <job_id>");
    const job = getJob(id);
    if (!job) return ctx.reply("Job not found.");
    const { getPolicy: gp } = await import("../db/database.js");
    const p = gp(id);
    await ctx.reply(
      `*Policy for ${job.name}*\n\n` +
      `Chain lock: ${p.chain}\n` +
      `Max per execution: $${p.maxPerExecutionUSD}\n` +
      `Daily cap: $${p.maxDailyUSD}\n` +
      `Cooldown: ${p.cooldownSeconds}s\n` +
      `Expires: ${p.expiresAt > 0 ? new Date(p.expiresAt).toISOString() : "Never"}\n` +
      `Token allowlist: ${p.tokenAllowlist.length > 0 ? p.tokenAllowlist.join(", ") : "All tokens"}\n` +
      `Deny transfers: ${p.denyTransfers}\n` +
      `Deny approvals: ${p.denyApprovals}\n` +
      `Max slippage: ${p.maxSlippagePercent}%`,
      { parse_mode: "Markdown" }
    );
  });

  // Shared /pause|/resume helper
  const jobCommand = async (ctx: Context, action: "pause" | "resume") => {
    const id = typeof ctx.match === "string" ? ctx.match.trim() : undefined;
    if (!id) return ctx.reply(`Usage: /${action} <job_id>`);
    const job = getJob(id);
    if (!job) return ctx.reply("Job not found.");
    action === "pause" ? agent.pauseJob(id) : agent.resumeJob(id);
    logger.audit("TelegramBot", `job_${action}`, { jobId: id });
    await ctx.reply(`Job "${job.name}" ${action}d.`);
  };

  bot.command("pause",  ctx => jobCommand(ctx, "pause"));
  bot.command("resume", ctx => jobCommand(ctx, "resume"));

  // Wizard message handler
  bot.on("message:text", async ctx => {
    const userId = ctx.from!.id;
    const state = wizards.get(userId);
    if (!state) return;

    const text = ctx.message.text.trim();

    // Injection check on all wizard inputs
    const check = sanitizeUserInput(text);
    if (!check.ok) {
      await ctx.reply(` ${check.reason}`);
      wizards.delete(userId);
      return;
    }

    try {
      await handleWizardStep(ctx, userId, state, text, agent);
    } catch (err) {
      await ctx.reply(` ${safeErrorMessage(err)}`);
      wizards.delete(userId);
    }
  });

  return bot;
}

async function handleWizardStep(
  ctx: Context, userId: number, state: WizardState, text: string, agent: DCAAgent
): Promise<void> {
  switch (state.step) {
    case 1: {
      state.name = text;
      state.step = 2;
      wizards.set(userId, state);
      await ctx.reply("Step 2/7 — FROM token symbol (e.g. USDC):");
      break;
    }
    case 2: {
      const t = safeParseToken(text);
      if (!t) { await ctx.reply("Invalid token symbol. Letters and numbers only, e.g. USDC"); return; }
      state.fromToken = t; state.step = 3;
      wizards.set(userId, state);
      await ctx.reply("Step 3/7 — TO token symbol (e.g. ETH):");
      break;
    }
    case 3: {
      const t = safeParseToken(text);
      if (!t) { await ctx.reply("Invalid token symbol."); return; }
      state.toToken = t; state.step = 4;
      wizards.set(userId, state);
      await ctx.reply(`Step 4/7 — Amount in USD ($${MIN_AMOUNT_USD}–$${MAX_AMOUNT_USD}):`);
      break;
    }
    case 4: {
      const amt = validateAmountUSD(parseFloat(text));
      if (!amt.ok) { await ctx.reply(` ${amt.reason}`); return; }
      state.amountUSD = amt.value; state.step = 5;
      wizards.set(userId, state);
      await ctx.reply(`Step 5/7 — Chain (${SUPPORTED_CHAINS.join(", ")}):`);
      break;
    }
    case 5: {
      const chain = safeParseChain(text);
      if (!chain) { await ctx.reply(`Unsupported chain. Choose: ${SUPPORTED_CHAINS.join(", ")}`); return; }
      state.chain = chain; state.step = 6;
      wizards.set(userId, state);
      await ctx.reply("Step 6/7 — Cron schedule (e.g. 0 * * * * = hourly, 0 9 * * * = daily 9am):");
      break;
    }
    case 6: {
      state.cron = text; state.step = 7;
      wizards.set(userId, state);
      await ctx.reply("Step 7/7 — Max buy price in USD (e.g. 3000 for ETH), or type 'skip':");
      break;
    }
    case 7: {
      state.maxPriceUSD = text.toLowerCase() === "skip" ? null : parseFloat(text) || null;
      wizards.delete(userId);

      const job = await agent.createJob({
        name: state.name!,
        fromToken: state.fromToken!,
        toToken: state.toToken!,
        amountUSD: state.amountUSD!,
        chain: state.chain!,
        cron: state.cron!,
        slippage: 2,
        maxPriceUSD: state.maxPriceUSD ?? undefined,
        policy: {
          maxDailyUSD: state.amountUSD! * 5,
          cooldownSeconds: 300,
          denyTransfers: true,
          denyApprovals: true,
          maxSlippagePercent: 2,
        } as Partial<Policy>,
      });

      await ctx.reply(
        ` *Job created!*\n\nID: \`${job.id}\`\nName: ${job.name}\n` +
        `Pair: ${job.fromToken} → ${job.toToken}\n` +
        `Amount: $${job.amountUSD} on ${job.chain}\n` +
        `Schedule: \`${job.cron}\`\n\n` +
        `Use /simulate ${job.id} to dry-run first.`,
        { parse_mode: "Markdown" }
      );
      break;
    }
  }
}
