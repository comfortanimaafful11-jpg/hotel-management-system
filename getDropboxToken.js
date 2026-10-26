require("dotenv").config();

const key = process.env.DROPBOX_APP_KEY;
const secret = process.env.DROPBOX_APP_SECRET;
const code = process.argv[2];

if (!key || !secret || !code) {
  console.log("Put DROPBOX_APP_KEY and DROPBOX_APP_SECRET in .env first, then run:");
  console.log("node getDropboxToken.js THE_CODE_FROM_DROPBOX");
  process.exit(1);
}

(async () => {
  const basic = Buffer.from(key + ":" + secret).toString("base64");
  const res = await fetch("https://api.dropbox.com/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: "Basic " + basic,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({ code, grant_type: "authorization_code" })
  });
  const data = await res.json();

  if (!res.ok || !data.refresh_token) {
    console.log("Dropbox said no (" + res.status + "): " + (data.error_description || data.error || "unknown error"));
    console.log("Codes work only once and expire quickly. Get a fresh code and try again.");
    return;
  }
  console.log("Success. Add this line to .env and keep it secret:");
  console.log("DROPBOX_REFRESH_TOKEN=" + data.refresh_token);
})();