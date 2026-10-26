require("dotenv").config();
const readline = require("readline/promises");
const mysql = require("mysql2/promise");
const { newSalt, hashPassword } = require("./security");

function strongEnough(pw) {
  return pw.length >= 10 && /[a-z]/.test(pw) && /[A-Z]/.test(pw) &&
         /\d/.test(pw) && /[^A-Za-z0-9]/.test(pw);
}

async function main() {
  if (!process.env.PEPPER || process.env.PEPPER.length < 32) {
    console.log("PEPPER is missing in .env.");
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const username = (await rl.question("Username to reset: ")).trim();
  const password = await rl.question("New password: ");
  rl.close();

  if (!strongEnough(password)) {
    console.log("Password needs 10+ characters with upper, lower, number and symbol.");
    return;
  }

  const db = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
  });

  try {
    const salt = newSalt();
    const hash = await hashPassword(password, salt);

    const [result] = await db.execute(
      "UPDATE users SET password_hash = ?, salt = ?, failed_attempts = ?, locked_until = NULL WHERE username = ?",
      [hash, salt, 0, username]
    );

    if (result.affectedRows === 0) {
      console.log("No user found with that username.");
    } else {
      await db.execute(
        "INSERT INTO audit_log (username_tried, action, details, result) VALUES (?, ?, ?, ?)",
        [username, "Password reset", "Reset from the server command line", "Success"]
      );
      console.log("Password changed for " + username + ". The account is unlocked.");
    }
  } catch (err) {
    console.log("Error:", err.message);
  } finally {
    await db.end();
  }
}

main();