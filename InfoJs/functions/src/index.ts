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
// const slugify = (str: string) => {
//   return str
//     .normalize("NFD")
//     .replace(/[\u0300-\u036f]/g, "")
//     .replace(/đ/g, "d")
//     .replace(/Đ/g, "D")
//     .replace(/[^a-zA-Z0-9]+/g, "_")
//     .toLowerCase()
//     .replace(/^_+|_+$/g, "");
// };
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
const buildSlugAndTokens = (input: string) => {
  const normalized = normalizeVN(input);

  const parts = normalized.split(" ");

  return {
    slugName: parts.join("_"), // nguyen_van_an
    tokens: parts, // ["nguyen", "van", "an"]
  };
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

// export const createSampleDoc = onRequest(async (req, res) => {
//   try {
//     const {uid, secret, name, address, plaintext} = req.body;
//     if (!uid || !secret || !name || !address || !plaintext) {
//       res.status(400).send(
// "Thiếu uid / secret / name / address / plaintext");
//       return;
//     }

//     const salt = crypto.randomBytes(16);
//     const iv = crypto.randomBytes(12);

//     const key = crypto.pbkdf2Sync(secret, salt, 150_000, 32, "sha256");

//     const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
//     const encrypted = Buffer.concat([
//       cipher.update(plaintext, "utf8"),
//       cipher.final(),
//     ]);
//     const authTag = cipher.getAuthTag();
//     const dataName = buildSlugAndTokens(name);

//     await db.collection("doituongs").add({
//       encryptedContent: encrypted.toString("base64"),
//       iv: iv.toString("base64"),
//       salt: salt.toString("base64"),
//       authTag: authTag.toString("base64"),
//       version: 1,
//       createdAt: Date.now(),

//       slugName: dataName.slugName,
//       name,
//       address,
//       tokens: dataName.tokens,

//       ownerUid: uid,
//       shareWith: [],
//       public: false,
//     });


//     res.send("✅ Sample document đã tạo (E2EE-ready)");
//   } catch (e: any) {
//     res.status(500).send(e.message);
//   }
// });

// ----------------TELEGRAM BOT------------------------------
export const createSampleDoc = onRequest(async (req, res) => {
  try {
    const {uid, secret, name, address, plaintext} = req.body;

    if (!uid || !secret || !name || !address || !plaintext) {
      res.status(400).send("Thiếu uid / secret / name / address / plaintext");
      return;
    }

    // =========================
    // 1️⃣ Sinh DEK (per document)
    // =========================
    const dek = crypto.randomBytes(32); // 256-bit

    // =========================
    // 2️⃣ Encrypt plaintext bằng DEK
    // =========================
    const dekIv = crypto.randomBytes(12);
    const cipherTextCipher = crypto.createCipheriv(
      "aes-256-gcm",
      dek,
      dekIv
    );

    const ciphertext = Buffer.concat([
      cipherTextCipher.update(plaintext, "utf8"),
      cipherTextCipher.final(),
    ]);
    const cipherAuthTag = cipherTextCipher.getAuthTag();

    // =========================
    // 3️⃣ Derive KEK từ secret
    // =========================
    const kekSalt = crypto.randomBytes(16);
    const kek = crypto.pbkdf2Sync(
      secret,
      kekSalt,
      150_000,
      32,
      "sha256"
    );

    // =========================
    // 4️⃣ Encrypt DEK bằng KEK
    // =========================
    const kekIv = crypto.randomBytes(12);
    const dekCipher = crypto.createCipheriv(
      "aes-256-gcm",
      kek,
      kekIv
    );

    const encryptedDEK = Buffer.concat([
      dekCipher.update(dek),
      dekCipher.final(),
    ]);
    const dekAuthTag = dekCipher.getAuthTag();

    // =========================
    // 5️⃣ Metadata
    // =========================
    const dataName = buildSlugAndTokens(name);

    // =========================
    // 6️⃣ Save Firestore
    // =========================
    await db.collection("doituongs").add({
      // 🔐 crypto data
      ciphertext: ciphertext.toString("base64"),
      cipherIv: dekIv.toString("base64"),
      cipherAuthTag: cipherAuthTag.toString("base64"),

      encryptedDEK: encryptedDEK.toString("base64"),
      kekIv: kekIv.toString("base64"),
      dekAuthTag: dekAuthTag.toString("base64"),
      kekSalt: kekSalt.toString("base64"),

      version: 2,
      createdAt: Date.now(),

      // 🔎 search / display
      slugName: dataName.slugName,
      tokens: dataName.tokens,
      name,
      address,

      // 🔐 permission
      ownerUid: uid,
      sharedWith: [],
      public: false,
    });

    res.send("✅ Sample document đã tạo (KEK / DEK – v2)");
  } catch (e: any) {
    res.status(500).send(e.message);
  }
});

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
       /chondoituong_<slug> <id>
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


// export const view = onRequest(async (req, res) => {
//   try {
//     // 🚫 chặn Telegram preview
//     const ua = String(req.headers["user-agent"] || "");
//     if (/TelegramBot|bot|crawler|spider/i.test(ua)) {
//       res.status(204).end();
//       return;
//     }

//     const token = String(req.query.token || "");
//     if (!token) throw new Error();

//     const ref = db.collection("viewTokens").doc(token);
//     let tokenData: any;

//     await db.runTransaction(async (tx) => {
//       const snap = await tx.get(ref);
//       if (!snap.exists) throw new Error();

//       const d = snap.data()!;
//       if (d.used || Date.now() > d.expiresAt) throw new Error();

//       tokenData = d;
//       tx.update(ref, {used: true});
//     });

//     const docSnap = await db
//       .collection("doituongs")
//       .doc(tokenData.docId)
//       .get();

//     if (!docSnap.exists) throw new Error();
//     const d = docSnap.data()!;

//     if (!d.encryptedContent || !d.iv || !d.salt || !d.authTag) {
//       throw new Error();
//     }

//     res.setHeader("Content-Type", "text/html; charset=utf-8");
//     res.send(`<!doctype html>
// <html>
// <body>
// <h3>🔐 Nhập secret để giải mã</h3>
// <input type="password" id="secret"/>
// <button onclick="decrypt()">Giải mã</button>
// <pre id="out"></pre>

// <script>
// const ENCRYPTED = "${d.encryptedContent}";
// const IV = "${d.iv}";
// const SALT = "${d.salt}";
// const AUTH_TAG = "${d.authTag}";

// function b64(b){return Uint8Array.from(atob(b),c=>c.charCodeAt(0));}

// let attempts = 0;

// async function decrypt(){
//   try{
//     if(++attempts > 5){
//       document.body.innerHTML = "⛔ Quá số lần thử";
//       return;
//     }

//     const secret = document.getElementById("secret").value;
//     const enc = new TextEncoder();

//     const keyMaterial = await crypto.subtle.importKey(
//       "raw", enc.encode(secret), "PBKDF2", false, ["deriveKey"]
//     );

//     const key = await crypto.subtle.deriveKey(
//       {
//         name:"PBKDF2",
//         salt:b64(SALT),
//         iterations:150000,
//         hash:"SHA-256"
//       },
//       keyMaterial,
//       {name:"AES-GCM",length:256},
//       false,
//       ["decrypt"]
//     );

//     const cipher = b64(ENCRYPTED);
//     const tag = b64(AUTH_TAG);
//     const combined = new Uint8Array(cipher.length + tag.length);
//     combined.set(cipher);
//     combined.set(tag, cipher.length);

//     const plaintext = await crypto.subtle.decrypt(
//       {name:"AES-GCM", iv:b64(IV), tagLength:128},
//       key,
//       combined
//     );

//     document.getElementById("out").textContent =
//       new TextDecoder().decode(plaintext);

//     setTimeout(()=>document.body.innerHTML="⛔ Nội dung đã bị huỷ",300000);
//   }catch{
//     alert("❌ Secret sai");
//   }
// }
// </script>
// </body>
// </html>`);
//   } catch {
//     res.status(403).send("⛔ Token không hợp lệ");
//   }
// });
