import * as admin from "firebase-admin";
import {setGlobalOptions} from "firebase-functions/v2/options";
import {onRequest} from "firebase-functions/v2/https";
import bcrypt from "bcrypt";
import * as crypto from "crypto";
import {defineSecret} from "firebase-functions/params";

setGlobalOptions({region: "asia-southeast1"});
admin.initializeApp();
const db = admin.firestore();
const TELEGRAM_BOT_TOKEN = defineSecret("TELEGRAM_BOT_TOKEN");

async function sendTelegram(chatId: number, text: string) {
  await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN.value()}/sendMessage`,
    {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({chat_id: chatId, text}),
    }
  );
}
// function getAESKey(secret: string, uid: string): Buffer {
//   return crypto.pbkdf2Sync(secret, uid, 100_000, 32, "sha256");
// }
function getAESKeyAsync(secret: string, uid: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(
      secret,
      uid,
      100_000,
      32,
      "sha256",
      (err, key) => {
        if (err) reject(err);
        else resolve(key);
      }
    );
  });
}

function encryptAESGCM(plaintext: string, key: Buffer) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);

  let encrypted = cipher.update(plaintext, "utf8", "base64");
  encrypted += cipher.final("base64");

  return {
    encryptedContent: encrypted,
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}
function decryptAESGCM(
  encrypted: string,
  key: Buffer,
  ivBase64: string,
  authTagBase64: string
): string {
  const iv = Buffer.from(ivBase64, "base64");
  const authTag = Buffer.from(authTagBase64, "base64");

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encrypted, "base64", "utf8");
  decrypted += decipher.final("utf8");

  return decrypted;
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

    // const key = getAESKey(secret, uid);
    const key = await getAESKeyAsync(secret, uid);

    const plaintext =
      "📓 Nhật ký ngày thứ nhất\n📝 Đây là nội dung bí mật." +
      "Ngày xửa ngày xưa, có một con Rùa và một con Thỏ sống "+
      "trong một khu rừng xinh đẹp và yên tĩnh. Ngày ngày chúng "+
      "vui chơi với nhau như hai người bạn thân. Một hôm, "+
      "Thỏ và Rùa cãi nhau xem ai nhanh hơn.\n"+
      "Rồi chúng quyết định giải quyết việc tranh "+
      "luận bằng một cuộc thi chạy đua. Thỏ và Rùa đồng "+
      "ý lộ trình và bắt đầu cuộc đua. Thỏ xuất phát nhanh "+
      "như tên bắn và chạy thục mạng rất nhanh, khi thấy "+
      "rằng mình đã khá xa Rùa, Thỏ nghĩ nên nghỉ cho đỡ "+
      "mệt dưới một bóng cây xum xuê lá bên vệ đường.\n"+
      "Vì quá tự tin vào khả năng giành chiến thắng của "+
      "mình, Thỏ ngồi dưới bóng cây và nhanh chóng ngủ "+
      "thiếp đi. Rùa chạy mãi rồi cũng đến nơi, thấy "+
      "Thỏ đang ngủ ngon giấc Rùa từ từ vượt qua Thỏ "+
      "và về đích trước Thỏ. Khi Thỏ thức dậy thì rùa"+
      " đã đến đích và trở thành người chiến thắng.\n"+
      "Rùa vì sự kiên trì bền bỉ mà chiến thắng chú Thỏ.\n"+
      "Lúc này Thỏ biết mình đã thua cuộc vì quá "+
      "tự tin vào khả năng của mình, còn Rùa chiến "+
      "thắng vì kiên trì bám đuổi mục tiêu và làm "+
      "việc hết sức trong khả năng của mình, cộng "+
      "với một chút may mắn và giành chiến thắng.\n"+
      "Truyện giáo dục đức tính kiên trì, siêng năng, "+
      "nhẫn nại. Những người nhanh nhẹn nhưng cẩu thả "+
      "trong suy nghĩ cuối cùng cũng sẽ bị đánh bại bởi "+
      "người kiên nhẫn, siêng năng dù họ chậm hơn rất nhiều.\n\n\n"+
      "Ngày xửa ngày xưa, có một con Rùa và một con Thỏ sống "+
      "trong một khu rừng xinh đẹp và yên tĩnh. Ngày ngày chúng "+
      "vui chơi với nhau như hai người bạn thân. Một hôm, "+
      "Thỏ và Rùa cãi nhau xem ai nhanh hơn.\n"+
      "Rồi chúng quyết định giải quyết việc tranh "+
      "luận bằng một cuộc thi chạy đua. Thỏ và Rùa đồng "+
      "ý lộ trình và bắt đầu cuộc đua. Thỏ xuất phát nhanh "+
      "như tên bắn và chạy thục mạng rất nhanh, khi thấy "+
      "rằng mình đã khá xa Rùa, Thỏ nghĩ nên nghỉ cho đỡ "+
      "mệt dưới một bóng cây xum xuê lá bên vệ đường.\n"+
      "Vì quá tự tin vào khả năng giành chiến thắng của "+
      "mình, Thỏ ngồi dưới bóng cây và nhanh chóng ngủ "+
      "thiếp đi. Rùa chạy mãi rồi cũng đến nơi, thấy "+
      "Thỏ đang ngủ ngon giấc Rùa từ từ vượt qua Thỏ "+
      "và về đích trước Thỏ. Khi Thỏ thức dậy thì rùa"+
      " đã đến đích và trở thành người chiến thắng.\n"+
      "Rùa vì sự kiên trì bền bỉ mà chiến thắng chú Thỏ.\n"+
      "Lúc này Thỏ biết mình đã thua cuộc vì quá "+
      "tự tin vào khả năng của mình, còn Rùa chiến "+
      "thắng vì kiên trì bám đuổi mục tiêu và làm "+
      "việc hết sức trong khả năng của mình, cộng "+
      "với một chút may mắn và giành chiến thắng.\n"+
      "Truyện giáo dục đức tính kiên trì, siêng năng, "+
      "nhẫn nại. Những người nhanh nhẹn nhưng cẩu thả "+
      "trong suy nghĩ cuối cùng cũng sẽ bị đánh bại bởi "+
      "người kiên nhẫn, siêng năng dù họ chậm hơn rất nhiều.\n\n\n"+
      "Ngày xửa ngày xưa, có một con Rùa và một con Thỏ sống "+
      "trong một khu rừng xinh đẹp và yên tĩnh. Ngày ngày chúng "+
      "vui chơi với nhau như hai người bạn thân. Một hôm, "+
      "Thỏ và Rùa cãi nhau xem ai nhanh hơn.\n"+
      "Rồi chúng quyết định giải quyết việc tranh "+
      "luận bằng một cuộc thi chạy đua. Thỏ và Rùa đồng "+
      "ý lộ trình và bắt đầu cuộc đua. Thỏ xuất phát nhanh "+
      "như tên bắn và chạy thục mạng rất nhanh, khi thấy "+
      "rằng mình đã khá xa Rùa, Thỏ nghĩ nên nghỉ cho đỡ "+
      "mệt dưới một bóng cây xum xuê lá bên vệ đường.\n"+
      "Vì quá tự tin vào khả năng giành chiến thắng của "+
      "mình, Thỏ ngồi dưới bóng cây và nhanh chóng ngủ "+
      "thiếp đi. Rùa chạy mãi rồi cũng đến nơi, thấy "+
      "Thỏ đang ngủ ngon giấc Rùa từ từ vượt qua Thỏ "+
      "và về đích trước Thỏ. Khi Thỏ thức dậy thì rùa"+
      " đã đến đích và trở thành người chiến thắng.\n"+
      "Rùa vì sự kiên trì bền bỉ mà chiến thắng chú Thỏ.\n"+
      "Lúc này Thỏ biết mình đã thua cuộc vì quá "+
      "tự tin vào khả năng của mình, còn Rùa chiến "+
      "thắng vì kiên trì bám đuổi mục tiêu và làm "+
      "việc hết sức trong khả năng của mình, cộng "+
      "với một chút may mắn và giành chiến thắng.\n"+
      "Truyện giáo dục đức tính kiên trì, siêng năng, "+
      "nhẫn nại. Những người nhanh nhẹn nhưng cẩu thả "+
      "trong suy nghĩ cuối cùng cũng sẽ bị đánh bại bởi "+
      "người kiên nhẫn, siêng năng dù họ chậm hơn rất nhiều.\n\n\n"+
      "Ngày xửa ngày xưa, có một con Rùa và một con Thỏ sống "+
      "trong một khu rừng xinh đẹp và yên tĩnh. Ngày ngày chúng "+
      "vui chơi với nhau như hai người bạn thân. Một hôm, "+
      "Thỏ và Rùa cãi nhau xem ai nhanh hơn.\n"+
      "Rồi chúng quyết định giải quyết việc tranh "+
      "luận bằng một cuộc thi chạy đua. Thỏ và Rùa đồng "+
      "ý lộ trình và bắt đầu cuộc đua. Thỏ xuất phát nhanh "+
      "như tên bắn và chạy thục mạng rất nhanh, khi thấy "+
      "rằng mình đã khá xa Rùa, Thỏ nghĩ nên nghỉ cho đỡ "+
      "mệt dưới một bóng cây xum xuê lá bên vệ đường.\n"+
      "Vì quá tự tin vào khả năng giành chiến thắng của "+
      "mình, Thỏ ngồi dưới bóng cây và nhanh chóng ngủ "+
      "thiếp đi. Rùa chạy mãi rồi cũng đến nơi, thấy "+
      "Thỏ đang ngủ ngon giấc Rùa từ từ vượt qua Thỏ "+
      "và về đích trước Thỏ. Khi Thỏ thức dậy thì rùa"+
      " đã đến đích và trở thành người chiến thắng.\n"+
      "Rùa vì sự kiên trì bền bỉ mà chiến thắng chú Thỏ.\n"+
      "Lúc này Thỏ biết mình đã thua cuộc vì quá "+
      "tự tin vào khả năng của mình, còn Rùa chiến "+
      "thắng vì kiên trì bám đuổi mục tiêu và làm "+
      "việc hết sức trong khả năng của mình, cộng "+
      "với một chút may mắn và giành chiến thắng.\n"+
      "Truyện giáo dục đức tính kiên trì, siêng năng, "+
      "nhẫn nại. Những người nhanh nhẹn nhưng cẩu thả "+
      "trong suy nghĩ cuối cùng cũng sẽ bị đánh bại bởi "+
      "người kiên nhẫn, siêng năng dù họ chậm hơn rất nhiều.\n\n\n"+
      "Ngày xửa ngày xưa, có một con Rùa và một con Thỏ sống "+
      "trong một khu rừng xinh đẹp và yên tĩnh. Ngày ngày chúng "+
      "vui chơi với nhau như hai người bạn thân. Một hôm, "+
      "Thỏ và Rùa cãi nhau xem ai nhanh hơn.\n"+
      "Rồi chúng quyết định giải quyết việc tranh "+
      "luận bằng một cuộc thi chạy đua. Thỏ và Rùa đồng "+
      "ý lộ trình và bắt đầu cuộc đua. Thỏ xuất phát nhanh "+
      "như tên bắn và chạy thục mạng rất nhanh, khi thấy "+
      "rằng mình đã khá xa Rùa, Thỏ nghĩ nên nghỉ cho đỡ "+
      "mệt dưới một bóng cây xum xuê lá bên vệ đường.\n"+
      "Vì quá tự tin vào khả năng giành chiến thắng của "+
      "mình, Thỏ ngồi dưới bóng cây và nhanh chóng ngủ "+
      "thiếp đi. Rùa chạy mãi rồi cũng đến nơi, thấy "+
      "Thỏ đang ngủ ngon giấc Rùa từ từ vượt qua Thỏ "+
      "và về đích trước Thỏ. Khi Thỏ thức dậy thì rùa"+
      " đã đến đích và trở thành người chiến thắng.\n"+
      "Rùa vì sự kiên trì bền bỉ mà chiến thắng chú Thỏ.\n"+
      "Lúc này Thỏ biết mình đã thua cuộc vì quá "+
      "tự tin vào khả năng của mình, còn Rùa chiến "+
      "thắng vì kiên trì bám đuổi mục tiêu và làm "+
      "việc hết sức trong khả năng của mình, cộng "+
      "với một chút may mắn và giành chiến thắng.\n"+
      "Truyện giáo dục đức tính kiên trì, siêng năng, "+
      "nhẫn nại. Những người nhanh nhẹn nhưng cẩu thả "+
      "trong suy nghĩ cuối cùng cũng sẽ bị đánh bại bởi "+
      "người kiên nhẫn, siêng năng dù họ chậm hơn rất nhiều.\n\n\n"+
      "Ngày xửa ngày xưa, có một con Rùa và một con Thỏ sống "+
      "trong một khu rừng xinh đẹp và yên tĩnh. Ngày ngày chúng "+
      "vui chơi với nhau như hai người bạn thân. Một hôm, "+
      "Thỏ và Rùa cãi nhau xem ai nhanh hơn.\n"+
      "Rồi chúng quyết định giải quyết việc tranh "+
      "luận bằng một cuộc thi chạy đua. Thỏ và Rùa đồng "+
      "ý lộ trình và bắt đầu cuộc đua. Thỏ xuất phát nhanh "+
      "như tên bắn và chạy thục mạng rất nhanh, khi thấy "+
      "rằng mình đã khá xa Rùa, Thỏ nghĩ nên nghỉ cho đỡ "+
      "mệt dưới một bóng cây xum xuê lá bên vệ đường.\n"+
      "Vì quá tự tin vào khả năng giành chiến thắng của "+
      "mình, Thỏ ngồi dưới bóng cây và nhanh chóng ngủ "+
      "thiếp đi. Rùa chạy mãi rồi cũng đến nơi, thấy "+
      "Thỏ đang ngủ ngon giấc Rùa từ từ vượt qua Thỏ "+
      "và về đích trước Thỏ. Khi Thỏ thức dậy thì rùa"+
      " đã đến đích và trở thành người chiến thắng.\n"+
      "Rùa vì sự kiên trì bền bỉ mà chiến thắng chú Thỏ.\n"+
      "Lúc này Thỏ biết mình đã thua cuộc vì quá "+
      "tự tin vào khả năng của mình, còn Rùa chiến "+
      "thắng vì kiên trì bám đuổi mục tiêu và làm "+
      "việc hết sức trong khả năng của mình, cộng "+
      "với một chút may mắn và giành chiến thắng.\n"+
      "Truyện giáo dục đức tính kiên trì, siêng năng, "+
      "nhẫn nại. Những người nhanh nhẹn nhưng cẩu thả "+
      "trong suy nghĩ cuối cùng cũng sẽ bị đánh bại bởi "+
      "người kiên nhẫn, siêng năng dù họ chậm hơn rất nhiều.\n\n\n";

    const encrypted = encryptAESGCM(plaintext, key);

    await db.collection("documents").doc("nhatkyngaythunhat").set({
      ...encrypted,
      createdAt: Date.now(),
    });

    res.send("✅ Document đã được mã hoá & lưu");
  } catch (e: any) {
    res.status(500).send(e.message);
  }
});
export const telegramWebhook = onRequest(
  {secrets: [TELEGRAM_BOT_TOKEN]},
  async (req, res) => {
    // ⚠️ Telegram cần 200 ngay
    res.status(200).send("ok");

    const message = req.body.message;
    if (!message?.text) return;

    const chatId = message.chat.id;
    const text = message.text.trim();

    const [command, secret] = text.split(/\s+/);

    if (command !== "/nhatkyngaythunhat" || !secret) {
      return sendTelegram(chatId, "❌ Cú pháp: /nhatkyngaythunhat <secret>");
    }

    // 🔎 tìm user
    const snap = await db
      .collection("users")
      .where("telegramChatId", "==", chatId)
      .limit(1)
      .get();

    if (snap.empty) {
      return sendTelegram(chatId, "⛔ Không xác định người dùng");
    }

    const userDoc = snap.docs[0];
    const user = userDoc.data();

    // 🔐 verify secret
    const ok = await bcrypt.compare(secret, user.secretHash);
    if (!ok) {
      return sendTelegram(chatId, "⛔ Secret không đúng");
    }

    // 📄 lấy document
    // const docSnap = await db
    //   .collection("documents")
    //   .doc("nhatkyngaythunhat")
    //   .get();

    // if (!docSnap.exists) {
    //   return sendTelegram(chatId, "❌ Không có dữ liệu");
    // }

    // const d = docSnap.data()!;

    // // 🔓 decrypt
    // const key = getAESKey(secret, userDoc.id);
    // const plain = decryptAESGCM(
    //   d.encryptedContent,
    //   key,
    //   d.iv,
    //   d.authTag
    // );

    // // 📤 gửi nội dung
    // await sendTelegram(
    //   chatId,
    //   `📓 Nhật ký ngày thứ nhất\n\n${plain}`
    // );

    const token = crypto.randomUUID();

    await db.collection("viewTokens").doc(token).set({
      uid: userDoc.id,
      docId: "nhatkyngaythunhat",
      secret,
      used: false,
      expiresAt: Date.now() + 60000,
    });

    const url =
      `https://asia-southeast1-infojs-c6205.cloudfunctions.net/view?token=${token}`;

    await sendTelegram(
      chatId,
      "📓 Nhật ký ngày thứ nhất\n" +
      "⏱ Link chỉ dùng 1 lần (60s)\n" +
      `👉 ${url}`
    );
  }
);

