# Copilot Watch

Alerts for Strike copy traders, in Telegram and Discord: hear when the wallet you copy does something your copy can't follow.

Built for the Strike Finance hackathon (October 2026). Not affiliated with Strike Finance. General information only, not financial advice.

Built by [Ben Ryan](https://benryan.com.au).

## Accounts (public identifiers, not secrets)

- Telegram bot: [@CopilotWatchBot](https://t.me/CopilotWatchBot)
- Discord application ID: `1561719393992319007`
- Discord public key: `50e537c588ad61fa8b38b6ced330efecd368c0c74f351ea710808beba8d6cb48` (verifies interaction signatures)

Tokens live in `.secrets/` (git-ignored) and are never committed.

## Cloudflare

- Account: Ben's (ID `e1c2429ec9002472d72b7cfa3749ce2c`); wrangler 4 via `pnpm dlx wrangler@4`, OAuth login on Ben's Mac.
- KV namespace `copilot-watch`: id `22fd6ef1fa074edea7689bdaa2b5378f` (created 19 Oct 2026, empty).
- workers.dev subdomain: `ben-e1c` (auto-created 19 Oct). Placeholder Worker `copilot-watch` holds secrets `TELEGRAM_TOKEN` and `DISCORD_TOKEN` (loaded from `.secrets/` files); no code deployed yet.
