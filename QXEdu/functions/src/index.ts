import {getFirestore} from "firebase-admin/firestore";
import admin from "firebase-admin";
import {HttpsError, onCall, onRequest} from "firebase-functions/v2/https";
import {Child, Plan, Report} from "./types";
import {defineSecret} from "firebase-functions/params";
import {getAuth} from "firebase-admin/auth";
import {onDocumentWritten} from "firebase-functions/firestore";
import axios from "axios";

admin.initializeApp();
const db = getFirestore();
const auth = getAuth();
const FieldValue = admin.firestore.FieldValue;

const TELEGRAM_BOT_TOKEN = defineSecret("TELEGRAM_BOT_TOKEN");
// const ADMIN_CHAT_ID = defineSecret("ADMIN_CHAT_ID");
// const ADMIN_ID = defineSecret("ADMIN_ID");
type DeleteEntityType = "report" | "plan" | "children";

/**
 * Tạo tài khoản
 */
export const createStaffAccount = onCall(
  {
    region: "asia-southeast1",
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Bạn chưa đăng nhập");
    }

    const adminUid = request.auth.uid;

    const adminSnap = await db.collection("users").doc(adminUid).get();
    const adminData = adminSnap.data();

    if (adminData?.role !== "admin") {
      throw new HttpsError("permission-denied",
        "Bạn không có quyền tạo tài khoản");
    }

    const {
      email,
      password,
      fullName,
      phone = "",
      role = "teacher",
      position = "Chuyên viên Tâm lý",
    } = request.data;

    if (!email || !password || !fullName) {
      throw new HttpsError(
        "invalid-argument",
        "Thiếu email, mật khẩu hoặc họ tên"
      );
    }

    let userRecord;

    try {
      userRecord = await auth.createUser({
        email: String(email).trim(),
        password: String(password),
        displayName: String(fullName).trim(),
      });

      await db.collection("users").doc(userRecord.uid).set({
        id: userRecord.uid,

        avatar: "",
        birth: null,

        createAt: FieldValue.serverTimestamp(),
        updateAt: FieldValue.serverTimestamp(),

        email: String(email).trim(),
        fullName: String(fullName).trim(),
        phone: String(phone).trim(),

        position,
        role,

        shortName: "",
        telegramChatId: "",
      });

      return {
        success: true,
        uid: userRecord.uid,
        message: "Tạo tài khoản thành công",
      };
    } catch (error: any) {
      if (userRecord?.uid) {
        await auth.deleteUser(userRecord.uid);
      }

      if (error.code === "auth/email-already-exists") {
        throw new HttpsError("already-exists", "Email này đã được sử dụng");
      }

      if (error.code === "auth/invalid-email") {
        throw new HttpsError("invalid-argument", "Email không hợp lệ");
      }

      if (error.code === "auth/invalid-password") {
        throw new HttpsError("invalid-argument", "Mật khẩu không hợp lệ");
      }

      throw new HttpsError("internal", "Tạo tài khoản thất bại");
    }
  }
);
/**
 * Tạo mới kế hoạch từ carts
 */
export const createPlanFromCarts = onCall(
  {region: "asia-southeast1"},
  async (request) => {
    const uid = request.auth?.uid;

    if (!uid) {
      throw new HttpsError("unauthenticated", "Bạn chưa đăng nhập.");
    }

    const {title, childId, carts} = request.data;

    if (!title || !childId || !Array.isArray(carts) || carts.length === 0) {
      throw new HttpsError("invalid-argument", "Dữ liệu không hợp lệ.");
    }

    const userSnap = await db.collection("users").doc(uid).get();

    if (!userSnap.exists) {
      throw new HttpsError("permission-denied", "Không tìm thấy người dùng.");
    }

    const childSnap = await db.collection("children").doc(childId).get();

    if (!childSnap.exists) {
      throw new HttpsError("not-found", "Không tìm thấy trẻ.");
    }

    const child = {
      id: childSnap.id,
      ...(childSnap.data() as Omit<Child, "id">),
    } as Child;

    if (!Array.isArray(child.teacherIds) || !child.teacherIds.includes(uid)) {
      throw new HttpsError(
        "permission-denied",
        "Bạn không có quyền tạo kế hoạch cho trẻ này."
      );
    }

    const planRef = db.collection("plans").doc();
    const batch = db.batch();

    batch.set(planRef, {
      type: "KH",
      title,
      childId: child.id,
      teacherIds: child.teacherIds || [],
      authorId: uid,
      status: "pending",
      comment: "",
      updateById: uid,
      createAt: FieldValue.serverTimestamp(),
      updateAt: FieldValue.serverTimestamp(),
    });

    carts.forEach((cart) => {
      if (!cart.targetId) return;

      const planTaskRef = db.collection("planTasks").doc();

      batch.set(planTaskRef, {
        content: cart.content || "",
        intervention: cart.intervention || "",
        teacherIds: child.teacherIds || [],
        authorId: uid,
        planId: planRef.id,
        targetId: cart.targetId,
        childId: child.id,
        createAt: FieldValue.serverTimestamp(),
        updateAt: FieldValue.serverTimestamp(),
      });

      if (cart.id) {
        const cartRef = db.collection("carts").doc(cart.id);
        batch.delete(cartRef);
      }
    });

    batch.update(db.collection("Meta").doc("plans"), {
      lastUpdated: FieldValue.serverTimestamp(),
    });

    batch.update(db.collection("Meta").doc("carts"), {
      lastUpdated: FieldValue.serverTimestamp(),
    });

    await batch.commit();

    return {
      success: true,
      planId: planRef.id,
      message: "Thêm mới kế hoạch thành công.",
    };
  });