// ---------------------------------------------------
// ============================
// VIEW FUNCTION – 1 LẦN / 1 PHÚT
// ============================
export const view = onRequest(async (req, res) => {
  try {
    // 🚫 Chặn Telegram / bot preview
    const ua = String(req.headers["user-agent"] || "");
    if (/TelegramBot|bot|crawler|spider/i.test(ua)) {
      res.status(204).end();
      return;
    }

    const token = String(req.query.token || "");
    if (!token) {
      res.status(400).send("No token");
      return;
    }

    const ref = db.collection("viewTokens").doc(token);

    let plain = "";

    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) {
        throw new Error("TOKEN_NOT_FOUND");
      }

      const data = snap.data()!;
      if (data.used || Date.now() > data.expiresAt) {
        throw new Error("TOKEN_EXPIRED");
      }

      const docSnap = await tx.get(
        db.collection("documents").doc(data.docId)
      );

      if (!docSnap.exists) {
        throw new Error("DOC_NOT_FOUND");
      }

      const d = docSnap.data()!;

      // const key = getAESKey(data.secret, data.uid);
      const key = await getAESKeyAsync(data.secret, data.uid);
      plain = decryptAESGCM(
        d.encryptedContent,
        key,
        d.iv,
        d.authTag
      );

      // ✅ Đánh dấu token đã dùng
      tx.update(ref, {used: true});
    });

    // ✅ CHỈ SEND RESPONSE 1 LẦN – NGOÀI TRANSACTION
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`
      <pre>${plain}</pre>
      <script>
        setTimeout(() => {
          document.body.innerHTML = "⛔ Nội dung đã bị huỷ";
        }, 10000);
      </script>
    `);
  } catch (e) {
    res.status(403).send("⛔ Token không hợp lệ hoặc đã hết hạn");
  }
});
