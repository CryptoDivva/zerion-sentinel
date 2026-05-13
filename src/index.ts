// src/index.ts

import "dotenv/config";
import { statSync } from "fs";
import { logger } from "./security/logger.js";
import { DCAAgent } from "./agent/dca-agent.js";
import { createBot } from "./bot/telegram-bot.js";

// Startup security checks
function runSecurityChecks(): void {
  logger.info("Security", "Running startup checks");

  // ISR07: detect placeholder credentials
  const apiKey  = process.env.ZERION_API_KEY ?? "";
  const botToken = process.env.TELEGRAM_BOT_TOKEN ?? "";
  const privKey  = process.env.WALLET_PRIVATE_KEY ?? "";
  const ownerId  = process.env.TELEGRAM_OWNER_ID ?? "";

  if (!apiKey || apiKey.includes("YOUR_") || apiKey.length < 10)
    throw new Error("ZERION_API_KEY is missing or is a placeholder");
  if (!botToken || botToken.includes("YOUR_") || !botToken.includes(":"))
    throw new Error("TELEGRAM_BOT_TOKEN is missing or is a placeholder");
  if (!privKey || !privKey.startsWith("0x") || privKey.length !== 66)
    throw new Error("WALLET_PRIVATE_KEY must be a 0x-prefixed 64-byte hex string");
  if (!ownerId || isNaN(parseInt(ownerId)))
    throw new Error("TELEGRAM_OWNER_ID must be a numeric Telegram user ID");

  // A02: check .env file permissions (Linux/Mac only)
  try {
    const mode = statSync(".env").mode & 0o777;
    if (mode > 0o600) logger.warn("Security", ".env file is readable by others — run: chmod 600 .env");
  } catch { /* .env may not exist in prod */ }

  // ISR04: warn if running as root
  if (process.getuid?.() === 0) logger.warn("Security", "Running as root is not recommended");

  // Enforce TLS — A02/ISR05
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "1";

  logger.info("Security", "Startup checks passed");
}

async function main(): Promise<void> {
  runSecurityChecks();

  const zerionApiKey    = process.env.ZERION_API_KEY!;
  const botToken        = process.env.TELEGRAM_BOT_TOKEN!;
  const privateKey      = process.env.WALLET_PRIVATE_KEY!;
  const ownerId         = parseInt(process.env.TELEGRAM_OWNER_ID!);
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY ?? "";

  const agent = new DCAAgent(zerionApiKey, privateKey, anthropicApiKey);

  // Notify ref pattern — no temporal dead zone
  let sendNotification: (msg: string) => void = () => {};
  agent.setNotify(msg => sendNotification(msg));

  const bot = createBot(botToken, ownerId, agent);

  // Wire notification to bot after both are created
  sendNotification = (msg: string) => {
    bot.api.sendMessage(ownerId, msg).catch(err =>
      logger.error("Notify", "Failed to send notification", { err: err.message })
    );
  };

  await agent.boot();

  bot.start({
    onStart: () => {
      logger.info("Bot", "ZerionSentinel running", { ownerId, wallet: agent.getWalletAddress() });
      console.log(`\n✅ ZerionSentinel running\n   Wallet: ${agent.getWalletAddress()}\n   Open Telegram and type /start\n`);
    },
  });

  // Graceful shutdown
  const shutdown = () => { bot.stop(); process.exit(0); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("uncaughtException", err => { logger.error("Process", "Uncaught exception", { err: err.message }); process.exit(1); });
  process.on("unhandledRejection", err => { logger.error("Process", "Unhandled rejection", { err: String(err) }); });
}

main().catch(err => { console.error("Fatal:", err.message); process.exit(1); });
