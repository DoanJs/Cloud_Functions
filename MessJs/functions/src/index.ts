import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { onDocumentCreated, onDocumentWritten }
  from "firebase-functions/v2/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { setGlobalOptions } from "firebase-functions/v2/options";
import * as admin from "firebase-admin";

// ⚙️ Đặt region mặc định cho toàn bộ Cloud Functions
setGlobalOptions({ region: "asia-southeast1" });
// Khởi tạo Firebase Admin (chỉ gọi một lần)
initializeApp();

const db = getFirestore();

export const onMessageCreated = onDocumentCreated(
  "chatRooms/{roomId}/batches/{batchId}/messages/{messageId}",
  async (event) => {
    const message = event.data?.data();
    if (!message) return;

    const { roomId, batchId, messageId } = event.params;

    const roomRef = db.doc(`chatRooms/${roomId}`);
    const batchRef = db.doc(`chatRooms/${roomId}/batches/${batchId}`);
    const unreadRef = roomRef.collection("unreadCounts");

    // 1️⃣ Cập nhật lastMessage để hiển thị ngoài badge
    const previewText =
      message?.type === "text"
        ? message?.text
        : message?.type === "image"
          ? "📷 Ảnh"
          : message?.type === "audio"
            ? "🎤 Tin nhắn thoại"
            : message?.type === "video"
              ? "🎞️ Video"
              : message?.type === "file"
                ? "📎 Tệp đính kèm"
                : "";

    await roomRef.update({
      lastMessageId: messageId,
      lastMessageText: previewText,
      lastMessageAt: message?.createAt || FieldValue.serverTimestamp(),
      lastSenderId: message?.senderId || null,
      lastBatchId: batchId,
    });
    // Cập nhật số lượng tin nhắn trong batches/{batchId}
    await batchRef.update({
      messageCount: FieldValue.increment(1),
    });

    // 2️⃣ Lấy danh sách members
    const roomSnap = await roomRef.get();
    const memberIds = roomSnap.data()?.memberIds || [];

    // 3️⃣ Tăng unreadCount cho người khác
    const batch = db.batch();
    memberIds.forEach((uid: string) => {
      if (uid !== message?.senderId) {
        const docRef = unreadRef.doc(uid);
        batch.set(
          docRef,
          {
            count: FieldValue.increment(1),
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      }
    });
    await batch.commit();

    // =========================
    // 4️⃣ MEDIA INDEX (NEW)
    // =========================
    const MEDIA_TYPES = ["image", "video", "audio", "file"];

    if (MEDIA_TYPES.includes(message.type)) {
      const mediaRef = db.doc(
        `chatRooms/${roomId}/media/${messageId}`,
      );

      // idempotent – tránh duplicate khi retry
      const mediaSnap = await mediaRef.get();
      if (!mediaSnap.exists) {
        await mediaRef.set({
          type: message.type,
          roomId,
          batchId,
          messageId,
          senderId: message.senderId,

          deleted: false,
          deletedAt: null,
          deletedBy: null,
          duration: message.duration || 0,
          height: message.height || 0,
          width: message.width || 0,
          mediaURL: message.mediaURL || "",
          thumbKey: message.thumbKey || "",
          createAt: message.createAt || FieldValue.serverTimestamp(),
        });
      }
    }

    // 4️⃣ (Tuỳ chọn) Gửi thông báo FCM
    await sendNotificationToMembers({
      roomId,
      senderId: message.senderId,
      previewText,
    });
  }
);
const sendNotificationToMembers = async ({
  roomId,
  senderId,
  previewText,
}: {
  roomId: string;
  senderId: string;
  previewText: string;
}) => {
  const roomSnap = await db.doc(`chatRooms/${roomId}`).get();
  if (!roomSnap.exists) return;

  const roomType: string = roomSnap.data()?.type || "private";
  const memberIds: string[] = roomSnap.data()?.memberIds || [];
  const receivers = memberIds.filter((id) => id !== senderId);

  // 🔥 load users song song
  const userSnaps = await Promise.all(
    receivers.map((uid) => db.doc(`users/${uid}`).get()),
  );

  let tokens: string[] = [];

  userSnaps.forEach((snap) => {
    if (!snap.exists) return;

    const data = snap.data();
    if (!data) return;
    const mutedRooms: string[] = data.mutedRooms || [];
    if (mutedRooms.includes(roomId)) return;

    tokens.push(...(data.fcmTokens || []));
  });

  // 🔥 remove duplicate tokens
  tokens = [...new Set(tokens)];

  if (!tokens.length) return;

  const response = await admin.messaging().sendEachForMulticast({
    tokens,
    notification: {
      title: roomSnap.data()?.name || "New message",
      body: previewText || "New message",
    },
    data: {
      type: "chat",
      chatRoomId: String(roomId),
      roomType: String(roomType),
      targetId: roomType === "private" ? receivers[0] : roomId,
    },
    android: {
      priority: "high",
      notification: {
        sound: "default",
      },
    },
    apns: {
      payload: {
        aps: {
          sound: "default",
          badge: 1,
        },
      },
    },
  });

  // 🔥 cleanup token chết
  const invalidTokens: string[] = [];

  response.responses.forEach((res, idx) => {
    if (!res.success) {
      const code = res.error?.code;
      if (
        code === "messaging/registration-token-not-registered" ||
        code === "messaging/invalid-registration-token"
      ) {
        invalidTokens.push(tokens[idx]);
      }
    }
  });

  if (invalidTokens.length) {
    await Promise.all(
      userSnaps.map((snap) => {
        if (!snap.exists) return;
        return snap.ref.update({
          tokens: admin.firestore.FieldValue.arrayRemove(...invalidTokens),
        });
      }),
    );
  }
};

const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID ?? "",
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? "",
  },
});
export const getUploadUrl = onCall(async (request) => {
  const { fileType, type, isThumb, roomId, messageId } = request.data;
  // Group theo mime
  let group = "image";
  if (type.startsWith("video/")) group = "video";
  if (type.startsWith("audio/")) group = "audio";
  if (isThumb) group = "thumbnail";

  const fileName = `${Date.now()}.${fileType}`;
  const fileKey = `chatRooms/${roomId}/${group}/${messageId}/${fileName}`;

  const command = new PutObjectCommand({
    Bucket: process.env.BUCKET,
    Key: fileKey,
    ContentType: type,
  });

  const uploadUrl = await getSignedUrl(r2, command, { expiresIn: 300 });

  return {
    uploadUrl,
    fileKey,
  };
});
export const getViewUrl = onCall(async (req) => {
  const { fileKey } = req.data;

  if (!fileKey) throw new Error("fileKey missing");

  const command = new GetObjectCommand({
    Bucket: process.env.BUCKET,
    Key: fileKey,
  });

  // Signed GET URL (expire in 5 minutes)
  const viewUrl = await getSignedUrl(r2, command, { expiresIn: 900 });

  return { viewUrl };
});
export const syncMessageReactions = onDocumentWritten(
  "chatRooms/{roomId}/userReactions/{userId}/reactions/{messageId}",
  async (event) => {
    const { roomId, messageId } = event.params;

    const before = event.data?.before?.data();
    const after = event.data?.after?.data();

    // luôn có batchId trong before hoặc after
    const batchId = after?.batchId ?? before?.batchId;

    const messageRef = db.doc(
      `chatRooms/${roomId}/batches/${batchId}/messages/${messageId}`
    );

    // CASE 1: remove
    if (before && !after) {
      await messageRef.update({
        [`reactionCounts.${before.reaction}`]: FieldValue.increment(-1),
      });
      return;
    }

    // CASE 2: add
    if (!before && after) {
      await messageRef.update({
        [`reactionCounts.${after.reaction}`]: FieldValue.increment(1),
      });
      return;
    }

    // CASE 3: update
    if (before && after && before.reaction !== after.reaction) {
      const batch = db.batch();
      batch.update(messageRef, {
        [`reactionCounts.${before.reaction}`]: FieldValue.increment(-1),
      });
      batch.update(messageRef, {
        [`reactionCounts.${after.reaction}`]: FieldValue.increment(1),
      });
      await batch.commit();
      return;
    }
  }
);


