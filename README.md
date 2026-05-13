# ZerionSentinel

Autonomous DCA onchain agent built on the Zerion API. No CLI dependency — pure REST + viem signing.

## What it does

- **DCA Bot**: Dollar-cost averages into any token on a cron schedule
- **9-gate Policy Engine**: Chain lock, spend limits, daily cap, cooldown, expiry, token allowlist, deny-transfers, deny-approvals, slippage max
- **Smart Price Gate**: Only executes if target token price is within your set range
- **Proof-of-Execution Receipt**: `/verify <txhash>` — shows policy snapshot active at execution time + block explorer link
- **Telegram interface**: Full bot with `/simulate` dry-run before spending real money

>  **Alpha Notice**: Built on Zerion API (stable REST) not the Zerion CLI (Alpha). All swaps route through Zerion's aggregator as required by the hackathon rules.

## Quick Start

### 1. Prerequisites
- Node.js 20+ (or 22+)
- A funded EVM wallet (USDC on Base recommended)
- Zerion API key from [dashboard.zerion.io](https://dashboard.zerion.io)
- Telegram bot token from [@BotFather](https://t.me/BotFather)
- Your Telegram user ID from [@userinfobot](https://t.me/userinfobot)

### 2. Install
```bash
git clone https://github.com/YOUR_USERNAME/zerion-sentinel.git
cd zerion-sentinel
npm install
```

### 3. Configure
```bash
cp .env.example .env
# Edit .env with your keys
chmod 600 .env   # Linux/Mac only
on Windows: icacls .env /inheritance:r /grant:r "$($env:username):(R,W)" 

Then Run: npm run dev
```

### 4. Test
Open Telegram, message your bot:
1. `/new` — Create a DCA job (7-step wizard)
 for example:
Step 1: ETH-DCA
Then follow the wizard steps that come next:
Step 2: USDC (from token)
Step 3: ETH (to token)
Step 4: 5 (amount in USD)
Step 5: base (chain)
Step 6: 0 * * * * (hourly cron)
Step 7: skip (no price gate for now)
2. `/simulate <id>` — Dry run first
3. `/run <id>` — Execute a real swap
4. `/verify <txhash>` — View Proof-of-Execution receipt

## Scoped Policies

Every job has a policy with these gates:

| Gate | Default | Description |
|------|---------|-------------|
| Chain lock | base | Execution locked to one chain |
| Max per execution | job amount ×1.1 | Spend cap per swap |
| Daily cap | job amount ×5 | Total daily spend limit |
| Cooldown | 300s | Min time between executions |
| Token allowlist | all | Optional: restrict to specific tokens |
| Deny transfers | true | Blocks raw ETH sends |
| Deny approvals | true | Blocks ERC-20 approvals |
| Max slippage | 2% | MEV protection |
| Price gate | optional | Only buy if price is within range |

## Architecture

```
Telegram Bot (Grammy)
    ↓
DCAAgent (scheduler + policy engine)
    ↓
ZerionClient (REST: /v1/swap/offers/)
    ↓
EVMSigner (viem: sign + broadcast)
    ↓
Base / EVM chain (real onchain tx)
```

## Security

- OWASP Top 10:2025 (A01–A10) addressed
- OWASP LLM Top 10:2025 (LLM01–LLM10) addressed  
- OWASP Infrastructure Security Risks 2024 (ISR01–ISR10) addressed
- Execution lock prevents double-spend race conditions
- All SQL uses prepared statements (no injection)
- Shell metacharacter blocking (no CLI injection)
- Structured logging with secret masking

## Forked from

[zeriontech/zerion-ai](https://github.com/zeriontech/zerion-ai)
