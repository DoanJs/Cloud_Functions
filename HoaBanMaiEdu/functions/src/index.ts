import axios from "axios";
import {defineSecret} from "firebase-functions/params";
import {getFirestore} from "firebase-admin/firestore";
import {onDocumentWritten} from "firebase-functions/firestore";
import admin from "firebase-admin";
import {onCall, HttpsError, onRequest} from "firebase-functions/v2/https";
// Firebase init
admin.initializeApp();
const db = getFirestore();

const TELEGRAM_BOT_TOKEN = defineSecret("TELEGRAM_BOT_TOKEN");
/* ================== UTILS ================== */

type DeleteEntityType = "report" | "plan";

async function sendTelegram(
  chatId: string,
  text: string,
  token: string,
  route: string
) {
  if (!chatId) return;

  try {
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "🔍 Xem chi tiết",
              url: `https://hoa-ban-mai-edu.vercel.app/${route}`,
            },
          ],
        ],
      },
    });
  } catch (err) {
    console.error("Telegram send error:", err);
  }
}

async function getChild(childId: string) {
  const snap = await db.doc(`children/${childId}`).get();
  return snap.exists ? {id: snap.id, ...snap.data()} : null;
}

async function getUser(uid: string) {
  const snap = await db.doc(`users/${uid}`).get();
  if (!snap.exists) return null;
  return {id: uid, ...snap.data()};
}

async function getUsersByIds(uids: string[]) {
  const users = await Promise.all(uids.map((uid) => getUser(uid)));
  return users.filter(Boolean) as any[];
}

function convertPosition(position: string) {
  const result: string =
    position === "Giám đốc" ?
      "Giám đốc" :
      position === "Phó Giám đốc" ?
        "Quản lý chuyên môn" :
        "Chuyên viên tâm lý";
  return result;
}

function canDeleteEntity(
  actor: { role?: string; id: string },
  teacherIds: string[] = []
) {
  if (actor.role === "admin") return true;
  return teacherIds.includes(actor.id);
}

async function notifyDeleteEntity(params: {
  type: DeleteEntityType;
  actorId: string;
  data: {
    title?: string;
    childId?: string;
    teacherIds?: string[];
  };
}) {
  const {type, actorId, data} = params;
  const {title, childId, teacherIds = []} = data;

  if (!childId || !title) return;

  const child: any = await getChild(childId);
  if (!child) return;

  const actor: any = await getUser(actorId);
  if (!actor) return;

  const users = await getUsersByIds(teacherIds);
  const targets = users.filter((u) => u.id !== actorId);

  const label = type === "report" ? "báo cáo" : "kế hoạch";

  const message = [
    `🗑️ <b>${convertPosition(actor.position)} ${actor.fullName}</b>`,
    `đã xoá ${label} "<b>${title}</b>"`,
    `của trẻ "<b>${child.fullName}</b>"`,
  ].join(" ");

  await Promise.all(
    targets.map((u) =>
      sendTelegram(
        u.telegramChatId,
        message,
        TELEGRAM_BOT_TOKEN.value(),
        `home/${child.id}`
      )
    )
  );
}
/* ================== CLOUD FUNCTION TRIGGER ================== */

