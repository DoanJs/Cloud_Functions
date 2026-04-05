import {initializeApp} from "firebase-admin/app";
import {FieldValue, getFirestore} from "firebase-admin/firestore";
import {HttpsError, onCall, onRequest} from "firebase-functions/v2/https";
import {defineSecret} from "firebase-functions/params";

initializeApp();

const db = getFirestore();

type FuelLevel = "empty" | "quarter" | "half" | "three_quarters" | "full";
type CleanStatus = "clean" | "normal" | "dirty";
type RequestStatus = "pending" | "approved" | "rejected";
type RequestType = "borrow" | "return" | "refuel";
interface CreateReturnRequestData {
  vehicleId?: string;
  currentKm?: number;
  fuelLevel?: FuelLevel;
  cleanStatus?: CleanStatus;
  note?: string;
}
type CreateRefuelRequestData = {
  vehicleId: string;
  fuelLevel: FuelLevel;
  note?: string;
  amount?: number;
  liters?: number;
};

const TELEGRAM_BOT_TOKEN = defineSecret("TELEGRAM_BOT_TOKEN");
const TELEGRAM_ADMIN_CHAT_ID = defineSecret("TELEGRAM_ADMIN_CHAT_ID");

const approveBorrowCore = async (requestId: string) => {
  const requestRef = db.collection("borrow_requests").doc(requestId);
  let requestData: any;

  await db.runTransaction(async (tx) => {
    const rSnap = await tx.get(requestRef);

    if (!rSnap.exists) {
      throw new Error("Không tìm thấy yêu cầu.");
    }

    const rData = rSnap.data() || {};
    requestData = rData;

    if (rData.type !== "borrow") {
      throw new Error("Không phải yêu cầu mượn xe.");
    }

    if (rData.status !== "pending") {
      throw new Error("Yêu cầu đã được xử lý.");
    }

    const vehicleRef = db.collection("vehicles").doc(rData.vehicleId);
    const vSnap = await tx.get(vehicleRef);

    if (!vSnap.exists) {
      throw new Error("Không tìm thấy xe.");
    }

    const vData = vSnap.data() || {};

    if (vData.status !== "available") {
      throw new Error("Xe không sẵn sàng.");
    }

    const now = FieldValue.serverTimestamp();

    tx.update(vehicleRef, {
      borrowedById: rData.requestedByUid || "",
      borrowedByName: rData.requestedByName || "",
      borrowedReason: rData.reason || "",
      status: "borrowed",
      updatedAt: now,
    });

    tx.update(requestRef, {
      status: "approved",
      updatedAt: now,
    });
  });

  return requestData;
};
const rejectBorrowCore = async (requestId: string) => {
  const requestRef = db.collection("borrow_requests").doc(requestId);

  const snap = await requestRef.get();

  if (!snap.exists) {
    throw new Error("Không tìm thấy yêu cầu.");
  }

  const data = snap.data();

  if (data?.type !== "borrow") {
    throw new Error("Không phải yêu cầu mượn xe.");
  }

  if (data?.status !== "pending") {
    throw new Error("Yêu cầu đã xử lý.");
  }

  await requestRef.update({
    status: "rejected",
    updatedAt: FieldValue.serverTimestamp(),
  });

  return data;
};
const approveReturnCore = async (requestId: string) => {
  const requestRef = db.collection("return_requests").doc(requestId);
  let requestData: any;

  await db.runTransaction(async (tx) => {
    const rSnap = await tx.get(requestRef);

    if (!rSnap.exists) {
      throw new Error("Không tìm thấy yêu cầu.");
    }

    const rData = rSnap.data() || {};
    requestData = rData;

    if (rData.type !== "return") {
      throw new Error("Không phải yêu cầu trả xe.");
    }

    if (rData.status !== "pending") {
      throw new Error("Yêu cầu không còn pending.");
    }

    const vehicleId = String(rData.vehicleId || "").trim();
    if (!vehicleId) {
      throw new Error("Yêu cầu không có vehicleId.");
    }

    const vehicleRef = db.collection("vehicles").doc(vehicleId);
    const vSnap = await tx.get(vehicleRef);

    if (!vSnap.exists) {
      throw new Error("Không tìm thấy xe.");
    }

    const vData = vSnap.data() || {};

    if (vData.status !== "borrowed") {
      throw new Error("Xe đã bị thay đổi trạng thái.");
    }

    const currentKm = Number(rData.currentKm);
    const fuelLevel = String(rData.fuelLevel || "").trim();
    const cleanStatus = String(rData.cleanStatus || "").trim();

    if (!Number.isFinite(currentKm) || currentKm < 0) {
      throw new Error("Dữ liệu currentKm trong yêu cầu không hợp lệ.");
    }

    const validFuelLevels = [
      "empty",
      "quarter",
      "half",
      "three_quarters",
      "full",
    ];
    if (!validFuelLevels.includes(fuelLevel)) {
      throw new Error("Dữ liệu fuelLevel trong yêu cầu không hợp lệ.");
    }

    const validCleanStatuses = ["clean", "normal", "dirty"];
    if (!validCleanStatuses.includes(cleanStatus)) {
      throw new Error("Dữ liệu cleanStatus trong yêu cầu không hợp lệ.");
    }

    const oldKm = Number(vData.currentKm || 0);
    if (currentKm < oldKm) {
      throw new Error("Số km trả xe nhỏ hơn số km hiện tại của xe.");
    }

    const now = FieldValue.serverTimestamp();

    tx.update(vehicleRef, {
      currentKm,
      fuelLevel,
      cleanStatus,
      borrowedById: "",
      borrowedByName: "",
      borrowedReason: "",
      status: "available",
      updatedAt: now,
    });

    tx.update(requestRef, {
      status: "approved",
      updatedAt: now,
    });
  });

  return requestData;
};
const rejectReturnCore = async (requestId: string) => {
  const requestRef = db.collection("return_requests").doc(requestId);

  const snap = await requestRef.get();

  if (!snap.exists) {
    throw new Error("Không tìm thấy yêu cầu.");
  }

  const data = snap.data() || {};

  if (data.type !== "return") {
    throw new Error("Không phải yêu cầu trả xe.");
  }

  if (data.status !== "pending") {
    throw new Error("Yêu cầu đã xử lý.");
  }

  await requestRef.update({
    status: "rejected",
    updatedAt: FieldValue.serverTimestamp(),
  });

  return data;
};
const approveRefuelCore = async (requestId: string) => {
  const requestRef = db.collection("refuel_requests").doc(requestId);
  let requestData: any;

  await db.runTransaction(async (tx) => {
    const reqSnap = await tx.get(requestRef);

    if (!reqSnap.exists) {
      throw new Error("Không tìm thấy yêu cầu đổ xăng.");
    }

    const reqData = reqSnap.data() || {};
    requestData = reqData;

    const status = String(reqData.status || "").trim();
    const vehicleId = String(reqData.vehicleId || "").trim();
    const fuelLevel = String(reqData.fuelLevel || "").trim() as FuelLevel;

    if (status !== "pending") {
      throw new Error("Yêu cầu đổ xăng không còn ở trạng thái chờ duyệt.");
    }

    if (!vehicleId) {
      throw new Error("Yêu cầu không có vehicleId hợp lệ.");
    }

    const validFuelLevels: FuelLevel[] = [
      "empty",
      "quarter",
      "half",
      "three_quarters",
      "full",
    ];

    if (!validFuelLevels.includes(fuelLevel)) {
      throw new Error("fuelLevel của yêu cầu không hợp lệ.");
    }

    const vehicleRef = db.collection("vehicles").doc(vehicleId);
    const vehicleSnap = await tx.get(vehicleRef);

    if (!vehicleSnap.exists) {
      throw new Error("Không tìm thấy xe.");
    }

    const now = FieldValue.serverTimestamp();

    // update request
    tx.update(requestRef, {
      status: "approved",
      updatedAt: now,
    });

    // update vehicle
    tx.update(vehicleRef, {
      fuelLevel,
      updatedAt: now,
    });
  });

  return requestData;
};
const rejectRefuelCore = async (requestId: string) => {
  const requestRef = db.collection("refuel_requests").doc(requestId);

  const snap = await requestRef.get();

  if (!snap.exists) {
    throw new Error("Không tìm thấy yêu cầu đổ xăng.");
  }

  const data = snap.data() || {};

  const status = String(data.status || "").trim();

  if (status !== "pending") {
    throw new Error("Yêu cầu đổ xăng đã được xử lý.");
  }

  await requestRef.update({
    status: "rejected",
    updatedAt: FieldValue.serverTimestamp(),
  });

  return data;
};
const sendTelegramMessage = async (
  chatId: string,
  text: string,
  extra?: any
) => {
  const token = TELEGRAM_BOT_TOKEN.value();

  if (!token) throw new Error("Thiếu TELEGRAM_BOT_TOKEN");
  if (!chatId) throw new Error("Thiếu chatId");

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      ...extra,
    }),
  });

  const data = await res.json();
  console.log("Telegram response:", data);

  if (!res.ok || !data.ok) {
    throw new Error(data?.description || "Gửi Telegram thất bại");
  }

  return data;
};
const notifyUser = async (
  requestData: any,
  action: "approved" | "rejected"
) => {
  if (!requestData?.requestedByUid) return;

  const userSnap = await db
    .collection("users")
    .doc(requestData.requestedByUid)
    .get();

  const user = userSnap.data() || {};
  const chatId = String(user.telegramChatId || "").trim();

  if (!chatId) {
    console.log("User chưa có telegramChatId:", requestData.requestedByUid);
    return;
  }

  const requestType = String(requestData.type || "").trim();
  const vehicleName = String(requestData.vehicleName || "").trim();
  const plate = String(requestData.plate || "").trim();

  let typeText = "yêu cầu";

  if (requestType === "borrow") {
    typeText = "mượn xe";
  } else if (requestType === "return") {
    typeText = "trả xe";
  } else if (requestType === "refuel") {
    typeText = "đổ xăng";
  }

  const msg =
    action === "approved" ?
      `✅ Yêu cầu ${typeText} của bạn đã được DUYỆT
      \nXe: ${vehicleName}\nBiển số: ${plate}` :
      `❌ Yêu cầu ${typeText} của bạn đã bị TỪ CHỐI
      \nXe: ${vehicleName}\nBiển số: ${plate}`;

  await sendTelegramMessage(chatId, msg);
};
export const telegramWebhook = onRequest(
  {
    region: "asia-southeast1",
    secrets: [TELEGRAM_BOT_TOKEN, TELEGRAM_ADMIN_CHAT_ID],
  },
  async (req: any, res: any) => {
    try {
      const body = req.body;

      if (body.callback_query) {
        const callback = body.callback_query;
        const data = String(callback.data || "");
        const chatId = String(callback.message?.chat?.id || "");

        if (chatId !== TELEGRAM_ADMIN_CHAT_ID.value()) {
          return res.sendStatus(403);
        }

        const [type, action, ...rest] = data.split("_");
        const requestId = rest.join("_");

        console.log("callback data:", data);
        console.log("type:", type);
        console.log("action:", action);
        console.log("requestId:", requestId);

        if (!type || !action || !requestId) {
          await sendTelegramMessage(chatId, "⚠️ Dữ liệu callback không hợp lệ");
          return res.sendStatus(200);
        }

        try {
          let requestData: any;
          let successMessage = "";

          if (action === "approve") {
            if (type === "borrow") {
              requestData = await approveBorrowCore(requestId);
              successMessage = "✅ Đã duyệt yêu cầu mượn xe";
            } else if (type === "return") {
              requestData = await approveReturnCore(requestId);
              successMessage = "✅ Đã duyệt yêu cầu trả xe";
            } else if (type === "refuel") {
              requestData = await approveRefuelCore(requestId);
              successMessage = "✅ Đã duyệt yêu cầu đổ xăng";
            } else {
              await sendTelegramMessage(chatId, "⚠️ Loại yêu cầu không hợp lệ");
              return res.sendStatus(200);
            }

            await notifyUser(requestData, "approved");
            await sendTelegramMessage(chatId, successMessage);
          } else if (action === "reject") {
            if (type === "borrow") {
              requestData = await rejectBorrowCore(requestId);
              successMessage = "❌ Đã từ chối yêu cầu mượn xe";
            } else if (type === "return") {
              requestData = await rejectReturnCore(requestId);
              successMessage = "❌ Đã từ chối yêu cầu trả xe";
            } else if (type === "refuel") {
              requestData = await rejectRefuelCore(requestId);
              successMessage = "❌ Đã từ chối yêu cầu đổ xăng";
            } else {
              await sendTelegramMessage(chatId, "⚠️ Loại yêu cầu không hợp lệ");
              return res.sendStatus(200);
            }

            await notifyUser(requestData, "rejected");
            await sendTelegramMessage(chatId, successMessage);
          } else {
            await sendTelegramMessage(chatId, "⚠️ Action không hợp lệ");
          }

          await fetch(
            `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN.value()}/answerCallbackQuery`,
            {
              method: "POST",
              headers: {"Content-Type": "application/json"},
              body: JSON.stringify({
                callback_query_id: callback.id,
              }),
            }
          );

          await fetch(
            `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN.value()}/editMessageReplyMarkup`,
            {
              method: "POST",
              headers: {"Content-Type": "application/json"},
              body: JSON.stringify({
                chat_id: chatId,
                message_id: callback.message.message_id,
                reply_markup: {inline_keyboard: []},
              }),
            }
          );
        } catch (err: any) {
          await sendTelegramMessage(chatId, `⚠️ ${err.message}`);
        }
      }

      return res.sendStatus(200);
    } catch (err: any) {
      console.error(err);
      return res.sendStatus(500);
    }
  }
);
export const submitBorrowRequest = onCall(
  {
    region: "asia-southeast1",
    secrets: [TELEGRAM_BOT_TOKEN, TELEGRAM_ADMIN_CHAT_ID],
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Bạn cần đăng nhập.");
    }

    const vehicleId = String(request.data?.vehicleId || "").trim();
    const reason = String(request.data?.reason || "").trim();

    if (!vehicleId) {
      throw new HttpsError("invalid-argument", "Thiếu vehicleId.");
    }

    if (!reason) {
      throw new HttpsError("invalid-argument",
        "Vui lòng nhập mục đích mượn xe.");
    }

    const uid = request.auth.uid;

    const userSnap = await db.collection("users").doc(uid).get();
    const userData = userSnap.data() || {};
    const requestedByName =
      userData.fullName ?? request.auth.token.name ?? "Không rõ";

    const vehicleRef = db.collection("vehicles").doc(vehicleId);
    const vehicleSnap = await vehicleRef.get();

    if (!vehicleSnap.exists) {
      throw new HttpsError("not-found", "Không tìm thấy xe.");
    }

    const vehicleData = vehicleSnap.data() || {};

    if (vehicleData.status !== "available") {
      throw new HttpsError(
        "failed-precondition",
        "Xe hiện không sẵn sàng để gửi yêu cầu mượn.",
      );
    }

    const pendingQuery = await db
      .collection("borrow_requests")
      .where("vehicleId", "==", vehicleId)
      .where("status", "==", "pending")
      .limit(1)
      .get();

    if (!pendingQuery.empty) {
      throw new HttpsError(
        "already-exists",
        "Xe này đã có yêu cầu mượn đang chờ duyệt.",
      );
    }

    const requestRef = db.collection("borrow_requests").doc();

    await requestRef.set({
      vehicleId,
      vehicleName: vehicleData.name || "",
      plate: vehicleData.plate || "",
      status: "pending",

      requestedByUid: uid,
      requestedByName,
      reason,
      type: "borrow",

      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    // 🚀 Gửi Telegram cho admin
    await sendTelegramMessage(
      TELEGRAM_ADMIN_CHAT_ID.value(),
      `🚗 <b>YÊU CẦU MƯỢN XE</b>\n
    🚘 <b>Xe:</b> ${vehicleData.name || ""}
    🔖 <b>Biển số:</b> ${vehicleData.plate || ""}
    👤 <b>Người mượn:</b> ${requestedByName}
    📝 <b>Lý do:</b> ${reason}
    ⛽ <b>Mức xăng hiện tại:</b> ${vehicleData.fuelLevel || "Không rõ"}
    🛣️ <b>Km hiện tại:</b> ${vehicleData.currentKm ?? "Không rõ"}
    `,
      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "✅ Duyệt",
                callback_data: `borrow_approve_${requestRef.id}`,
              },
              {
                text: "❌ Từ chối",
                callback_data: `borrow_reject_${requestRef.id}`,
              },
            ],
          ],
        },
      }
    );

    return {
      success: true,
      message: "Đã gửi yêu cầu mượn xe. Vui lòng chờ admin xác nhận.",
      requestId: requestRef.id,
    };
  },
);
export const approveBorrowRequest = onCall(
  {
    region: "asia-southeast1",
    secrets: [TELEGRAM_BOT_TOKEN, TELEGRAM_ADMIN_CHAT_ID]},
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Bạn cần đăng nhập.");
    }

    const uid = request.auth.uid;

    const userSnap = await db.collection("users").doc(uid).get();
    const userData = userSnap.data() || {};

    if (userData.role !== "admin") {
      throw new HttpsError(
        "permission-denied",
        "Bạn không có quyền duyệt yêu cầu."
      );
    }

    const requestId = String(request.data?.requestId || "").trim();
    if (!requestId) {
      throw new HttpsError("invalid-argument", "Thiếu requestId.");
    }

    try {
      const requestData = await approveBorrowCore(requestId);

      await notifyUser(requestData, "approved");

      return {
        success: true,
        message: "Duyệt yêu cầu mượn xe thành công.",
      };
    } catch (err: any) {
      throw new HttpsError("failed-precondition", err.message);
    }
  }
);
export const rejectBorrowRequest = onCall(
  {
    region: "asia-southeast1",
    secrets: [TELEGRAM_BOT_TOKEN, TELEGRAM_ADMIN_CHAT_ID]},
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Bạn cần đăng nhập.");
    }

    const uid = request.auth.uid;

    const userSnap = await db.collection("users").doc(uid).get();
    const userData = userSnap.data() || {};

    if (userData.role !== "admin") {
      throw new HttpsError(
        "permission-denied",
        "Bạn không có quyền từ chối yêu cầu."
      );
    }

    const requestId = String(request.data?.requestId || "").trim();
    if (!requestId) {
      throw new HttpsError("invalid-argument", "Thiếu requestId.");
    }

    try {
      const requestData = await rejectBorrowCore(requestId);

      await notifyUser(requestData, "rejected");

      return {
        success: true,
        message: "Từ chối yêu cầu mượn xe thành công.",
      };
    } catch (err: any) {
      throw new HttpsError("failed-precondition", err.message);
    }
  }
);

