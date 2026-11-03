// ─── الناشر التلقائي: رسائل ترويجية متنوعة في القناة على مدار اليوم ───
import { db, getSetting, setSetting, log, rand, todayStr, msUntilMidnight } from "./db";
import { getClient, isReady, targetPeerFrom, type TargetInfo } from "./tg";

export interface PosterMessage {
  id: string;
  text: string;
  enabled: boolean;
}

export interface PosterState {
  running: boolean;
  intervalMin: number; // دقائق
  intervalMax: number; // دقائق
  dailyLimit: number;
  day: string;
  todayCount: number;
  totalPosted: number;
  lastPostedAt: number | null;
  nextPostAt: number | null;
  lastMessageId: string | null;
  lastError: string | null;
}

/** حزمة الرسائل الفخمة — هوية موحدة بفواصل زخرفية، وكلها تحمل {wa} وبعضها {link} */
const SEED_MESSAGES: string[] = [
  // 1 — بحوث جامعية
  `━━━━━━━━━━━━━━━━
✦ أم رهام ✦ خدمات طلابية متكاملة
━━━━━━━━━━━━━━━━

📜 بحوث جامعية بمعايير النشر العلمي

◈ مراجع حديثة وموثّقة
◈ صياغة أكاديمية رصينة
◈ فحص انتحار + تقرير مطابقة
◈ التزام تام بالمواعيد

◆ جودة تليق بتقديرك العالي ◆

📲 تواصل مباشر — ردّ خلال دقائق
{wa}`,

  // 2 — واجبات وتكليفات
  `─────────────────
🎓 أم رهام · خدمات طلابية
─────────────────

✍️ واجبات وتكليفات أسبوعية؟
نُنجزها نيابةً عنك بإتقان

✧ حلول مفصّلة خطوة بخطوة
✧ ضمان الدرجة الكاملة
✧ تسليم قبل الموعد

⌛ وقتك أثمن من أن يُهدر

📥 اطلب الآن 👇
{wa}`,

  // 3 — عروض تقديمية
  `▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
🎤 عروض تقديمية تسرق الأنظار
▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀

PowerPoint بإخراج احترافي

▸ تصميم أنيق يليق بعرضك
▸ محتوى مرتب ومنقّح
▸ رسوم بيانية ومؤثرات مدروسة
▸ جاهز للتقديم من أول شريحة

✦ لا تقبل بأقل من التميز ✦

📲 واتساب — خدمة فورية
{wa}`,

  // 4 — تحليل بيانات
  `━━━━━━━━━━━━━
📊 تحليل بيانات أكاديمي
━━━━━━━━━━━━━

SPSS ▸ Excel ▸ Python

◈ اختبارات إحصائية دقيقة
◈ جداول ورسوم توضيحية
◈ كتابة النتائج وتفسيرها
◈ دقة يحسدك عليها المشرف

من البيانات الخام إلى نتائج جاهزة للمناقشة

📲 استشارة مجانية — راسلنا
{wa}`,

  // 5 — ترجمة
  `───────────────────
🌐 ترجمة أكاديمية معتمدة
───────────────────

عربي ⇄ إنجليزي بجودة النخبة

✧ مصطلحات تخصصية دقيقة
✧ صياغة سليمة بلا حرفية
✧ مراجعة لغوية مزدوجة
✧ تسليم سريع بسرّية تامة

أطروحتك تستحق ترجمة تليق بها

📥 اطلب عرض السعر الآن
{wa}`,

  // 6 — تلخيص
  `✦ ✦ ✦ ✦ ✦ ✦ ✦ ✦
📖 اختصر الطريق للتفوق
✦ ✦ ✦ ✦ ✦ ✦ ✦ ✦

تلخيص الكتب والمحاضرات

▸ صفحات تتحول لصفحات معدودة
▸ المهم فقط — بلا حشو
▸ تنسيق يسهّل الحفظ والمراجعة

وفّر ساعات مراجعتك لما يستحق

📲 واتساب — متاحون الآن
{wa}`,

  // 7 — مشاريع تخرج
  `▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
💻 مشروع تخرجك.. من الفكرة للمناقشة
▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓

برمجة تطبيقات وأنظمة متكاملة

◈ تحليل وتصميم كامل
◈ كود نظيف موثّق
◈ شرح تفصيلي تستوعبه قبل مناقشتك
◈ دعم حتى لحظة التسليم

مشروعك أمانة — ونحن أهل لها

📲 احجز موعدك
{wa}`,

  // 8 — سرعة الإنجاز
  `━━━━━━━━━━━━━━━━━
⏱️ حين يضغط الوقت.. نحن خيارك
━━━━━━━━━━━━━━━━━

خدمة سباق مع الوقت

▸ استلام فوري لطلبك
▸ متابعة لحظية بالحالة
▸ تسليم قبل الموعد

لأن درجتك لا تنتظر

📲 راسلنا الآن — رد خلال دقائق
{wa}`,

  // 9 — شمول الجامعات
  `─────────────────
🏛️ لطلاب جامعات المملكة كافة
─────────────────

✦ أم رهام ✦ خدمات طلابية متكاملة

الإمام ▸ البترول ▸ التقنية ▸ الطائف
العربية المفتوحة ▸ وجميع التخصصات

من السنة التحضيرية حتى الدكتوراه
فريق يفهم متطلبات جامعتك بدقة

📩 اطلب خدمتك الآن
{wa}`,

  // 10 — ضمان الجودة
  `◆ ◆ ◆ ◆ ◆ ◆ ◆
💯 التزامنا ليس شعاراً
◆ ◆ ◆ ◆ ◆ ◆ ◆

▸ تعديلات مجانية حتى رضاك التام
▸ سرية تامة لبياناتك وطلبك
▸ استرداد كامل إن لم نوفّق

رضاك خطنا الأول والأخير

📲 واتساب — تجربة تستحقها
{wa}`,

  // 11 — فترة الامتحانات
  `━━━━━━━━━━━━━━━━
🌙 معك في أكثر الليالي ضغطاً
━━━━━━━━━━━━━━━━

فترة الامتحانات لا ترحم

واجبات متراكمة؟ مشاريع عالقة؟
تسليم غداً؟

↳ نستقبل طلبك في أي ساعة
↳ ننجز بأسرع وقت وأعلى جودة

لا تحمل الهم وحدك

📲 تواصل الآن
{wa}`,

  // 12 — مصادر ومراجع
  `▚▚▚▚▚▚▚▚▚▚▚▚▚▚▚▚
📚 مراجعك.. من مصادر عالمية
▚▚▚▚▚▚▚▚▚▚▚▚▚▚▚▚

وصول لقواعد بيانات علمية محكّمة

◈ استخراج أحدث الدراسات
◈ توثيق بنظام APA وغيره
◈ مصادر يستحسنها مشرفك

بحثك يبدأ من مراجع تليق

📩 اطلب قائمة مراجعك
{wa}`,

  // 13 — عرض المجموعات
  `━━━━━━━━━━━━━━━━
🎁 عرض المجموعات — حصري
━━━━━━━━━━━━━━━━

اجمع زملاءك واطلبوا معاً

▸ خصم يليق بالطلبات الجماعية
▸ تنسيق موحد لكل الطلبات
▸ تسليم متزامن للجميع

التوفير يشبه النجاح.. يزيد بالتشارك

📲 استفسر عن العرض
{wa}`,

  // 14 — مشاركة القناة
  `✦ ✦ ✦ ✦ ✦ ✦
🔗 زملاؤك يحتاجوننا أيضاً
✦ ✦ ✦ ✦ ✦ ✦

شارك القناة مع مجموعتك الدراسية

خدمات طلابية بجودة تفوق السعر
يستحقها كل طالب طموح

👇 القناة هنا
{link}

📲 للاستفسار وطلب الخدمة
{wa}`,

  // 15 — البطاقة الختامية
  `━━━━━━━━━━━━━━━━━━
✦ أم رهام ✦
خدمات طلابية متكاملة
━━━━━━━━━━━━━━━━━━

بحوث ▸ عروض ▸ واجبات ▸ ترجمة
تلخيص ▸ مشاريع تخرج ▸ تحليل بيانات

كل ما يحتاجه الطالب.. تحت سقف واحد
بجودة تليق وسرعة تُرضي

📲 خطنا المباشر — في انتظارك
{wa}`,
];