export const onReportWrite = onDocumentWritten(
  {
    document: "reports/{reportId}",
    region: "asia-southeast1",
    secrets: [TELEGRAM_BOT_TOKEN],
  },
  async (event) => {
    const botToken = TELEGRAM_BOT_TOKEN.value();
    const beforeSnap = event.data?.before;
    const afterSnap = event.data?.after;

    // ========= DELETE =========
    if (beforeSnap?.exists && !afterSnap?.exists) {
      // const before = beforeSnap.data();
      // if (!before) return;

      // // xử lý delete ở đây
      // const {
      //   title,
      //   childId,
      //   teacherIds = [],
      //   updateById,
      // } = before;
      // if (!updateById) return;

      // if (!childId) return;

      // const child: any = await getChild(childId);
      // if (!child) return;

      // const actor: any = await getUser(updateById);
      // if (!actor) return;

      // const users = await getUsersByIds(teacherIds);

      // const targets = users.filter(
      //   (u) => u.id !== updateById
      // );

      // await Promise.all(
      //   targets.map((u) =>
      //     sendTelegram(
      //       u.telegramChatId,
      //       `🗑️ <b>${convertPosition(actor.position)}
      //  ${actor.fullName}</b>
      //  đã xoá báo cáo "<b>${title}</b>"
      //  của trẻ "<b>${child.fullName}</b>"`,
      //       botToken,
      //       `home/${child.id}`
      //     )
      //   )
      // );
      return;
    }

    // ⛔ Không phải delete mà after không tồn tại → bỏ
    if (!afterSnap?.exists) return;

    const after = afterSnap.data();
    if (!after) return;

    const before = beforeSnap?.data();

    if (!after) return;

    const {
      title,
      status,
      comment,
      teacherIds = [],
      updateById,
      childId,
      updateAt,
    } = after;

    if (!updateById) return;

    if (!childId) return;

    const child: any = await getChild(childId);
    if (!child) return;

    const actor: any = await getUser(updateById);
    if (!actor) return;

    const users = await getUsersByIds(teacherIds);

    const others = users.filter((u) => u.id !== updateById);

    /* ========= 1. TẠO ========= */
    if (!beforeSnap?.exists) {
      await Promise.all(
        others.map((u) =>
          sendTelegram(
            u.telegramChatId,
            `📌 <b>${convertPosition(actor.position)} ${actor.fullName}</b>` +
              ` đã tạo báo cáo "<b>${title}</b>"` +
              ` của trẻ "<b>${child.fullName}</b>"`,
            botToken,
            `home/${child.id}/pending`
          )
        )
      );
      return;
    }

    /* ========= 2. DUYỆT ========= */
    if (
      before?.status !== "approved" &&
      status === "approved" &&
      actor.role === "admin"
    ) {
      await Promise.all(
        others.map((u) =>
          sendTelegram(
            u.telegramChatId,
            `✅ <b>${convertPosition(actor.position)} ${actor.fullName}</b>` +
              ` đã duyệt báo cáo "<b>${title}</b>"` +
              ` của trẻ "<b>${child.fullName}</b>"`,
            botToken,
            `home/${child.id}/report`
          )
        )
      );
      return;
    }

    /* ========= 3. GÓP Ý ========= */
    if (before?.comment !== comment && comment) {
      if (actor.role === "admin" || actor.position === "Phó Giám đốc") {
        await Promise.all(
          others.map((u) =>
            sendTelegram(
              u.telegramChatId,
              `💬 <b>${convertPosition(actor.position)} ${actor.fullName}</b>` +
                ` đã góp ý báo cáo "<b>${title}</b>"` +
                ` của trẻ "<b>${child.fullName}</b>"`,
              botToken,
              `home/${child.id}/pending`
            )
          )
        );
      }
      return;
    }

    /* ========= 4. SỬA ========= */
    if (before?.updateAt !== updateAt) {
      await Promise.all(
        others.map((u) =>
          sendTelegram(
            u.telegramChatId,
            `✏️ <b>${convertPosition(actor.position)} ${actor.fullName}</b>` +
              ` đã chỉnh sửa báo cáo "<b>${title}</b>"` +
              ` của trẻ "<b>${child.fullName}</b>"`,
            botToken,
            `home/${child.id}/pending`
          )
        )
      );
    }
  }
);