export const submitReturnRequest = onCall(
  {
    region: "asia-southeast1",
    secrets: [TELEGRAM_BOT_TOKEN, TELEGRAM_ADMIN_CHAT_ID],
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Bạn cần đăng nhập.");
    }

    const uid = request.auth.uid;
    const data = (request.data || {}) as CreateReturnRequestData;

    const vehicleId = String(data.vehicleId || "").trim();
    const currentKm = Number(data.currentKm);
    const fuelLevel = String(data.fuelLevel || "").trim() as FuelLevel;
    const cleanStatus = String(data.cleanStatus || "").trim() as CleanStatus;
    const note = String(data.note || "").trim();

    if (!vehicleId) {
      throw new HttpsError("invalid-argument", "Thiếu vehicleId.");
    }

    if (!Number.isFinite(currentKm) || currentKm < 0) {
      throw new HttpsError("invalid-argument", "currentKm không hợp lệ.");
    }

    const validFuelLevels: FuelLevel[] = [
      "empty",
      "quarter",
      "half",
      "three_quarters",
      "full",
    ];

    if (!validFuelLevels.includes(fuelLevel)) {
      throw new HttpsError("invalid-argument", "fuelLevel không hợp lệ.");
    }

    const validCleanStatuses: CleanStatus[] = ["clean", "normal", "dirty"];
    if (!validCleanStatuses.includes(cleanStatus)) {
      throw new HttpsError("invalid-argument", "cleanStatus không hợp lệ.");
    }

    const vehicleRef = db.collection("vehicles").doc(vehicleId);
    const userRef = db.collection("users").doc(uid);
    const returnReqRef = db.collection("return_requests").doc();

    const result = await db.runTransaction(async (tx) => {
      const [vehicleSnap, userSnap] = await Promise.all([
        tx.get(vehicleRef),
        tx.get(userRef),
      ]);

      if (!vehicleSnap.exists) {
        throw new HttpsError("not-found", "Không tìm thấy xe.");
      }

      const vehicleData = vehicleSnap.data() || {};
      const userData = userSnap.data() || {};

      const vehicleName = String(vehicleData.name || "").trim();
      const plate = String(vehicleData.plate || "").trim();
      const vehicleStatus = String(vehicleData.status || "").trim();
      const oldKm = Number(vehicleData.currentKm || 0);
      const borrowedByUid = String(vehicleData.borrowedByUid || "").trim();

      if (vehicleStatus !== "borrowed") {
        throw new HttpsError(
          "failed-precondition",
          "Xe hiện không ở trạng thái đang mượn."
        );
      }

      if (borrowedByUid && borrowedByUid !== uid) {
        throw new HttpsError(
          "permission-denied",
          "Bạn không phải người đang mượn xe này."
        );
      }

      if (currentKm < oldKm) {
        throw new HttpsError(
          "invalid-argument",
          `Số km hiện tại không được nhỏ hơn ${oldKm}.`
        );
      }

      const kmIncrease = currentKm - oldKm;

      const pendingQuery = db
        .collection("return_requests")
        .where("vehicleId", "==", vehicleId)
        .where("status", "==", "pending")
        .limit(1);

      const pendingSnap = await tx.get(pendingQuery);

      if (!pendingSnap.empty) {
        throw new HttpsError(
          "already-exists",
          "Xe này đã có yêu cầu trả đang chờ xử lý."
        );
      }

      const requestedByName = String(
        userData.fullName || request.auth?.token?.name || "Không rõ"
      ).trim();

      const payload = {
        plate,
        vehicleId,
        vehicleName,

        type: "return" as RequestType,
        requestedByName,
        requestedByUid: uid,
        status: "pending" as RequestStatus,

        cleanStatus,
        currentKm,
        fuelLevel,
        kmIncrease,
        note,

        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      };

      tx.set(returnReqRef, payload);

      return {
        id: returnReqRef.id,
        ...payload,
      };
    });

    const adminChatId = TELEGRAM_ADMIN_CHAT_ID.value();

    const returnMessage =
      "↩️ <b>YÊU CẦU TRẢ XE</b>\n" +
      "━━━━━━━━━━━━━━━\n" +
      `🚘 <b>Xe:</b> ${result.vehicleName || ""}\n` +
      `🔖 <b>Biển số:</b> ${result.plate || ""}\n` +
      `👤 <b>Người trả:</b> ${result.requestedByName || ""}\n` +
      "━━━━━━━━━━━━━━━\n" +
      `🛣️ <b>Km hiện tại:</b> ${result.currentKm ?? "Không rõ"}\n` +
      `📈 <b>Km tăng thêm:</b> ${result.kmIncrease ?? 0} km\n` +
      `⛽ <b>Mức xăng:</b> ${result.fuelLevel || "Không rõ"}\n` +
      `🧼 <b>Tình trạng xe:</b> ${result.cleanStatus || "Không rõ"}\n` +
      `${result.note ? `📝 <b>Ghi chú:</b> ${result.note}\n` : ""}`;

    try {
      await sendTelegramMessage(
        adminChatId,
        returnMessage,
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "✅ Duyệt",
                  callback_data: `return_approve_${result.id}`,
                },
                {
                  text: "❌ Từ chối",
                  callback_data: `return_reject_${result.id}`,
                },
              ],
            ],
          },
        }
      );
    } catch (e) {
      console.error("Send Telegram return request to admin failed:", e);
    }

    return {
      message: "Gửi yêu cầu trả xe thành công.",
      request: result,
    };
  }
);
export const approveReturnRequest = onCall(
  {
    region: "asia-southeast1",
    secrets: [TELEGRAM_BOT_TOKEN, TELEGRAM_ADMIN_CHAT_ID],
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Bạn cần đăng nhập.");
    }

    const uid = request.auth.uid;

    const userSnap = await db.collection("users").doc(uid).get();
    const userData = userSnap.data() || {};

    if (userData.role !== "admin") {
      throw new HttpsError(
        "permission-denied",
        "Bạn không có quyền duyệt yêu cầu."
      );
    }

    const requestId = String(request.data?.requestId || "").trim();
    if (!requestId) {
      throw new HttpsError("invalid-argument", "Thiếu requestId.");
    }

    try {
      const requestData = await approveReturnCore(requestId);

      await notifyUser(requestData, "approved");

      return {
        success: true,
        message: "Duyệt yêu cầu trả xe thành công.",
      };
    } catch (err: any) {
      throw new HttpsError("failed-precondition", err.message);
    }
  }
);
export const rejectReturnRequest = onCall(
  {
    region: "asia-southeast1",
    secrets: [TELEGRAM_BOT_TOKEN, TELEGRAM_ADMIN_CHAT_ID],
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Bạn cần đăng nhập.");
    }

    const uid = request.auth.uid;

    const userSnap = await db.collection("users").doc(uid).get();
    const userData = userSnap.data() || {};

    if (userData.role !== "admin") {
      throw new HttpsError(
        "permission-denied",
        "Bạn không có quyền từ chối yêu cầu."
      );
    }

    const requestId = String(request.data?.requestId || "").trim();
    if (!requestId) {
      throw new HttpsError("invalid-argument", "Thiếu requestId.");
    }

    try {
      const requestData = await rejectReturnCore(requestId);

      await notifyUser(requestData, "rejected");

      return {
        success: true,
        message: "Từ chối yêu cầu trả xe thành công.",
      };
    } catch (err: any) {
      throw new HttpsError("failed-precondition", err.message);
    }
  }
);

