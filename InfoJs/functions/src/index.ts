import bcrypt from "bcrypt";
import * as crypto from "crypto";
import * as admin from "firebase-admin";
import {defineSecret} from "firebase-functions/params";
import {onRequest} from "firebase-functions/v2/https";
import {setGlobalOptions} from "firebase-functions/v2/options";
import {templeDoc} from "./templeDoc";

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

export const createSampleDoc = onRequest(async (req, res) => {
  try {
    const {uid, secret} = req.body;
    if (!uid || !secret) {
      res.status(400).send("Thiếu uid / secret");
      return;
    }

    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);

    const key = crypto.pbkdf2Sync(secret, salt, 150_000, 32, "sha256");

    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([
      cipher.update(templeDoc, "utf8"),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();

    await db.collection("documents").doc("nhatkyngaythuhai").set({
      encryptedContent: encrypted.toString("base64"),
      iv: iv.toString("base64"),
      salt: salt.toString("base64"),
      authTag: authTag.toString("base64"),
      ownerUid: uid,
      version: 1,
      createdAt: Date.now(),
    });

    res.send("✅ Sample document đã tạo (E2EE-ready)");
  } catch (e: any) {
    res.status(500).send(e.message);
  }
});
export const telegramWebhook = onRequest(async (req, res) => {
  const msg = req.body.message;

  // ⚠️ BẮT BUỘC trả OK ngay
  res.status(200).send("ok");

  if (!msg?.text) return;
  if (msg.text.trim() !== "/nhatkyngaythuhai") return;

  await db.collection("processMessages").add({
    chatId: msg.chat.id,
    messageId: msg.message_id,
    text: msg.text,
    createdAt: Date.now(),
  });
});
import {onDocumentCreated} from "firebase-functions/v2/firestore";

export const onProcessMessageCreated = onDocumentCreated(
  {
    document: "processMessages/{id}",
    secrets: [TELEGRAM_BOT_TOKEN], // 🔥 BẮT BUỘC
    minInstances: 1,
  },
  async (event) => {
    const data = event.data?.data();
    if (!data) return;

    const {chatId, messageId} = data;

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

    const userDoc = userSnap.docs[0];
    const ownerUid = userDoc.id;

    // 🔐 create view token
    const token = crypto.randomUUID();

    await db.collection("viewTokens").doc(token).set({
      ownerUid,
      docId: "nhatkyngaythuhai",
      used: false,
      expiresAt: Date.now() + 60_000,
      createdAt: Date.now(),
    });

    const url =
      "https://asia-southeast1-infojs-c6205.cloudfunctions.net/view" +
      `?token=${token}`;

    // 📤 send telegram
    const botReply = await sendTelegram(
      chatId,
      "📓 Nhật ký ngày thứ hai\n" +
        "⏱ Link dùng 1 lần (60s)\n" +
        `👉 ${url}`
    );

    // 🧹 xoá message user
    await deleteMessage(chatId, messageId);

    // 🧹 auto xoá message bot
    const botMessageId = botReply?.result?.message_id;
    if (botMessageId) {
      setTimeout(async () => {
        await deleteMessage(chatId, botMessageId);
      }, 10_000);
    }
  }
);

// export const telegramWebhook = onRequest(async (req, res) => {
//   const msg = req.body.message;
//   res.status(200).send("ok");

//   if (!msg?.text) return;
//   if (msg.text.trim() !== "/nhatkyngaythuhai") return;

//   // 🔎 lookup user theo telegramChatId
//   const userSnap = await db
//     .collection("users")
//     .where("telegramChatId", "==", msg.chat.id)
//     .limit(1)
//     .get();

//   if (userSnap.empty) {
//     await sendTelegram(msg.chat.id, "⛔ Không xác định người dùng");
//     return;
//   }

//   const userDoc = userSnap.docs[0];
//   const ownerUid = userDoc.id;

//   const token = crypto.randomUUID();

//   await db.collection("viewTokens").doc(token).set({
//     ownerUid,
//     docId: "nhatkyngaythuhai",
//     used: false,
//     expiresAt: Date.now() + 60_000,
//   });

//   const url =
//     "https://asia-southeast1-infojs-c6205.cloudfunctions.net/view" +
//     `?token=${token}`;

//   const botReply = await sendTelegram(
//     msg.chat.id,
//     "📓 Nhật ký ngày thứ hai\n" +
//       "⏱ Link dùng 1 lần (60s)\n" +
//       `👉 ${url}`
//   );

//   await deleteMessage(msg.chat.id, msg.message_id);

//   // ⛔ nếu Telegram không trả result → dừng
//   const botMessageId = botReply?.result?.message_id;

//   if (botMessageId) {
//     // 🧹 auto xoá message bot
//     setTimeout(async () => {
//       await deleteMessage(msg.chat.id, botMessageId);
//     }, 10_000);
//   }
// });

export const view = onRequest(async (req, res) => {
  try {
    // 🚫 chặn Telegram preview
    const ua = String(req.headers["user-agent"] || "");
    if (/TelegramBot|bot|crawler|spider/i.test(ua)) {
      res.status(204).end();
      return;
    }

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

    const docSnap = await db
      .collection("documents")
      .doc(tokenData.docId)
      .get();

    if (!docSnap.exists) throw new Error();
    const d = docSnap.data()!;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`<!doctype html>
<html>
<body>
<h3>🔐 Nhập secret để giải mã</h3>
<input type="password" id="secret"/>
<button onclick="decrypt()">Giải mã</button>
<pre id="out"></pre>

<script>
const ENCRYPTED = "${d.encryptedContent}";
const IV = "${d.iv}";
const SALT = "${d.salt}";
const AUTH_TAG = "${d.authTag}";

function b64(b){return Uint8Array.from(atob(b),c=>c.charCodeAt(0));}

let attempts = 0;

async function decrypt(){
  try{
    if(++attempts > 5){
      document.body.innerHTML = "⛔ Quá số lần thử";
      return;
    }

    const secret = document.getElementById("secret").value;
    const enc = new TextEncoder();

    const keyMaterial = await crypto.subtle.importKey(
      "raw", enc.encode(secret), "PBKDF2", false, ["deriveKey"]
    );

    const key = await crypto.subtle.deriveKey(
      {
        name:"PBKDF2",
        salt:b64(SALT),
        iterations:150000,
        hash:"SHA-256"
      },
      keyMaterial,
      {name:"AES-GCM",length:256},
      false,
      ["decrypt"]
    );

    const cipher = b64(ENCRYPTED);
    const tag = b64(AUTH_TAG);
    const combined = new Uint8Array(cipher.length + tag.length);
    combined.set(cipher);
    combined.set(tag, cipher.length);

    const plaintext = await crypto.subtle.decrypt(
      {name:"AES-GCM", iv:b64(IV), tagLength:128},
      key,
      combined
    );

    document.getElementById("out").textContent =
      new TextDecoder().decode(plaintext);

    setTimeout(()=>document.body.innerHTML="⛔ Nội dung đã bị huỷ",10000);
  }catch{
    alert("❌ Secret sai");
  }
}
</script>
</body>
</html>`);
  } catch {
    res.status(403).send("⛔ Token không hợp lệ");
  }
});
