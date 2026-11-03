// ─── طبقة تيليجرام: إدارة عميل GramJS والمصادقة وعمليات القنوات ───
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { Api } from "telegram";
import { computeCheck } from "telegram/Password";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, db, getSetting, log, setSetting } from "./db";

const SESSION_PATH = join(DATA_DIR, "session.txt");
const CONFIG_PATH = join(DATA_DIR, "config.json");

export interface Creds {
  apiId: number;
  apiHash: string;
  phone: string;
}

export interface TargetInfo {
  peerId: string; // المعرف المعلَّم (-100…)
  id: string; // المعرف الخام
  accessHash: string | null;
  title: string;
  username: string | null;
  isAdmin: boolean;
  isCreator: boolean;
  membersCount: number;
}

let creds: Creds | null = null;
// عميل واحد على مستوى العملية (globalThis) — ينجو من إعادة التحميل الساخن (bun --hot)
// حتى لا يُنشأ عميل موازٍ بنفس الجلسة فيحدث تعارض AUTH_KEY_DUPLICATED
const G = globalThis as typeof globalThis & { __tgClient?: TelegramClient | null };

let client: TelegramClient | null = G.__tgClient ?? null;

function setClient(c: TelegramClient | null): void {
  client = c;
  G.__tgClient = c;
}

/** إغلاق قاطع للعميل — يغلق السوكيت وكل الحلقات الداخلية (destroy أقوى من disconnect) */
async function killClient(): Promise<void> {
  const c = client;
  if (!c) return;
  try {
    await c.disconnect();
  } catch {
    /* ignore */
  }
  try {
    await c.destroy();
  } catch {
    /* ignore */
  }
  setClient(null);
}
let pending: { phoneCodeHash: string; phone: string; viaApp: boolean } | null = null;
let loginStep: "idle" | "code_sent" | "need_password" = "idle";

// ─── أدوات داخلية ───

function loadCreds(): Creds | null {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Creds;
  } catch {
    return null;
  }
}

function saveCreds(): void {
  if (creds) writeFileSync(CONFIG_PATH, JSON.stringify(creds, null, 2));
}

export function errMsg(e: unknown): string {
  const raw = String((e as { errorMessage?: string; message?: string })?.errorMessage || (e as Error)?.message || e);
  const map: Record<string, string> = {
    API_ID_INVALID: "بيانات api_id / api_hash غير صحيحة — تأكد منها من my.telegram.org",
    API_ID_PUBLISHED_FLOOD: "هذا api_id مقيّد مؤقتاً من تيليجرام — انتظر ساعة وأعد المحاولة",
    PHONE_NUMBER_INVALID: "رقم الهاتف غير صحيح",
    PHONE_NUMBER_BANNED: "هذا الرقم محظور من تيليجرام — استخدم رقماً آخر",
    PHONE_NUMBER_UNOCCUPIED: "لا يوجد حساب تيليجرام على هذا الرقم — فعّله من التطبيق أولاً",
    PHONE_CODE_INVALID: "رمز التحقق غير صحيح",
    PHONE_CODE_EXPIRED: "انتهت صلاحية الرمز — اضغط إعادة الإرسال",
    PHONE_CODE_EMPTY: "أدخل رمز التحقق",
    SESSION_PASSWORD_NEEDED: "مطلوبة كلمة المرور الثنائية",
    PASSWORD_HASH_INVALID: "كلمة المرور الثنائية غير صحيحة",
    AUTH_KEY_UNREGISTERED: "انتهت الجلسة — أعد تسجيل الدخول",
    AUTH_RESTART: "تعارض في الجلسة — أعد المحاولة",
    FLOOD_WAIT_X: "تيليجرام يطلب التريّث قليلاً — أعد المحاولة بعد دقيقة",
    USERNAME_NOT_OCCUPIED: "المعرف غير مستخدم",
    PEER_ID_INVALID: "تعذر الوصول لهذا المحادثة — حدّث قائمة الحوارات",
    CHAT_ADMIN_REQUIRED: "مطلوبة صلاحية مشرف",
    USER_ALREADY_PARTICIPANT: "العضو موجود مسبقاً",
  };
  for (const key of Object.keys(map)) {
    if (raw.includes(key)) return map[key];
  }
  if (raw.includes("FLOOD_WAIT")) return `تيليجرام يطلب الانتظار قبل المحاولة التالية (${raw})`;
  if (raw.includes("PEER_FLOOD")) return "PEER_FLOOD — تقييد خطر على الحساب";
  return raw;
}