export const submitRefuelRequest = onCall(
  {
    region: "asia-southeast1",
    secrets: [TELEGRAM_BOT_TOKEN, TELEGRAM_ADMIN_CHAT_ID],
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Bạn cần đăng nhập.");
    }

    const uid = request.auth.uid;
    const data = (request.data || {}) as CreateRefuelRequestData;

    const vehicleId = String(data.vehicleId || "").trim();
    const fuelLevel = String(data.fuelLevel || "").trim() as FuelLevel;
    const liters = Number(data.liters);
    const note = String(data.note || "").trim();

    if (!vehicleId) {
      throw new HttpsError("invalid-argument", "Thiếu vehicleId.");
    }

    const validFuelLevels: FuelLevel[] = [
      "empty",
      "quarter",
      "half",
      "three_quarters",
      "full",
    ];

    if (!validFuelLevels.includes(fuelLevel)) {
      throw new HttpsError("invalid-argument", "fuelLevel không hợp lệ.");
    }

    if (!Number.isFinite(liters) || liters <= 0) {
      throw new HttpsError("invalid-argument", "Số lít đổ xăng không hợp lệ.");
    }

    const fuelLevelOrder: Record<FuelLevel, number> = {
      empty: 0,
      quarter: 1,
      half: 2,
      three_quarters: 3,
      full: 4,
    };

    const vehicleRef = db.collection("vehicles").doc(vehicleId);
    const userRef = db.collection("users").doc(uid);
    const refuelReqRef = db.collection("refuel_requests").doc();

    const result = await db.runTransaction(async (tx) => {
      const [vehicleSnap, userSnap] = await Promise.all([
        tx.get(vehicleRef),
        tx.get(userRef),
      ]);

      if (!vehicleSnap.exists) {
        throw new HttpsError("not-found", "Không tìm thấy xe.");
      }

      const vehicleData = vehicleSnap.data() || {};
      const userData = userSnap.data() || {};

      const vehicleName = String(vehicleData.name || "").trim();
      const plate = String(vehicleData.plate || "").trim();
      const previousFuelLevel = String(
        vehicleData.fuelLevel || "empty"
      ).trim() as FuelLevel;

      if (!validFuelLevels.includes(previousFuelLevel)) {
        throw new HttpsError(
          "failed-precondition",
          "Mức xăng hiện tại của xe không hợp lệ."
        );
      }

      if (previousFuelLevel === "full") {
        throw new HttpsError(
          "failed-precondition",
          "Xe đã đầy xăng, không cần gửi yêu cầu đổ xăng."
        );
      }

      if (fuelLevelOrder[fuelLevel] <= fuelLevelOrder[previousFuelLevel]) {
        throw new HttpsError(
          "invalid-argument",
          "Mức xăng sau khi đổ phải lớn hơn mức xăng hiện tại."
        );
      }

      const pendingQuery = db
        .collection("refuel_requests")
        .where("vehicleId", "==", vehicleId)
        .where("status", "==", "pending")
        .limit(1);

      const pendingSnap = await tx.get(pendingQuery);

      if (!pendingSnap.empty) {
        throw new HttpsError(
          "already-exists",
          "Xe này đã có yêu cầu đổ xăng đang chờ xử lý."
        );
      }

      const requestedByName = String(
        userData.fullName || request.auth?.token?.name || "Không rõ"
      ).trim();

      const payload = {
        plate,
        vehicleId,
        vehicleName,

        type: "refuel" as const,
        requestedByName,
        requestedByUid: uid,
        status: "pending" as RequestStatus,

        previousFuelLevel,
        fuelLevel,
        liters,
        note,

        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      };

      tx.set(refuelReqRef, payload);

      return {
        id: refuelReqRef.id,
        ...payload,
      };
    });

    const adminChatId = TELEGRAM_ADMIN_CHAT_ID.value();

    const refuelMessage =
      "⛽ <b>YÊU CẦU ĐỔ XĂNG</b>\n" +
      "━━━━━━━━━━━━━━━\n" +
      `🚘 <b>Xe:</b> ${result.vehicleName || ""}\n` +
      `🔖 <b>Biển số:</b> ${result.plate || ""}\n` +
      `👤 <b>Người gửi:</b> ${result.requestedByName || ""}\n` +
      "━━━━━━━━━━━━━━━\n" +
      `📉 <b>Mức xăng cũ:</b> ${result.previousFuelLevel || "Không rõ"}\n` +
      `📈 <b>Mức xăng mới:</b> ${result.fuelLevel || "Không rõ"}\n` +
      `⛽ <b>Số lít:</b> ${result.liters ?? "Không rõ"}\n` +
      `${result.note ? `📝 <b>Ghi chú:</b> ${result.note}\n` : ""}`;

    try {
      await sendTelegramMessage(
        adminChatId,
        refuelMessage,
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "✅ Duyệt",
                  callback_data: `refuel_approve_${result.id}`,
                },
                {
                  text: "❌ Từ chối",
                  callback_data: `refuel_reject_${result.id}`,
                },
              ],
            ],
          },
        }
      );
    } catch (e) {
      console.error("Send Telegram refuel request to admin failed:", e);
    }

    return {
      success: true,
      message: "Gửi yêu cầu đổ xăng thành công.",
      request: result,
    };
  }
);
export const approveRefuelRequest = onCall(
  {
    region: "asia-southeast1",
    secrets: [TELEGRAM_BOT_TOKEN, TELEGRAM_ADMIN_CHAT_ID],
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Bạn cần đăng nhập.");
    }

    const uid = request.auth.uid;
    const requestId = String(request.data?.requestId || "").trim();

    if (!requestId) {
      throw new HttpsError("invalid-argument", "Thiếu requestId.");
    }

    const userSnap = await db.collection("users").doc(uid).get();
    const userData = userSnap.data() || {};

    if (String(userData.role || "").trim() !== "admin") {
      throw new HttpsError(
        "permission-denied",
        "Bạn không có quyền duyệt yêu cầu."
      );
    }

    try {
      const requestData = await approveRefuelCore(requestId);

      try {
        await notifyUser(requestData, "approved");
      } catch (e) {
        console.error("Notify user approve refuel failed:", e);
      }

      return {
        success: true,
        message: "Duyệt yêu cầu đổ xăng thành công.",
      };
    } catch (err: any) {
      throw new HttpsError("failed-precondition", err.message);
    }
  }
);
export const rejectRefuelRequest = onCall(
  {
    region: "asia-southeast1",
    secrets: [TELEGRAM_BOT_TOKEN, TELEGRAM_ADMIN_CHAT_ID],
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Bạn cần đăng nhập.");
    }

    const uid = request.auth.uid;
    const requestId = String(request.data?.requestId || "").trim();

    if (!requestId) {
      throw new HttpsError("invalid-argument", "Thiếu requestId.");
    }

    const userSnap = await db.collection("users").doc(uid).get();
    const userData = userSnap.data() || {};

    if (String(userData.role || "").trim() !== "admin") {
      throw new HttpsError(
        "permission-denied",
        "Bạn không có quyền từ chối yêu cầu."
      );
    }

    try {
      const requestData = await rejectRefuelCore(requestId);

      try {
        await notifyUser(requestData, "rejected");
      } catch (e) {
        console.error("Notify user reject refuel failed:", e);
      }

      return {
        success: true,
        message: "Từ chối yêu cầu đổ xăng thành công.",
      };
    } catch (err: any) {
      throw new HttpsError("failed-precondition", err.message);
    }
  }
);
