// ─── خدمة الرشق — خادم HTTP (المنفذ من البيئة PORT أو 3030) ───
import "./env"; // تهيئة الجلسة/الإعدادات من متغيرات البيئة أولاً (للنشر على Render)
import {
  authCode,
  authLogout,
  authPassword,
  authResend,
  authStart,
  boot,
  channelPublicLink,
  createChannel,
  errMsg,
  exportInviteLink,
  healthPayload,
  importContacts,
  listDialogs,
  meInfo,
  postToChannel,
  resolveChannel,
  savedCreds,
  scrapeSource,
  type TargetInfo,
} from "./tg";
import {
  campaignStatus,
  clearFlood,
  poolStats,
  resumeIfRunning,
  startCampaign,
  stopCampaign,
} from "./engine";
import {
  addMessage,
  deleteMessage,
  listMessages,
  postNow,
  posterStatus,
  resumePoster,
  startPoster,
  stopPoster,
  updateMessage,
} from "./poster";
import { db, getLogs, getSetting, log, setSetting } from "./db";

const PORT = Number(process.env.PORT) || 3030;

// ─── إعدادات افتراضية ───

const DEFAULT_TEMPLATE = `📢 أهلاً بك في قناتنا الجديدة!

هنا تنزل [محتوى القناة — يُحدَّث لاحقاً]

📩 للاستفسار والتواصل المباشر عبر واتساب:
👉 {wa}

🔗 انضم للقناة:
{link}`;

interface AppSettings {
  waNumber: string | null;
  template: string;
  scrapeLimit: number;
}

function appSettings(): AppSettings {
  const s = getSetting<Partial<AppSettings>>("app", {});
  return {
    waNumber: s.waNumber ?? null,
    template: s.template || DEFAULT_TEMPLATE,
    scrapeLimit: s.scrapeLimit ?? 2000,
  };
}

// ─── مساعدات الاستجابة ───

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-store",
};

function ok(data: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ ok: true, ...data }), {
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS },
  });
}

function fail(e: unknown, status = 400): Response {
  return new Response(JSON.stringify({ ok: false, error: errMsg(e) }), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS },
  });
}

