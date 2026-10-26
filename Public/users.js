(function () {
  const body = document.getElementById("usersBody");
  let me = null;

  function esc(text) {
    const div = document.createElement("div");
    div.textContent = String(text);
    return div.innerHTML;
  }

  function msg(text, isError) {
    const el = document.getElementById("userMsg");
    el.textContent = text;
    el.className = isError ? "msg error" : "msg";
  }

  async function api(method, url, data) {
    const options = { method, headers: {} };
    if (data) {
      options.headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(data);
    }
    const res = await fetch(url, options);
    if (res.status === 401) {
      window.location.href = "/login.html";
      throw new Error("Signed out");
    }
    return res.json();
  }

  function render(users) {
    body.innerHTML = users.map(function (u) {
      const isMe = u.id === me;
      const roleOptions = ["Admin", "Manager", "Receptionist"].map(function (r) {
        return "<option" + (r === u.role ? " selected" : "") + ">" + r + "</option>";
      }).join("");

      const actions = isMe ? "(this is you)" : `
        <button class="small" data-act="toggle" data-id="${u.id}" data-active="${u.is_active ? 1 : 0}">${u.is_active ? "Disable" : "Enable"}</button>
        ${u.is_locked ? `<button class="small" data-act="unlock" data-id="${u.id}">Unlock</button>` : ""}
        <button class="small" data-act="reset2fa" data-id="${u.id}">Reset 2FA</button>
        <button class="small" data-act="password" data-id="${u.id}">New password</button>
        <button class="small danger" data-act="delete" data-id="${u.id}" data-name="${esc(u.username)}">Delete</button>`;

      return `<tr>
        <td>${esc(u.full_name)}</td>
        <td>${esc(u.username)}</td>
        <td><select data-role="${u.id}" ${isMe ? "disabled" : ""}>${roleOptions}</select></td>
        <td><span class="badge ${u.is_active ? "active" : "disabled"}">${u.is_active ? "Active" : "Disabled"}</span>
            ${u.is_locked ? ' <span class="badge disabled">Locked</span>' : ""}</td>
        <td>${u.two_fa_linked ? "Linked" : "Not set up"}</td>
        <td>${actions}</td>
      </tr>`;
    }).join("");
  }

  async function load() {
    try {
      const data = await api("GET", "/api/admin/users");
      if (!data.ok) { msg(data.message, true); return; }
      me = data.me;
      render(data.users);
    } catch (err) { /* redirected to login */ }
  }

  // Add user
  document.getElementById("addUserBtn").addEventListener("click", async function () {
    const payload = {
      fullName: document.getElementById("newName").value.trim(),
      username: document.getElementById("newUsername").value.trim(),
      password: document.getElementById("newPassword").value,
      role: document.getElementById("newRole").value
    };
    if (!payload.fullName || !payload.username || !payload.password) {
      msg("Fill in the name, username and password.", true);
      return;
    }
    try {
      const data = await api("POST", "/api/admin/users", payload);
      if (data.ok) {
        document.getElementById("newName").value = "";
        document.getElementById("newUsername").value = "";
        document.getElementById("newPassword").value = "";
        msg("User created.");
        load();
      } else {
        msg(data.message, true);
      }
    } catch (err) {}
  });

  // Buttons in the table
  body.addEventListener("click", async function (e) {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const id = btn.dataset.id;
    const act = btn.dataset.act;
    let data;

    try {
      if (act === "toggle") {
        data = await api("PATCH", "/api/admin/users/" + id + "/status", { active: btn.dataset.active !== "1" });
      } else if (act === "unlock") {
        data = await api("POST", "/api/admin/users/" + id + "/unlock");
      } else if (act === "reset2fa") {
        if (!confirm("Reset two-factor for this user? They will scan a new QR code at next sign-in.")) return;
        data = await api("POST", "/api/admin/users/" + id + "/reset-2fa");
      } else if (act === "password") {
        const pw = prompt("Type the new password (10+ characters, upper, lower, number, symbol):");
        if (!pw) return;
        data = await api("POST", "/api/admin/users/" + id + "/password", { password: pw });
      } else if (act === "delete") {
        if (!confirm("Delete " + btn.dataset.name + "? A copy is kept in the deleted-data database.")) return;
        data = await api("DELETE", "/api/admin/users/" + id);
      }
      msg(data.ok ? "Done." : data.message, !data.ok);
      load();
    } catch (err) {}
  });

  // Role dropdown
  body.addEventListener("change", async function (e) {
    if (e.target.dataset.role === undefined) return;
    try {
      const data = await api("PATCH", "/api/admin/users/" + e.target.dataset.role + "/role", { role: e.target.value });
      msg(data.ok ? "Role updated." : data.message, !data.ok);
      load();
    } catch (err) {}
  });

  load();
})();