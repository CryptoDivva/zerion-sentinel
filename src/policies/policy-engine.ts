// src/policies/policy-engine.ts
// Scoped policy enforcement — all 9 gates, fail-closed on load failure

import { SupportedChain } from "../security/validator.js";

export interface Policy {
  chain: SupportedChain;
  maxPerExecutionUSD: number;
  maxDailyUSD: number;
  cooldownSeconds: number;
  expiresAt: number;             // unix ms; 0 = no expiry
  tokenAllowlist: string[];      // empty = all tokens allowed
  denyTransfers: boolean;
  denyApprovals: boolean;
  maxSlippagePercent: number;
}

export const DEFAULT_POLICY: Policy = {
  chain: "base",
  maxPerExecutionUSD: 50,
  maxDailyUSD: 200,
  cooldownSeconds: 3600,
  expiresAt: 0,
  tokenAllowlist: [],
  denyTransfers: true,
  denyApprovals: true,
  maxSlippagePercent: 2,
};

export interface PolicyCheckInput {
  chain: string;
  amountUSD: number;
  tokenSymbol: string;
  slippagePercent: number;
  todaySpentUSD: number;
  lastExecutedAt: number | null;  // unix ms
  isTransfer?: boolean;
  isApproval?: boolean;
}

export interface PolicyResult {
  allowed: boolean;
  reason?: string;
}

export function checkPolicy(p: Policy, input: PolicyCheckInput): PolicyResult {
  const now = Date.now();

  if (p.expiresAt > 0 && now > p.expiresAt)
    return { allowed: false, reason: "Policy expired" };

  if (input.chain !== p.chain)
    return { allowed: false, reason: `Chain locked to ${p.chain}` };

  if (input.amountUSD > p.maxPerExecutionUSD)
    return { allowed: false, reason: `Exceeds per-execution limit $${p.maxPerExecutionUSD}` };

  if (input.todaySpentUSD + input.amountUSD > p.maxDailyUSD)
    return { allowed: false, reason: `Would exceed daily cap $${p.maxDailyUSD}` };

  if (p.cooldownSeconds > 0 && input.lastExecutedAt !== null) {
    const elapsed = (now - input.lastExecutedAt) / 1000;
    if (elapsed < p.cooldownSeconds)
      return { allowed: false, reason: `Cooldown: ${Math.ceil(p.cooldownSeconds - elapsed)}s remaining` };
  }

  if (p.tokenAllowlist.length > 0 && !p.tokenAllowlist.includes(input.tokenSymbol.toUpperCase()))
    return { allowed: false, reason: `Token ${input.tokenSymbol} not in allowlist` };

  if (p.denyTransfers && input.isTransfer)
    return { allowed: false, reason: "Transfers blocked by policy" };

  if (p.denyApprovals && input.isApproval)
    return { allowed: false, reason: "Approvals blocked by policy" };

  if (input.slippagePercent > p.maxSlippagePercent)
    return { allowed: false, reason: `Slippage ${input.slippagePercent}% exceeds max ${p.maxSlippagePercent}%` };

  return { allowed: true };
}

export function buildPolicySnapshot(p: Policy): string {
  return JSON.stringify({
    chain: p.chain,
    maxPerExecutionUSD: p.maxPerExecutionUSD,
    maxDailyUSD: p.maxDailyUSD,
    cooldownSeconds: p.cooldownSeconds,
    expiresAt: p.expiresAt,
    tokenAllowlist: p.tokenAllowlist,
    denyTransfers: p.denyTransfers,
    denyApprovals: p.denyApprovals,
    maxSlippagePercent: p.maxSlippagePercent,
  });
}
