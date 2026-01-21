import bcrypt from "bcrypt";
import * as crypto from "crypto";
import * as admin from "firebase-admin";
import {defineSecret} from "firebase-functions/params";
import {onRequest} from "firebase-functions/v2/https";
import {setGlobalOptions} from "firebase-functions/v2/options";
import {onDocumentCreated} from "firebase-functions/v2/firestore";
// import {templeDoc} from "./templeDoc";

setGlobalOptions({region: "asia-southeast1"});
admin.initializeApp();
const db = admin.firestore();
const TELEGRAM_BOT_TOKEN = defineSecret("TELEGRAM_BOT_TOKEN");

async function sendTelegram(chatId: number, text: string) {
  const res = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN.value()}/sendMessage`,
    {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({chat_id: chatId, text}),
    },
  );

  return await res.json(); // ✅ QUAN TRỌNG
}
async function deleteMessage(chatId: number, messageId: number) {
  await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN.value()}/deleteMessage`,
    {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
      }),
    },
  );
}
const normalizeVN = (str: string): string => {
  return str
    .toLowerCase()
    .normalize("NFD") // tách dấu
    .replace(/[\u0300-\u036f]/g, "") // bỏ dấu
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9\s]/g, "") // bỏ ký tự lạ
    .replace(/\s+/g, " ") // gộp space
    .trim();
};
// const buildSlugAndTokens = (input: string) => {
//   const normalized = normalizeVN(input);

//   const parts = normalized.split(" ");