export const onPlanWrite = onDocumentWritten(
  {
    document: "plans/{planId}",
    region: "asia-southeast1",
    secrets: [TELEGRAM_BOT_TOKEN],
  },
  async (event) => {
    const botToken = TELEGRAM_BOT_TOKEN.value();
    const beforeSnap = event.data?.before;
    const afterSnap = event.data?.after;

    // ========= DELETE =========
    if (beforeSnap?.exists && !afterSnap?.exists) {
      // const before = beforeSnap.data();
      // if (!before) return;

      // // xử lý delete ở đây
      // const {
      //   title,
      //   childId,
      //   teacherIds = [],
      //   updateById,
      // } = before;
      // if (!updateById) return;

      // if (!childId) return;

      // const child: any = await getChild(childId);
      // if (!child) return;

      // const actor: any = await getUser(updateById);
      // if (!actor) return;

      // const users = await getUsersByIds(teacherIds);

      // const targets = users.filter(
      //   (u) => u.id !== updateById
      // );

      // await Promise.all(
      //   targets.map((u) =>
      //     sendTelegram(
      //       u.telegramChatId,
      //       `🗑️ <b>${convertPosition(actor.position)}
      // ${actor.fullName}</b> đã xoá kế hoạch "<b>${title}</b>"
      //  của trẻ "<b>${child.fullName}</b>"`,
      //       botToken,
      //       `home/${child.id}`
      //     )
      //   )
      // );
      return;
    }

    // ⛔ Không phải delete mà after không tồn tại → bỏ
    if (!afterSnap?.exists) return;

    const after = afterSnap.data();
    if (!after) return;

    const before = beforeSnap?.data();

    if (!after) return;

    const {
      title,
      status,
      comment,
      teacherIds = [],
      updateById,
      childId,
      updateAt,
    } = after;

    if (!updateById) return;

    if (!childId) return;

    const child: any = await getChild(childId);
    if (!child) return;

    const actor: any = await getUser(updateById);
    if (!actor) return;

    const users = await getUsersByIds(teacherIds);

    const others = users.filter((u) => u.id !== updateById);
    /* ========= 1. TẠO ========= */
    if (!beforeSnap?.exists) {
      await Promise.all(
        others.map((u) =>
          sendTelegram(
            u.telegramChatId,
            `📌 <b>${convertPosition(actor.position)} ${actor.fullName}</b>` +
              ` đã tạo kế hoạch "<b>${title}</b>"` +
              ` của trẻ "<b>${child.fullName}</b>"`,
            botToken,
            `home/${child.id}/pending`
          )
        )
      );
      return;
    }

    /* ========= 2. DUYỆT ========= */
    if (
      before?.status !== "approved" &&
      status === "approved" &&
      actor.role === "admin"
    ) {
      await Promise.all(
        others.map((u) =>
          sendTelegram(
            u.telegramChatId,
            `✅ <b>${convertPosition(actor.position)} ${actor.fullName}</b>` +
              ` đã duyệt kế hoạch "<b>${title}</b>"` +
              ` của trẻ "<b>${child.fullName}</b>"`,
            botToken,
            `home/${child.id}/plan`
          )
        )
      );
      return;
    }

    /* ========= 3. GÓP Ý ========= */
    if (before?.comment !== comment && comment) {
      if (actor.role === "admin" || actor.position === "Phó Giám đốc") {
        await Promise.all(
          others.map((u) =>
            sendTelegram(
              u.telegramChatId,
              `💬 <b>${convertPosition(actor.position)} ${actor.fullName}</b>` +
                ` đã góp ý kế hoạch "<b>${title}</b>"` +
                ` của trẻ "<b>${child.fullName}</b>"`,
              botToken,
              `home/${child.id}/pending`
            )
          )
        );
      }
      return;
    }

    /* ========= 4. SỬA ========= */
    if (before?.updateAt !== updateAt) {
      await Promise.all(
        others.map((u) =>
          sendTelegram(
            u.telegramChatId,
            `✏️ <b>${convertPosition(actor.position)} ${actor.fullName}</b>` +
              ` đã chỉnh sửa kế hoạch "<b>${title}</b>"` +
              ` của trẻ "<b>${child.fullName}</b>"`,
            botToken,
            `home/${child.id}/pending`
          )
        )
      );
    }
  }
);

/* ================== CLOUD FUNCTION HTTPSCALLABLE ================== */