/** نسخة حزمة الرسائل — تُرفع لإعادة بذر القوالب عند تطوير التصميم */
const SEED_VERSION = 2;

const DEFAULT_STATE: PosterState = {
  running: false,
  intervalMin: 50,
  intervalMax: 110,
  dailyLimit: 18,
  day: todayStr(),
  todayCount: 0,
  totalPosted: 0,
  lastPostedAt: null,
  nextPostAt: null,
  lastMessageId: null,
  lastError: null,
};

let state: PosterState = { ...DEFAULT_STATE, ...getSetting<Partial<PosterState>>("poster", {}) };
let timer: ReturnType<typeof setTimeout> | null = null;

function persist(): void {
  setSetting("poster", state);
}

function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** تهيئة حزمة الرسائل — يعيد البذر عند رفع نسخة القوالب (تحسين التصميم) */
function ensureSeeded(): PosterMessage[] {
  const existing = getSetting<PosterMessage[] | null>("posterMessages", null);
  const seededVersion = getSetting<number>("posterSeedVersion", 0);
  if (seededVersion === SEED_VERSION && existing && Array.isArray(existing) && existing.length > 0) return existing;
  const seeded = SEED_MESSAGES.map((text) => ({ id: newId(), text, enabled: true }));
  setSetting("posterMessages", seeded);
  setSetting("posterSeedVersion", SEED_VERSION);
  if (seededVersion > 0) log("info", `حُدّثت حزمة رسائل الناشر (نسخة ${SEED_VERSION} — ${seeded.length} رسالة فخمة)`);
  return seeded;
}