//   return {
//     slugName: parts.join("_"), // nguyen_van_an
//     tokens: parts, // ["nguyen", "van", "an"]
//   };
// };
export const createAccount = onRequest(async (req, res) => {
  try {
    const {email, password, displayName, telegramChatId} = req.body;
    if (!email || !password || !telegramChatId) {
      res.status(400).send("Thiếu dữ liệu");
      return;
    }

    const user = await admin.auth().createUser({
      email,
      password,
      displayName,
    });

    const secret = Math.random().toString(36).slice(2, 12);
    const secretHash = await bcrypt.hash(secret, 10);

    await db.collection("users").doc(user.uid).set({
      email,
      displayName,
      telegramChatId,
      secretHash,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({
      uid: user.uid,
      secret, // ⚠️ chỉ trả 1 lần
    });
  } catch (e: any) {
    res.status(500).send(e.message);
  }
});

// ----------------TELEGRAM BOT------------------------------
export const telegramWebhook = onRequest(async (req, res) => {
  const msg = req.body.message;

  await db.collection("processMessages").add({
    chatId: msg.chat.id,
    messageId: msg.message_id,
    text: msg.text,
    createdAt: Date.now(),
  });

  res.status(200).send("ok");
});

export const uploadEncryptedDoiTuong = onRequest(async (req, res) => {
  // =========================
  // 🔓 CORS (BẮT BUỘC)
  // =========================
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");

  // ✅ BẮT BUỘC: xử lý preflight
  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }

  try {
    if (req.method !== "POST") {
      res.status(405).send("Method Not Allowed");
      return;
    }

    const data = req.body;

    // =========================
    // 1️⃣ Validate tối thiểu
    // =========================
    const requiredFields = [
      "ciphertext",
      "cipherIv",
      "cipherAuthTag",
      "encryptedDEK",
      "kekIv",
      "dekAuthTag",
      "kekSalt",
      "ownerUid",
      "name",
      "address",
    ];

    for (const f of requiredFields) {
      if (!data[f]) {
        res.status(400).send(`Thiếu field: ${f}`);
        return;
      }
    }

    // =========================
    // 2️⃣ Sanitize nhẹ
    // =========================
    const doc = {
      ciphertext: String(data.ciphertext),
      cipherIv: String(data.cipherIv),
      cipherAuthTag: String(data.cipherAuthTag),

      encryptedDEK: String(data.encryptedDEK),
      kekIv: String(data.kekIv),
      dekAuthTag: String(data.dekAuthTag),
      kekSalt: String(data.kekSalt),

      version: Number(data.version ?? 2),
      createdAt: Number(data.createdAt ?? Date.now()),

      slugName: data.slugName ?? "",
      tokens: Array.isArray(data.tokens) ? data.tokens : [],
      name: String(data.name),
      address: String(data.address),

      ownerUid: String(data.ownerUid),
      sharedWith: Array.isArray(data.sharedWith) ? data.sharedWith : [],
      public: Boolean(data.public),
    };

    // =========================
    // 3️⃣ Save Firestore
    // =========================
    const ref = await db.collection("doituongs").add(doc);

    res.send({ok: true, id: ref.id});
  } catch (e) {
    console.error(e);
    res.status(500).send("Upload failed");
  }
});

export const onProcessMessageCreated = onDocumentCreated(
  {
    document: "processMessages/{id}",
    secrets: [TELEGRAM_BOT_TOKEN],
  },
  async (event) => {
    const data = event.data?.data();
    if (!data) return;

    const {chatId, messageId, text} = data;
    const raw = (text || "").trim();

    // 🔎 lookup user theo telegramChatId
    const userSnap = await db
      .collection("users")
      .where("telegramChatId", "==", chatId)
      .limit(1)
      .get();

    if (userSnap.empty) {
      await sendTelegram(chatId, "⛔ Không xác định người dùng");
      return;
    }

    const ownerUid = userSnap.docs[0].id;

    /* =========================
       /help
    ========================= */
    if (/^\/help$/i.test(raw)) {
      await sendTelegram(
        chatId,
        "📌 Các lệnh hỗ trợ:\n" +
        "/doituong <tên đối tượng>\n"
      );
      return;
    }

    /* =========================
       /chondoituong_<id>
    ========================= */
    if (raw.startsWith("/chondoituong_")) {
      const match = raw.match(/^\/chondoituong_([\w-]+)$/);

      if (!match) {
        await sendTelegram(chatId, "❌ Cú pháp không hợp lệ.");
        return;
      }

      const objectId = match[1];

      // 🔐 create view token
      const token = crypto.randomUUID();

      await db.collection("viewTokens").doc(token).set({
        ownerUid,
        docId: objectId,
        used: false,
        expiresAt: Date.now() + 180_000,
        createdAt: Date.now(),
      });

      const url =
        "https://asia-southeast1-infojs-c6205.cloudfunctions.net/view" +
        `?token=${token}`;

      const botReply = await sendTelegram(
        chatId,
        "📓 Thông tin đối tượng:\n" +
        "⏱ Link dùng 1 lần (3p)\n" +
        `👉 ${url}`
      );

      // 🧹 xoá message user
      await deleteMessage(chatId, messageId);

      // 🧹 auto xoá message bot
      const botMessageId = botReply?.result?.message_id;
      if (botMessageId) {
        setTimeout(async () => {
          await deleteMessage(chatId, botMessageId);
        }, 60_000);
      }

      return;
    }

    /* =========================
       /doituong <tên>
    ========================= */
    const m = raw.match(/^\/doituong\s+(.+)$/i);

    if (!m) {
      await sendTelegram(
        chatId,
        "❌ Gõ /help để xem danh sách lệnh"
      );
      return;
    }

    const inputName = m[1].trim(); // Nguyễn Văn An
    const keyword = normalizeVN(inputName);

    const snap = await db
      .collection("doituongs")
      .where("tokens", "array-contains", keyword)
      .get();

    if (snap.empty) {
      await sendTelegram(
        chatId,
        `📭 Không tìm thấy đối tượng: ${inputName}`
      );
      return;
    }

    const accessibleDocs = snap.docs.filter((d) => {
      const data = d.data();

      if (data.public === true) return true;
      if (data.ownerUid === ownerUid) return true;
      if (
        Array.isArray(data.sharedWith) &&
        data.sharedWith.includes(ownerUid)
      ) {
        return true;
      }

      return false;
    });

    if (accessibleDocs.length === 0) {
      await sendTelegram(
        chatId,
        "🔒 Có kết quả nhưng bạn không có quyền truy cập"
      );
      return;
    }

    const lines = accessibleDocs.map((d, i) => {
      const data = d.data();
      return (
        `${i + 1}. ${data.name} - ${data.address}\n` +
        `👉 /chondoituong_${d.id}`
      );
    });

    const botDoituongsReply = await sendTelegram(
      chatId,
      "🔎 Tìm thấy các đối tượng sau, chọn 1 đối tượng để tiếp tục:\n\n" +
      lines.join("\n\n")
    );

    // 🧹 auto xoá message bot
    const botMessageId = botDoituongsReply?.result?.message_id;
    if (botMessageId) {
      setTimeout(async () => {
        await deleteMessage(chatId, botMessageId);
      }, 60_000);
    }
  }
);

export const view = onRequest(async (req, res) => {
  try {
    // 🚫 Chặn bot / Telegram preview
    const ua = String(req.headers["user-agent"] || "");
    if (/TelegramBot|bot|crawler|spider/i.test(ua)) {
      res.status(204).end();
      return;
    }

    // =========================
    // 1️⃣ Validate token
    // =========================
    const token = String(req.query.token || "");
    if (!token) throw new Error();

    const ref = db.collection("viewTokens").doc(token);
    let tokenData: any;

    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new Error();

      const d = snap.data()!;
      if (d.used || Date.now() > d.expiresAt) throw new Error();

      tokenData = d;
      tx.update(ref, {used: true});
    });

    // =========================
    // 2️⃣ Load document
    // =========================
    const docSnap = await db
      .collection("doituongs")
      .doc(tokenData.docId)
      .get();

    if (!docSnap.exists) throw new Error();
    const d = docSnap.data()!;

    // =========================
    // 3️⃣ Render HTML
    // =========================
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`<!doctype html>
<html>
<body>
<h3>🔐 Nhập secret để giải mã</h3>

<input type="password" id="secret"/>
<button onclick="decrypt()">Giải mã</button>

<pre id="out"></pre>

<script>
const DATA = ${JSON.stringify({
    ciphertext: d.ciphertext,
    cipherIv: d.cipherIv,
    cipherAuthTag: d.cipherAuthTag,

    encryptedDEK: d.encryptedDEK,
    kekIv: d.kekIv,
    dekAuthTag: d.dekAuthTag,
    kekSalt: d.kekSalt,
  })};

function b64(b){
  return Uint8Array.from(atob(b), c => c.charCodeAt(0));
}

let attempts = 0;

async function decrypt(){
  try{
    if(++attempts > 5){
      document.body.innerHTML = "⛔ Quá số lần thử";
      return;
    }

    const secret = document.getElementById("secret").value;
    const enc = new TextEncoder();

    // =========================
    // 1️⃣ Derive KEK
    // =========================
    const keyMaterial = await crypto.subtle.importKey(
      "raw",
      enc.encode(secret),
      "PBKDF2",
      false,
      ["deriveKey"]
    );

    const kek = await crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: b64(DATA.kekSalt),
        iterations: 150000,
        hash: "SHA-256"
      },
      keyMaterial,
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"]
    );

    // =========================
    // 2️⃣ Decrypt DEK
    // =========================
    const dekCombined = new Uint8Array([
      ...b64(DATA.encryptedDEK),
      ...b64(DATA.dekAuthTag)
    ]);

    const dekRaw = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: b64(DATA.kekIv),
        tagLength: 128
      },
      kek,
      dekCombined
    );

    const dekKey = await crypto.subtle.importKey(
      "raw",
      dekRaw,
      "AES-GCM",
      false,
      ["decrypt"]
    );

    // =========================
    // 3️⃣ Decrypt content
    // =========================
    const contentCombined = new Uint8Array([
      ...b64(DATA.ciphertext),
      ...b64(DATA.cipherAuthTag)
    ]);

    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: b64(DATA.cipherIv),
        tagLength: 128
      },
      dekKey,
      contentCombined
    );

    document.getElementById("out").textContent =
      new TextDecoder().decode(plaintext);

    // ⏳ Auto destroy after 5 minutes
    setTimeout(() => {
      document.body.innerHTML = "⛔ Nội dung đã bị huỷ";
    }, 300000);

  } catch (e) {
    alert("❌ Secret sai hoặc dữ liệu không hợp lệ");
  }
}
</script>
</body>
</html>`);
  } catch {
    res.status(403).send("⛔ Token không hợp lệ");
  }
});

