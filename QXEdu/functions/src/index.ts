/* eslint-disable require-jsdoc */
import {getFirestore} from "firebase-admin/firestore";
import admin from "firebase-admin";
import {HttpsError, onCall} from "firebase-functions/v2/https";
import {Child, Plan, Report} from "./types";
admin.initializeApp();
const db = getFirestore();
const FieldValue = admin.firestore.FieldValue;

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

    const oldTasksSnap = await db
      .collection("planTasks")
      .where("planId", "==", planId)
      .where("teacherIds", "array-contains", uid)
      .get();

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
  {region: "asia-southeast1"},
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
    ] = await Promise.all([
      db.collection("planTasks").where("planId", "==", planId).get(),
      db.collection("reports").where("planId", "==", planId).get(),
      db.collection("reportTasks").where("planId", "==", planId).get(),
      db.collection("reportSaveds").where("planId", "==", planId).get(),
    ]);

    const batch = db.batch();

    batch.delete(planRef);

    planTasksSnap.docs.forEach((doc) => batch.delete(doc.ref));
    reportsSnap.docs.forEach((doc) => batch.delete(doc.ref));
    reportTasksSnap.docs.forEach((doc) => batch.delete(doc.ref));
    reportSavedsSnap.docs.forEach((doc) => batch.delete(doc.ref));

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

    await batch.commit();

    return {
      success: true,
      deleted: {
        planTasks: planTasksSnap.size,
        reports: reportsSnap.size,
        reportTasks: reportTasksSnap.size,
        reportSaveds: reportSavedsSnap.size,
      },
    };
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
  {region: "asia-southeast1"},
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

    const batch = db.batch();

    batch.delete(reportRef);

    reportTasksSnap.docs.forEach((doc) => {
      batch.delete(doc.ref);
    });

    batch.set(
      db.collection("Meta").doc("reports"),
      {lastUpdated: FieldValue.serverTimestamp()},
      {merge: true}
    );

    await batch.commit();

    return {
      success: true,
      deleted: {
        reports: 1,
        reportTasks: reportTasksSnap.size,
      },
      deletedCount: 1 + reportTasksSnap.size,
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

    // 🔎 query tất cả dữ liệu liên quan
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

    // 🧹 xoá child cuối cùng
    await childRef.delete();

    // 📊 update meta
    const metaUpdates = [
      "children", "plans",
      "reports", "carts",
      "reportSaveds",
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
    ]);

    return {
      ok: true,
      deletedTeacherId: teacherId,
      updatedCount: updates.length,
      synced: syncResults,
    };
  }
);