export const deleteReport = onCall(
  {region: "asia-southeast1", secrets: [TELEGRAM_BOT_TOKEN]},
  async (req) => {
    const uid = req.auth?.uid;
    if (!uid) {
      throw new HttpsError("unauthenticated", "Login required");
    }

    const {reportId} = req.data as { reportId?: string };
    if (!reportId) {
      throw new HttpsError("invalid-argument", "reportId is required");
    }

    // 1️⃣ Lấy report trước khi xoá
    const reportRef = db.doc(`reports/${reportId}`);
    const reportSnap = await reportRef.get();
    if (!reportSnap.exists) return;

    const reportData: any = reportSnap.data();

    const actor = await getUser(uid);
    if (!actor) {
      throw new HttpsError("failed-precondition", "Actor not found");
    }

    if (!canDeleteEntity(actor, reportData.teacherIds)) {
      throw new HttpsError("permission-denied", "Not allowed to delete report");
    }

    // 2️⃣ Lấy các task thuộc report
    const reportsSnap = await db
      .collection("reportTasks")
      .where("reportId", "==", reportId)
      .get();

    // 3️⃣ Xoá trong 1 batch
    const batch = db.batch();

    reportsSnap.docs.forEach((doc) => {
      batch.delete(doc.ref);
    });

    batch.delete(reportRef);

    await batch.commit();

    // 4️⃣ (Sau khi xoá) gửi Telegram notify
    await notifyDeleteEntity({
      type: "report",
      actorId: uid,
      data: reportData,
    });

    return {ok: true};
  }
);

export const deletePlan = onCall(
  {region: "asia-southeast1", secrets: [TELEGRAM_BOT_TOKEN]},
  async (req) => {
    const uid = req.auth?.uid;
    if (!uid) {
      throw new HttpsError("unauthenticated", "Login required");
    }

    const {planId} = req.data as { planId?: string };
    if (!planId) {
      throw new HttpsError("invalid-argument", "planId is required");
    }

    // 1️⃣ Lấy plan trước khi xoá
    const planRef = db.doc(`plans/${planId}`);
    const planSnap = await planRef.get();
    if (!planSnap.exists) return;

    const planData: any = planSnap.data();

    const actor = await getUser(uid);
    if (!actor) {
      throw new HttpsError("failed-precondition", "Actor not found");
    }

    if (!canDeleteEntity(actor, planData.teacherIds)) {
      throw new HttpsError("permission-denied", "Not allowed to delete report");
    }

    // 2️⃣ Lấy các task thuộc plan
    const tasksSnap = await db
      .collection("planTasks")
      .where("planId", "==", planId)
      .get();

    // 3️⃣ Xoá trong 1 batch
    const batch = db.batch();

    tasksSnap.docs.forEach((doc) => {
      batch.delete(doc.ref);
    });

    batch.delete(planRef);

    await batch.commit();

    // 4️⃣ (Sau khi xoá) gửi Telegram notify
    await notifyDeleteEntity({
      type: "plan",
      actorId: uid,
      data: planData,
    });

    return {ok: true};
  }
);

/* ================== CLOUD FUNCTION TELEGRAM WEBHOOK ================== */
/* =====================================================
   CONFIG
===================================================== */
type DocumentType = "plan" | "report";

const DOCUMENT_CONFIG: Record<DocumentType, any> = {
  plan: {
    collection: "plans",
    label: "kế hoạch",
    icon: "📌",
  },
  report: {
    collection: "reports",
    label: "báo cáo",
    icon: "📊",
  },
};
const ADMIN_CHAT_ID = defineSecret("ADMIN_CHAT_ID");
const ADMIN_ID = defineSecret("ADMIN_ID");
/* =====================================================
   TELEGRAM WEBHOOK
===================================================== */
export const telegramWebhook = onRequest(
  {
    region: "asia-southeast1",
    secrets: [ADMIN_ID, ADMIN_CHAT_ID, TELEGRAM_BOT_TOKEN],
  },
  async (req, res) => {
    const update = req.body;

    /* ---------- CALLBACK ---------- */
    if (update.callback_query) {
      const cb = update.callback_query;
      const chatId = cb.message.chat.id;

      await handleCallback(cb.data, chatId);
      await answerCallback(cb.id);

      res.sendStatus(200);
      return;
    }

    /* ---------- MESSAGE ---------- */
    const message = update.message;
    if (!message?.text) {
      res.sendStatus(200);
      return;
    }

    const chatId = message.chat.id;
    const text = message.text.trim();

    await handleCommand(text, chatId);

    res.sendStatus(200);
  }
);

