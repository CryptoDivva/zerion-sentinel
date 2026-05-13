// src/db/database.ts
// Pure JSON file database — no native compilation needed (works on Node 24 Windows)

import { mkdirSync, existsSync, readFileSync, writeFileSync } from "fs";
import { Policy, DEFAULT_POLICY } from "../policies/policy-engine.js";
import { SupportedChain } from "../security/validator.js";

mkdirSync("data", { recursive: true });
const DB_PATH = "data/sentinel.json";

interface DbSchema {
  jobs: Record<string, DCAJob>;
  policies: Record<string, Policy>;
  logs: ExecutionLog[];
}

function load(): DbSchema {
  if (!existsSync(DB_PATH)) return { jobs: {}, policies: {}, logs: [] };
  try { return JSON.parse(readFileSync(DB_PATH, "utf-8")) as DbSchema; }
  catch { return { jobs: {}, policies: {}, logs: [] }; }
}

function save(db: DbSchema): void {
  writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf-8");
}

export interface DCAJob {
  id: string; name: string; fromToken: string; toToken: string;
  amountUSD: number; chain: SupportedChain; cron: string; slippage: number;
  maxPriceUSD: number | null; minPriceUSD: number | null;
  status: "active" | "paused"; createdAt: number; lastRunAt: number | null;
}

export interface ExecutionLog {
  id: string; jobId: string;
  status: "success" | "failed" | "policy_blocked" | "price_gated" | "execution_in_progress" | "policy_load_failed";
  txHash?: string; amountInUSD?: number; amountOut?: string;
  gasUSD?: number; priceImpact?: number; policySnapshot?: string;
  message?: string; executedAt: number;
}

export function saveJob(job: DCAJob, policy: Policy): void {
  const db = load(); db.jobs[job.id] = job; db.policies[job.id] = policy; save(db);
}
export function getJob(id: string): DCAJob | null { return load().jobs[id] ?? null; }
export function listJobs(): DCAJob[] { return Object.values(load().jobs); }
export function listActiveJobs(): DCAJob[] { return Object.values(load().jobs).filter(j => j.status === "active"); }
export function setJobStatus(id: string, status: "active" | "paused"): void {
  const db = load(); if (db.jobs[id]) { db.jobs[id].status = status; save(db); }
}
export function updateLastRun(id: string, ts: number): void {
  const db = load(); if (db.jobs[id]) { db.jobs[id].lastRunAt = ts; save(db); }
}
export function getPolicy(jobId: string): Policy { return load().policies[jobId] ?? DEFAULT_POLICY; }
export function saveLog(log: ExecutionLog): void {
  const db = load(); db.logs.push(log);
  if (db.logs.length > 500) db.logs = db.logs.slice(-500);
  save(db);
}
export function getLogsByJob(jobId: string): ExecutionLog[] {
  return load().logs.filter(l => l.jobId === jobId).slice(-10).reverse();
}
export function getLogByTxHash(txHash: string): ExecutionLog | null {
  return load().logs.find(l => l.txHash === txHash) ?? null;
}
export function getTodaySpend(jobId: string): number {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  return load().logs
    .filter(l => l.jobId === jobId && l.status === "success" && l.executedAt >= start.getTime())
    .reduce((s, l) => s + (l.amountInUSD ?? 0), 0);
}
