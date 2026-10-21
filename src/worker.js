// Copilot Watch: Telegram webhook, Discord interactions, and a 2-minute poll of public Strike and Hyperliquid data.
import { handleTelegram } from './telegram.js';
import { handleDiscord } from './discord.js';
import { poll } from './poll.js';

export default {
  async fetch(req, env, ctx) {
    const { pathname } = new URL(req.url);
    if (req.method === 'POST' && pathname === '/telegram') return handleTelegram(req, env, ctx);
    if (req.method === 'POST' && pathname === '/discord') return handleDiscord(req, env, ctx);
    if (pathname === '/health') return new Response('ok');
    if (pathname === '/') return new Response('Copilot Watch: Telegram and Discord alerts for Strike copy traders. https://t.me/CopilotWatchBot', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    return new Response('Not found', { status: 404 });
  },
  async scheduled(_e, env, ctx) { ctx.waitUntil(poll(env)); },
};