/* =====================================================
   COMMAND HANDLER
===================================================== */
async function handleCommand(text: string, chatId: number) {
  const [command, _] = text.split(" ");

  if (chatId !== Number(ADMIN_CHAT_ID.value())) return;

  switch (command) {
  case "/start":
    await sendTelegramCommand(
      chatId,
      "👋 Chào bạn! Dùng /help để xem danh sách lệnh."
    );
    return;

  case "/help":
    await sendTelegramCommand(
      chatId,
      `
📌 <b>DANH SÁCH LỆNH</b>

<b>Chờ duyệt</b>
/pending – Tất cả kế hoạch & báo cáo
/pending_plan – Kế hoạch chờ duyệt
/pending_report – Báo cáo chờ duyệt

<b>Kiểm tra trẻ chưa làm</b>
/plan_check – Kế hoạch tháng hiện tại
/plan_check 9/2026 – Kế hoạch tháng chỉ định
/report_check – Báo cáo tháng hiện tại
/report_check 9/2026 – Báo cáo tháng chỉ định
`
    );
    return;

  case "/pending":
    await handlePending("all", chatId);
    return;

  case "/pending_plan":
    await handlePending("plan", chatId);
    return;

  case "/pending_report":
    await handlePending("report", chatId);
    return;

  default:
    await handleCheckCommand(text, chatId);
    return;
  }
}

/* =====================================================
   CHECK MISSING ( /plan_check , /report_check )
===================================================== */
async function handleCheckCommand(text: string, chatId: number) {
  const [command, time] = text.split(" ");

  let type: DocumentType;
  let isPlanCheck = false;
  if (command === "/plan_check") {
    type = "plan";
    isPlanCheck = true;
  } else if (command === "/report_check") {
    type = "report";
  } else {
    await sendTelegramCommand(chatId, "❓ Lệnh không hợp lệ. Gõ /help");
    return;
  }

  let month: number;
  let year: number;

  if (!time) {
    const now = new Date();
    month = now.getMonth() + 1;
    year = now.getFullYear();
  } else {
    const [m, y] = time.split("/");
    month = Number(m);
    year = Number(y);

    if (!month || !year || month < 1 || month > 12) {
      await sendTelegramCommand(chatId, "⚠️ Ví dụ cú pháp đúng: 9/2026");
      return;
    }
  }

  // =============================
  // 2️⃣ PLAN → LUÔN LÙI 1 THÁNG
  // =============================
  if (isPlanCheck) {
    const result = subtractOneMonth(year, month);
    year = result.year;
    month = result.month;
  }

  const children = await getChildrenWithoutDocument(type, year, month);

  if (!children.length) {
    await sendTelegramCommand(
      chatId,
      `✅ Tất cả trẻ đã có ${DOCUMENT_CONFIG[type].label}`+
      ` tháng ${month}/${year}.`
    );
    return;
  }

  const teacherIds = children.flatMap((c: any) => c.teacherIds || []);

  const teacherMap = await getTeachersMap(teacherIds);

  // 👉 GÁN THẲNG VÀO CHILDREN
  children.forEach((child: any) => {
    child.teachers = (child.teacherIds || [])
      .map((id: any) => teacherMap.get(id))
      .filter(Boolean);
  });

  await askAdminToRemind(type, chatId, children, year, month);
}
async function getTeachersMap(teacherIds: string[]) {
  const uniqueIds = [...new Set(teacherIds)]
    .filter(Boolean)
    .filter((t) => t !== ADMIN_ID.value()); // trừ admin;

  const snaps = await Promise.all(uniqueIds.map((id) => getUser(id)));

  const map = new Map<string, string>();

  snaps.forEach((t: any) => {
    if (t) {
      map.set(t.id, `Cô ${t.shortName}`);
    }
  });

  return map;
}