/**
 * Cập nhật chi tiết kế hoạch từ carts
 */
export const updatePlanFromCarts = onCall(
  {region: "asia-southeast1"},
  async (request) => {
    const uid = request.auth?.uid;

    if (!uid) {
      throw new HttpsError("unauthenticated", "Bạn chưa đăng nhập.");
    }

    const {planId, childId, carts} = request.data;

    if (!planId || !childId || !Array.isArray(carts)) {
      throw new HttpsError("invalid-argument", "Dữ liệu không hợp lệ.");
    }

    const planRef = db.collection("plans").doc(planId);
    const planSnap = await planRef.get();

    if (!planSnap.exists) {
      throw new HttpsError("not-found", "Không tìm thấy kế hoạch.");
    }

    const plan = {
      id: planSnap.id,
      ...(planSnap.data() as Omit<Plan, "id">),
    } as Plan;

    if (!Array.isArray(plan.teacherIds) || !plan.teacherIds.includes(uid)) {
      throw new HttpsError(
        "permission-denied",
        "Bạn không có quyền cập nhật kế hoạch này."
      );
    }

    if (plan.status !== "pending") {
      throw new HttpsError(
        "failed-precondition",
        "Chỉ được chỉnh sửa kế hoạch đang chờ duyệt."
      );
    }

    const childSnap = await db.collection("children").doc(childId).get();

    if (!childSnap.exists) {
      throw new HttpsError("not-found", "Không tìm thấy trẻ.");
    }

    const child = {
      id: childSnap.id,
      ...(childSnap.data() as Omit<Child, "id">),
    } as Child;

    if (!Array.isArray(child.teacherIds) || !child.teacherIds.includes(uid)) {
      throw new HttpsError(
        "permission-denied",
        "Bạn không có quyền với trẻ này."
      );
    }

    // const oldTasksSnap = await db
    //   .collection("planTasks")
    //   .where("planId", "==", planId)
    //   .where("teacherIds", "array-contains", uid)
    //   .get();

    const [oldTasksSnap, cartsSnap] = await Promise.all([
      db
        .collection("planTasks")
        .where("planId", "==", planId)
        .where("teacherIds", "array-contains", uid)
        .get(),

      db
        .collection("carts")
        .where("childId", "==", childId)
        .where("authorId", "==", uid)
        .get(),
    ]);

    const batch = db.batch();

    batch.update(planRef, {
      updateById: uid,
      updateAt: FieldValue.serverTimestamp(),
    });

    oldTasksSnap.docs.forEach((doc) => {
      batch.delete(doc.ref);
    });

    carts.forEach((cart) => {
      if (!cart.targetId) return;

      const planTaskRef = db.collection("planTasks").doc();

      batch.set(planTaskRef, {
        childId: child.id,
        planId,
        targetId: cart.targetId,
        teacherIds: child.teacherIds || [],
        authorId: uid,
        content: cart.content || "",
        intervention: cart.intervention || "",
        createAt: FieldValue.serverTimestamp(),
        updateAt: FieldValue.serverTimestamp(),
      });
    });

    // Xóa toàn bộ carts của trẻ do giáo viên này tạo
    cartsSnap.docs.forEach((doc) => {
      batch.delete(doc.ref);
    });

    batch.update(db.collection("Meta").doc("plans"), {
      lastUpdated: FieldValue.serverTimestamp(),
    });

    await batch.commit();

    return {
      success: true,
      planId,
      message: "Chỉnh sửa kế hoạch thành công.",
    };
  });

/**
 * Xóa kế hoạch
 */
export const deletePlan = onCall(
  {region: "asia-southeast1", secrets: [TELEGRAM_BOT_TOKEN]},
  async (request) => {
    const uid = request.auth?.uid;

    if (!uid) {
      throw new HttpsError("unauthenticated", "Chưa đăng nhập");
    }

    const {planId} = request.data;

    if (!planId) {
      throw new HttpsError("invalid-argument", "Thiếu planId");
    }

    const planRef = db.collection("plans").doc(planId);
    const planSnap = await planRef.get();

    if (!planSnap.exists) {
      throw new HttpsError("not-found", "Không tìm thấy kế hoạch");
    }

    const plan = planSnap.data();

    if (!plan?.teacherIds?.includes(uid)) {
      throw new HttpsError("permission-denied", "Không có quyền xoá kế hoạch");
    }

    if (plan.status !== "pending") {
      throw new HttpsError(
        "failed-precondition",
        "Chỉ được xoá kế hoạch đang pending"
      );
    }

    const [
      planTasksSnap,
      reportsSnap,
      reportTasksSnap,
      reportSavedsSnap,
      commentsSnap,
    ] = await Promise.all([
      db.collection("planTasks").where("planId", "==", planId).get(),
      db.collection("reports").where("planId", "==", planId).get(),
      db.collection("reportTasks").where("planId", "==", planId).get(),
      db.collection("reportSaveds").where("planId", "==", planId).get(),
      db.collection("comments").where("_id", "==", planId).get(),
    ]);

    const batch = db.batch();

    batch.delete(planRef);

    planTasksSnap.docs.forEach((doc) => batch.delete(doc.ref));
    reportsSnap.docs.forEach((doc) => batch.delete(doc.ref));
    reportTasksSnap.docs.forEach((doc) => batch.delete(doc.ref));
    reportSavedsSnap.docs.forEach((doc) => batch.delete(doc.ref));
    commentsSnap.docs.forEach((doc) => batch.delete(doc.ref));

    batch.set(
      db.collection("Meta").doc("plans"),
      {lastUpdated: FieldValue.serverTimestamp()},
      {merge: true}
    );

    batch.set(
      db.collection("Meta").doc("reports"),
      {lastUpdated: FieldValue.serverTimestamp()},
      {merge: true}
    );

    batch.set(
      db.collection("Meta").doc("reportSaveds"),
      {lastUpdated: FieldValue.serverTimestamp()},
      {merge: true}
    );

    batch.set(
      db.collection("Meta").doc("comments"),
      {lastUpdated: FieldValue.serverTimestamp()},
      {merge: true}
    );

    await batch.commit();

    // 4️⃣ (Sau khi xoá) gửi Telegram notify
    await notifyDeleteEntity({
      type: "plan",
      actorId: uid,
      data: plan,
    });

    return {
      success: true,
      deleted: {
        planTasks: planTasksSnap.size,
        reports: reportsSnap.size,
        reportTasks: reportTasksSnap.size,
        reportSaveds: reportSavedsSnap.size,
        comments: commentsSnap.size,
      },
    };
  }
);