// export const rotateKEKForDoiTuongs = onRequest(async (req, res) => {
//   try {
//     const {ownerUid, oldSecret, newSecret} = req.body;

//     if (!ownerUid || !oldSecret || !newSecret) {
//       res.status(400).send("Thiếu ownerUid / oldSecret / newSecret");
//       return;
//     }

//     // 🔎 Lấy tất cả doituongs của user
//     const snap = await db
//       .collection("doituongs")
//       .where("ownerUid", "==", ownerUid)
//       .get();

//     if (snap.empty) {
//       res.send("ℹ️ Không có document nào để rotate");
//       return;
//     }

//     let rotated = 0;
//     let failed = 0;

//     for (const doc of snap.docs) {
//       try {
//         const d = doc.data();

//         // =========================
//         // 1️⃣ Derive KEK cũ
//         // =========================
//         const oldSalt = Buffer.from(d.kekSalt, "base64");
//         const oldKek = crypto.pbkdf2Sync(
//           oldSecret,
//           oldSalt,
//           150_000,
//           32,
//           "sha256"
//         );

//         // =========================
//         // 2️⃣ Decrypt DEK
//         // =========================
//         const dekIv = Buffer.from(d.kekIv, "base64");
//         const dekAuthTag = Buffer.from(d.dekAuthTag, "base64");
//         const encryptedDEK = Buffer.from(d.encryptedDEK, "base64");

//         const dekDecipher = crypto.createDecipheriv(
//           "aes-256-gcm",
//           oldKek,
//           dekIv
//         );
//         dekDecipher.setAuthTag(dekAuthTag);