/* =====================================================
   ASK ADMIN CONFIRM REMIND
===================================================== */
async function askAdminToRemind(
  type: DocumentType,
  chatId: number,
  children: any[],
  year: number,
  month: number
) {
  const cfg = DOCUMENT_CONFIG[type];

  const {displayMonth, displayYear} = getDisplayMonthYear(
    type,
    year,
    month
  );

  const previewText = renderChildrenPreview(children, 20);

  const teacherCount = new Set(
    children.flatMap((c: any) => c.teacherIds || [])
  ).size;

  const text =
    `${cfg.icon} <b>TRẺ CHƯA CÓ ${cfg.label.toUpperCase()} ` +
    `THÁNG ${displayMonth}/${displayYear}</b>\n\n` +
    `• Tổng số trẻ: <b>${children.length}</b>\n` +
    `• Giáo viên liên quan: <b>${teacherCount}</b>\n\n` +
    previewText +
    "\n\n❓ <b>Bạn có muốn nhắc giáo viên không?</b>";

  await sendTelegramRaw({
    chat_id: chatId,
    text,
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: `🔔 Nhắc ${cfg.label}`,
            callback_data: `REMIND:${type}:${year}:${month}`,
          },
          {
            text: "❌ Bỏ qua",
            callback_data: "CANCEL",
          },
        ],
      ],
    },
  });
}

/* =====================================================
   CALLBACK HANDLER
===================================================== */
async function handleCallback(data: string, chatId: number) {
  if (data === "CANCEL") {
    await sendTelegramCommand(chatId, "❌ Đã huỷ nhắc nhở.");
    return;
  }

  if (data.startsWith("REMIND:")) {
    const [, type, yearStr, monthStr] = data.split(":");
    await remindTeachersMissingDocument(
      type as DocumentType,
      Number(yearStr),
      Number(monthStr)
    );

    await sendTelegramCommand(
      chatId,
      `✅ Đã gửi nhắc nhở ${DOCUMENT_CONFIG[type as DocumentType].label}.`
    );
  }
}

/* =====================================================
   PENDING COMMAND
===================================================== */
async function handlePending(type: "all" | DocumentType, chatId: number) {
  if (type === "all") {
    const plans = await getPending("plans");
    const reports = await getPending("reports");

    const text =
      "⏳ <b>DANH SÁCH CHỜ DUYỆT</b>\n\n" +
      formatPending("📌 Kế hoạch", plans) +
      "\n\n" +
      formatPending("📊 Báo cáo", reports);

    await sendTelegramCommand(chatId, text);
    return;
  }

  const cfg = DOCUMENT_CONFIG[type];
  const items = await getPending(cfg.collection);

  await sendTelegramCommand(
    chatId,
    formatPending(`${cfg.icon} ${capitalizeFirstLetter(cfg.label)}`, items)
  );
}

