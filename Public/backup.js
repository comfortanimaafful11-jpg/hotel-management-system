(function () {
  function $(id) { return document.getElementById(id); }

  function esc(text) {
    const div = document.createElement("div");
    div.textContent = text === null || text === undefined ? "" : String(text);
    return div.innerHTML;
  }
  function msg(id, text, isError) {
    const el = $(id);
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
    const text = await res.text();
    try { return JSON.parse(text); }
    catch (e) { throw new Error("Server replied with status " + res.status + ". Is server.js updated and restarted?"); }
  }

  // ---------- Backups ----------
  async function loadBackups() {
    try {
      const data = await api("GET", "/api/admin/backups");
      if (!data.ok) { msg("backupMsg", data.message, true); return; }
      $("backupBody").innerHTML = data.backups.length
        ? data.backups.map(b => `
          <tr>
            <td>${esc(b.taken_at)}</td><td>${esc(b.type)}</td><td>${esc(b.file_name)}</td>
            <td><span class="badge ${b.status === "Success" ? "active" : "disabled"}">${esc(b.status)}</span></td>
            <td>${b.status === "Success" ? `<button class="small" data-verify="${b.id}">Verify</button>` : ""}</td>
          </tr>`).join("")
        : "<tr><td colspan='5'>No backups yet.</td></tr>";
    } catch (err) { msg("backupMsg", "Problem: " + err.message, true); }
  }

  $("backupBtn").addEventListener("click", async function () {
    msg("backupMsg", "Backing up...");
    try {
      const data = await api("POST", "/api/admin/backups");
      msg("backupMsg", data.ok ? "Backup saved: " + data.fileName : data.message, !data.ok);
      loadBackups();
    } catch (err) { msg("backupMsg", "Problem: " + err.message, true); }
  });

  $("backupBody").addEventListener("click", async function (e) {
    const id = e.target.dataset.verify;
    if (!id) return;
    msg("backupMsg", "Checking...");
    try {
      const data = await api("POST", "/api/admin/backups/" + id + "/verify");
      msg("backupMsg", data.message, !data.ok);
    } catch (err) { msg("backupMsg", "Problem: " + err.message, true); }
  });

  // ---------- Restore points ----------
  async function loadPoints() {
    try {
      const data = await api("GET", "/api/admin/restore-points");
      if (!data.ok) { msg("rpMsg", data.message, true); return; }
      $("rpBody").innerHTML = data.points.length
        ? data.points.map(p => `
          <tr>
            <td>${esc(p.created_at)}</td><td>${esc(p.label)}</td>
            <td><button class="small" data-apply="${p.id}" data-label="${esc(p.label)}">Restore settings</button></td>
          </tr>`).join("")
        : "<tr><td colspan='3'>No restore points yet.</td></tr>";
    } catch (err) { msg("rpMsg", "Problem: " + err.message, true); }
  }

  $("rpCreateBtn").addEventListener("click", async function () {
    try {
      const data = await api("POST", "/api/admin/restore-points", { label: $("rpLabel").value });
      if (data.ok) {
        $("rpLabel").value = "";
        msg("rpMsg", "Restore point created.");
        loadPoints();
      } else {
        msg("rpMsg", data.message, true);
      }
    } catch (err) { msg("rpMsg", "Problem: " + err.message, true); }
  });

  $("rpBody").addEventListener("click", async function (e) {
    const id = e.target.dataset.apply;
    if (!id) return;
    if (!confirm("Restore settings from \"" + e.target.dataset.label + "\"?\n\nOnly hotel information, security settings and permissions change. Guests, bookings, payments and accounts are NOT touched. Your current settings are saved first.")) return;
    try {
      const data = await api("POST", "/api/admin/restore-points/" + id + "/apply");
      msg("rpMsg", data.ok ? "Settings restored. Your previous settings were saved as a new restore point." : data.message, !data.ok);
      loadPoints();
    } catch (err) { msg("rpMsg", "Problem: " + err.message, true); }
  });

  // Reload when you open the section
  $("nav").addEventListener("click", function (e) {
    const btn = e.target.closest("button");
    if (btn && btn.dataset.target === "backup") { loadBackups(); loadPoints(); }
  });

  loadBackups();
  loadPoints();
})();