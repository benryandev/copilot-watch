// Language choice: English by default; simplified Chinese ('zh') or traditional Chinese ('zh-Hant') for Telegram users whose app
// is set to Chinese or who send /lang zh | tw.
// Discord stays English. A chat's choice is kept in chat.settings.lang (or a short-lived pref before the chat has a record).
import { T, A } from './text.js';
import { TZ, AZ } from './text-zh.js';
import { TH, AH } from './text-zh-hant.js';

export const LANGS = ['en', 'zh', 'zh-Hant'];
const SETS = { en: { T, A }, zh: { T: TZ, A: AZ }, 'zh-Hant': { T: TH, A: AH } };

/** Telegram's language_code → 'zh-Hant' (zh-hant, zh-tw, zh-hk, zh-mo), 'zh' (other zh*) or 'en'. */
export const autoLang = code => (/^zh[-_](hant|tw|hk|mo)/i.test(code || '') ? 'zh-Hant' : /^zh/i.test(code || '') ? 'zh' : 'en');

/** /lang argument → 'en' | 'zh' | null. */
export function parseLang(arg) {
  const a = String(arg || '').trim().toLowerCase();
  if (['tw', 'hk', 'hant', 'zh-hant', 'zh-tw', '繁體', '繁体', '繁中', '繁體中文', '正體'].includes(a)) return 'zh-Hant';
  if (['zh', 'cn', 'hans', 'zh-hans', 'chinese', '中文', '简体', '简体中文', '簡體'].includes(a)) return 'zh';
  if (['en', 'english', '英文', '英语'].includes(a)) return 'en';
  return null;
}

export const texts = lang => SETS[lang] || SETS.en;