function capitalizeFirstLetter(text: string) {
  if (!text) return "";
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function formatPending(title: string, items: any[]) {
  if (!items.length) {
    return `<b>${title}</b>\n✅ Không có mục nào chờ duyệt`;
  }

  const total = items.length;
  const shownItems = items.slice(0, 20);

  let text = `<b>${title}: ${total}</b>\n\n`;

  text += shownItems
    .map(
      (p, i) =>
        `<a href="https://hoa-ban-mai-edu.vercel.app/home/${p.childId}/pending">` +
        `${i + 1}. 👶 <b>${p.title} - ${p.childFullName ?? "Không rõ"}</b>` +
        "</a>"
    )
    .join("\n");

  if (total > 20) {
    text += `\n\n… và <b>${total - 20}</b> ${title} khác`;
  }

  return text;
}

function getDisplayMonthYear(
  type: DocumentType,
  year: number,
  month: number
) {
  if (type !== "plan") {
    return {displayMonth: month, displayYear: year};
  }

  // plan → tháng sau
  if (month === 12) {
    return {displayMonth: 1, displayYear: year + 1};
  }

  return {displayMonth: month + 1, displayYear: year};
}

/* =====================================================
   BUSINESS LOGIC
===================================================== */
async function remindTeachersMissingDocument(
  type: DocumentType,
  year: number,
  month: number
) {
  const cfg = DOCUMENT_CONFIG[type];
  const children: any = await getChildrenWithoutDocument(type, year, month);

  const teacherMap = new Map<string, any[]>();

  for (const child of children) {
    for (const teacherId of child.teacherIds || []) {
      if (!teacherMap.has(teacherId)) teacherMap.set(teacherId, []);
      teacherMap.get(teacherId)!.push(child);
    }
  }

  for (const [teacherId, list] of teacherMap.entries()) {
    const teacher: any = await getUser(teacherId);
    if (!teacher?.telegramChatId) continue;
    // ❌ không gửi cho admin
    if (teacher.role === "admin") continue;
    // hoặc: if (ADMIN_CHAT_IDS.includes(teacher.telegramChatId)) continue;
    const text =
      `⏰ <b>NHẮC NHỞ LẬP ${cfg.label.toUpperCase()}`+
      ` THÁNG ${month}/${year}</b>\n\n` +
      list.map((c, i) => `${i + 1}. 👶 <b>${c.fullName}</b>`).join("\n") +
      "\n\nCô vui lòng hoàn thiện sớm.";

    await sendTelegramCommand(teacher.telegramChatId, text);
  }
}

/* =====================================================
   DATA ACCESS
===================================================== */
async function getChildrenWithoutDocument(
  type: DocumentType,
  year: number,
  month: number
) {
  const cfg = DOCUMENT_CONFIG[type];
  const start = new Date(year, month - 1, 1);
  const end = new Date(year, month, 1);

  const snap = await db
    .collection(cfg.collection)
    .where("createAt", ">=", start)
    .where("createAt", "<", end)
    .get();

  const childHasDoc = new Set(snap.docs.map((d) => d.data().childId));
  const childrenSnap = await db.collection("children").get();

  return childrenSnap.docs
    .map((d) => ({id: d.id, ...d.data()}))
    .filter((c) => !childHasDoc.has(c.id));
}

async function getChildrenMap(childIds: string[]) {
  const uniqueIds = [...new Set(childIds)].filter(Boolean);

  const snaps = await Promise.all(
    uniqueIds.map((id) => db.doc(`children/${id}`).get())
  );

  const map = new Map<string, any>();

  snaps.forEach((snap) => {
    if (snap.exists) {
      map.set(snap.id, snap.data());
    }
  });

  return map;
}
async function getPending(collection: string) {
  // 1️⃣ lấy pending documents
  const snap = await db
    .collection(collection)
    .where("status", "==", "pending")
    .get();

  if (snap.empty) return [];

  const docs = snap.docs.map((d) => ({
    id: d.id,
    ...d.data(),
  })) as any[];

  // 2️⃣ lấy danh sách childId
  const childIds = [...new Set(docs.map((d) => d.childId).filter(Boolean))];

  // 3️⃣ join children
  const childMap = await getChildrenMap(childIds);

  // 4️⃣ gắn childFullName vào từng document
  return docs.map((doc) => ({
    ...doc,
    childFullName: childMap.get(doc.childId)?.fullName ?? "Không rõ",
  }));
}

/* =====================================================
   TELEGRAM HELPERS
===================================================== */
async function sendTelegramCommand(chatId: number, text: string) {
  await sendTelegramRaw({chat_id: chatId, text});
}

async function sendTelegramRaw(payload: any) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN.value()}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({parse_mode: "HTML", ...payload}),
  });
}