/**
 * AI tạo tổng kết
 */

// functions/src/index.ts

import {GoogleGenAI, Type} from "@google/genai";

const GEMINI_API_KEY = defineSecret("GEMINI_API_KEY");

type GoalSummaryInput = {
  domain: string;
  supportText: string;
  teachingContent: string;
  teacherBullets: string[];
};

function buildPrompt(data: GoalSummaryInput) {
  return `
Bạn là giáo viên can thiệp viết báo cáo tổng kết cuối tháng cho trẻ.

Nhiệm vụ:
Dựa vào các dữ liệu được cung cấp, hãy viết phần "Tổng kết" 
phù hợp cho mục tiêu can thiệp.

Dữ liệu:
- Lĩnh vực: ${data.domain}
- Mức độ hỗ trợ: ${data.supportText}
- Nội dung dạy/can thiệp: ${data.teachingContent}
- Ghi chú/gạch đầu dòng của giáo viên:
${data.teacherBullets.map((item, index) => `${index + 1}. ${item}`).join("\n")}

Yêu cầu:
- Viết thành 1 đoạn văn hoàn chỉnh.
- Không gạch đầu dòng.
- Văn phong chuyên môn, nhẹ nhàng, dễ hiểu cho phụ huynh.
- Dựa sát vào dữ liệu được cung cấp.
- Có thể diễn đạt lại ý của giáo viên cho mạch lạc hơn.
- Có thể thêm số liệu, phần trăm, số cơ hội, 
số lần duy trì nếu dữ liệu giáo viên có đề cập.
- Không tự tạo số liệu nếu dữ liệu không có.
- Không tự thêm nhận xét chuyên môn ngoài dữ liệu được cung cấp.
- Nếu dữ liệu còn ít, viết thận trọng, không suy diễn quá mức.
- Độ dài khoảng 4–7 câu.
- Chỉ viết phần tổng kết, không viết tiêu đề.

Chỉ trả về JSON hợp lệ theo format:
{
  "summary": "..."
}
`;
}
export const generateGoalSummaryAI = onCall(
  {
    region: "asia-southeast1",
    timeoutSeconds: 60,
    memory: "512MiB",
    secrets: [GEMINI_API_KEY],
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Bạn cần đăng nhập.");
    }

    const goal = request.data?.goal as GoalSummaryInput | undefined;

    if (!goal) {
      throw new HttpsError("invalid-argument", "Thiếu dữ liệu goal.");
    }

    const domain = String(goal.domain || "").trim();
    const supportText = String(goal.supportText || "").trim();
    const teachingContent = String(goal.teachingContent || "").trim();

    const teacherBullets = Array.isArray(goal.teacherBullets) ?
      goal.teacherBullets.map((item) => String(item).trim()).filter(Boolean) :
      [];

    if (!domain) {
      throw new HttpsError("invalid-argument", "Thiếu lĩnh vực.");
    }

    if (!supportText) {
      throw new HttpsError("invalid-argument", "Thiếu mức độ hỗ trợ.");
    }

    if (!teachingContent) {
      throw new HttpsError("invalid-argument", "Thiếu nội dung dạy/can thiệp.");
    }

    if (teacherBullets.length === 0) {
      throw new HttpsError(
        "invalid-argument",
        "Cần nhập ít nhất một gạch đầu dòng của giáo viên."
      );
    }

    const cleanedData: GoalSummaryInput = {
      domain,
      supportText,
      teachingContent,
      teacherBullets,
    };

    const ai = new GoogleGenAI({
      apiKey: GEMINI_API_KEY.value(),
    });

    try {
      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: buildPrompt(cleanedData),
        config: {
          temperature: 0.35,
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              summary: {
                type: Type.STRING,
              },
            },
            required: ["summary"],
          },
        },
      });

      const text = response.text;

      if (!text) {
        throw new Error("Gemini không trả về nội dung.");
      }

      const parsed = JSON.parse(text);

      if (!parsed.summary || typeof parsed.summary !== "string") {
        throw new Error("Gemini trả về JSON không có summary hợp lệ.");
      }

      return {
        ok: true,
        summary: parsed.summary.trim(),
      };
    } catch (error) {
      console.error("generateGoalSummaryAI error:", error);
      throw new HttpsError("internal", "Không thể tạo tổng kết bằng AI.");
    }
  }
);