export function getClient(): TelegramClient | null {
  return client;
}

/** الاعتمادات المحفوظة (تكوين مسبق من ملف الإعداد) — للوحة والدمج عند الدخول */
export function savedCreds(): Creds | null {
  return creds ?? loadCreds();
}

export function isReady(): boolean {
  return client !== null && loginStep === "idle";
}

export function getLoginStep(): "idle" | "code_sent" | "need_password" {
  return loginStep;
}

/** معرف معلَّم موحّد (نمط -100xxxx للقنوات) */
export function markedId(e: { className?: string; id?: unknown }): string {
  const idStr = String(e.id);
  if (e.className === "Channel") return `-100${idStr}`;
  if (e.className === "Chat") return `-${idStr}`;
  return idStr;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── الإقلاع وإعادة الاتصال ───

export async function boot(): Promise<void> {
  creds = loadCreds();
  if (!creds || !existsSync(SESSION_PATH)) {
    log("info", "لا توجد جلسة محفوظة — بانتظار بيانات الدخول من اللوحة");
    return;
  }
  // إعادة تحميل ساخنة: العميل القديم ما زال حياً ومتصلاً — نعيد استخدامه مباشرة بلا اتصال جديد
  if (client && client.connected) {
    try {
      if (await client.isUserAuthorized()) {
        loginStep = "idle";
        const me = (await client.getMe()) as Api.User;
        log("success", `الجلسة حية عبر إعادة التحميل: ${displayName(me)} (${creds.phone})`);
        return;
      }
    } catch {
      /* العميل القديم غير صالح — نستمر بمحاولة اتصال نظيف */
      await killClient();
    }
  }
  // AUTH_KEY_DUPLICATED: تيليجرام يرى اتصالاً قديماً بنفس الجلسة (نشر متزامن / إعادة تحميل)
  // نعيد المحاولة بتراجع تصاعدي — الخادم يترك الاتصال الميت خلال دقائق
  const WAITS = [30_000, 60_000, 120_000, 180_000, 300_000, 300_000];
  for (let attempt = 0; ; attempt++) {
    try {
      const session = new StringSession(readFileSync(SESSION_PATH, "utf8").trim());
      const c = new TelegramClient(session, creds.apiId, creds.apiHash, {
        connectionRetries: 5,
        retryDelay: 2000,
        autoReconnect: true,
      });
      setClient(c);
      await c.connect();
      if (await c.isUserAuthorized()) {
        loginStep = "idle";
        const me = (await client.getMe()) as Api.User;
        log("success", `تم استئناف الجلسة: ${displayName(me)} (${creds.phone})`);
        return;
      }
      log("warn", "الجلسة المحفوظة غير صالحة — أعد تسجيل الدخول من اللوحة");
      await killClient();
      try {
        unlinkSync(SESSION_PATH);
      } catch {
        /* ignore */
      }
      return;
    } catch (e) {
      await killClient();
      const raw = String((e as { errorMessage?: string })?.errorMessage || (e as Error)?.message || e);
      if (raw.includes("AUTH_KEY_DUPLICATED") && attempt < WAITS.length) {
        log("warn", `تعارض جلسة (اتصال قديم ما زال مسجلاً لدى تيليجرام) — محاولة ${attempt + 1}/${WAITS.length + 1} بعد ${WAITS[attempt] / 1000} ثانية`);
        await sleep(WAITS[attempt]);
        continue;
      }
      log("error", `فشل استئناف الجلسة: ${errMsg(e)}`);
      return;
    }
  }
}

export function displayName(u: Api.User | undefined | null): string {
  if (!u) return "؟";
  return [u.firstName, u.lastName].filter(Boolean).join(" ").trim() || u.username || `ID ${u.id?.toString()}`;
}

export async function meInfo(): Promise<{
  id: string;
  name: string;
  username: string | null;
  phone: string | null;
} | null> {
  if (!client || !isReady()) return null;
  const me = (await client.getMe()) as Api.User;
  return {
    id: me.id.toString(),
    name: displayName(me),
    username: me.username ?? null,
    phone: me.phone ? `+${me.phone}` : null,
  };
}

// ─── المصادقة ───

export async function authStart(input: { apiId: number; apiHash: string; phone: string }): Promise<{ viaApp: boolean }> {
  if (client && (await client.isUserAuthorized())) {
    throw new Error("مسجّل دخول مسبقاً — سجّل الخروج أولاً");
  }
  // قطع أي عميل سابق معلق
  if (client) {
    await killClient();
  }
  creds = { apiId: input.apiId, apiHash: input.apiHash, phone: input.phone };
  saveCreds();

  setClient(
    new TelegramClient(new StringSession(""), creds.apiId, creds.apiHash, {
      connectionRetries: 3,
      retryDelay: 1500,
    })
  );
  await client.connect();
  const sent = await client.sendCode({ apiId: creds.apiId, apiHash: creds.apiHash }, creds.phone);
  pending = { phoneCodeHash: sent.phoneCodeHash, phone: creds.phone, viaApp: sent.isCodeViaApp };
  loginStep = "code_sent";
  log("info", `أُرسل رمز التحقق إلى ${creds.phone}${sent.isCodeViaApp ? " (داخل تيليجرام)" : " (SMS)"}`);
  return { viaApp: sent.isCodeViaApp };
}

export async function authResend(): Promise<void> {
  if (!client || !creds || loginStep !== "code_sent") {
    throw new Error("لا يوجد طلب رمز مفعّل — ابدأ من جديد");
  }
  const sent = await client.sendCode({ apiId: creds.apiId, apiHash: creds.apiHash }, creds.phone);
  pending = { phoneCodeHash: sent.phoneCodeHash, phone: creds.phone, viaApp: sent.isCodeViaApp };
  log("info", "أُعيد إرسال رمز التحقق");
}

async function finishLogin(): Promise<void> {
  if (!client) return;
  const session = client.session.save() as unknown as string;
  writeFileSync(SESSION_PATH, session);
  pending = null;
  loginStep = "idle";
  const me = (await client.getMe()) as Api.User;
  log("success", `تم تسجيل الدخول بنجاح: ${displayName(me)} (${creds?.phone}) — الجلسة محفوظة محلياً`);
}

export async function authCode(code: string): Promise<{ done: boolean; needPassword: boolean }> {
  if (!client || !pending || loginStep !== "code_sent") {
    throw new Error("لم يُطلب رمز بعد — ابدأ بتعبئة البيانات والإرسال");
  }
  try {
    await client.invoke(
      new Api.auth.SignIn({
        phoneNumber: pending.phone,
        phoneCodeHash: pending.phoneCodeHash,
        phoneCode: code,
      })
    );
  } catch (e) {
    const raw = String((e as { errorMessage?: string })?.errorMessage || (e as Error)?.message || e);
    if (raw.includes("SESSION_PASSWORD_NEEDED")) {
      loginStep = "need_password";
      return { done: false, needPassword: true };
    }
    throw e;
  }
  await finishLogin();
  return { done: true, needPassword: false };
}

export async function authPassword(password: string): Promise<{ done: boolean }> {
  if (!client || loginStep !== "need_password") {
    throw new Error("لا يُطلب دخول بكلمة مرور حالياً");
  }
  const pwdInfo = await client.invoke(new Api.account.GetPassword());
  await client.invoke(new Api.auth.CheckPassword({ password: await computeCheck(pwdInfo, password) }));
  await finishLogin();
  return { done: true };
}

export async function authLogout(): Promise<void> {
  if (client) {
    try {
      if (await client.isUserAuthorized()) {
        await client.invoke(new Api.auth.LogOut());
      }
    } catch {
      /* ignore */
    }
    await killClient();
  }
  pending = null;
  loginStep = "idle";
  try {
    unlinkSync(SESSION_PATH);
  } catch {
    /* ignore */
  }
  log("warn", "تم تسجيل الخروج وحذف الجلسة المحلية");
}

// ─── الحوارات ───

export interface DialogInfo {
  id: string;
  title: string;
  type: "channel" | "group" | "supergroup" | "user";
  username: string | null;
  isCreator: boolean;
  isAdmin: boolean;
  accessHash: string | null;
}

export async function listDialogs(): Promise<DialogInfo[]> {
  if (!client || !isReady()) throw new Error("غير متصل — سجّل الدخول أولاً");
  const dialogs = await client.getDialogs({ limit: 300 });
  const out: DialogInfo[] = [];
  for (const d of dialogs) {
    const e = d.entity as { className?: string };
    if (!e) continue;
    let item: DialogInfo | null = null;
    if (e.className === "Channel") {
      const ch = d.entity as Api.Channel;
      item = {
        id: markedId(ch),
        title: ch.title || "",
        type: ch.broadcast ? "channel" : "supergroup",
        username: ch.username ?? null,
        isCreator: !!ch.creator,
        isAdmin: !!ch.adminRights,
        accessHash: ch.accessHash ? ch.accessHash.toString() : null,
      };
    } else if (e.className === "Chat") {
      const c = d.entity as Api.Chat;
      item = {
        id: markedId(c),
        title: c.title || "",
        type: "group",
        username: null,
        isCreator: !!c.creator,
        isAdmin: !!c.adminRights,
        accessHash: null,
      };
    } else if (e.className === "User") {
      const u = d.entity as Api.User;
      item = {
        id: markedId(u),
        title: displayName(u),
        type: "user",
        username: u.username ?? null,
        isCreator: false,
        isAdmin: false,
        accessHash: u.accessHash ? u.accessHash.toString() : null,
      };
    }
    if (item && item.title) out.push(item);
  }
  log("info", `جُلبت ${out.length} حواراً`);
  return out;
}

/** كيان قناة + مدخل جاهز للاستدعاءات */
export async function resolveChannel(peerId: string): Promise<{ input: Api.InputChannel; info: () => Promise<TargetInfo> }> {
  if (!client || !isReady()) throw new Error("غير متصل — سجّل الدخول أولاً");
  const entity = (await client.getEntity(peerId)) as Api.Channel;
  const input = new Api.InputChannel({
    channelId: entity.id,
    accessHash: entity.accessHash ?? BigInt(0),
  });
  return {
    input,
    info: async () => {
      const res = await client!.invoke(new Api.channels.GetChannels({ id: [input] }));
      const ch = (res.chats[0] ?? entity) as Api.Channel;
      let membersCount = 0;
      try {
        const full = await client!.invoke(new Api.channels.GetFullChannel({ channel: input }));
        membersCount = Number(full.fullChat.participantsCount ?? 0);
      } catch {
        /* لا يهم */
      }
      return {
        peerId: markedId(ch),
        id: ch.id.toString(),
        accessHash: ch.accessHash ? ch.accessHash.toString() : null,
        title: ch.title || "",
        username: ch.username ?? null,
        isAdmin: !!ch.adminRights || !!ch.creator,
        isCreator: !!ch.creator,
        membersCount,
      } satisfies TargetInfo;
    },
  };
}

/** مدخل قناة من الهدف المحفوظ */
export function targetInputFrom(t: { id: string; accessHash: string | null }): Api.InputChannel {
  return new Api.InputChannel({ channelId: BigInt(t.id), accessHash: BigInt(t.accessHash ?? "0") });
}

export function targetPeerFrom(t: { id: string; accessHash: string | null }): Api.InputPeerChannel {
  return new Api.InputPeerChannel({ channelId: BigInt(t.id), accessHash: BigInt(t.accessHash ?? "0") });
}

export async function createChannel(title: string, about: string, username?: string): Promise<TargetInfo> {
  if (!client || !isReady()) throw new Error("غير متصل — سجّل الدخول أولاً");
  const updates = await client.invoke(new Api.channels.CreateChannel({ title, about, broadcast: true }));
  const ch = updates.chats[0] as Api.Channel;
  if (!ch) throw new Error("تعذر إنشاء القناة — أعد المحاولة");
  const info: TargetInfo = {
    peerId: markedId(ch),
    id: ch.id.toString(),
    accessHash: ch.accessHash ? ch.accessHash.toString() : null,
    title: ch.title || title,
    username: null,
    isAdmin: true,
    isCreator: true,
    membersCount: 1,
  };
  // حجز الرابط العام القصير (t.me/username) إن طُلب
  if (username) {
    try {
      await client.invoke(
        new Api.channels.UpdateUsername({
          channel: new Api.InputChannel({ channelId: ch.id, accessHash: ch.accessHash ?? BigInt(0) }),
          username,
        })
      );
      info.username = username;
      log("success", `ضُبط الرابط العام للقناة: https://t.me/${username}`);
    } catch (e) {
      log("warn", `تعذر حجز الرابط t.me/${username} (قد يكون محجوزاً): ${errMsg(e)} — القناة أُنشئت وستعمل برابط دعوة`);
    }
  }
  setSetting("target", info);
  log("success", `أُنشئت القناة «${info.title}» وأصبحت هدف الرشق (الرقم منشئ القناة)`);
  return info;
}

// ─── سحب الأعضاء ───

export interface ScrapeResult {
  total: number;
  added: number;
  duplicates: number;
  bots: number;
  deleted: number;
}

export async function scrapeSource(peerId: string, limit: number, title: string): Promise<ScrapeResult> {
  if (!client || !isReady()) throw new Error("غير متصل — سجّل الدخول أولاً");
  const res: ScrapeResult = { total: 0, added: 0, duplicates: 0, bots: 0, deleted: 0 };
  const insert = db.query(
    `INSERT INTO members(user_id, access_hash, first_name, last_name, username, phone, origin, source_peer, status, updated_at)
     VALUES(?, ?, ?, ?, ?, ?, 'scrape', ?, 'new', ?)`
  );
  const exists = db.query("SELECT 1 FROM members WHERE user_id = ?");
  const now = Date.now();
  for await (const user of client.iterParticipants(peerId, { limit })) {
    const u = user as Api.User;
    res.total++;
    if (u.bot) {
      res.bots++;
      continue;
    }
    if (u.deleted) {
      res.deleted++;
      continue;
    }
    const userId = u.id.toString();
    if (exists.get(userId)) {
      res.duplicates++;
      // تحديث الاسم/الهاش إن وُجد أحدث
      db.query(
        "UPDATE members SET access_hash = COALESCE(?, access_hash), source_peer = ?, updated_at = ? WHERE user_id = ? AND status = 'new'"
      ).run(u.accessHash ? u.accessHash.toString() : null, peerId, now, userId);
      continue;
    }
    insert.run(
      userId,
      u.accessHash ? u.accessHash.toString() : null,
      u.firstName ?? "",
      u.lastName ?? "",
      u.username ?? null,
      u.phone ?? null,
      peerId,
      now
    );
    res.added++;
  }
  db.query("UPDATE sources SET last_scrape = ?, last_count = (SELECT COUNT(*) FROM members WHERE source_peer = ?) WHERE peer_id = ?").run(
    now,
    peerId,
    peerId
  );
  log(
    "success",
    `سحب «${title}»: ${res.total} عضو — ${res.added} جديد، ${res.duplicates} مكرر، ${res.bots} بوت، ${res.deleted} محذوف`
  );
  return res;
}

/** استبعاد من هم أصلاً داخل القناة الهدف */
export async function excludeExistingTargetMembers(t: { id: string; accessHash: string | null; title: string }): Promise<number> {
  if (!client || !isReady()) return 0;
  const peer = targetPeerFrom(t);
  const exists = db.query("SELECT 1 FROM members WHERE user_id = ?");
  const mark = db.query("UPDATE members SET status = 'already', updated_at = ? WHERE user_id = ? AND status = 'new'");
  let count = 0;
  for await (const user of client.iterParticipants(peer, { limit: 20000 })) {
    const u = user as Api.User;
    if (u.bot || u.deleted) continue;
    const userId = u.id.toString();
    if (exists.get(userId)) {
      mark.run(Date.now(), userId);
      count++;
    }
  }
  log("info", `استُبعد ${count} عضواً موجودين مسبقاً في «${t.title}»`);
  return count;
}

// ─── جهات الاتصال ───

export async function importContacts(phones: string[]): Promise<{ imported: number; failed: number }> {
  if (!client || !isReady()) throw new Error("غير متصل — سجّل الدخول أولاً");
  let imported = 0;
  let failed = 0;
  const insert = db.query(
    `INSERT INTO members(user_id, access_hash, first_name, last_name, username, phone, origin, status, updated_at)
     VALUES(?, ?, ?, ?, ?, ?, 'contact', 'new', ?)
     ON CONFLICT(user_id) DO UPDATE SET phone = COALESCE(excluded.phone, members.phone), access_hash = COALESCE(excluded.access_hash, members.access_hash), updated_at = excluded.updated_at`
  );
  for (let i = 0; i < phones.length; i += 25) {
    const chunk = phones.slice(i, i + 25);
    const contacts = chunk.map(
      (p, j) =>
        new Api.InputPhoneContact({
          clientId: BigInt(i + j + 1),
          phone: p,
          firstName: "جهة",
          lastName: `رشق ${i + j + 1}`,
        })
    );
    try {
      const res = await client.invoke(new Api.contacts.ImportContacts({ contacts }));
      for (const u of res.users as Api.User[]) {
        insert.run(
          u.id.toString(),
          u.accessHash ? u.accessHash.toString() : null,
          u.firstName ?? "",
          u.lastName ?? "",
          u.username ?? null,
          u.phone ?? null,
          Date.now()
        );
        imported++;
      }
      log("info", `استيراد دفعة جهات اتصال: ${res.users.length} من ${chunk.length}`);
    } catch (e) {
      failed += chunk.length;
      log("error", `فشل استيراد دفعة (${chunk.length} رقم): ${errMsg(e)}`);
    }
    if (i + 25 < phones.length) await sleep(4000); // تباعد آمن بين الدفعات
  }
  log("success", `اكتمل استيراد جهات الاتصال: ${imported} ناجح، ${failed} فاشل`);
  return { imported, failed };
}

// ─── روابط الدعوة والنشر ───

export async function exportInviteLink(t: { id: string; accessHash: string | null }, usageLimit?: number): Promise<string> {
  if (!client || !isReady()) throw new Error("غير متصل — سجّل الدخول أولاً");
  const peer = targetPeerFrom(t);
  const res = await client.invoke(
    new Api.messages.ExportChatInvite({
      peer,
      ...(usageLimit && usageLimit > 0 ? { usageLimit } : {}),
    })
  );
  const link = (res as Api.ChatInviteExported).link;
  db.query("INSERT INTO links(url, title, usage_limit, created_at) VALUES(?, '', ?, ?)").run(
    link,
    usageLimit && usageLimit > 0 ? usageLimit : null,
    Date.now()
  );
  log("success", `أُنشئ رابط دعوة${usageLimit ? ` بحد ${usageLimit}` : ""}: ${link}`);
  return link;
}

export async function postToChannel(t: { id: string; accessHash: string | null; title: string }, message: string): Promise<number> {
  if (!client || !isReady()) throw new Error("غير متصل — سجّل الدخول أولاً");
  const peer = targetPeerFrom(t);
  const msg = await client.sendMessage(peer, { message, linkPreview: false });
  log("success", `نُشر محتوى ترويجي في «${t.title}» (رسالة #${msg.id})`);
  return msg.id;
}

/** رابط القناة (اسم المستخدم أو أحدث رابط دعوة، وإلا يُنشأ رابط) */
export async function channelPublicLink(t: TargetInfo): Promise<string> {
  if (t.username) return `https://t.me/${t.username}`;
  const row = db.query("SELECT url FROM links ORDER BY id DESC LIMIT 1").get() as { url: string } | null;
  if (row) return row.url;
  return await exportInviteLink({ id: t.id, accessHash: t.accessHash });
}

// ─── حالة عامة ───

export function healthPayload() {
  return {
    loggedIn: !!(client && loginStep === "idle" && client.connected !== false),
    hasSession: existsSync(SESSION_PATH),
    phone: creds?.phone ?? null,
    loginStep,
  };
}
