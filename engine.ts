// ─── محرك الرشق: إضافات مُقيَّدة بحدود يومية وتأخير عشوائي وفرامل أمان ───
import { Api } from "telegram";
import {
  db,
  getSetting,
  log,
  msUntilMidnight,
  rand,
  setSetting,
  todayStr,
} from "./db";
import {
  excludeExistingTargetMembers,
  getClient,
  isReady,
  targetInputFrom,
  type TargetInfo,
} from "./tg";

export type CampaignMode = "scrape" | "contact";

export interface CampaignState {
  running: boolean;
  mode: CampaignMode;
  day: string;
  todayCount: number;
  dailyLimit: number;
  delayMin: number;
  delayMax: number;
  floodStop: boolean;
  pausedUntil: number | null;
  nextActionAt: number | null;
  startedAt: number | null;
  finishedAt: number | null;
}

const DEFAULT_STATE: CampaignState = {
  running: false,
  mode: "scrape",
  day: todayStr(),
  todayCount: 0,
  dailyLimit: 20,
  delayMin: 90,
  delayMax: 240,
  floodStop: false,
  pausedUntil: null,
  nextActionAt: null,
  startedAt: null,
  finishedAt: null,
};

let state: CampaignState = { ...DEFAULT_STATE, ...getSetting<Partial<CampaignState>>("campaign", {}) };
let timer: ReturnType<typeof setTimeout> | null = null;

interface MemberRow {
  user_id: string;
  access_hash: string | null;
  first_name: string;
  last_name: string;
  username: string | null;
  origin: string;
  status: string;
  updated_at: number;
}

function persist(): void {
  setSetting("campaign", state);
}

function schedule(ms: number): void {
  if (timer) clearTimeout(timer);
  state.nextActionAt = Date.now() + ms;
  timer = setTimeout(() => void engineTick(), ms);
}

function memberName(m: MemberRow): string {
  return `${m.first_name} ${m.last_name}`.trim() || m.username || `ID ${m.user_id}`;
}

function markMember(userId: string, status: string, error?: string): void {
  db.query("UPDATE members SET status = ?, error = ?, updated_at = ? WHERE user_id = ?").run(
    status,
    error ?? null,
    Date.now(),
    userId
  );
}

/** إحصائيات الحوض حسب الحالة */
export function poolStats() {
  const rows = db.query("SELECT status, origin, COUNT(*) as n FROM members GROUP BY status, origin").all() as {
    status: string;
    origin: string;
    n: number;
  }[];
  const byStatus: Record<string, number> = {};
  const byOrigin = { scrape: 0, contact: 0 };
  let total = 0;
  for (const r of rows) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + r.n;
    if (r.origin === "contact") byOrigin.contact += r.n;
    else byOrigin.scrape += r.n;
    total += r.n;
  }
  return { total, byStatus, byOrigin };
}

export function campaignStatus() {
  const s = poolStats();
  const remaining = db
    .query("SELECT COUNT(*) as n FROM members WHERE status = 'new' AND origin = ?")
    .get(state.mode) as { n: number };
  const recent = db
    .query(
      `SELECT user_id, first_name, last_name, username, status, updated_at FROM members
       WHERE status IN ('added','already','privacy','not_mutual','failed','flood','limit')
       ORDER BY updated_at DESC LIMIT 15`
    )
    .all() as (MemberRow & { first_name: string; last_name: string })[];
  return {
    running: state.running,
    mode: state.mode,
    day: state.day,
    todayCount: state.todayCount,
    dailyLimit: state.dailyLimit,
    delayMin: state.delayMin,
    delayMax: state.delayMax,
    floodStop: state.floodStop,
    pausedUntil: state.pausedUntil,
    nextActionAt: state.running ? state.nextActionAt : null,
    startedAt: state.startedAt,
    counters: {
      added: s.byStatus.added ?? 0,
      already: s.byStatus.already ?? 0,
      privacy: s.byStatus.privacy ?? 0,
      notMutual: s.byStatus.not_mutual ?? 0,
      failed: s.byStatus.failed ?? 0,
      processed:
        (s.byStatus.added ?? 0) +
        (s.byStatus.already ?? 0) +
        (s.byStatus.privacy ?? 0) +
        (s.byStatus.not_mutual ?? 0) +
        (s.byStatus.failed ?? 0) +
        (s.byStatus.flood ?? 0) +
        (s.byStatus.limit ?? 0),
    },
    remaining: remaining.n,
    recent: recent.map((r) => ({
      userId: r.user_id,
      name: memberName(r as MemberRow),
      status: r.status,
      at: r.updated_at,
    })),
  };
}