/**
 * Tạo báo cáo
 */
export const createReportFromPlan = onCall(
  {region: "asia-southeast1"},
  async (request) => {
    const uid = request.auth?.uid;

    if (!uid) {
      throw new HttpsError("unauthenticated", "Chưa đăng nhập");
    }

    const {childId, planId, addReports, isReportSaved} = request.data;

    if (!childId || !planId || !Array.isArray(addReports)) {
      throw new HttpsError("invalid-argument", "Dữ liệu không hợp lệ");
    }

    if (addReports.length === 0) {
      throw new HttpsError("invalid-argument", "Không có nội dung báo cáo");
    }

    const childRef = db.collection("children").doc(childId);
    const planRef = db.collection("plans").doc(planId);

    const [childSnap, planSnap] = await Promise.all([
      childRef.get(),
      planRef.get(),
    ]);

    if (!childSnap.exists) {
      throw new HttpsError("not-found", "Không tìm thấy trẻ");
    }

    if (!planSnap.exists) {
      throw new HttpsError("not-found", "Không tìm thấy kế hoạch");
    }

    const child = childSnap.data();
    const plan = planSnap.data();

    const teacherIds = child?.teacherIds || [];

    if (!Array.isArray(teacherIds) || !teacherIds.includes(uid)) {
      throw new HttpsError(
        "permission-denied",
        "Bạn không có quyền tạo báo cáo cho trẻ này"
      );
    }

    if (plan?.childId !== childId) {
      throw new HttpsError(
        "failed-precondition",
        "Kế hoạch không thuộc trẻ này"
      );
    }

    if (!plan?.teacherIds?.includes(uid)) {
      throw new HttpsError(
        "permission-denied",
        "Bạn không có quyền tạo báo cáo cho kế hoạch này"
      );
    }

    if (plan?.status !== "approved") {
      throw new HttpsError(
        "failed-precondition",
        "Chỉ được tạo báo cáo từ kế hoạch đã duyệt"
      );
    }

    const reportRef = db.collection("reports").doc();

    const reportData = {
      type: "BC",
      title: plan?.title || "",
      childId,
      teacherIds,
      authorId: uid,
      planId,
      status: "pending",
      comment: "",
      updateById: uid,
      createAt: FieldValue.serverTimestamp(),
      updateAt: FieldValue.serverTimestamp(),
    };

    const operations: Array<{
      type: "set" | "delete";
      ref: FirebaseFirestore.DocumentReference;
      data?: any;
      options?: FirebaseFirestore.SetOptions;
    }> = [];

    operations.push({
      type: "set",
      ref: reportRef,
      data: reportData,
    });

    addReports.forEach((item: any) => {
      const reportTaskRef = db.collection("reportTasks").doc();

      operations.push({
        type: "set",
        ref: reportTaskRef,
        data: {
          reportId: reportRef.id,
          planId,
          childId,
          planTaskId: isReportSaved ? item.planTaskId : item.id,
          content: item.total ?? "",
          isEdit: false,
          teacherIds,
          authorId: uid,
          createAt: FieldValue.serverTimestamp(),
          updateAt: FieldValue.serverTimestamp(),
        },
      });

      if (isReportSaved && item.id) {
        operations.push({
          type: "delete",
          ref: db.collection("reportSaveds").doc(item.id),
        });
      }
    });

    operations.push({
      type: "set",
      ref: db.collection("Meta").doc("reports"),
      data: {lastUpdated: FieldValue.serverTimestamp()},
      options: {merge: true},
    });

    if (isReportSaved) {
      operations.push({
        type: "set",
        ref: db.collection("Meta").doc("reportSaveds"),
        data: {lastUpdated: FieldValue.serverTimestamp()},
        options: {merge: true},
      });
    }

    const chunkSize = 450;

    for (let i = 0; i < operations.length; i += chunkSize) {
      const batch = db.batch();
      const chunk = operations.slice(i, i + chunkSize);

      chunk.forEach((op) => {
        if (op.type === "set") {
          batch.set(op.ref, op.data, op.options || {});
        }

        if (op.type === "delete") {
          batch.delete(op.ref);
        }
      });

      await batch.commit();
    }

    return {
      success: true,
      reportId: reportRef.id,
      created: {
        reports: 1,
        reportTasks: addReports.length,
      },
      deleted: {
        reportSaveds: isReportSaved ?
          addReports.filter((item: any) => item.id).length :
          0,
      },
    };
  }
);

/**
 * Tạo/update báo cáo nháp
 */
