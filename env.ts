// ─── تهيئة البيئة: ترطيب الجلسة والإعدادات من متغيرات البيئة (للنشر على Render) ───
// يُستورد أولاً في index.ts حتى تُقرأ الإعدادات بعد الترطيب مباشرة.
// القاعدة: متغيرات البيئة تعمل فقط عند غياب البيانات المحلية — لا تطمس جلسة قائمة.
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, getSetting, setSetting } from "./db";

const SESSION_PATH = join(DATA_DIR, "session.txt");
const CONFIG_PATH = join(DATA_DIR, "config.json");

function envStr(key: string): string | undefined {
  const v = process.env[key];
  return v && v.trim() ? v.trim() : undefined;
}

function envNum(key: string): number | undefined {
  const v = Number(envStr(key));
  return Number.isFinite(v) && v > 0 ? v : undefined;
}

function applyEnv(): void {
  try {
    // 1) بيانات التطبيق (api_id / api_hash / phone)
    if (!existsSync(CONFIG_PATH)) {
      const apiId = envNum("API_ID");
      const apiHash = envStr("API_HASH");
      if (apiId && apiHash) {
        writeFileSync(CONFIG_PATH, JSON.stringify({ apiId, apiHash, phone: envStr("PHONE") || "" }, null, 2));
        console.log("• [env] حُمّلت بيانات التطبيق (api_id/api_hash) من متغيرات البيئة");
      }
    }

    // 2) جلسة تيليجرام (StringSession)
    if (!existsSync(SESSION_PATH)) {
      const s = envStr("SESSION_STRING");
      if (s) {
        writeFileSync(SESSION_PATH, s);
        console.log("• [env] حُمّلت جلسة تيليجرام من متغير البيئة SESSION_STRING");
      }
    }

    // 3) رقم الواتساب (يحمله كل محتوى ترويجي)
    const app = getSetting<{ waNumber?: string | null }>("app", {});
    if (!app.waNumber) {
      const wa = envStr("WA_NUMBER");
      if (wa) {
        app.waNumber = wa;
        setSetting("app", app);
        console.log(`• [env] ضُبط رقم الواتساب: ${wa}`);
      }
    }

    // 4) القناة الهدف (يلزمها الناشر والحملة)
    const target = getSetting<Record<string, unknown> | null>("target", null);
    if (!target) {
      const peer = envStr("TARGET_PEER");
      const id = envStr("TARGET_ID");
      if (peer && id) {
        setSetting("target", {
          peerId: peer,
          id,
          accessHash: envStr("TARGET_ACCESS_HASH") || null,
          title: envStr("TARGET_TITLE") || peer,
          username: envStr("TARGET_USERNAME") || null,
          isAdmin: true,
          isCreator: true,
          membersCount: 0,
        });
        console.log(`• [env] ضُبطت القناة الهدف: ${envStr("TARGET_TITLE") || peer}`);
      }
    }

    // 5) الناشر التلقائي — انطلاق ذاتي بعد الإقلاع
    const poster = getSetting<Record<string, unknown>>("poster", null);
    if ((envStr("POSTER_ON") || "").toLowerCase() === "true") {
      const intervalMin = envNum("POSTER_INTERVAL_MIN");
      const intervalMax = envNum("POSTER_INTERVAL_MAX");
      const dailyLimit = envNum("POSTER_DAILY_LIMIT");
      const next: Record<string, unknown> = { ...(poster || {}), running: true };
      if (intervalMin) next.intervalMin = Math.min(Math.max(intervalMin, 15), 720);
      if (intervalMax) next.intervalMax = Math.min(Math.max(intervalMax, Number(next.intervalMin) || 50), 1440);
      if (dailyLimit) next.dailyLimit = Math.min(Math.max(dailyLimit, 1), 40);
      if (Number(next.intervalMax) < Number(next.intervalMin)) next.intervalMax = next.intervalMin;
      setSetting("poster", next);
      console.log(`• [env] الناشر التلقائي مفعّل — كل ${next.intervalMin}-${next.intervalMax} دقيقة، سقف ${next.dailyLimit}/يوم`);
    }
  } catch (e) {
    console.log(`⚠ [env] تعذرت تهيئة متغيرات البيئة: ${String((e as Error).message || e)}`);
  }
}

applyEnv();
