// src/agent/consensus-engine.ts
// Three-agent consensus system inspired by Wise Men Protocol
// Uses Anthropic Claude (claude-haiku-4-5 — fastest/cheapest) for each agent
// Balthasar: technical analysis | Melchior: fundamentals | Caspar: risk management

import { logger, safeErrorMessage } from "../security/logger.js";

export type AgentVerdict = "BUY" | "SELL" | "HOLD";

export interface AgentAnalysis {
  agent: "Balthasar" | "Melchior" | "Caspar";
  verdict: AgentVerdict;
  confidence: number;   // 0–100
  reasoning: string;
}

export interface ConsensusResult {
  verdict: AgentVerdict;
  confidence: number;
  analyses: AgentAnalysis[];
  consensusReached: boolean;
  voteCounts: Record<AgentVerdict, number>;
}

export interface MarketData {
  symbol: string;
  priceUSD: number;
  change24hPct: number;
  volumeUSD24h: number;
  marketCapUSD?: number;
  liquidityUSD?: number;
}

// Each agent has a distinct system prompt / persona
const AGENT_PERSONAS = {
  Balthasar: {
    focus: "technical analysis",
    systemPrompt: `You are Balthasar, a technical analysis agent. Analyze price momentum, volume trends, and market structure.
Focus only on: price action, 24h change, volume vs typical, support/resistance implications.
Respond ONLY with valid JSON: {"verdict":"BUY"|"SELL"|"HOLD","confidence":0-100,"reasoning":"one sentence max"}`,
  },
  Melchior: {
    focus: "fundamentals",
    systemPrompt: `You are Melchior, a fundamental analysis agent. Analyze token legitimacy, liquidity health, and organic growth signals.
Focus only on: market cap to liquidity ratio, volume/market cap ratio, red flags for wash trading.
Respond ONLY with valid JSON: {"verdict":"BUY"|"SELL"|"HOLD","confidence":0-100,"reasoning":"one sentence max"}`,
  },
  Caspar: {
    focus: "risk management",
    systemPrompt: `You are Caspar, a risk management agent. Your primary duty is capital preservation.
Assess downside risk based on: volatility (24h change magnitude), liquidity depth, position sizing safety.
Be conservative — prefer HOLD over risky BUY. 
Respond ONLY with valid JSON: {"verdict":"BUY"|"SELL"|"HOLD","confidence":0-100,"reasoning":"one sentence max"}`,
  },
};

async function queryAgent(
  agentName: keyof typeof AGENT_PERSONAS,
  market: MarketData,
  apiKey: string
): Promise<AgentAnalysis> {
  const persona = AGENT_PERSONAS[agentName];
  const userPrompt = `Analyze: ${market.symbol} | Price: $${market.priceUSD} | 24h: ${market.change24hPct.toFixed(2)}% | Volume: $${market.volumeUSD24h.toLocaleString()} | MarketCap: ${market.marketCapUSD ? "$" + market.marketCapUSD.toLocaleString() : "unknown"} | Liquidity: ${market.liquidityUSD ? "$" + market.liquidityUSD.toLocaleString() : "unknown"}`;

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 150,
      system: persona.systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  if (!resp.ok) throw new Error(`Anthropic API error: ${resp.status}`);

  const data = await resp.json() as { content: { type: string; text: string }[] };
  const text = data.content.find(b => b.type === "text")?.text ?? "{}";

  // Strip any markdown fences before parsing
  const clean = text.replace(/```json|```/g, "").trim();
  const parsed = JSON.parse(clean) as { verdict: AgentVerdict; confidence: number; reasoning: string };

  // Validate verdict is one of the allowed values
  const verdict = (["BUY", "SELL", "HOLD"] as AgentVerdict[]).includes(parsed.verdict)
    ? parsed.verdict : "HOLD";

  return {
    agent: agentName,
    verdict,
    confidence: Math.min(100, Math.max(0, Number(parsed.confidence) || 50)),
    reasoning: String(parsed.reasoning ?? "").slice(0, 200),
  };
}

// Majority vote — 2 of 3 required for BUY/SELL; otherwise HOLD
function tally(analyses: AgentAnalysis[]): ConsensusResult {
  const counts: Record<AgentVerdict, number> = { BUY: 0, SELL: 0, HOLD: 0 };
  for (const a of analyses) counts[a.verdict]++;

  let verdict: AgentVerdict = "HOLD";
  let consensusReached = false;

  if (counts.BUY >= 2) { verdict = "BUY"; consensusReached = true; }
  else if (counts.SELL >= 2) { verdict = "SELL"; consensusReached = true; }

  const avgConfidence = Math.round(
    analyses.filter(a => a.verdict === verdict).reduce((s, a) => s + a.confidence, 0) /
    Math.max(1, analyses.filter(a => a.verdict === verdict).length)
  );

  return { verdict, confidence: avgConfidence, analyses, consensusReached, voteCounts: counts };
}

export async function runConsensus(market: MarketData, anthropicApiKey: string): Promise<ConsensusResult> {
  logger.info("ConsensusEngine", "Starting 3-agent analysis", { symbol: market.symbol });

  // Run all three agents in parallel
  const results = await Promise.allSettled([
    queryAgent("Balthasar", market, anthropicApiKey),
    queryAgent("Melchior", market, anthropicApiKey),
    queryAgent("Caspar", market, anthropicApiKey),
  ]);

  const analyses: AgentAnalysis[] = results.map((r, i) => {
    const name = (["Balthasar", "Melchior", "Caspar"] as const)[i];
    if (r.status === "fulfilled") return r.value;
    logger.warn("ConsensusEngine", `Agent ${name} failed`, { err: safeErrorMessage(r.reason) });
    // Fail-safe: failing agent votes HOLD
    return { agent: name, verdict: "HOLD" as AgentVerdict, confidence: 0, reasoning: "Agent unavailable" };
  });

  const result = tally(analyses);
  logger.info("ConsensusEngine", "Consensus complete", {
    symbol: market.symbol, verdict: result.verdict, votes: result.voteCounts,
  });
  return result;
}