export const saveReportSaveds = onCall(
  {region: "asia-southeast1"},
  async (request) => {
    const uid = request.auth?.uid;

    if (!uid) {
      throw new HttpsError("unauthenticated", "Chưa đăng nhập");
    }

    const {childId, planId, addReports, isReportSaved} = request.data;

    if (!childId || !planId || !Array.isArray(addReports)) {
      throw new HttpsError("invalid-argument", "Dữ liệu không hợp lệ");
    }

    if (addReports.length === 0) {
      throw new HttpsError("invalid-argument", "Không có dữ liệu nháp");
    }

    const [childSnap, planSnap] = await Promise.all([
      db.collection("children").doc(childId).get(),
      db.collection("plans").doc(planId).get(),
    ]);

    if (!childSnap.exists) {
      throw new HttpsError("not-found", "Không tìm thấy trẻ");
    }

    if (!planSnap.exists) {
      throw new HttpsError("not-found", "Không tìm thấy kế hoạch");
    }

    const child = childSnap.data();
    const plan = planSnap.data();

    const teacherIds = child?.teacherIds || [];

    if (!teacherIds.includes(uid)) {
      throw new HttpsError("permission-denied", "Bạn không có quyền lưu nháp");
    }

    if (plan?.childId !== childId) {
      throw new HttpsError(
        "failed-precondition",
        "Kế hoạch không thuộc trẻ này"
      );
    }

    const operations: Array<{
      type: "set" | "delete";
      ref: FirebaseFirestore.DocumentReference;
      data?: any;
      options?: FirebaseFirestore.SetOptions;
    }> = [];

    const newSavedItems: any[] = [];

    addReports.forEach((item: any) => {
      if (isReportSaved && item.id) {
        operations.push({
          type: "delete",
          ref: db.collection("reportSaveds").doc(item.id),
        });
      }

      const newRef = db.collection("reportSaveds").doc();

      const {id, ...data} = item;

      const savedData = {
        ...data,
        childId,
        planId,
        planTaskId: item.planTaskId ?? id,
        total: item.total ?? "",
        teacherIds,
        authorId: uid,
        updateById: uid,
        createAt: FieldValue.serverTimestamp(),
        updateAt: FieldValue.serverTimestamp(),
      };

      operations.push({
        type: "set",
        ref: newRef,
        data: savedData,
      });

      newSavedItems.push({
        ...savedData,
        id: newRef.id,
      });
    });

    operations.push({
      type: "set",
      ref: db.collection("Meta").doc("reportSaveds"),
      data: {
        lastUpdated: FieldValue.serverTimestamp(),
      },
      options: {merge: true},
    });

    const chunkSize = 450;

    for (let i = 0; i < operations.length; i += chunkSize) {
      const batch = db.batch();
      const chunk = operations.slice(i, i + chunkSize);

      chunk.forEach((op) => {
        if (op.type === "set") {
          batch.set(op.ref, op.data, op.options || {});
        } else {
          batch.delete(op.ref);
        }
      });

      await batch.commit();
    }

    return {
      success: true,
      saved: {
        reportSaveds: addReports.length,
      },
      deleted: {
        reportSaveds: isReportSaved ?
          addReports.filter((item: any) => item.id).length :
          0,
      },
      items: newSavedItems,
    };
  }
);

/**
 * Cập nhật chi tiết báo cáo
 */
export const updateReportTasks = onCall(
  {region: "asia-southeast1"},
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) {
      throw new HttpsError("unauthenticated", "Chưa đăng nhập");
    }

    const {reportId, reportTasks} = request.data;

    if (!reportId || !Array.isArray(reportTasks)) {
      throw new HttpsError("invalid-argument", "Dữ liệu không hợp lệ");
    }

    const reportRef = db.collection("reports").doc(reportId);
    const reportSnap = await reportRef.get();

    if (!reportSnap.exists) {
      throw new HttpsError("not-found", "Không tìm thấy report");
    }

    const report = {
      id: reportSnap.id,
      ...(reportSnap.data() as Omit<Report, "id">),
    } as Report;

    // check quyền
    if (!report.teacherIds?.includes(uid)) {
      throw new HttpsError("permission-denied", "Không có quyền");
    }

    if (report.status !== "pending") {
      throw new HttpsError(
        "failed-precondition",
        "Chỉ được chỉnh sửa báo cáo đang chờ duyệt."
      );
    }

    const batch = db.batch();

    // update tasks
    reportTasks.forEach((task) => {
      const ref = db.collection("reportTasks").doc(task.id);

      batch.update(ref, {
        content: task.content || "",
        updateAt: FieldValue.serverTimestamp(),
      });
    });

    // update report
    batch.update(reportRef, {
      updateById: uid,
      updateAt: FieldValue.serverTimestamp(),
    });

    // update meta
    batch.set(
      db.collection("Meta").doc("reports"),
      {lastUpdated: FieldValue.serverTimestamp()},
      {merge: true}
    );

    await batch.commit();

    return {
      success: true,
      updatedCount: reportTasks.length,
    };
  }
);

/**
 * Xóa báo cáo
 */
