const loginForm = document.getElementById("loginForm");
const twoFaForm = document.getElementById("twoFaForm");
const message = document.getElementById("message");
const passwordInput = document.getElementById("password");
const toggleBtn = document.getElementById("togglePassword");
const backBtn = document.getElementById("backBtn");
const setupBox = document.getElementById("setupBox");

async function postJSON(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {})
  });
  return response.json();
}

function backToStart() {
  twoFaForm.classList.add("hidden");
  setupBox.classList.add("hidden");
  loginForm.classList.remove("hidden");
  document.getElementById("code").value = "";
}

toggleBtn.addEventListener("click", function () {
  const isHidden = passwordInput.type === "password";
  passwordInput.type = isHidden ? "text" : "password";
  toggleBtn.textContent = isHidden ? "Hide" : "Show";
});

// Step 1: username + password
loginForm.addEventListener("submit", async function (event) {
  event.preventDefault();
  const username = document.getElementById("username").value.trim();
  const password = passwordInput.value;

  if (username === "" || password === "") {
    message.textContent = "Please enter your username and password.";
    return;
  }

  try {
    const data = await postJSON("/api/login", { username, password });
    if (!data.ok) { message.textContent = data.message; return; }

    message.textContent = "";
    passwordInput.value = "";
    loginForm.classList.add("hidden");
    twoFaForm.classList.remove("hidden");

    if (data.next === "2fa-setup") {
      const setup = await postJSON("/api/2fa/setup");
      if (setup.ok) {
        document.getElementById("qrImg").src = setup.qr;
        document.getElementById("manualKey").textContent = setup.key;
        document.getElementById("twoFaHelp").textContent =
          "First time: scan this QR code with Google Authenticator or Microsoft Authenticator, then enter the 6-digit code.";
        setupBox.classList.remove("hidden");
      } else {
        message.textContent = setup.message;
        backToStart();
        return;
      }
    }
    document.getElementById("code").focus();
  } catch (err) {
    message.textContent = "Cannot reach the server. Is it running?";
  }
});

// Step 2: the 6-digit code
twoFaForm.addEventListener("submit", async function (event) {
  event.preventDefault();
  const code = document.getElementById("code").value.trim();

  if (!/^\d{6}$/.test(code)) {
    message.textContent = "Enter the 6-digit code (numbers only).";
    return;
  }

  try {
    const data = await postJSON("/api/2fa/verify", { code });
    if (data.ok) {
      window.location.href = data.redirect;
    } else {
      message.textContent = data.message;
      if (data.restart) backToStart();
      document.getElementById("code").value = "";
    }
  } catch (err) {
    message.textContent = "Cannot reach the server. Is it running?";
  }
});

backBtn.addEventListener("click", function () {
  backToStart();
  message.textContent = "";
});