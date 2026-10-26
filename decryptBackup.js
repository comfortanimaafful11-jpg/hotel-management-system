require("dotenv").config();
const fs = require("fs");
const crypto = require("crypto");

const file = process.argv[2];
if (!file) {
  console.log("Usage: node decryptBackup.js backups\\hotel-backup-XXXX.bak");
  process.exit(1);
}

const buf = fs.readFileSync(file);
const key = Buffer.from(process.env.BACKUP_KEY, "hex");
const decipher = crypto.createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12));
decipher.setAuthTag(buf.subarray(12, 28));
const plain = Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]);

fs.writeFileSync(file + ".json", plain);
console.log("Decrypted copy saved as " + file + ".json");
console.log("It contains private data. Delete it when you are done looking.");