//         const dek = Buffer.concat([
//           dekDecipher.update(encryptedDEK),
//           dekDecipher.final(),
//         ]);

//         if (dek.length !== 32) {
//           throw new Error("DEK length invalid");
//         }

//         // =========================
//         // 3️⃣ Derive KEK mới
//         // =========================
//         const newSalt = crypto.randomBytes(16);
//         const newKek = crypto.pbkdf2Sync(
//           newSecret,
//           newSalt,
//           150_000,
//           32,
//           "sha256"
//         );

//         // =========================
//         // 4️⃣ Encrypt lại DEK
//         // =========================
//         const newKekIv = crypto.randomBytes(12);
//         const dekCipher = crypto.createCipheriv(
//           "aes-256-gcm",
//           newKek,
//           newKekIv
//         );

//         const newEncryptedDEK = Buffer.concat([
//           dekCipher.update(dek),
//           dekCipher.final(),
//         ]);
//         const newDekAuthTag = dekCipher.getAuthTag();

//         // =========================
//         // 5️⃣ Update Firestore
//         // =========================
//         await doc.ref.update({
//           encryptedDEK: newEncryptedDEK.toString("base64"),
//           kekIv: newKekIv.toString("base64"),
//           dekAuthTag: newDekAuthTag.toString("base64"),
//           kekSalt: newSalt.toString("base64"),
//         });

//         rotated++;
//       } catch (e) {
//         console.error(`❌ Rotate failed for doc ${doc.id}`, e);
//         failed++;
//       }
//     }

//     res.send(
//       `✅ Rotate KEK xong\n✔ Thành công: ${rotated}\n❌ Thất bại: ${failed}`
//     );
//   } catch (e: any) {
//     console.error(e);
//     res.status(500).send(e.message);
//   }
// });
export const rotateKEKWriteBatch = onRequest(async (req, res) => {
  // CORS
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }
  if (req.method !== "POST") {
    res.status(405).send("Method Not Allowed");
    return;
  }

  try {
    const {ownerUid, updates} = req.body as {
      ownerUid: string;
      updates: Array<{
        docId: string;
        encryptedDEK: string;
        kekIv: string;
        dekAuthTag: string;
        kekSalt: string;
      }>;
    };

    if (!ownerUid || !Array.isArray(updates) || updates.length === 0) {
      res.status(400).send("Thiếu ownerUid hoặc updates rỗng");
      return;
    }

    // giới hạn để tránh abuse (Firestore batch giới hạn 500 writes)
    if (updates.length > 200) {
      res.status(400).send("updates quá nhiều (tối đa 200/lần)");
      return;
    }

    // Validate tối thiểu từng item
    for (const u of updates) {
      if (!u?.docId || !u.encryptedDEK ||
        !u.kekIv || !u.dekAuthTag || !u.kekSalt) {
        res.status(400).send("Có item thiếu field");
        return;
      }
    }

    // 🔐 (Khuyến nghị) Verify Firebase Auth ở đây nếu bạn dùng đăng nhập:
    // - Lấy idToken từ header Authorization: Bearer <token>
    // - Verify token => uid
    // - Bắt buộc uid === ownerUid
    // Mình để comment để bạn bật khi cần.
    //
    // const authHeader = String(req.headers.authorization || "");
    // const m = authHeader.match(/^Bearer\s+(.+)$/i);
    // if (!m) return res.status(401).send("Unauthenticated");
    // const decoded = await admin.auth().verifyIdToken(m[1]);
    // if (decoded.uid !== ownerUid) return res.status(403).send("Forbidden");

    // 1) Load tất cả docs để kiểm tra ownerUid (chống client update bậy)
    const refs = updates.map((u) => db.collection("doituongs").doc(u.docId));
    const snaps = await db.getAll(...refs);

    // 2) Batch update
    const batch = db.batch();
    const failed: Array<{ docId: string; reason: string }> = [];

    snaps.forEach((snap, idx) => {
      const u = updates[idx];

      if (!snap.exists) {
        failed.push({docId: u.docId, reason: "NOT_FOUND"});
        return;
      }

      const data = snap.data()!;
      if (data.ownerUid !== ownerUid) {
        failed.push({docId: u.docId, reason: "FORBIDDEN_OWNER"});
        return;
      }

      batch.update(snap.ref, {
        encryptedDEK: u.encryptedDEK,
        kekIv: u.kekIv,
        dekAuthTag: u.dekAuthTag,
        kekSalt: u.kekSalt,
        rotatedAt: Date.now(),
      });
    });

    await batch.commit();

    res.send({
      ok: true,
      total: updates.length,
      updated: updates.length - failed.length,
      failed,
    });
  } catch (e) {
    console.error(e);
    res.status(500).send("Rotate batch write failed");
  }
});

