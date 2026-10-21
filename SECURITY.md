# Security

## What Copilot Watch can and can't do

- It reads **public** Strike and Hyperliquid endpoints only. It never asks for, receives or stores an API key, wallet signature or seed phrase. If anything claiming to be Copilot Watch asks for one, it isn't this bot.
- It can't place, change or close trades, and can't change any Strike setting.

## What is stored (Workers KV)

- Per chat: Telegram chat id or Discord channel and server ids, the user id that set the watch, the accounts watched, the alert threshold.
- Per watched account: the last open copies and fill ids seen (public data), to detect changes.
- Alert cool-down markers (expire after 6–24 hours) and, only when Telegram or Discord rejects a send, the alert text for up to an hour so it can be resent.
- `/stop` deletes the chat's data; an account nobody watches any more is deleted with it. Logs record counts only.

## How requests are checked

- Telegram webhook: `X-Telegram-Bot-Api-Secret-Token` compared in constant time; anything else gets 401. Direct messages only.
- Discord interactions: Ed25519 signature over timestamp + body with the application's public key; timestamps older than 5 minutes are refused. Outgoing messages disable all mentions and escape markdown in names that come from Strike.
- Limits: 10 commands a minute per chat (Workers rate limiting), 5 accounts per chat, 3 channels per Discord server, 300 chats in total; each poll stays within a subrequest budget.
- Discord: only the person who set a watch, or a member with Manage Server, can change or stop it.

## Secrets

Bot tokens and the webhook secret are Worker secrets, and locally live in `.secrets/` (git-ignored). Scripts read them from files and never print them.

## Reporting a problem

Email ben@benryan.com.au with "Copilot Watch security" in the subject. Please don't open a public issue for anything exploitable.