export const makeContactId = (uidA: string, uidB: string) => {
  return uidA < uidB ? `${uidA}_${uidB}` : `${uidB}_${uidA}`;
};
type FriendRequestStatus =
  | "pending"
  | "accepted"
  | "declined"
  | "cancelled";
export interface FriendRequestDoc {
  id: string;
  from: string;
  to: string;
  status: FriendRequestStatus;
  memberIds: string[];
  createdAt?: FirebaseFirestore.FieldValue;
  updatedAt?: FirebaseFirestore.FieldValue;
  processed?: boolean;
}
export const sendFriendRequest = onCall(
  { region: "asia-southeast1" }, // optional nhưng nên có
  async (request) => {
    const from = request.auth?.uid;
    const to = request.data?.to;

    if (!from) {
      throw new HttpsError("unauthenticated", "Not signed in");
    }

    if (!to || typeof to !== "string") {
      throw new HttpsError("invalid-argument", "Missing or invalid 'to'");
    }

    if (from === to) {
      throw new HttpsError(
        "failed-precondition",
        "Cannot send friend request to yourself"
      );
    }

    const pairId = makeContactId(from, to);
    const ref = db.doc(`friendRequests/${pairId}`);
    const serverNow = admin.firestore.FieldValue.serverTimestamp();

    // 🚫 Check block (to has blocked from)
    const blockedSnap = await db
      .doc(`blocks/${to}/blocked/${from}`)
      .get();

    if (blockedSnap.exists) {
      throw new HttpsError(
        "permission-denied",
        "You are blocked by this user"
      );
    }

    const snap = await ref.get();

    // ---------- Existing request ----------
    if (snap.exists) {
      const doc = snap.data() as FriendRequestDoc;

      if (doc.status === "accepted") {
        const friendSnap = await db
          .doc(`friendShips/${from}/friends/${to}`)
          .get();

        if (friendSnap.exists) {
          return { result: "already_friends" };
        }
      }

      if (doc.status === "pending") {
        return { result: "already_pending" };
      }

      // reopen request
      await ref.set(
        {
          id: pairId,
          from,
          to,
          status: "pending",
          memberIds: [from, to],
          updatedAt: serverNow,
          createdAt: doc.createdAt ?? serverNow,
          processed: false,
        },
        { merge: true }
      );

      return { result: "reopened" };
    }

    // ---------- Defensive: already friends ----------
    const friendSnap = await db
      .doc(`friendShips/${from}/friends/${to}`)
      .get();

    if (friendSnap.exists) {
      await ref.set({
        id: pairId,
        from,
        to,
        status: "accepted",
        memberIds: [from, to],
        createdAt: serverNow,
        updatedAt: serverNow,
        processed: true,
      });

      return { result: "already_friends" };
    }

    // ---------- Create new request ----------
    await ref.set({
      id: pairId,
      from,
      to,
      status: "pending",
      memberIds: [from, to],
      createdAt: serverNow,
      updatedAt: serverNow,
      processed: false,
    });

    return { result: "pending" };
  }
);
export const acceptFriendRequest = onCall(
  { region: "asia-southeast1" },
  async (request) => {
    const uid = request.auth?.uid;
    const pairId = request.data?.pairId;

    if (!uid) {
      throw new HttpsError("unauthenticated", "Not signed in");
    }

    if (!pairId || typeof pairId !== "string") {
      throw new HttpsError("invalid-argument", "Missing pairId");
    }

    const requestRef = db.doc(`friendRequests/${pairId}`);

    await db.runTransaction(async (tx) => {
      const snap = await tx.get(requestRef);

      if (!snap.exists) {
        throw new HttpsError("not-found", "Friend request not found");
      }

      const doc = snap.data() as FriendRequestDoc;

      // Chỉ accept khi đang pending
      if (doc.status !== "pending") {
        throw new HttpsError("failed-precondition", "Request is not pending");
      }

      // Chỉ người nhận mới được accept
      if (doc.to !== uid) {
        throw new HttpsError("permission-denied", "Not allowed to accept");
      }

      const from = doc.from;
      const to = doc.to;
      const now = admin.firestore.FieldValue.serverTimestamp();

      const friendRefA = db.doc(`friendShips/${from}/friends/${to}`);
      const friendRefB = db.doc(`friendShips/${to}/friends/${from}`);

      // 4️⃣ Lấy profile để tạo FriendPreview
      const fromProfileRef = db.doc(`users/${from}`);
      const toProfileRef = db.doc(`users/${to}`);

      const [fromProfileSnap, toProfileSnap] = await Promise.all([
        tx.get(fromProfileRef),
        tx.get(toProfileRef),
      ]);

      if (!fromProfileSnap.exists || !toProfileSnap.exists) {
        throw new HttpsError("failed-precondition", "User profile missing");
      }

      const fromProfile = fromProfileSnap.data();
      const toProfile = toProfileSnap.data();

      if (!fromProfile || !toProfile) {
        throw new HttpsError(
          "failed-precondition",
          "User profile missing"
        );
      }

      // Tạo quan hệ bạn bè 2 chiều
      tx.set(friendRefA, {
        id: to,
        displayName: toProfile.displayName ?? null,
        photoURL: toProfile.photoURL ?? null,
        email: toProfile.email ?? null, // optional
        createdAt: now,
      });

      tx.set(friendRefB, {
        id: from,
        displayName: fromProfile.displayName ?? null,
        photoURL: fromProfile.photoURL ?? null,
        email: fromProfile.email ?? null,
        createdAt: now,
      });

      // Update request
      tx.update(requestRef, {
        status: "accepted",
        updatedAt: now,
        processed: true,
      });
    });

    return { result: "accepted" };
  }
);
export const declineFriendRequest = onCall(
  { region: "asia-southeast1" },
  async (request) => {
    const uid = request.auth?.uid;
    const pairId = request.data?.pairId;

    if (!uid) {
      throw new HttpsError("unauthenticated", "Not signed in");
    }

    if (!pairId || typeof pairId !== "string") {
      throw new HttpsError("invalid-argument", "Missing pairId");
    }

    const requestRef = db.doc(`friendRequests/${pairId}`);

    const snap = await requestRef.get();

    if (!snap.exists) {
      throw new HttpsError("not-found", "Friend request not found");
    }

    const doc = snap.data() as FriendRequestDoc;

    if (doc.status !== "pending") {
      throw new HttpsError("failed-precondition", "Request is not pending");
    }

    if (doc.to !== uid) {
      throw new HttpsError("permission-denied", "Not allowed to decline");
    }

    await requestRef.update({
      status: "declined",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      processed: true,
    });

    return { result: "declined" };
  }
);
export const unfriend = onCall(
  { region: "asia-southeast1" },
  async (request) => {
    const uid = request.auth?.uid;
    const friendId = request.data?.friendId;

    if (!uid) {
      throw new HttpsError("unauthenticated", "Not signed in");
    }

    if (!friendId || typeof friendId !== "string") {
      throw new HttpsError("invalid-argument", "Missing friendId");
    }

    const refA = db.doc(`friendShips/${uid}/friends/${friendId}`);
    const refB = db.doc(`friendShips/${friendId}/friends/${uid}`);

    await db.runTransaction(async (tx) => {
      const snapA = await tx.get(refA);
      const snapB = await tx.get(refB);

      if (snapA.exists) tx.delete(refA);
      if (snapB.exists) tx.delete(refB);
    });

    return { result: "unfriended" };
  }
);
export const blockUser = onCall(
  { region: "asia-southeast1" },
  async (request) => {
    const uid = request.auth?.uid;
    const targetId = request.data?.targetId;

    if (!uid) {
      throw new HttpsError("unauthenticated", "Not signed in");
    }

    if (!targetId || typeof targetId !== "string") {
      throw new HttpsError("invalid-argument", "Missing targetId");
    }

    if (uid === targetId) {
      throw new HttpsError("failed-precondition", "Cannot block yourself");
    }

    const batch = db.batch();
    const now = admin.firestore.FieldValue.serverTimestamp();

    // 1. Xóa friendship (2 chiều)
    batch.delete(db.doc(`friendShips/${uid}/friends/${targetId}`));
    batch.delete(db.doc(`friendShips/${targetId}/friends/${uid}`));

    // 2. Xóa friendRequest (nếu có)
    const pairId = makeContactId(uid, targetId);
    batch.delete(db.doc(`friendRequests/${pairId}`));

    // 3. Tạo block
    batch.set(
      db.doc(`blocks/${uid}/blocked/${targetId}`),
      { createdAt: now }
    );

    await batch.commit();

    return { result: "blocked" };
  }
);
export const unblockUser = onCall(
  { region: "asia-southeast1" },
  async (request) => {
    const uid = request.auth?.uid;
    const targetId = request.data?.targetId;

    if (!uid) {
      throw new HttpsError("unauthenticated", "Not signed in");
    }

    if (!targetId || typeof targetId !== "string") {
      throw new HttpsError("invalid-argument", "Missing targetId");
    }

    await db
      .doc(`blocks/${uid}/blocked/${targetId}`)
      .delete();

    return { result: "unblocked" };
  }
);
export const cancelFriendRequest = onCall(
  { region: "asia-southeast1" },
  async (request) => {
    const uid = request.auth?.uid;
    const pairId = request.data?.pairId;

    if (!uid) {
      throw new HttpsError("unauthenticated", "Not signed in");
    }

    if (!pairId || typeof pairId !== "string") {
      throw new HttpsError("invalid-argument", "Missing pairId");
    }

    const ref = db.doc(`friendRequests/${pairId}`);
    const snap = await ref.get();

    if (!snap.exists) {
      throw new HttpsError("not-found", "Friend request not found");
    }

    const doc = snap.data() as FriendRequestDoc;

    // Chỉ người gửi mới được hủy
    if (doc.from !== uid) {
      throw new HttpsError(
        "permission-denied",
        "Only sender can cancel request"
      );
    }

    // Chỉ hủy khi đang pending
    if (doc.status !== "pending") {
      throw new HttpsError(
        "failed-precondition",
        "Request is not pending"
      );
    }

    await ref.update({
      status: "cancelled",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      processed: true,
    });

    return { result: "cancelled" };
  }
);
export const addMemberToGroup = onCall(
  { region: "asia-southeast1" },
  async (request) => {
    const callerUid = request.auth?.uid;
    const { roomId, targetUid } = request.data;

    if (!callerUid) {
      throw new HttpsError(
        "unauthenticated",
        "User not authenticated",
      );
    }

    if (!roomId || !targetUid) {
      throw new HttpsError(
        "invalid-argument",
        "roomId and targetUid are required",
      );
    }

    const roomRef = db.doc(`chatRooms/${roomId}`);
    const membersCol = roomRef.collection("members");
    const callerMemberRef = membersCol.doc(callerUid);
    const targetMemberRef = membersCol.doc(targetUid);
    const userRef = db.doc(`users/${targetUid}`);

    await db.runTransaction(async (tx) => {
      // 1️⃣ Check room
      const roomSnap = await tx.get(roomRef);
      if (!roomSnap.exists) {
        throw new HttpsError("not-found", "Room not found");
      }

      // 2️⃣ Check caller role (owner | admin)
      const callerSnap = await tx.get(callerMemberRef);
      if (!callerSnap.exists) {
        throw new HttpsError(
          "permission-denied",
          "Not a group member",
        );
      }

      const callerRole = callerSnap.data()?.role;
      if (callerRole !== "owner" && callerRole !== "admin") {
        throw new HttpsError(
          "permission-denied",
          "Only owner or admin can add member",
        );
      }

      // 3️⃣ Check target user exists
      const userSnap = await tx.get(userRef);
      if (!userSnap.exists) {
        throw new HttpsError(
          "not-found",
          "Target user not found",
        );
      }

      // 4️⃣ Check target already member
      const targetMemberSnap = await tx.get(targetMemberRef);
      if (targetMemberSnap.exists) {
        return; // đã là member → không làm gì
      }

      // 5️⃣ Add member
      const userData = userSnap.data();

      tx.set(targetMemberRef, {
        role: "member",
        nickName: userData?.displayName || "",
        photoURL: userData?.photoURL || "",
        joinedAt:
          admin.firestore.FieldValue.serverTimestamp(),
      });

      // 6️⃣ Update room stats
      tx.update(roomRef, {
        memberIds:
          admin.firestore.FieldValue.arrayUnion(
            targetUid,
          ),
        memberCount:
          admin.firestore.FieldValue.increment(1),
        updatedAt:
          admin.firestore.FieldValue.serverTimestamp(),
      });

      // 7️⃣ (khuyến nghị) system message
      // const msgRef = roomRef
      //   .collection('messages')
      //   .doc();

      // tx.set(msgRef, {
      //   type: 'system',
      //   action: 'add_member',
      //   actorUserId: callerUid,
      //   targetUserId: targetUid,
      //   createdAt:
      //     admin.firestore.FieldValue.serverTimestamp(),
      // });
    });

    return { success: true };
  },
);
export const leaveGroup = onCall(
  { region: "asia-southeast1" },
  async (request) => {
    const uid = request.auth?.uid;
    const { roomId } = request.data;

    if (!uid) {
      throw new HttpsError(
        "unauthenticated",
        "User not authenticated",
      );
    }

    if (!roomId) {
      throw new HttpsError(
        "invalid-argument",
        "roomId is required",
      );
    }

    const roomRef = db.doc(`chatRooms/${roomId}`);
    const membersCol = roomRef.collection("members");
    const memberRef = membersCol.doc(uid);

    await db.runTransaction(async (tx) => {
      const roomSnap = await tx.get(roomRef);
      if (!roomSnap.exists) {
        throw new HttpsError(
          "not-found",
          "Room not found",
        );
      }

      const memberSnap = await tx.get(memberRef);
      if (!memberSnap.exists) {
        throw new HttpsError(
          "failed-precondition",
          "User is not a member of this room",
        );
      }

      const role = memberSnap.data()?.role;

      // =========================
      // 🔴 OWNER RỜI NHÓM
      // =========================
      if (role === "owner") {
        // 1️⃣ tìm admin lâu nhất
        const adminSnap = await tx.get(
          membersCol
            .where("role", "==", "admin")
            .orderBy("joinedAt", "asc")
            .limit(1),
        );

        if (!adminSnap.empty) {
          const newOwnerRef = adminSnap.docs[0].ref;
          tx.update(newOwnerRef, { role: "owner" });
        } else {
          // 2️⃣ không có admin → tìm member lâu nhất
          const memberSnap2 = await tx.get(
            membersCol
              .where("role", "==", "member")
              .orderBy("joinedAt", "asc")
              .limit(1),
          );

          if (!memberSnap2.empty) {
            const newOwnerRef = memberSnap2.docs[0].ref;
            tx.update(newOwnerRef, { role: "owner" });
          } else {
            // 3️⃣ không còn ai → GIẢI TÁN NHÓM
            tx.delete(memberRef);
            tx.delete(roomRef);
            return;
          }
        }
      }

      // =========================
      // ❌ XOÁ MEMBER HIỆN TẠI
      // =========================
      tx.delete(memberRef);

      // =========================
      // ➖ UPDATE ROOM
      // =========================
      tx.update(roomRef, {
        memberIds:
          admin.firestore.FieldValue.arrayRemove(uid),
        memberCount:
          admin.firestore.FieldValue.increment(-1),
        updatedAt:
          admin.firestore.FieldValue.serverTimestamp(),
      });

      // =========================
      // 📝 SYSTEM MESSAGE (optional)
      // =========================
      // const msgRef = roomRef
      //   .collection('messages')
      //   .doc();

      // tx.set(msgRef, {
      //   type: 'system',
      //   action: 'leave_group',
      //   actorUserId: uid,
      //   createdAt:
      //     admin.firestore.FieldValue.serverTimestamp(),
      // });
    });

    return { success: true };
  },
);
export const promoteToAdmin = onCall(
  { region: "asia-southeast1" },
  async (request) => {
    const uid = request.auth?.uid;
    const { roomId, targetUid } = request.data;

    if (!uid) {
      throw new HttpsError(
        "unauthenticated",
        "User not authenticated",
      );
    }

    if (!roomId || !targetUid) {
      throw new HttpsError(
        "invalid-argument",
        "roomId and targetUid are required",
      );
    }

    const roomRef = db.doc(`chatRooms/${roomId}`);
    const membersCol = roomRef.collection("members");
    const callerRef = membersCol.doc(uid);
    const targetRef = membersCol.doc(targetUid);

    await db.runTransaction(async (tx) => {
      // 1️⃣ check caller
      const callerSnap = await tx.get(callerRef);
      if (
        !callerSnap.exists ||
        callerSnap.data()?.role !== "owner"
      ) {
        throw new HttpsError(
          "permission-denied",
          "Only owner can promote admin",
        );
      }

      // 2️⃣ check target
      const targetSnap = await tx.get(targetRef);
      if (!targetSnap.exists) {
        throw new HttpsError(
          "not-found",
          "Target not in group",
        );
      }

      if (targetSnap.data()?.role === "admin") {
        return; // đã là admin
      }

      if (targetSnap.data()?.role === "owner") {
        throw new HttpsError(
          "failed-precondition",
          "Owner cannot be promoted",
        );
      }

      // 3️⃣ update role
      tx.update(targetRef, { role: "admin" });
    });

    return { success: true };
  },
);
export const demoteAdmin = onCall(
  { region: "asia-southeast1" },
  async (request) => {
    const uid = request.auth?.uid;
    const { roomId, targetUid } = request.data;

    if (!uid) {
      throw new HttpsError(
        "unauthenticated",
        "User not authenticated",
      );
    }

    if (!roomId || !targetUid) {
      throw new HttpsError(
        "invalid-argument",
        "roomId and targetUid are required",
      );
    }

    const roomRef = db.doc(`chatRooms/${roomId}`);
    const membersCol = roomRef.collection("members");
    const callerRef = membersCol.doc(uid);
    const targetRef = membersCol.doc(targetUid);

    await db.runTransaction(async (tx) => {
      // 1️⃣ check caller
      const callerSnap = await tx.get(callerRef);
      if (
        !callerSnap.exists ||
        callerSnap.data()?.role !== "owner"
      ) {
        throw new HttpsError(
          "permission-denied",
          "Only owner can promote member",
        );
      }

      // 2️⃣ check target
      const targetSnap = await tx.get(targetRef);
      if (!targetSnap.exists) {
        throw new HttpsError(
          "not-found",
          "Target not in group",
        );
      }

      if (targetSnap.data()?.role === "member") {
        return; // đã là admin
      }

      if (targetSnap.data()?.role === "owner") {
        throw new HttpsError(
          "failed-precondition",
          "Owner cannot be promoted",
        );
      }

      // 3️⃣ update role
      tx.update(targetRef, { role: "member" });
    });

    return { success: true };
  },
);
