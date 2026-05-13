// src/security/logger.ts
// OWASP A09:2025 Security Logging + LLM02:2025 Sensitive Info Disclosure

const SECRET_PATTERNS = [
  /0x[a-fA-F0-9]{62,66}/g,          // private keys
  /zk_[a-zA-Z0-9_]{8,}/g,           // Zerion API keys
  /[0-9]{9,10}:[A-Za-z0-9_\-]{30,}/g, // Telegram tokens
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/g, // bearer tokens
];

const LEVEL = (process.env.LOG_LEVEL ?? "info").toLowerCase();
const LEVELS: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function mask(text: string): string {
  let out = text;
  for (const p of SECRET_PATTERNS) out = out.replace(p, "[REDACTED]");
  return out;
}

function emit(level: string, ctx: string, msg: string, meta?: unknown): void {
  if ((LEVELS[level] ?? 0) < (LEVELS[LEVEL] ?? 1)) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, ctx, msg, ...(meta ? { meta } : {}) });
  const safe = mask(line);
  if (level === "error" || level === "warn") process.stderr.write(safe + "\n");
  else process.stdout.write(safe + "\n");
}

export const logger = {
  debug: (ctx: string, msg: string, meta?: unknown) => emit("debug", ctx, msg, meta),
  info:  (ctx: string, msg: string, meta?: unknown) => emit("info",  ctx, msg, meta),
  warn:  (ctx: string, msg: string, meta?: unknown) => emit("warn",  ctx, msg, meta),
  error: (ctx: string, msg: string, meta?: unknown) => emit("error", ctx, msg, meta),
  audit: (ctx: string, event: string, meta?: unknown) => {
    const line = JSON.stringify({ ts: new Date().toISOString(), level: "AUDIT", ctx, event, ...(meta ? { meta } : {}) });
    process.stderr.write(mask(line) + "\n");
  },
};

export function safeErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message.replace(/\/[^\s]+/g, "[path]").slice(0, 200);
  return "Unknown error";
}