async function body(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

// ─── المسارات ───

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = req.method.toUpperCase();
  const q = url.searchParams;

  // ── الصحة والهوية ──
  if (path === "/api/health" && method === "GET") {
    return ok({ service: "tg-rashq", ...healthPayload() });
  }

  // ── التجهيز المسبق (اعتمادات محفوظة + مخطط القناة + واتساب) ──
  if (path === "/api/prepared" && method === "GET") {
    const c = savedCreds();
    const s = appSettings();
    return ok({
      apiId: c?.apiId ?? null,
      hasApiHash: !!c?.apiHash,
      phone: c?.phone || null,
      waNumber: s.waNumber,
      blueprint: getSetting<{ title: string; username: string } | null>("channelBlueprint", null),
    });
  }

  if (path === "/api/me" && method === "GET") {
    try {
      return ok({ user: await meInfo() });
    } catch (e) {
      return fail(e);
    }
  }

  // ── المصادقة ──
  if (path === "/api/auth/start" && method === "POST") {
    try {
      const b = await body(req);
      // دمج مع الاعتمادات المحفوظة مسبقاً — يكفي إرسال الرقم وحده
      const saved = savedCreds();
      const apiId = Number(b.apiId) || saved?.apiId || 0;
      const apiHash = String(b.apiHash || "").trim() || saved?.apiHash || "";
      let phone = String(b.phone || "").trim();
      if (!phone.startsWith("+")) phone = `+${phone.replace(/^0+/, "")}`;
      if (!apiId || !apiHash) throw new Error("بيانات ناقصة — api_id و api_hash مطلوبة");
      if (!/^\+\d{7,15}$/.test(phone)) throw new Error("رقم الهاتف غير صحيح (بصيغة دولية مثل +9677xxxxxxx)");
      const r = await authStart({ apiId, apiHash, phone });
      return ok({ codeSent: true, viaApp: r.viaApp });
    } catch (e) {
      return fail(e);
    }
  }

  if (path === "/api/auth/code" && method === "POST") {
    try {
      const b = await body(req);
      const r = await authCode(String(b.code || "").trim());
      return ok({ done: r.done, needPassword: r.needPassword });
    } catch (e) {
      return fail(e);
    }
  }

  if (path === "/api/auth/password" && method === "POST") {
    try {
      const b = await body(req);
      const r = await authPassword(String(b.password || ""));
      return ok({ done: r.done });
    } catch (e) {
      return fail(e);
    }
  }

  if (path === "/api/auth/resend" && method === "POST") {
    try {
      await authResend();
      return ok({ codeSent: true });
    } catch (e) {
      return fail(e);
    }
  }

  if (path === "/api/auth/logout" && method === "POST") {
    try {
      stopCampaign("تم إيقاف الحملة بسبب تسجيل الخروج");
      stopPoster();
      await authLogout();
      return ok({});
    } catch (e) {
      return fail(e);
    }
  }

  // ── الحوارات ──
  if (path === "/api/dialogs" && method === "GET") {
    try {
      return ok({ dialogs: await listDialogs() });
    } catch (e) {
      return fail(e);
    }
  }

  // ── القناة الهدف ──
  if (path === "/api/target" && method === "GET") {
    return ok({ target: getSetting<TargetInfo | null>("target", null) });
  }

  if (path === "/api/target" && method === "POST") {
    try {
      const b = await body(req);
      const peerId = String(b.peerId || "");
      if (!peerId) throw new Error("peerId مطلوب");
      const r = await resolveChannel(peerId);
      const info = await r.info();
      setSetting("target", info);
      log(info.isAdmin ? "success" : "warn", `عُيّنت «${info.title}» هدفاً (${info.isAdmin ? "مشرف ✓" : "ليس مشرفاً ✗"})`);
      return ok({ target: info });
    } catch (e) {
      return fail(e);
    }
  }

  if (path === "/api/target" && method === "DELETE") {
    setSetting("target", null);
    stopCampaign("أُوقفت الحملة: أُزيلت القناة الهدف");
    stopPoster();
    return ok({});
  }

  if (path === "/api/target/check" && method === "POST") {
    try {
      const t = getSetting<TargetInfo | null>("target", null);
      if (!t) throw new Error("لا هدف معيّن");
      const r = await resolveChannel(t.peerId);
      const info = await r.info();
      setSetting("target", info);
      return ok({ target: info });
    } catch (e) {
      return fail(e);
    }
  }

  if (path === "/api/target/create" && method === "POST") {
    try {
      const b = await body(req);
      const title = String(b.title || "").trim();
      const about = String(b.about || "").trim();
      if (title.length < 3) throw new Error("اسم القناة قصير جداً");
      const rawUsername = String(b.username || "").trim().replace(/^@/, "");
      let username: string | undefined;
      if (rawUsername) {
        if (!/^[a-zA-Z0-9_]{5,32}$/.test(rawUsername)) {
          throw new Error("الرابط القصير غير صالح — 5-32 حرفاً إنجليزياً/رقماً/شرطة سفلية فقط");
        }
        username = rawUsername;
      }
      const info = await createChannel(title, about, username);
      return ok({ target: info });
    } catch (e) {
      return fail(e);
    }
  }

  // ── المصادر ──
  if (path === "/api/sources" && method === "GET") {
    const sources = db
      .query(
        `SELECT s.peer_id, s.title, s.type, s.last_scrape,
                (SELECT COUNT(*) FROM members m WHERE m.source_peer = s.peer_id) as count
         FROM sources s ORDER BY s.rowid DESC`
      )
      .all() as { peer_id: string; title: string; type: string; last_scrape: number | null; count: number }[];
    return ok({
      sources: sources.map((s) => ({
        peerId: s.peer_id,
        title: s.title,
        type: s.type,
        count: s.count,
        lastScrape: s.last_scrape,
      })),
    });
  }

  if (path === "/api/sources" && method === "POST") {
    try {
      const b = await body(req);
      const peerId = String(b.peerId || "");
      const title = String(b.title || "");
      const type = String(b.type || "group");
      const accessHash = b.accessHash ? String(b.accessHash) : null;
      if (!peerId || !title) throw new Error("بيانات المصدر ناقصة");
      db.query(
        `INSERT INTO sources(peer_id, title, type, access_hash) VALUES(?, ?, ?, ?)
         ON CONFLICT(peer_id) DO UPDATE SET title = excluded.title, type = excluded.type, access_hash = COALESCE(excluded.access_hash, sources.access_hash)`
      ).run(peerId, title, type, accessHash);
      log("info", `أُضيف مصدر: «${title}»`);
      return ok({});
    } catch (e) {
      return fail(e);
    }
  }

  if (path === "/api/sources" && method === "DELETE") {
    const peerId = q.get("peerId") || "";
    if (peerId) {
      db.query("DELETE FROM sources WHERE peer_id = ?").run(peerId);
      log("info", `أُزيل مصدر ${peerId}`);
    }
    return ok({});
  }

  // ── السحب ──
  if (path === "/api/scrape" && method === "POST") {
    try {
      const b = await body(req);
      const peerId = String(b.peerId || "");
      const limit = Math.min(Math.max(Number(b.limit) || appSettings().scrapeLimit, 100), 20000);
      const src = db.query("SELECT title FROM sources WHERE peer_id = ?").get(peerId) as { title: string } | null;
      const title = src?.title || peerId;
      const r = await scrapeSource(peerId, limit, title);
      return ok(r);
    } catch (e) {
      return fail(e);
    }
  }

  // ── الحوض ──
  if (path === "/api/pool" && method === "GET") {
    return ok(poolStats());
  }

  // ── جهات الاتصال ──
  if (path === "/api/contacts/import" && method === "POST") {
    try {
      const b = await body(req);
      const phones = Array.isArray(b.phones) ? (b.phones as unknown[]).map(String) : [];
      if (phones.length === 0) throw new Error("لا أرقام مرسلة");
      if (phones.length > 200) throw new Error("200 رقم كحد أقصى في الدفعة الواحدة");
      const r = await importContacts(phones);
      return ok(r);
    } catch (e) {
      return fail(e);
    }
  }

  // ── الحملة ──
  if (path === "/api/campaign/status" && method === "GET") {
    return ok(campaignStatus());
  }

  if (path === "/api/campaign/start" && method === "POST") {
    try {
      const b = await body(req);
      const mode = b.mode === "contact" ? "contact" : "scrape";
      const dailyLimit = Math.min(Math.max(Number(b.dailyLimit) || 20, 1), 40);
      const delayMin = Math.min(Math.max(Number(b.delayMin) || 90, 30), 1800);
      const delayMax = Math.min(Math.max(Number(b.delayMax) || 240, delayMin), 3600);
      await startCampaign({ mode, dailyLimit, delayMin, delayMax });
      return ok({});
    } catch (e) {
      return fail(e);
    }
  }

  if (path === "/api/campaign/stop" && method === "POST") {
    stopCampaign();
    return ok({});
  }

  if (path === "/api/campaign/clear-flood" && method === "POST") {
    clearFlood();
    return ok({});
  }

  // ── الإعدادات ──
  if (path === "/api/settings" && method === "GET") {
    const s = appSettings();
    const c = campaignStatus();
    return ok({
      waNumber: s.waNumber,
      template: s.template,
      scrapeLimit: s.scrapeLimit,
      dailyLimit: c.dailyLimit,
      delayMin: c.delayMin,
      delayMax: c.delayMax,
      mode: c.mode,
    });
  }

  if (path === "/api/settings" && method === "POST") {
    try {
      const b = await body(req);
      const current = appSettings();
      const next: AppSettings = {
        waNumber: b.waNumber !== undefined ? (String(b.waNumber).trim() || null) : current.waNumber,
        template: b.template !== undefined ? String(b.template) : current.template,
        scrapeLimit: b.scrapeLimit !== undefined ? Math.min(Math.max(Number(b.scrapeLimit) || 2000, 100), 20000) : current.scrapeLimit,
      };
      setSetting("app", next);
      if (b.waNumber !== undefined) log("success", next.waNumber ? `حُفظ رقم الواتساب: ${next.waNumber}` : "مُسح رقم الواتساب");
      if (b.template !== undefined) log("info", "حُفظ قالب المحتوى الترويجي");
      return ok({
        ...next,
        dailyLimit: campaignStatus().dailyLimit,
        delayMin: campaignStatus().delayMin,
        delayMax: campaignStatus().delayMax,
        mode: campaignStatus().mode,
      });
    } catch (e) {
      return fail(e);
    }
  }

  // ── الترويج ──
  if (path === "/api/promo/post" && method === "POST") {
    try {
      const b = await body(req);
      const template = String(b.message || appSettings().template);
      const target = getSetting<TargetInfo | null>("target", null);
      if (!target) throw new Error("لا قناة هدف معيّنة");
      const s = appSettings();
      const waUrl = s.waNumber ? `https://wa.me/${s.waNumber.replace(/[^\d]/g, "")}` : null;
      const chLink = await channelPublicLink(target);
      let message = template.replaceAll("{wa}", waUrl || "سيُضاف رقم الواتساب لاحقاً");
      message = message.replaceAll("{link}", chLink);
      if (!waUrl) throw new Error("اضبط رقم الواتساب في الإعدادات أولاً — كل محتوى ترويجي يجب أن يحمله");
      const id = await postToChannel(target, message);
      return ok({ messageId: id, rendered: message });
    } catch (e) {
      return fail(e);
    }
  }

  // ── روابط الدعوة ──
  if (path === "/api/links" && method === "GET") {
    const links = db
      .query("SELECT id, url, title, usage_limit, created_at FROM links ORDER BY id DESC LIMIT 50")
      .all() as { id: number; url: string; title: string; usage_limit: number | null; created_at: number }[];
    return ok({
      links: links.map((l) => ({ id: l.id, url: l.url, title: l.title, usageLimit: l.usage_limit, createdAt: l.created_at })),
    });
  }

  if (path === "/api/links/create" && method === "POST") {
    try {
      const b = await body(req);
      const target = getSetting<TargetInfo | null>("target", null);
      if (!target) throw new Error("لا قناة هدف معيّنة");
      if (!target.isAdmin) throw new Error("مطلوبة صلاحية مشرف لإنشاء الروابط");
      const usageLimit = b.usageLimit ? Math.min(Math.max(Number(b.usageLimit), 1), 100000) : undefined;
      await exportInviteLink({ id: target.id, accessHash: target.accessHash }, usageLimit);
      const links = db
        .query("SELECT id, url, title, usage_limit, created_at FROM links ORDER BY id DESC LIMIT 1")
        .all() as { id: number; url: string; title: string; usage_limit: number | null; created_at: number }[];
      const l = links[0];
      return ok({ link: { id: l.id, url: l.url, title: l.title, usageLimit: l.usage_limit, createdAt: l.created_at } });
    } catch (e) {
      return fail(e);
    }
  }

  // ── السجلات ──
  if (path === "/api/logs" && method === "GET") {
    const limit = Math.min(Math.max(Number(q.get("limit")) || 300, 1), 500);
    const level = q.get("level") || undefined;
    return ok({ logs: getLogs(limit, level) });
  }

  // ── الناشر التلقائي ──
  if (path === "/api/poster/status" && method === "GET") {
    return ok(posterStatus());
  }

  if (path === "/api/poster/start" && method === "POST") {
    try {
      const b = await body(req);
      await startPoster({
        intervalMin: b.intervalMin !== undefined ? Number(b.intervalMin) : undefined,
        intervalMax: b.intervalMax !== undefined ? Number(b.intervalMax) : undefined,
        dailyLimit: b.dailyLimit !== undefined ? Number(b.dailyLimit) : undefined,
      });
      return ok(posterStatus());
    } catch (e) {
      return fail(e);
    }
  }

  if (path === "/api/poster/stop" && method === "POST") {
    stopPoster();
    return ok(posterStatus());
  }

  if (path === "/api/poster/now" && method === "POST") {
    try {
      return ok(await postNow());
    } catch (e) {
      return fail(e);
    }
  }

  if (path === "/api/poster/messages" && method === "GET") {
    return ok({ messages: listMessages() });
  }

  if (path === "/api/poster/messages" && method === "POST") {
    try {
      const b = await body(req);
      if (b.id) {
        updateMessage(String(b.id), {
          ...(b.text !== undefined ? { text: String(b.text) } : {}),
          ...(b.enabled !== undefined ? { enabled: !!b.enabled } : {}),
        });
      } else {
        addMessage(String(b.text || ""));
      }
      return ok({ messages: listMessages() });
    } catch (e) {
      return fail(e);
    }
  }

  if (path === "/api/poster/messages" && method === "DELETE") {
    const id = q.get("id") || "";
    if (id) deleteMessage(id);
    return ok({ messages: listMessages() });
  }

  return fail(new Error(`مسار غير معروف: ${method} ${path}`), 404);
}

// ─── الإقلاع ───

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    if (req.method.toUpperCase() === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }
    try {
      return await handle(req);
    } catch (e) {
      log("error", `خطأ غير متوقع: ${errMsg(e)}`);
      return fail(e, 500);
    }
  },
});

console.log(`\n🚀 خدمة الرشق تعمل على المنفذ ${server.port}`);
log("info", "خدمة الرشق بدأت التشغيل — جارٍ محاولة استئناف الجلسة إن وجدت");

void boot().then(() => {
  resumeIfRunning();
  resumePoster();
});

process.on("SIGINT", () => {
  console.log("\nإيقاف الخدمة…");
  server.stop();
  process.exit(0);
});

// hot-reload touch