export const deleteReport = onCall(
  {region: "asia-southeast1", secrets: [TELEGRAM_BOT_TOKEN]},
  async (request) => {
    const uid = request.auth?.uid;

    if (!uid) {
      throw new HttpsError("unauthenticated", "Chưa đăng nhập");
    }

    const {reportId} = request.data;

    if (!reportId) {
      throw new HttpsError("invalid-argument", "Thiếu reportId");
    }

    const reportRef = db.collection("reports").doc(reportId);
    const reportSnap = await reportRef.get();

    if (!reportSnap.exists) {
      throw new HttpsError("not-found", "Không tìm thấy báo cáo");
    }

    const report = reportSnap.data();

    if (!report?.teacherIds?.includes(uid)) {
      throw new HttpsError("permission-denied", "Không có quyền xoá báo cáo");
    }

    // Nếu muốn chỉ xoá báo cáo pending/draft thì mở đoạn này
    if (report.status !== "pending") {
      throw new HttpsError(
        "failed-precondition",
        "Chỉ được xoá báo cáo đang pending"
      );
    }

    const reportTasksSnap = await db
      .collection("reportTasks")
      .where("reportId", "==", reportId)
      .get();
    const commentsSnap = await db
      .collection("comments")
      .where("_id", "==", reportId)
      .get();

    const batch = db.batch();

    batch.delete(reportRef);

    reportTasksSnap.docs.forEach((doc) => {
      batch.delete(doc.ref);
    });
    commentsSnap.docs.forEach((doc) => {
      batch.delete(doc.ref);
    });

    batch.set(
      db.collection("Meta").doc("reports"),
      {lastUpdated: FieldValue.serverTimestamp()},
      {merge: true}
    );
    batch.set(
      db.collection("Meta").doc("comments"),
      {lastUpdated: FieldValue.serverTimestamp()},
      {merge: true}
    );

    await batch.commit();

    // 4️⃣ (Sau khi xoá) gửi Telegram notify
    await notifyDeleteEntity({
      type: "report",
      actorId: uid,
      data: report,
    });

    return {
      success: true,
      deleted: {
        reports: 1,
        reportTasks: reportTasksSnap.size,
        comments: commentsSnap.size,
      },
      deletedCount: 1 + reportTasksSnap.size + commentsSnap.size,
    };
  }
);

/**
 * Xóa trẻ
 */
export const deleteChildDeep = onCall(
  {region: "asia-southeast1"},
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) {
      throw new HttpsError("unauthenticated", "Chưa đăng nhập");
    }

    const {childId} = request.data;
    if (!childId) {
      throw new HttpsError("invalid-argument", "Thiếu childId");
    }

    // 🔐 check admin
    const userSnap = await db.collection("users").doc(uid).get();
    const user = userSnap.data();

    if (user?.role !== "admin") {
      throw new HttpsError("permission-denied", "Chỉ admin được xoá");
    }

    const childRef = db.collection("children").doc(childId);
    const childSnap = await childRef.get();

    if (!childSnap.exists) {
      throw new HttpsError("not-found", "Không tìm thấy trẻ");
    }

    const childData: any = childSnap.data();

    // 🔎 query tất cả dữ liệu liên quan
    const [
      cartsSnap,
      plansSnap,
      planTasksSnap,
      reportsSnap,
      reportTasksSnap,
      reportSavedsSnap,
      commentsSnap,
    ] = await Promise.all([
      db.collection("carts").where("childId", "==", childId).get(),
      db.collection("plans").where("childId", "==", childId).get(),
      db.collection("planTasks").where("childId", "==", childId).get(),
      db.collection("reports").where("childId", "==", childId).get(),
      db.collection("reportTasks").where("childId", "==", childId).get(),
      db.collection("reportSaveds").where("childId", "==", childId).get(),
      db.collection("comments").where("childId", "==", childId).get(),
    ]);

    // 🔥 helper chia batch (tránh vượt 500 ops)
    const commitInBatches = async (docs: any) => {
      const chunkSize = 450; // an toàn
      for (let i = 0; i < docs.length; i += chunkSize) {
        const batch = db.batch();
        docs.slice(i, i + chunkSize).forEach((doc: any) => {
          batch.delete(doc.ref);
        });
        await batch.commit();
      }
    };

    // 🧹 xoá từng nhóm
    await commitInBatches(cartsSnap.docs);
    await commitInBatches(planTasksSnap.docs);
    await commitInBatches(plansSnap.docs);
    await commitInBatches(reportTasksSnap.docs);
    await commitInBatches(reportSavedsSnap.docs);
    await commitInBatches(reportsSnap.docs);
    await commitInBatches(commentsSnap.docs);

    // 🧹 xoá child cuối cùng
    await childRef.delete();

    // 📊 update meta
    const metaUpdates = [
      "children", "plans",
      "reports", "carts",
      "reportSaveds", "comments",
    ];

    await Promise.all(
      metaUpdates.map((key) =>
        db
          .collection("Meta")
          .doc(key)
          .set(
            {lastUpdated: FieldValue.serverTimestamp()},
            {merge: true}
          )
      )
    );

    // 7️⃣ Notify sau khi xoá xong toàn bộ
    await notifyDeleteEntity({
      type: "children",
      actorId: uid,
      data: childData,
    });

    return {
      ok: true,
      deletedChildId: childId,
      deleted: {
        carts: cartsSnap.size,
        plans: plansSnap.size,
        planTasks: planTasksSnap.size,
        reports: reportsSnap.size,
        reportTasks: reportTasksSnap.size,
        reportSaveds: reportSavedsSnap.size,
        comments: commentsSnap.size,
      },
      deletedPlansCount: plansSnap.size,
      deletedReportsCount: reportsSnap.size,
    };
  }
);

/**
 * Cập nhật trẻ
 */
