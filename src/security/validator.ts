// src/security/validator.ts
// OWASP A03:2025 Injection + LLM01:2025 Prompt Injection prevention

import { z } from "zod";

// Shell metacharacters — note: * excluded so cron expressions work
const SHELL_UNSAFE = /[;&|`$(){}<>\\"'#~\r\0]/;

// LLM prompt injection patterns
const LLM_INJECTION = [
  /ignore\s+(above|previous|all)/i,
  /override\s+(policy|rules|instructions)/i,
  /transfer\s+all/i,
  /system\s*:/i,
  /you\s+are\s+now/i,
  /disregard/i,
  /jailbreak/i,
];

export const MIN_AMOUNT_USD = 1;
export const MAX_AMOUNT_USD = 500;
export const MAX_SLIPPAGE = 3;
export const MAX_ACTIVE_JOBS = 10;

export const SUPPORTED_CHAINS = [
  "base", "ethereum", "arbitrum", "optimism", "polygon",
  "avalanche", "bnb-smart-chain", "linea", "scroll", "zksync-era",
] as const;
export type SupportedChain = typeof SUPPORTED_CHAINS[number];

export const JobNameSchema = z
  .string().min(1).max(40)
  .regex(/^[a-zA-Z0-9\s\-_]+$/, "Only alphanumeric, spaces, hyphens, underscores");

export const AmountSchema = z
  .number()
  .min(MIN_AMOUNT_USD, `Minimum $${MIN_AMOUNT_USD}`)
  .max(MAX_AMOUNT_USD, `Maximum $${MAX_AMOUNT_USD}`);

export const ChainSchema = z.enum(SUPPORTED_CHAINS as unknown as [string, ...string[]]);

export const TokenSymbolSchema = z
  .string().min(1).max(10)
  .regex(/^[A-Z0-9]+$/, "Uppercase letters and numbers only");

export const SlippageSchema = z
  .number().min(0.1).max(MAX_SLIPPAGE, `Max slippage is ${MAX_SLIPPAGE}%`);

export const CronSchema = z
  .string()
  .regex(
    /^(\*|[0-9,\-\/]+)\s+(\*|[0-9,\-\/]+)\s+(\*|[0-9,\-\/]+)\s+(\*|[0-9,\-\/]+)\s+(\*|[0-9,\-\/]+)$/,
    "Invalid cron expression"
  );

export function sanitizeUserInput(input: string): { ok: boolean; reason?: string } {
  // Skip shell/injection check for cron expressions (contain * and spaces)
  const isCron = /^[\d\s\*,\-\/]+$/.test(input.trim());
  if (!isCron && SHELL_UNSAFE.test(input))
    return { ok: false, reason: "Invalid characters" };
  for (const pattern of LLM_INJECTION) {
    if (pattern.test(input)) return { ok: false, reason: "Input rejected by security policy" };
  }
  return { ok: true };
}

export function validateAmountUSD(value: unknown): { ok: boolean; value?: number; reason?: string } {
  const result = AmountSchema.safeParse(Number(value));
  if (!result.success) return { ok: false, reason: result.error.errors[0]?.message };
  return { ok: true, value: result.data };
}

export function safeParseChain(value: string): SupportedChain | null {
  const r = ChainSchema.safeParse(value.toLowerCase());
  return r.success ? (r.data as SupportedChain) : null;
}

export function safeParseToken(value: string): string | null {
  const r = TokenSymbolSchema.safeParse(value.toUpperCase());
  return r.success ? r.data : null;
}
