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
    console.log("PEPPER is missing in .env. Do step A and B first.");
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const fullName = (await rl.question("Full name: ")).trim();
  const username = (await rl.question("Username: ")).trim();
  const password = await rl.question("Password: ");
  rl.close();

  if (!fullName) { console.log("Full name is required."); return; }
  if (!/^[A-Za-z0-9_.-]{3,30}$/.test(username)) {
    console.log("Username: 3-30 letters, numbers, dot, dash or underscore.");
    return;
  }
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
    const [roles] = await db.execute("SELECT id FROM roles WHERE name = ?", ["Admin"]);
    const salt = newSalt();
    const hash = await hashPassword(password, salt);

    await db.execute(
      "INSERT INTO users (full_name, username, password_hash, salt, role_id) VALUES (?, ?, ?, ?, ?)",
      [fullName, username, hash, salt, roles[0].id]
    );
    await db.execute(
      "INSERT INTO audit_log (username_tried, action, details, result) VALUES (?, ?, ?, ?)",
      [username, "Create admin", "First admin account created", "Success"]
    );
    console.log("Admin account created for " + username);
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") console.log("That username already exists.");
    else console.log("Error:", err.message);
  } finally {
    await db.end();
  }
}

main();