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

  // ---------- Staff operations ----------
  async function loadStaff() {
    try {
      const data = await api("GET", "/api/staff");
      if (!data.ok) return;
      const keep = $("taskStaff").value;
      $("taskStaff").innerHTML = data.staff.map(s =>
        `<option value="${s.id}">${esc(s.full_name)} (${esc(s.role)})</option>`).join("");
      if (keep) $("taskStaff").value = keep;
    } catch (err) { msg("taskMsg", "Problem: " + err.message, true); }
  }

  async function loadTasks() {
    try {
      const data = await api("GET", "/api/tasks");
      if (!data.ok) { msg("taskMsg", data.message, true); return; }
      $("tasksBody").innerHTML = data.tasks.length
        ? data.tasks.map(t => `
          <tr>
            <td>${esc(t.staff)}</td><td>${esc(t.task)}</td><td>${esc(t.shift)}</td>
            <td><span class="badge ${t.is_done ? "active" : "warn"}">${t.is_done ? "Done" : "In progress"}</span></td>
            <td><button class="small" data-done="${t.id}" data-state="${t.is_done ? 1 : 0}">${t.is_done ? "Reopen" : "Mark done"}</button></td>
          </tr>`).join("")
        : "<tr><td colspan='5'>No tasks assigned yet.</td></tr>";
    } catch (err) { msg("taskMsg", "Problem: " + err.message, true); }
  }

  $("addTaskBtn").addEventListener("click", async function () {
    try {
      const data = await api("POST", "/api/tasks", {
        assignedTo: Number($("taskStaff").value),
        task: $("taskText").value,
        shift: $("taskShift").value
      });
      if (data.ok) {
        $("taskText").value = "";
        msg("taskMsg", "Task assigned.");
        loadTasks();
      } else {
        msg("taskMsg", data.message, true);
      }
    } catch (err) { msg("taskMsg", "Problem: " + err.message, true); }
  });

  $("tasksBody").addEventListener("click", async function (e) {
    const id = e.target.dataset.done;
    if (!id) return;
    try {
      await api("PATCH", "/api/tasks/" + id + "/done", { done: e.target.dataset.state !== "1" });
      loadTasks();
    } catch (err) { msg("taskMsg", "Problem: " + err.message, true); }
  });

  // ---------- Complaints ----------
  let selectedComplaint = null;
  let complaints = [];

  async function loadGuestsForComplaints() {
    try {
      const data = await api("GET", "/api/guests?q=");
      if (!data.ok) return;
      const keep = $("cGuest").value;
      $("cGuest").innerHTML = data.guests.map(g =>
        `<option value="${g.id}">${esc(g.full_name)} (${esc(g.phone)})</option>`).join("");
      if (keep) $("cGuest").value = keep;
    } catch (err) { msg("logComplaintMsg", "Problem: " + err.message, true); }
  }

  async function loadComplaints() {
    try {
      const data = await api("GET", "/api/complaints");
      if (!data.ok) { msg("complaintMsg", data.message, true); return; }
      complaints = data.complaints;
      $("complaintsBody").innerHTML = complaints.length
        ? complaints.map(c => `
          <tr>
            <td>${esc(c.guest)}</td><td>${esc(c.description)}</td>
            <td><span class="badge ${c.status === "Open" ? "warn" : "active"}">${esc(c.status)}</span></td>
            <td>${c.status === "Open"
              ? `<button class="small" data-resolve="${c.id}">Resolve</button>`
              : esc(c.resolution_note)}</td>
          </tr>`).join("")
        : "<tr><td colspan='4'>No complaints yet.</td></tr>";
    } catch (err) { msg("complaintMsg", "Problem: " + err.message, true); }
  }

  $("addComplaintBtn").addEventListener("click", async function () {
    try {
      const data = await api("POST", "/api/complaints", {
        guestId: Number($("cGuest").value),
        description: $("cText").value
      });
      if (data.ok) {
        $("cText").value = "";
        msg("logComplaintMsg", "Complaint logged.");
        loadComplaints();
      } else {
        msg("logComplaintMsg", data.message, true);
      }
    } catch (err) { msg("logComplaintMsg", "Problem: " + err.message, true); }
  });

  $("complaintsBody").addEventListener("click", function (e) {
    const id = e.target.dataset.resolve;
    if (!id) return;
    selectedComplaint = Number(id);
    const c = complaints.find(x => x.id === selectedComplaint);
    $("resolveTitle").textContent = "Resolve complaint from " + (c ? c.guest : "guest");
    msg("complaintMsg", "");
    $("resolveBox").style.display = "block";
    $("resolveNote").focus();
  });

  $("resolveBtn").addEventListener("click", async function () {
    try {
      const data = await api("PATCH", "/api/complaints/" + selectedComplaint + "/resolve", {
        note: $("resolveNote").value
      });
      if (data.ok) {
        $("resolveNote").value = "";
        $("resolveBox").style.display = "none";
        msg("complaintMsg", "");
        loadComplaints();
      } else {
        msg("complaintMsg", data.message, true);
      }
    } catch (err) { msg("complaintMsg", "Problem: " + err.message, true); }
  });

  // ---------- Decisions ----------
  function decisionBadge(status) {
    if (status === "Approved") return "active";
    if (status === "Rejected") return "disabled";
    return "warn";
  }

  async function loadDecisions() {
    try {
      const data = await api("GET", "/api/decisions");
      if (!data.ok) { msg("decisionMsg", data.message, true); return; }
      $("decisionsBody").innerHTML = data.decisions.length
        ? data.decisions.map(d => `
          <tr>
            <td>${esc(d.request_text)}</td><td>${esc(d.requested_by)}</td>
            <td><span class="badge ${decisionBadge(d.status)}">${esc(d.status)}</span></td>
            <td>${d.status === "Pending"
              ? `<button class="small" data-decide="${d.id}" data-choice="Approved">Approve</button>
                 <button class="small danger" data-decide="${d.id}" data-choice="Rejected">Reject</button>`
              : "Decided"}</td>
          </tr>`).join("")
        : "<tr><td colspan='4'>No requests yet.</td></tr>";
    } catch (err) { msg("decisionMsg", "Problem: " + err.message, true); }
  }

  $("addDecisionBtn").addEventListener("click", async function () {
    try {
      const data = await api("POST", "/api/decisions", { text: $("dText").value });
      if (data.ok) {
        $("dText").value = "";
        msg("decisionMsg", "Request submitted.");
        loadDecisions();
      } else {
        msg("decisionMsg", data.message, true);
      }
    } catch (err) { msg("decisionMsg", "Problem: " + err.message, true); }
  });

  $("decisionsBody").addEventListener("click", async function (e) {
    const id = e.target.dataset.decide;
    if (!id) return;
    try {
      const data = await api("PATCH", "/api/decisions/" + id, { decision: e.target.dataset.choice });
      msg("decisionMsg", data.ok ? "Decision recorded." : data.message, !data.ok);
      loadDecisions();
    } catch (err) { msg("decisionMsg", "Problem: " + err.message, true); }
  });

  // Reload when you open a section
  $("nav").addEventListener("click", function (e) {
    const btn = e.target.closest("button");
    if (!btn) return;
    const t = btn.dataset.target;
    if (t === "staff") { loadStaff(); loadTasks(); }
    if (t === "complaints") { loadGuestsForComplaints(); loadComplaints(); }
    if (t === "decisions") loadDecisions();
  });

  // ---------- Start ----------
  loadStaff();
  loadTasks();
  loadGuestsForComplaints();
  loadComplaints();
  loadDecisions();
})();