export function listMessages(): PosterMessage[] {
  return ensureSeeded();
}

export function addMessage(text: string): PosterMessage[] {
  const msgs = ensureSeeded();
  const clean = text.trim();
  if (!clean) throw new Error("الرسالة فارغة");
  msgs.push({ id: newId(), text: clean, enabled: true });
  setSetting("posterMessages", msgs);
  log("info", `أُضيفت رسالة للناشر (المجموع: ${msgs.length})`);
  return msgs;
}

export function updateMessage(id: string, patch: { text?: string; enabled?: boolean }): PosterMessage[] {
  const msgs = ensureSeeded();
  const m = msgs.find((x) => x.id === id);
  if (!m) throw new Error("الرسالة غير موجودة");
  if (patch.text !== undefined) {
    const clean = patch.text.trim();
    if (!clean) throw new Error("الرسالة فارغة");
    m.text = clean;
  }
  if (patch.enabled !== undefined) m.enabled = !!patch.enabled;
  setSetting("posterMessages", msgs);
  return msgs;
}

export function deleteMessage(id: string): PosterMessage[] {
  const msgs = ensureSeeded().filter((x) => x.id !== id);
  setSetting("posterMessages", msgs);
  return msgs;
}

function channelLink(t: TargetInfo): string {
  if (t.username) return `https://t.me/${t.username}`;
  const row = db.query("SELECT url FROM links ORDER BY id DESC LIMIT 1").get() as { url: string } | null;
  return row?.url ?? "";
}

