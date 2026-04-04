import {initializeApp} from "firebase-admin/app";
import {FieldValue, getFirestore} from "firebase-admin/firestore";
import {HttpsError, onCall} from "firebase-functions/v2/https";

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

export const approveBorrowRequest = onCall(
  {region: "asia-southeast1"},
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Bạn cần đăng nhập.");
    }

    const uid = request.auth.uid;

    // ✅ check role từ Firestore
    const userSnap = await db.collection("users").doc(uid).get();
    const userData = userSnap.data() || {};

    if (userData.role !== "admin") {
      throw new HttpsError(
        "permission-denied",
        "Bạn không có quyền duyệt yêu cầu.",
      );
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
export const rejectBorrowRequest = onCall(
  {region: "asia-southeast1"},
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
        "Bạn không có quyền từ chối yêu cầu.",
      );
    }

    const requestId = String(request.data?.requestId || "").trim();
    if (!requestId) {
      throw new HttpsError("invalid-argument", "Thiếu requestId.");
    }

    const requestRef = db.collection("borrow_requests").doc(requestId);

    await db.runTransaction(async (tx) => {
      const requestSnap = await tx.get(requestRef);

      if (!requestSnap.exists) {
        throw new HttpsError("not-found", "Không tìm thấy yêu cầu.");
      }

      const requestData = requestSnap.data() || {};

      if (requestData.type !== "borrow") {
        throw new HttpsError(
          "failed-precondition",
          "Không phải yêu cầu mượn xe.",
        );
      }

      if (requestData.status !== "pending") {
        throw new HttpsError(
          "failed-precondition",
          "Yêu cầu đã được xử lý trước đó.",
        );
      }

      const now = FieldValue.serverTimestamp();

      // update request
      tx.update(requestRef, {
        status: "rejected",
        updatedAt: now,
      });
    });

    return {
      success: true,
      message: "Từ chối yêu cầu mượn xe thành công.",
    };
  },
);
export const submitReturnRequest = onCall(
  {region: "asia-southeast1"},
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

    return {
      message: "Gửi yêu cầu trả xe thành công.",
      request: result,
    };
  }
);
export const approveReturnRequest = onCall(
  {region: "asia-southeast1"},
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Bạn cần đăng nhập.");
    }

    const uid = request.auth.uid;

    // check role từ Firestore
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

    const requestRef = db.collection("return_requests").doc(requestId);
    const requestSnap = await requestRef.get();

    if (!requestSnap.exists) {
      throw new HttpsError("not-found", "Không tìm thấy yêu cầu.");
    }

    const requestData = requestSnap.data() || {};

    if (requestData.type !== "return") {
      throw new HttpsError(
        "failed-precondition",
        "Không phải yêu cầu trả xe."
      );
    }

    if (requestData.status !== "pending") {
      throw new HttpsError(
        "failed-precondition",
        "Yêu cầu đã được xử lý trước đó."
      );
    }

    const vehicleId = String(requestData.vehicleId || "").trim();
    if (!vehicleId) {
      throw new HttpsError(
        "failed-precondition",
        "Yêu cầu không có vehicleId."
      );
    }

    const vehicleRef = db.collection("vehicles").doc(vehicleId);
    const vehicleSnap = await vehicleRef.get();

    if (!vehicleSnap.exists) {
      throw new HttpsError("not-found", "Không tìm thấy xe.");
    }

    const vehicleData = vehicleSnap.data() || {};

    if (vehicleData.status !== "borrowed") {
      throw new HttpsError(
        "failed-precondition",
        "Xe hiện không ở trạng thái đang mượn."
      );
    }

    await db.runTransaction(async (tx) => {
      const [vSnap, rSnap] = await Promise.all([
        tx.get(vehicleRef),
        tx.get(requestRef),
      ]);

      if (!vSnap.exists) {
        throw new HttpsError("not-found", "Không tìm thấy xe.");
      }

      if (!rSnap.exists) {
        throw new HttpsError("not-found", "Không tìm thấy yêu cầu.");
      }

      const vData = vSnap.data() || {};
      const rData = rSnap.data() || {};

      if (rData.type !== "return") {
        throw new HttpsError(
          "failed-precondition",
          "Không phải yêu cầu trả xe."
        );
      }

      if (rData.status !== "pending") {
        throw new HttpsError(
          "failed-precondition",
          "Yêu cầu không còn pending."
        );
      }

      if (vData.status !== "borrowed") {
        throw new HttpsError(
          "failed-precondition",
          "Xe đã bị thay đổi trạng thái."
        );
      }

      const currentKm = Number(rData.currentKm);
      const fuelLevel = String(rData.fuelLevel || "").trim();
      const cleanStatus = String(rData.cleanStatus || "").trim();

      if (!Number.isFinite(currentKm) || currentKm < 0) {
        throw new HttpsError(
          "failed-precondition",
          "Dữ liệu currentKm trong yêu cầu không hợp lệ."
        );
      }

      const validFuelLevels = [
        "empty",
        "quarter",
        "half",
        "three_quarters",
        "full",
      ];
      if (!validFuelLevels.includes(fuelLevel)) {
        throw new HttpsError(
          "failed-precondition",
          "Dữ liệu fuelLevel trong yêu cầu không hợp lệ."
        );
      }

      const validCleanStatus = ["clean", "normal", "dirty"];
      if (!validCleanStatus.includes(cleanStatus)) {
        throw new HttpsError(
          "failed-precondition",
          "Dữ liệu cleanStatus trong yêu cầu không hợp lệ."
        );
      }

      const oldKm = Number(vData.currentKm || 0);
      if (currentKm < oldKm) {
        throw new HttpsError(
          "failed-precondition",
          "Số km trả xe nhỏ hơn số km hiện tại của xe."
        );
      }

      const now = FieldValue.serverTimestamp();

      // update vehicle
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

      // update request
      tx.update(requestRef, {
        status: "approved",
        updatedAt: now,
      });
    });

    return {
      success: true,
      message: "Duyệt yêu cầu trả xe thành công.",
    };
  }
);
export const rejectReturnRequest = onCall(
  {region: "asia-southeast1"},
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Bạn cần đăng nhập.");
    }

    const uid = request.auth.uid;

    // check role từ Firestore
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

    const requestRef = db.collection("return_requests").doc(requestId);
    const requestSnap = await requestRef.get();

    if (!requestSnap.exists) {
      throw new HttpsError("not-found", "Không tìm thấy yêu cầu.");
    }

    const requestData = requestSnap.data() || {};

    if (requestData.type !== "return") {
      throw new HttpsError(
        "failed-precondition",
        "Không phải yêu cầu trả xe."
      );
    }

    if (requestData.status !== "pending") {
      throw new HttpsError(
        "failed-precondition",
        "Yêu cầu đã được xử lý trước đó."
      );
    }

    await db.runTransaction(async (tx) => {
      const rSnap = await tx.get(requestRef);

      if (!rSnap.exists) {
        throw new HttpsError("not-found", "Không tìm thấy yêu cầu.");
      }

      const rData = rSnap.data() || {};

      if (rData.type !== "return") {
        throw new HttpsError(
          "failed-precondition",
          "Không phải yêu cầu trả xe."
        );
      }

      if (rData.status !== "pending") {
        throw new HttpsError(
          "failed-precondition",
          "Yêu cầu không còn pending."
        );
      }

      const now = FieldValue.serverTimestamp();

      tx.update(requestRef, {
        status: "rejected",
        updatedAt: now,
      });
    });

    return {
      success: true,
      message: "Từ chối yêu cầu trả xe thành công.",
    };
  }
);
export const submitBorrowRequest = onCall(
  {region: "asia-southeast1"},
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

    return {
      success: true,
      message: "Đã gửi yêu cầu mượn xe. Vui lòng chờ admin xác nhận.",
      requestId: requestRef.id,
    };
  },
);
export const submitRefuelRequest = onCall(
  {region: "asia-southeast1"},
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

    return {
      success: true,
      message: "Gửi yêu cầu đổ xăng thành công.",
      request: result,
    };
  }
);
export const approveRefuelRequest = onCall(
  {region: "asia-southeast1"},
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Bạn cần đăng nhập.");
    }

    const uid = request.auth.uid;
    const requestId = String(request.data?.requestId || "").trim();

    if (!requestId) {
      throw new HttpsError("invalid-argument", "Thiếu requestId.");
    }

    const userRef = db.collection("users").doc(uid);
    const refuelReqRef = db.collection("refuel_requests").doc(requestId);

    const result = await db.runTransaction(async (tx) => {
      const [userSnap, reqSnap] = await Promise.all([
        tx.get(userRef),
        tx.get(refuelReqRef),
      ]);

      if (!userSnap.exists) {
        throw new HttpsError("permission-denied",
          "Không tìm thấy thông tin người dùng.");
      }

      const userData = userSnap.data() || {};
      if (String(userData.role || "").trim() !== "admin") {
        throw new HttpsError("permission-denied",
          "Bạn không có quyền duyệt yêu cầu.");
      }

      if (!reqSnap.exists) {
        throw new HttpsError("not-found",
          "Không tìm thấy yêu cầu đổ xăng.");
      }

      const reqData = reqSnap.data() || {};
      const status = String(reqData.status || "").trim();
      const vehicleId = String(reqData.vehicleId || "").trim();
      const fuelLevel = String(reqData.fuelLevel || "").trim() as FuelLevel;

      if (status !== "pending") {
        throw new HttpsError(
          "failed-precondition",
          "Yêu cầu đổ xăng này không còn ở trạng thái chờ duyệt."
        );
      }

      if (!vehicleId) {
        throw new HttpsError("failed-precondition",
          "Yêu cầu không có vehicleId hợp lệ.");
      }

      const validFuelLevels: FuelLevel[] = [
        "empty",
        "quarter",
        "half",
        "three_quarters",
        "full",
      ];

      if (!validFuelLevels.includes(fuelLevel)) {
        throw new HttpsError("failed-precondition",
          "fuelLevel của yêu cầu không hợp lệ.");
      }

      const vehicleRef = db.collection("vehicles").doc(vehicleId);
      const vehicleSnap = await tx.get(vehicleRef);

      if (!vehicleSnap.exists) {
        throw new HttpsError("not-found", "Không tìm thấy xe.");
      }

      const now = FieldValue.serverTimestamp();

      tx.update(refuelReqRef, {
        status: "approved",
        updatedAt: now,
      });

      tx.update(vehicleRef, {
        fuelLevel,
        updatedAt: now,
      });

      return {
        requestId,
        vehicleId,
      };
    });

    return {
      success: true,
      message: "Duyệt yêu cầu đổ xăng thành công.",
      data: result,
    };
  }
);
export const rejectRefuelRequest = onCall(
  {region: "asia-southeast1"},
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Bạn cần đăng nhập.");
    }

    const uid = request.auth.uid;
    const requestId = String(request.data?.requestId || "").trim();

    if (!requestId) {
      throw new HttpsError("invalid-argument", "Thiếu requestId.");
    }

    const userRef = db.collection("users").doc(uid);
    const refuelReqRef = db.collection("refuel_requests").doc(requestId);

    await db.runTransaction(async (tx) => {
      const [userSnap, reqSnap] = await Promise.all([
        tx.get(userRef),
        tx.get(refuelReqRef),
      ]);

      if (!userSnap.exists) {
        throw new HttpsError("permission-denied",
          "Không tìm thấy thông tin người dùng.");
      }

      const userData = userSnap.data() || {};
      if (String(userData.role || "").trim() !== "admin") {
        throw new HttpsError("permission-denied",
          "Bạn không có quyền từ chối yêu cầu.");
      }

      if (!reqSnap.exists) {
        throw new HttpsError("not-found",
          "Không tìm thấy yêu cầu đổ xăng.");
      }

      const reqData = reqSnap.data() || {};
      const status = String(reqData.status || "").trim();

      if (status !== "pending") {
        throw new HttpsError(
          "failed-precondition",
          "Yêu cầu đổ xăng này không còn ở trạng thái chờ xử lý."
        );
      }

      tx.update(refuelReqRef, {
        status: "rejected",
        updatedAt: FieldValue.serverTimestamp(),
      });
    });

    return {
      success: true,
      message: "Từ chối yêu cầu đổ xăng thành công.",
    };
  }
);
