import {initializeApp} from "firebase-admin/app";
import {FieldValue, getFirestore} from "firebase-admin/firestore";
import {HttpsError, onCall} from "firebase-functions/v2/https";

initializeApp();

const db = getFirestore();

export const submitBorrowRequest = onCall(
  {region: "asia-southeast1"},
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Bạn cần đăng nhập.");
    }

    const vehicleId = String(request.data?.vehicleId || "").trim();
    if (!vehicleId) {
      throw new HttpsError("invalid-argument", "Thiếu vehicleId.");
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

      createdAt: FieldValue.serverTimestamp(),
    });

    return {
      success: true,
      message: "Đã gửi yêu cầu mượn xe. Vui lòng chờ admin xác nhận.",
      requestId: requestRef.id,
    };
  },
);
export const approveBorrowRequest = onCall(
  {region: "asia-southeast1"},
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Bạn cần đăng nhập.");
    }

    const requestId = String(request.data?.requestId || "").trim();
    if (!requestId) {
      throw new HttpsError("invalid-argument", "Thiếu requestId.");
    }

    const requestRef = db.collection("borrow_requests").doc(requestId);
    const requestSnap = await requestRef.get();

    if (!requestSnap.exists) {
      throw new HttpsError("not-found", "Không tìm thấy yêu cầu.");
    }

    const requestData = requestSnap.data() || {};

    if (requestData.type !== "borrow") {
      throw new HttpsError("failed-precondition",
        "Không phải yêu cầu mượn xe.");
    }

    if (requestData.status !== "pending") {
      throw new HttpsError(
        "failed-precondition",
        "Yêu cầu đã được xử lý trước đó.",
      );
    }

    const vehicleId = requestData.vehicleId;
    if (!vehicleId) {
      throw new HttpsError("failed-precondition",
        "Yêu cầu không có vehicleId.");
    }

    const vehicleRef = db.collection("vehicles").doc(vehicleId);
    const vehicleSnap = await vehicleRef.get();

    if (!vehicleSnap.exists) {
      throw new HttpsError("not-found", "Không tìm thấy xe.");
    }

    const vehicleData = vehicleSnap.data() || {};

    if (vehicleData.status !== "available") {
      throw new HttpsError(
        "failed-precondition",
        "Xe hiện không sẵn sàng để duyệt.",
      );
    }

    // 👉 dùng transaction để tránh race condition
    await db.runTransaction(async (tx) => {
      const vSnap = await tx.get(vehicleRef);
      const rSnap = await tx.get(requestRef);

      const vData = vSnap.data() || {};
      const rData = rSnap.data() || {};

      if (vData.status !== "available") {
        throw new HttpsError("failed-precondition",
          "Xe đã bị thay đổi trạng thái.");
      }

      if (rData.status !== "pending") {
        throw new HttpsError("failed-precondition",
          "Yêu cầu không còn pending.");
      }

      const now = FieldValue.serverTimestamp();

      // update vehicle
      tx.update(vehicleRef, {
        borrowedById: rData.requestedByUid || "",
        borrowedByName: rData.requestedByName || "",
        borrowedReason: rData.reason || "",
        status: "borrowed",
        updatedAt: now,
      });

      // update request
      tx.update(requestRef, {
        status: "approved",
        updatedAt: now,
      });
    });

    return {
      success: true,
      message: "Duyệt yêu cầu mượn xe thành công.",
    };
  },
);