function pickMessage(): PosterMessage | null {
  const enabled = ensureSeeded().filter((m) => m.enabled && m.id !== state.lastMessageId);
  const pool = enabled.length > 0 ? enabled : ensureSeeded().filter((m) => m.enabled);
  if (pool.length === 0) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

/** نشر رسالة واحدة الآن — يعيد معرف الرسالة */
export async function postNow(): Promise<{ messageId: number; excerpt: string }> {
  const client = getClient();
  if (!client || !isReady()) throw new Error("غير متصل — سجّل الدخول أولاً");
  const target = getSetting<TargetInfo | null>("target", null);
  if (!target) throw new Error("لا قناة هدف معيّنة");
  const wa = getSetting<{ waNumber: string | null }>("app", {}).waNumber;
  const waUrl = wa ? `https://wa.me/${wa.replace(/[^\d]/g, "")}` : null;
  if (!waUrl) throw new Error("اضبط رقم الواتساب في الإعدادات أولاً — كل رسالة تحمله");
  const msg = pickMessage();
  if (!msg) throw new Error("لا توجد رسائل مفعّلة — أضف رسائل أولاً");
  const rendered = msg.text.replaceAll("{wa}", waUrl).replaceAll("{link}", channelLink(target));
  const sent = await client.sendMessage(targetPeerFrom(target), { message: rendered, linkPreview: false });
  state.totalPosted++;
  state.todayCount++;
  state.lastPostedAt = Date.now();
  state.lastMessageId = msg.id;
  state.lastError = null;
  persist();
  log("success", `نُشرت رسالة ترويجية (#${sent.id}): ${msg.text.slice(0, 50)}…`);
  return { messageId: sent.id, excerpt: rendered.slice(0, 120) };
}

function schedule(ms: number): void {
  if (timer) clearTimeout(timer);
  state.nextPostAt = Date.now() + ms;
  timer = setTimeout(() => void tick(), ms);
}

async function tick(): Promise<void> {
  state.nextPostAt = null;
  if (!state.running) return;

  const client = getClient();
  if (!client || !isReady()) {
    state.running = false;
    persist();
    log("error", "الناشر التلقائي: انقطع الاتصال — توقف");
    return;
  }

  const today = todayStr();
  if (state.day !== today) {
    state.day = today;
    state.todayCount = 0;
  }

  if (state.todayCount >= state.dailyLimit) {
    log("info", `الناشر: بلغ السقف اليومي (${state.todayCount}/${state.dailyLimit}) — استراحة حتى منتصف الليل`);
    persist();
    schedule(msUntilMidnight() + 60_000);
    return;
  }

  try {
    await postNow();
  } catch (e) {
    state.lastError = String((e as Error).message || e);
    log("error", `الناشر: ${state.lastError}`);
    if (state.lastError.includes("لا قناة") || state.lastError.includes("لا رسائل") || state.lastError.includes("رقم الواتساب")) {
      state.running = false;
      persist();
      return;
    }
  }

  persist();
  if (state.running) {
    schedule(rand(state.intervalMin, state.intervalMax) * 60_000);
  }
}

export function posterStatus() {
  const msgs = ensureSeeded();
  return {
    running: state.running,
    intervalMin: state.intervalMin,
    intervalMax: state.intervalMax,
    dailyLimit: state.dailyLimit,
    day: state.day,
    todayCount: state.todayCount,
    totalPosted: state.totalPosted,
    lastPostedAt: state.lastPostedAt,
    nextPostAt: state.running ? state.nextPostAt : null,
    lastError: state.lastError,
    enabledMessages: msgs.filter((m) => m.enabled).length,
    totalMessages: msgs.length,
  };
}

export async function startPoster(opts: { intervalMin?: number; intervalMax?: number; dailyLimit?: number }): Promise<void> {
  if (!isReady() || !getClient()) throw new Error("غير متصل — سجّل الدخول أولاً");
  const target = getSetting<TargetInfo | null>("target", null);
  if (!target) throw new Error("لا قناة هدف معيّنة");
  state = {
    ...state,
    ...(opts.intervalMin ? { intervalMin: Math.min(Math.max(opts.intervalMin, 15), 720) } : {}),
    ...(opts.intervalMax ? { intervalMax: Math.min(Math.max(opts.intervalMax, state.intervalMin), 1440) } : {}),
    ...(opts.dailyLimit ? { dailyLimit: Math.min(Math.max(opts.dailyLimit, 1), 40) } : {}),
    running: true,
  };
  if (state.intervalMax < state.intervalMin) state.intervalMax = state.intervalMin;
  persist();
  log("success", `انطلق الناشر التلقائي — كل ${state.intervalMin}-${state.intervalMax} دقيقة، سقف ${state.dailyLimit} رسالة/يوم`);
  schedule(4000);
}

export function stopPoster(): void {
  state.running = false;
  if (timer) clearTimeout(timer);
  timer = null;
  state.nextPostAt = null;
  persist();
  log("warn", "أُوقف الناشر التلقائي");
}

/** استئناف تلقائي بعد إعادة تشغيل الخدمة */
export function resumePoster(): void {
  if (!state.running) return;
  log("info", "استئناف الناشر التلقائي بعد إعادة التشغيل…");
  schedule(6000);
}
