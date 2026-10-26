// Language choice: English by default, simplified Chinese for Telegram users whose app is set to Chinese or who send /lang zh.
// Discord stays English. A chat's choice is kept in chat.settings.lang (or a short-lived pref before the chat has a record).
import { T, A } from './text.js';
import { TZ, AZ } from './text-zh.js';

export const LANGS = ['en', 'zh'];
const SETS = { en: { T, A }, zh: { T: TZ, A: AZ } };

/** Telegram's language_code (e.g. 'zh-hans', 'zh-hant', 'zh-tw', 'en') → 'zh' or 'en'. Traditional maps to simplified for now. */
export const autoLang = code => (/^zh/i.test(code || '') ? 'zh' : 'en');

/** /lang argument → 'en' | 'zh' | null. */
export function parseLang(arg) {
  const a = String(arg || '').trim().toLowerCase();
  if (['zh', 'cn', 'chinese', '中文', '简体', '简体中文'].includes(a)) return 'zh';
  if (['en', 'english', '英文', '英语'].includes(a)) return 'en';
  return null;
}

export const texts = lang => SETS[lang] || SETS.en;
