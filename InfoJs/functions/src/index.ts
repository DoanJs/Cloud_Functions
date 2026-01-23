import bcrypt from "bcrypt";
import * as crypto from "crypto";
import * as admin from "firebase-admin";
import {defineSecret} from "firebase-functions/params";
import {onRequest} from "firebase-functions/v2/https";
import {setGlobalOptions} from "firebase-functions/v2/options";
import {onDocumentCreated} from "firebase-functions/v2/firestore";
import type {Request, Response} from "express";

setGlobalOptions({region: "asia-southeast1"});
admin.initializeApp();
const db = admin.firestore();
const TELEGRAM_BOT_TOKEN = defineSecret("TELEGRAM_BOT_TOKEN");

const ALLOWED_ORIGINS = [
  "https://info-js-rho.vercel.app", // pro
  // "http://localhost:3000", // dev
];

export async function corsAndAuth(
  req: Request,
  res: Response
): Promise<{ uid: string } | null> {
  const origin = String(req.headers.origin || "");

  if (!ALLOWED_ORIGINS.includes(origin)) {
    res.status(403).send("CORS forbidden");
    return null;
  }

  res.set("Access-Control-Allow-Origin", origin);
  res.set("Vary", "Origin");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );
  res.set("Access-Control-Allow-Credentials", "true");

  // Preflight
  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return null;
  }

  // ---------- Firebase Auth ----------
  const authHeader = String(req.headers.authorization || "");
  const m = authHeader.match(/^Bearer\s+(.+)$/);

  if (!m) {
    res.status(401).send("Unauthenticated");
    return null;
  }

  try {
    const decoded = await admin.auth().verifyIdToken(m[1]);
    return {uid: decoded.uid};
  } catch {
    res.status(401).send("Invalid token");
    return null;
  }
}

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
  const auth = await corsAndAuth(req, res);
  if (!auth) return;

  try {
    if (req.method !== "POST") {
      res.status(405).send("Method Not Allowed");
      return;
    }

    const data = req.body;
    const ownerUid = auth.uid; // 🔥 UID TIN CẬY DUY NHẤT

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
      createdAt: Date.now(),

      slugName: data.slugName ?? "",
      tokens: Array.isArray(data.tokens) ? data.tokens : [],
      name: String(data.name),
      address: String(data.address),

      ownerUid,
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
        "https://view-25yevkpmeq-as.a.run.app" +
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

<div style={{ 
width: '100%', 
maxWidth: "100%", 
whiteSpace:"pre-wrap", 
wordBreak:"break-word", 
overflowWrap:"anywhere", 
lineHeight: 1.6, 
fontSize: "15px" }
} id="out"></div>

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

export const rotateKEKWriteBatch = onRequest(async (req, res) => {
  const auth = await corsAndAuth(req, res);
  if (!auth) return;

  if (req.method !== "POST") {
    res.status(405).send("Method Not Allowed");
    return;
  }

  try {
    const ownerUid = auth.uid;

    const {updates} = req.body as {
      updates: Array<{
        docId: string;
        encryptedDEK: string;
        kekIv: string;
        dekAuthTag: string;
        kekSalt: string;
      }>;
    };

    if (!Array.isArray(updates) || updates.length === 0) {
      res.status(400).send("updates rỗng");
      return;
    }

    // ===== CONFIG =====
    const CHUNK_SIZE = 200;

    const allFailed: Array<{docId: string; reason: string}> = [];
    let totalUpdated = 0;

    // ===== CHUNK LOOP =====
    for (let i = 0; i < updates.length; i += CHUNK_SIZE) {
      const chunk = updates.slice(i, i + CHUNK_SIZE);

      const refs = chunk.map((u) =>
        db.collection("doituongs").doc(u.docId)
      );
      const snaps = await db.getAll(...refs);

      const batch = db.batch();
      let chunkUpdated = 0;

      snaps.forEach((snap, idx) => {
        const u = chunk[idx];

        if (!snap.exists) {
          allFailed.push({docId: u.docId, reason: "NOT_FOUND"});
          return;
        }

        const data = snap.data()!;
        if (data.ownerUid !== ownerUid) {
          allFailed.push({docId: u.docId, reason: "FORBIDDEN_OWNER"});
          return;
        }

        batch.update(snap.ref, {
          encryptedDEK: String(u.encryptedDEK),
          kekIv: String(u.kekIv),
          dekAuthTag: String(u.dekAuthTag),
          kekSalt: String(u.kekSalt),
          rotatedAt: Date.now(),
        });

        chunkUpdated++;
      });

      if (chunkUpdated > 0) {
        await batch.commit();
        totalUpdated += chunkUpdated;
      }
    }

    if (totalUpdated === 0) {
      res.status(403).send("Không có document hợp lệ để rotate");
      return;
    }

    res.send({
      ok: true,
      total: updates.length,
      updated: totalUpdated,
      failed: allFailed,
    });
  } catch (e) {
    console.error(e);
    res.status(500).send("Rotate batch write failed");
  }
});