export const updateChild = onCall(
  {region: "asia-southeast1"},
  async (request) => {
    const uid = request.auth?.uid;

    if (!uid) {
      throw new HttpsError("unauthenticated", "Chưa đăng nhập");
    }

    const {childId, fullName, avatar, status,
      shortName,
      birth,
      gender, teacherIds} = request.data;

    if (!childId || !fullName || !Array.isArray(teacherIds)) {
      throw new HttpsError("invalid-argument", "Dữ liệu không hợp lệ");
    }

    const userSnap = await db.collection("users").doc(uid).get();
    const user = userSnap.data();

    if (user?.role !== "admin") {
      throw new HttpsError("permission-denied", "Chỉ admin được cập nhật trẻ");
    }

    const childRef = db.collection("children").doc(childId);
    const childSnap = await childRef.get();

    if (!childSnap.exists) {
      throw new HttpsError("not-found", "Không tìm thấy trẻ");
    }

    const child = childSnap.data();

    const oldTeacherIds = child?.teacherIds || [];
    const newTeacherIds = teacherIds;

    const normalize = (arr: string[]) => [...new Set(arr)].sort();

    const oldSorted = normalize(oldTeacherIds);
    const newSorted = normalize(newTeacherIds);

    const isTeacherChanged =
      oldSorted.length !== newSorted.length ||
      oldSorted.some((id, index) => id !== newSorted[index]);

    // validate teacherIds nếu có thay đổi
    if (isTeacherChanged) {
      const teacherDocs = await Promise.all(
        newSorted.map((teacherId) =>
          db.collection("users").doc(teacherId).get()
        )
      );

      const invalidTeacherIds = newSorted.filter(
        (_, index) => !teacherDocs[index].exists
      );

      if (invalidTeacherIds.length > 0) {
        throw new HttpsError(
          "invalid-argument",
          "Có giáo viên không tồn tại",
          {invalidTeacherIds}
        );
      }
    }

    const updateChildData = {
      fullName,
      avatar: avatar || "",
      status: status || "",
      shortName: shortName || "",
      gender: gender || "",
      birth: birth || "",
      teacherIds: newSorted,
      updateAt: FieldValue.serverTimestamp(),
      updateById: uid,
    };

    // Trường hợp KHÔNG đổi giáo viên: chỉ update children
    if (!isTeacherChanged) {
      await childRef.update(updateChildData);

      await db.collection("Meta").doc("children").set(
        {lastUpdated: FieldValue.serverTimestamp()},
        {merge: true}
      );

      return {
        ok: true,
        childId,
        teacherChanged: false,
        updated: {
          child: 1,
          carts: 0,
          plans: 0,
          planTasks: 0,
          reports: 0,
          reportTasks: 0,
          reportSaveds: 0,
        },
        updatedCount: 1,
      };
    }

    // Trường hợp CÓ đổi giáo viên: update children + sync teacherIds
    const [
      cartsSnap,
      plansSnap,
      planTasksSnap,
      reportsSnap,
      reportTasksSnap,
      reportSavedsSnap,
    ] = await Promise.all([
      db.collection("carts").where("childId", "==", childId).get(),
      db.collection("plans").where("childId", "==", childId).get(),
      db.collection("planTasks").where("childId", "==", childId).get(),
      db.collection("reports").where("childId", "==", childId).get(),
      db.collection("reportTasks").where("childId", "==", childId).get(),
      db.collection("reportSaveds").where("childId", "==", childId).get(),
    ]);

    const refs = [
      childRef,
      ...cartsSnap.docs.map((doc) => doc.ref),
      ...plansSnap.docs.map((doc) => doc.ref),
      ...planTasksSnap.docs.map((doc) => doc.ref),
      ...reportsSnap.docs.map((doc) => doc.ref),
      ...reportTasksSnap.docs.map((doc) => doc.ref),
      ...reportSavedsSnap.docs.map((doc) => doc.ref),
    ];

    const chunkSize = 450;

    for (let i = 0; i < refs.length; i += chunkSize) {
      const batch = db.batch();
      const chunk = refs.slice(i, i + chunkSize);

      chunk.forEach((ref) => {
        if (ref.path === childRef.path) {
          batch.update(ref, updateChildData);
        } else {
          batch.update(ref, {
            teacherIds: newSorted,
            updateAt: FieldValue.serverTimestamp(),
          });
        }
      });

      await batch.commit();
    }

    await Promise.all([
      db.collection("Meta").doc("children").set(
        {lastUpdated: FieldValue.serverTimestamp()},
        {merge: true}
      ),
      db.collection("Meta").doc("carts").set(
        {lastUpdated: FieldValue.serverTimestamp()},
        {merge: true}
      ),
      db.collection("Meta").doc("plans").set(
        {lastUpdated: FieldValue.serverTimestamp()},
        {merge: true}
      ),
      db.collection("Meta").doc("reports").set(
        {lastUpdated: FieldValue.serverTimestamp()},
        {merge: true}
      ),
      db.collection("Meta").doc("reportSaveds").set(
        {lastUpdated: FieldValue.serverTimestamp()},
        {merge: true}
      ),
    ]);

    return {
      ok: true,
      childId,
      teacherChanged: true,
      syncedTeacherIds: newSorted,
      updated: {
        child: 1,
        carts: cartsSnap.size,
        plans: plansSnap.size,
        planTasks: planTasksSnap.size,
        reports: reportsSnap.size,
        reportTasks: reportTasksSnap.size,
        reportSaveds: reportSavedsSnap.size,
      },
      updatedCount:
        1 +
        cartsSnap.size +
        plansSnap.size +
        planTasksSnap.size +
        reportsSnap.size +
        reportTasksSnap.size +
        reportSavedsSnap.size,
    };
  }
);

/**
 * Xóa giáo viên
 */