async function answerCallback(callbackId: string) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN.value()}/answerCallbackQuery`;
  await fetch(url, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({callback_query_id: callbackId}),
  });
}

function renderChildrenPreview(children: any[], limit = 20) {
  const shown = children.slice(0, limit);
  const remaining = children.length - shown.length;

  let text = shown
    .map(
      (c, i) =>
        `${i + 1}. 👶 <b>${c.fullName}</b> – ${c.teachers.join(" - ")}`
    )
    .join("\n");

  if (remaining > 0) {
    text += `\n\n➕ <b>${remaining} trẻ còn lại</b>`;
  }

  return text;
}

function subtractOneMonth(year: number, month: number) {
  month -= 1;

  if (month === 0) {
    month = 12;
    year -= 1;
  }

  return {year, month};
}
/* =====================================================
   CLOUD FUNCTION SCHEDULED
===================================================== */

import {onSchedule} from "firebase-functions/v2/scheduler";
type ReminderLevel = "FIRST" | "LAST";

export const monthlyTeacherReminderFirst = onSchedule(
  {
    schedule: "0 8 25 * *", // mỗi 8h sáng ngày 25 hàng tháng
    timeZone: "Asia/Ho_Chi_Minh",
    region: "asia-southeast1",
    secrets: [TELEGRAM_BOT_TOKEN],
  },
  async () => {
    await remindPlanNextMonth("FIRST");
    await remindReportCurrentMonth("FIRST");
  }
);
export const monthlyTeacherReminderLast = onSchedule(
  {
    schedule: "0 8 28 * *", // mỗi 8h sáng ngày 28 hàng tháng
    timeZone: "Asia/Ho_Chi_Minh",
    region: "asia-southeast1",
    secrets: [TELEGRAM_BOT_TOKEN],
  },
  async () => {
    await remindPlanNextMonth("LAST");
    await remindReportCurrentMonth("LAST");
  }
);
function getNextMonth(year: number, month: number) {
  month += 1;
  if (month === 13) {
    month = 1;
    year += 1;
  }
  return {year, month};
}
async function remindPlanNextMonth(level: ReminderLevel) {
  const now = new Date();
  const currentMonth = now.getMonth() + 1;
  const currentYear = now.getFullYear();

  const {year, month} = getNextMonth(currentYear, currentMonth);

  const children = await getChildrenWithoutDocument(
    "plan",
    year,
    month
  );

  await notifyTeachers(
    "plan",
    children,
    year,
    month,
    level
  );
}
async function remindReportCurrentMonth(level: ReminderLevel) {
  const now = new Date();
  const month = now.getMonth() + 1;
  const year = now.getFullYear();

  const children = await getChildrenWithoutDocument(
    "report",
    year,
    month
  );

  await notifyTeachers(
    "report",
    children,
    year,
    month,
    level
  );
}
async function notifyTeachers(
  type: DocumentType,
  children: any[],
  year: number,
  month: number,
  level: ReminderLevel
) {
  if (!children.length) return;

  // const cfg = DOCUMENT_CONFIG[type];
  const teacherMap = new Map<string, any[]>();

  for (const child of children) {
    for (const teacherId of child.teacherIds || []) {
      if (!teacherMap.has(teacherId)) teacherMap.set(teacherId, []);
      teacherMap.get(teacherId)!.push(child);
    }
  }

  for (const [teacherId, list] of teacherMap.entries()) {
    const teacher: any = await getUser(teacherId);
    if (!teacher?.telegramChatId) continue;
    if (teacher.role === "admin") continue;

    const preview = list.slice(0, 20);
    const remain = list.length - preview.length;

    let text =
      getReminderHeader(type, month, year, level) +
      "\n\n" +
      preview
        .map((c, i) => `${i + 1}. 👶 <b>${c.fullName}</b>`)
        .join("\n");

    if (remain > 0) {
      text += `\n\n➕ Và ${remain} trẻ khác`;
    }

    text += getReminderFooter(level);

    await sendTelegramCommand(teacher.telegramChatId, text);
  }
}
function getReminderHeader(
  type: DocumentType,
  month: number,
  year: number,
  level: ReminderLevel
) {
  const cfg = DOCUMENT_CONFIG[type];

  if (level === "FIRST") {
    return `⏰ <b>CHÚ Ý : Deadline gửi ${cfg.label.toUpperCase()} `+
    `THÁNG ${month}/${year}</b>`+
    " đã đến hạn. Các cô nhanh chóng " +
    "gửi duyệt đến quản lý chuyên môn.";
  }

  return `⛔ <b>CHÚ Ý : Deadline gửi ${cfg.label.toUpperCase()} `+
  `THÁNG ${month}/${year}</b>`+
  " đã đến hạn cuối chỉnh sửa."+
  " Hoàn tất chỉnh sửa trong hôm nay nhé cô";
}
function getReminderFooter(level: ReminderLevel) {
  if (level === "FIRST") {
    return "\n\n📌 Cô vui lòng sắp xếp hoàn thiện trong thời gian sớm nhất.";
  }

  return "\n\n⚠️ Hôm nay là hạn cuối. Cô vui lòng hoàn thành ngay trong ngày.";
}
