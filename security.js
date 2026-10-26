const crypto = require("crypto");

function newSalt() {
  return crypto.randomBytes(16).toString("hex");
}

function pepperPassword(password) {
  return crypto.createHmac("sha256", process.env.PEPPER).update(password).digest();
}

function hashPassword(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(pepperPassword(password), salt, 64, (err, key) => {
      if (err) reject(err);
      else resolve(key.toString("hex"));
    });
  });
}

async function verifyPassword(password, salt, storedHash) {
  const attempt = Buffer.from(await hashPassword(password, salt), "hex");
  const real = Buffer.from(storedHash, "hex");
  return attempt.length === real.length && crypto.timingSafeEqual(attempt, real);
}

// ---------- Encryption for 2FA secrets (AES-256-GCM) ----------
function getKey() {
  return Buffer.from(process.env.TOTP_KEY, "hex");
}

function encryptText(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getKey(), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("hex"), tag.toString("hex"), data.toString("hex")].join(":");
}

function decryptText(stored) {
  const [ivHex, tagHex, dataHex] = stored.split(":");
  const decipher = crypto.createDecipheriv("aes-256-gcm", getKey(), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataHex, "hex")),
    decipher.final()
  ]).toString("utf8");
}

module.exports = { newSalt, hashPassword, verifyPassword, encryptText, decryptText };