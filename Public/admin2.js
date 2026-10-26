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

  // ---------- Roles and permissions ----------
  async function loadPermissions() {
    try {
      const data = await api("GET", "/api/admin/permissions");
      if (!data.ok) { msg("permMsg", data.message, true); return; }
      const has = (role, id) => data.grants.some(g => g.role === role && g.permission_id === id);

      $("rolesBody").innerHTML = data.permissions.map(p => `
        <tr>
          <td>${esc(p.name)}</td>
          <td><input type="checkbox" checked disabled></td>
          <td><input type="checkbox" data-role="Manager" data-perm="${p.id}" ${has("Manager", p.id) ? "checked" : ""}></td>
          <td><input type="checkbox" data-role="Receptionist" data-perm="${p.id}" ${has("Receptionist", p.id) ? "checked" : ""}></td>
        </tr>`).join("");
    } catch (err) { msg("permMsg", "Problem: " + err.message, true); }
  }

  $("savePerms").addEventListener("click", async function () {
    const grants = { Manager: [], Receptionist: [] };
    document.querySelectorAll("#rolesBody input[data-perm]:checked").forEach(box => {
      grants[box.dataset.role].push(Number(box.dataset.perm));
    });
    try {
      const data = await api("PUT", "/api/admin/permissions", { grants });
      msg("permMsg", data.ok ? "Permissions saved." : data.message, !data.ok);
    } catch (err) { msg("permMsg", "Problem: " + err.message, true); }
  });

  // ---------- Hotel information ----------
  async function loadHotel() {
    try {
      const data = await api("GET", "/api/admin/hotel");
      if (!data.ok) { msg("hotelMsg", data.message, true); return; }
      const h = data.hotel;
      $("hName").value = h.name || "";
      $("hPhone").value = h.phone || "";
      $("hEmail").value = h.email || "";
      $("hAddress").value = h.address || "";
      $("hIn").value = h.checkin;
      $("hOut").value = h.checkout;
    } catch (err) { msg("hotelMsg", "Problem: " + err.message, true); }
  }

  $("saveHotel").addEventListener("click", async function () {
    try {
      const data = await api("PUT", "/api/admin/hotel", {
        name: $("hName").value, phone: $("hPhone").value, email: $("hEmail").value,
        address: $("hAddress").value, checkin: $("hIn").value, checkout: $("hOut").value
      });
      msg("hotelMsg", data.ok ? "Hotel information saved." : data.message, !data.ok);
    } catch (err) { msg("hotelMsg", "Problem: " + err.message, true); }
  });

  // ---------- All records ----------
  async function loadRecords() {
    try {
      const data = await api("GET", "/api/admin/records?type=" + encodeURIComponent($("recordType").value));
      if (!data.ok) return;
      $("recordsHead").innerHTML = "<tr>" + data.head.map(h => `<th>${esc(h)}</th>`).join("") + "</tr>";
      $("recordsBody").innerHTML = data.rows.length
        ? data.rows.map(r => "<tr>" + r.map(c => `<td>${esc(c)}</td>`).join("") + "</tr>").join("")
        : `<tr><td colspan="${data.head.length}">No records yet.</td></tr>`;
    } catch (err) {
      $("recordsBody").innerHTML = "<tr><td>Problem: " + esc(err.message) + "</td></tr>";
    }
  }
  $("recordType").addEventListener("change", loadRecords);

  // ---------- Security ----------
  async function loadSecurity() {
    try {
      const data = await api("GET", "/api/admin/security");
      if (!data.ok) { msg("secMsg", data.message, true); return; }
      $("sec2fa").checked = true;
      $("sec2fa").disabled = true;   // two-factor is always required by the login code
      $("secAttempts").value = data.settings.max_failed_attempts;
      $("secTimeout").value = data.settings.session_timeout_min;
      $("secLength").value = data.settings.min_password_length;

      $("lockedBody").innerHTML = data.locked.length
        ? data.locked.map(u => `
          <tr>
            <td>${esc(u.username)}</td><td>Too many failed attempts</td>
            <td><button class="small" data-unlock="${u.id}">Unlock</button></td>
          </tr>`).join("")
        : "<tr><td colspan='3'>No locked accounts.</td></tr>";
    } catch (err) { msg("secMsg", "Problem: " + err.message, true); }
  }

  $("saveSecurity").addEventListener("click", async function () {
    try {
      const data = await api("PUT", "/api/admin/security", {
        maxFailedAttempts: Number($("secAttempts").value),
        sessionTimeoutMin: Number($("secTimeout").value),
        minPasswordLength: Number($("secLength").value)
      });
      msg("secMsg", data.ok ? "Security settings saved. New sign-ins use the new timeout." : data.message, !data.ok);
    } catch (err) { msg("secMsg", "Problem: " + err.message, true); }
  });

  $("lockedBody").addEventListener("click", async function (e) {
    const id = e.target.dataset.unlock;
    if (!id) return;
    try {
      await api("POST", "/api/admin/users/" + id + "/unlock");
      loadSecurity();
    } catch (err) { msg("secMsg", "Problem: " + err.message, true); }
  });

  // Reload when you open a section
  $("nav").addEventListener("click", function (e) {
    const btn = e.target.closest("button");
    if (!btn) return;
    const t = btn.dataset.target;
    if (t === "roles") loadPermissions();
    if (t === "hotel") loadHotel();
    if (t === "records") loadRecords();
    if (t === "security") loadSecurity();
  });

  // ---------- Start ----------
  loadPermissions();
  loadHotel();
  loadRecords();
  loadSecurity();
})();