export const deleteTeacherDeep = onCall(
  {region: "asia-southeast1"},
  async (request) => {
    const uid = request.auth?.uid;

    if (!uid) {
      throw new HttpsError("unauthenticated", "Chưa đăng nhập");
    }

    const {teacherId} = request.data;

    if (!teacherId) {
      throw new HttpsError("invalid-argument", "Thiếu teacherId");
    }

    // Check admin
    const adminSnap = await db.collection("users").doc(uid).get();
    const adminUser = adminSnap.data();

    if (adminUser?.role !== "admin") {
      throw new HttpsError("permission-denied", "Chỉ admin được xoá giáo viên");
    }

    const teacherRef = db.collection("users").doc(teacherId);
    const teacherSnap = await teacherRef.get();

    if (!teacherSnap.exists) {
      throw new HttpsError("not-found", "Không tìm thấy giáo viên");
    }

    const collectionsNeedSync = [
      "carts",
      "plans",
      "planTasks",
      "reports",
      "reportTasks",
      "reportSaveds",
      "comments",
    ];

    // Children chỉ cần remove teacherIds
    const childrenSnap = await db
      .collection("children")
      .where("teacherIds", "array-contains", teacherId)
      .get();

    const updateMap = new Map<string, any>();

    const addUpdate = (ref: FirebaseFirestore.DocumentReference, data: any) => {
      const key = ref.path;
      const old = updateMap.get(key) || {};
      updateMap.set(key, {ref, data: {...old.data, ...data}});
    };

    // remove teacherId khỏi children.teacherIds
    childrenSnap.docs.forEach((doc) => {
      addUpdate(doc.ref, {
        teacherIds: FieldValue.arrayRemove(teacherId),
        updateAt: FieldValue.serverTimestamp(),
      });
    });

    const syncResults: Record<string, any> = {
      children: {
        removedTeacherIds: childrenSnap.size,
      },
    };

    for (const col of collectionsNeedSync) {
      const [teacherIdsSnap, authorSnap] = await Promise.all([
        db.collection(col)
          .where("teacherIds", "array-contains", teacherId).get(),
        db.collection(col)
          .where("authorId", "==", teacherId).get(),
      ]);

      teacherIdsSnap.docs.forEach((doc) => {
        addUpdate(doc.ref, {
          teacherIds: FieldValue.arrayRemove(teacherId),
          updateAt: FieldValue.serverTimestamp(),
        });
      });

      authorSnap.docs.forEach((doc) => {
        addUpdate(doc.ref, {
          authorId: "",
          updateAt: FieldValue.serverTimestamp(),
        });
      });

      syncResults[col] = {
        removedTeacherIds: teacherIdsSnap.size,
        clearedAuthorId: authorSnap.size,
      };
    }

    const updates = Array.from(updateMap.values());

    const chunkSize = 450;

    for (let i = 0; i < updates.length; i += chunkSize) {
      const batch = db.batch();
      const chunk = updates.slice(i, i + chunkSize);

      chunk.forEach((item) => {
        batch.update(item.ref, item.data);
      });

      await batch.commit();
    }

    // Xoá teacher document trong users
    await teacherRef.delete();

    // Nếu teacherId chính là Firebase Auth UID và bạn muốn xoá luôn auth user:
    // await admin.auth().deleteUser(teacherId);

    await Promise.all([
      db.collection("Meta").doc("users").set(
        {lastUpdated: FieldValue.serverTimestamp()},
        {merge: true}
      ),
      db.collection("Meta").doc("children").set(
        {lastUpdated: FieldValue.serverTimestamp()},
        {merge: true}
      ),
      db.collection("Meta").doc("carts").set(
        {lastUpdated: FieldValue.serverTimestamp()},
        {merge: true}
      ),
      db.collection("Meta").doc("plans").set(
        {lastUpdated: FieldValue.serverTimestamp()},
        {merge: true}
      ),
      db.collection("Meta").doc("reports").set(
        {lastUpdated: FieldValue.serverTimestamp()},
        {merge: true}
      ),
      db.collection("Meta").doc("reportSaveds").set(
        {lastUpdated: FieldValue.serverTimestamp()},
        {merge: true}
      ),
      db.collection("Meta").doc("comments").set(
        {lastUpdated: FieldValue.serverTimestamp()},
        {merge: true}
      ),
    ]);

    return {
      ok: true,
      deletedTeacherId: teacherId,
      updatedCount: updates.length,
      synced: syncResults,
    };
  }
);

/**
 * NOTIFICATION TELEGRAM
 */

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
              text: `Mở link ở Safari (nếu trên iOS) 
              hoặc mở trực tiếp (Android)`,
              url: `https://can-thiep-quang-xuong.vercel.app/${route}`,
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
                ` của trẻ "<b>${child.fullName}</b>": `+
                `<i>${comment}</i>`,
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
                ` của trẻ "<b>${child.fullName}</b>": ` +
                `${comment}`,
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
/plan_check 5/2026 – Kế hoạch tháng chỉ định
/report_check – Báo cáo tháng hiện tại
/report_check 5/2026 – Báo cáo tháng chỉ định
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
      await sendTelegramCommand(chatId, "⚠️ Ví dụ cú pháp đúng: 5/2026");
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
        `<a href="https://can-thiep-quang-xuong.vercel.app/home/${p.childId}/pending">` +
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
    .map((d) => ({id: d.id, ...d.data()} as {id: string, status?: string}))
    .filter((c) => !childHasDoc.has(c.id) && c.status !== "paused");
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
    schedule: "0 8 27 * *", // mỗi 8h sáng ngày 28 hàng tháng
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
    " đã đến hạn. Cô nhanh chóng " +
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