export async function startCampaign(opts: {
  mode: CampaignMode;
  dailyLimit: number;
  delayMin: number;
  delayMax: number;
}): Promise<void> {
  if (!isReady() || !getClient()) throw new Error("غير متصل — سجّل الدخول أولاً");
  const target = getSetting<TargetInfo | null>("target", null);
  if (!target) throw new Error("لم تُعيَّن قناة الهدف — اذهب لقسم «القناة»");
  if (!target.isAdmin) throw new Error("البوت ليس مشرفاً في القناة الهدف — ارفعه مشرفاً أولاً");
  if (state.floodStop) throw new Error("الحملة مقفلة أمانياً بعد PEER_FLOOD — أعد التعيين بعد الانتظار 24 ساعة");

  state = {
    ...state,
    ...opts,
    running: true,
    startedAt: Date.now(),
    finishedAt: null,
    pausedUntil: null,
  };
  persist();
  log(
    "success",
    `انطلقت الحملة (${state.mode === "contact" ? "جهات اتصال" : "من المجموعات"}) — سقف ${state.dailyLimit}/يوم، تباعد ${state.delayMin}-${state.delayMax} ثانية`
  );
  // استبعاد من هم أصلاً داخل القناة (خلفياً دون تعطيل الاستجابة)
  void excludeExistingTargetMembers(target).catch(() => undefined);
  schedule(2000);
}

export function stopCampaign(reason = "تم إيقاف الحملة من اللوحة"): void {
  state.running = false;
  state.finishedAt = Date.now();
  if (timer) clearTimeout(timer);
  timer = null;
  state.nextActionAt = null;
  persist();
  log("warn", reason);
}

export function clearFlood(): void {
  state.floodStop = false;
  state.pausedUntil = null;
  persist();
  log("warn", "أُعيد تعيين قفل PEER_FLOOD يدوياً — كن حذراً وابدأ بسقف أدنى");
}

/** استئناف تلقائي بعد إعادة تشغيل الخدمة */
export function resumeIfRunning(): void {
  if (!state.running) return;
  if (state.floodStop) {
    state.running = false;
    persist();
    return;
  }
  log("info", "استئناف الحملة تلقائياً بعد إعادة التشغيل…");
  schedule(3000);
}

// ─── الدورة الأساسية ───

