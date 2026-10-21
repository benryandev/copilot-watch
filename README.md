# Copilot Watch

Telegram and Discord alerts for Strike copy traders: hear when a copy is close to liquidation, when the wallet you copy has left a position your copy still holds, or when one of its trades wasn't copied.

Built during the Strike Finance hackathon (22–24 Oct 2026). Not affiliated with Strike Finance. Not financial advice.

## Try it

- **Telegram:** open [@CopilotWatchBot](https://t.me/CopilotWatchBot) and send `/start`.
- **Discord:** add the bot to your server (install link below), then run `/watch` in the channel where alerts should go.

`/watch` takes a Strike address (`addr1…`), a Strike nickname, or a sub-account ID (Strike app → Sub-accounts → Account ID → copy). An address or nickname watches the main account and every active sub-account; add a sub-account name to watch only that one (`/watch addr1… Sub1`).

| Command | What it does |
|---|---|
| `/watch <account> [sub-account name]` | Start watching; replies with each account's active copies |
| `/status` | Open copies, P&L and distance to liquidation, nearest first |
| `/settings liq=5` | Liquidation alert threshold, 1–20% (a second alert always fires at 2%) |
| `/unwatch <account>` | Stop watching one account |
| `/stop` | Stop everything here and delete this chat's data |

## Alerts

Checked about every 2 minutes. Each alert fires once per event (a near-liquidation alert can repeat after 6 hours), and says what happened plus the plain options. The first check after `/watch` only records a baseline, so history never triggers alerts.

| | Alert | When |
|---|---|---|
| A1 | Copy near liquidation | Mark within the set % of the copy's liquidation price, again at 2%. Stock and commodity markets add a note that prices pause outside market hours. |
| A2 | Orphaned copy | The copy is still open but the lead holds nothing on that market, or holds the opposite side, in two checks in a row. If the lead was liquidated there, the alert says so. |
| A3 | Missed copy | The lead opened or added on a market Strike lists and this account has no copy fill for it within 10 minutes (likely caps, balance or a leverage lock). |
| A4 | Lead close to liquidation | The lead's Hyperliquid cross maintenance margin reaches 60% of account value (Hyperliquid liquidates at 100%), on either the crypto or the stock/commodity account. |
| A5 | Lead moved money out | More than half of the lead's Hyperliquid account withdrawn in 24 hours (matters for fixed-ratio copies, which size off the lead's equity). |
| A6 | Copy liquidated or ended | A copy fill closed by liquidation or auto-deleverage, or the subscription changed to liquidated or stopped. |

## How it uses Strike

Public, unauthenticated reads only. Copilot Watch never asks for an API key: Strike keys can trade and have no read-only scope.

| Need | Endpoint |
|---|---|
| Resolve `/watch` | `GET /v2/account?blockchain_address=`, `GET /v2/account?account_id=`, `GET /v2/account/by-nickname?nickname=` |
| Which leads an account copies | `GET /v2/copy/leaderboard?status=active` (also `liquidated`, `stopped` when a copy ends) |
| Copied positions with mark and liquidation price | `GET /v2/copy/positions?account_id=` (fallback: `GET /v2/positions` + `GET /price/v2/premiumIndex`) |
| Copy fills, liquidations, ADL | `GET /v2/history/fill?account_id=` (`client_order_id` = `copy:<subscription>:…`, `auto_close_type`) |
| Markets and the Hyperliquid twin of each | `GET /v2/markets` |
| Lead side (Hyperliquid info API) | `clearinghouseState` (main and `xyz` dex), `userFillsByTime`, `userNonFundingLedgerUpdates`, `meta` |

## How it runs

A Cloudflare Worker (`src/worker.js`) with three entry points:

- `POST /telegram`: Telegram webhook, checked against a secret header (constant-time compare). Direct messages only.
- `POST /discord`: Discord HTTP interactions, Ed25519 signature and timestamp checked; replies are deferred and then edited, alerts are posted to the channel. Mentions are always disabled and Strike-supplied names are markdown-escaped.
- A cron every 2 minutes (`src/poll.js`) reads each watched account once and each lead once, however many chats watch them, diffs against the stored baseline, and sends alerts. A lead that Hyperliquid doesn't answer for is skipped for that round, never read as "holds nothing".

State lives in Workers KV. `core/` (HTTP with backoff, Strike and Hyperliquid clients, market map) is shared with [Copilot Check](https://github.com/benryandev/copilot-check) and copied in by `pnpm sync-core`; a test checks the copy against its hash.

## Privacy

Stored per chat: the Telegram chat id or Discord channel and server ids, the user id that set the watch (Discord permissions), the accounts watched, the alert threshold, and per account the last 200 fill ids and open copies seen (public data). Alert text is stored only when Telegram or Discord can't take it, for up to an hour so it can be resent; logs carry counts only. `/stop` deletes the chat's data; accounts no longer watched by anyone are deleted with it.

## Limits

- Per chat: 5 accounts, 10 commands a minute. Per Discord server: 3 channels. In total: 300 chats (a prototype limit). Each 2-minute run reads at most ~900 public endpoints; accounts and leads beyond that roll over to the next run. In Discord, only the person who set a watch or a member with Manage Server can change or stop it.
- Strike's copy list can lag up to 10 minutes, so a brand-new or just-stopped copy can take that long to show.
- Caps, exclusions and leverage settings aren't public, so a missed-copy alert can only say "likely caps, balance or a leverage lock".
- Hyperliquid rate-limits by IP and Workers share IPs; a busy round skips the lead rather than guessing.

## Run it yourself

```sh
pnpm test                      # node --test, no dependencies
pnpm sync-core                 # copy core/ from ../copilot-check
pnpm dlx wrangler@4 secret put TELEGRAM_TOKEN            # and DISCORD_TOKEN, TELEGRAM_WEBHOOK_SECRET
pnpm deploy
node scripts/set-telegram.mjs  # webhook, commands, description
node scripts/register-discord.mjs --guild <id> | --global
node scripts/register-discord.mjs --set-endpoint https://<worker>/discord
```

Tokens are read from `.secrets/` (git-ignored) and never printed.

## Licence

MIT. Not financial advice. Not affiliated with Strike Finance. Past results don't predict future ones.

Built by [Ben Ryan](https://benryan.com.au).

## Accounts (public identifiers, not secrets)

- Telegram bot: [@CopilotWatchBot](https://t.me/CopilotWatchBot)
- Discord application ID: `1561719393992319007`
- Discord public key: `50e537c588ad61fa8b38b6ced330efecd368c0c74f351ea710808beba8d6cb48` (verifies interaction signatures)
- Discord test server ("Copilot") guild ID: `1561721893071880303` (for guild-scoped slash commands)
- Cloudflare: Workers Paid account; KV namespace `copilot-watch` (`22fd6ef1fa074edea7689bdaa2b5378f`); Worker at `copilot-watch.benryan.workers.dev`.