async function engineTick(): Promise<void> {
  state.nextActionAt = null;
  if (!state.running) return;

  const client = getClient();
  if (!client || !isReady()) {
    state.running = false;
    persist();
    log("error", "انقطع الاتصال — أُوقفت الحملة");
    return;
  }

  // يوم جديد؟ صفّر العدّاد
  const today = todayStr();
  if (state.day !== today) {
    state.day = today;
    state.todayCount = 0;
    log("info", "يوم جديد — صُفّر عدّاد الإضافات اليومية");
  }

  // سقف اليوم
  if (state.todayCount >= state.dailyLimit) {
    const wait = msUntilMidnight() + 60_000;
    log("info", `بلغنا السقف اليومي (${state.todayCount}/${state.dailyLimit}) — استراحة حتى منتصف الليل`);
    persist();
    schedule(wait);
    return;
  }

  // استراحة إجبارية (FLOOD_WAIT)
  if (state.pausedUntil && Date.now() < state.pausedUntil) {
    persist();
    schedule(state.pausedUntil - Date.now() + 2000);
    return;
  }
  state.pausedUntil = null;

  const target = getSetting<TargetInfo | null>("target", null);
  if (!target) {
    stopCampaign("أُوقفت الحملة: لا قناة هدف معيّنة");
    return;
  }

  // التقط العضو التالي من الحوض
  const member = db
    .query("SELECT * FROM members WHERE status = 'new' AND origin = ? ORDER BY updated_at ASC LIMIT 1")
    .get(state.mode) as MemberRow | null;
  if (!member) {
    state.running = false;
    state.finishedAt = Date.now();
    persist();
    log("success", "اكتمل الحوض — لا مزيد من الأعضاء الجدد. اسحب المزيد من المصادر أو استورد جهات اتصال");
    return;
  }

  const name = memberName(member);
  try {
    const inputUser = new Api.InputUser({
      userId: BigInt(member.user_id),
      accessHash: BigInt(member.access_hash ?? "0"),
    });
    await client.invoke(
      new Api.channels.InviteToChannel({
        channel: targetInputFrom(target),
        users: [inputUser],
      })
    );
    markMember(member.user_id, "added");
    log("success", `أُضيف «${name}» إلى «${target.title}» ✓ (${state.todayCount + 1}/${state.dailyLimit} اليوم)`);
  } catch (e) {
    const raw = String((e as { errorMessage?: string })?.errorMessage || (e as Error)?.message || e);
    const seconds = (e as { seconds?: number })?.seconds;
    if (raw.includes("PEER_FLOOD")) {
      markMember(member.user_id, "flood", raw);
      state.floodStop = true;
      state.running = false;
      state.finishedAt = Date.now();
      persist();
      log(
        "error",
        `🚨 PEER_FLOOD — قفل أمان تلقائي! أوقفنا كل شيء لحماية الرقم. اترك الحساب 24-48 ساعة (تصفح عادية فقط) ثم أعد التعيين وابدأ بسقف أدنى`
      );
      return;
    } else if (raw.includes("USER_PRIVACY_RESTRICTED")) {
      markMember(member.user_id, "privacy", raw);
      log("info", `تخطّي «${name}» — إعدادات خصوصيته تمنع إضافته`);
    } else if (raw.includes("USER_NOT_MUTUAL_CONTACT") || raw.includes("USERS_TOO_MUCH")) {
      markMember(member.user_id, "not_mutual", raw);
      log("info", `تخطّي «${name}» — ليس جهة اتصال (لا يمكن إضافته للقناة)`);
    } else if (raw.includes("USER_ALREADY_PARTICIPANT")) {
      markMember(member.user_id, "already", raw);
      log("info", `«${name}» عضو في القناة مسبقاً`);
    } else if (typeof seconds === "number" && seconds > 0) {
      state.pausedUntil = Date.now() + (seconds + 10) * 1000;
      log("warn", `FLOOD_WAIT ${seconds}ث — استراحة إجبارية ثم نكمل تلقائياً`);
    } else if (raw.includes("USER_CHANNELS_TOO_MUCH") || raw.includes("CHANNELS_TOO_MUCH")) {
      markMember(member.user_id, "limit", raw);
      log("info", `تخطّي «${name}» — عضو في الحد الأقصى من القنوات`);
    } else if (raw.includes("USER_ID_INVALID") || raw.includes("USER_DEACTIVATED") || raw.includes("USER_IS_BOT")) {
      markMember(member.user_id, "failed", raw);
      log("warn", `تخطّي «${name}» — حساب غير صالح (${raw})`);
    } else {
      markMember(member.user_id, "failed", raw);
      log("error", `فشل إضافة «${name}»: ${raw}`);
    }
  }

  // كل محاولة تُحتسب ضمن السقف اليومي (حتى المرفوضة — لأنها لمست الخادم)
  state.todayCount++;

  // تباعد عشوائي بين المحاولات
  const delay = rand(state.delayMin, state.delayMax) * 1000;
  persist();
  schedule(delay);
}
