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
  function money(n) { return "GHS " + Number(n).toLocaleString(); }
  function statBox(label, value) {
    return `<div class="stat"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`;
  }
  function badgeClass(status) {
    if (["Available", "Checked out"].includes(status)) return "active";
    if (["Occupied", "Confirmed", "Checked in"].includes(status)) return "info";
    if (status === "Maintenance") return "warn";
    return "disabled";
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

  // ---------- Navigation (reloads the numbers when you open a section) ----------
  $("nav").addEventListener("click", function (e) {
    const btn = e.target.closest("button");
    if (!btn) return;
    document.querySelectorAll("#nav button").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
    btn.classList.add("active");
    $(btn.dataset.target).classList.add("active");

    const t = btn.dataset.target;
    if (t === "rooms") loadRooms();
    if (t === "bookings") loadBookings();
    if (t === "payments") { loadReport(); loadPayments(); }
    if (t === "reports") loadReport();
  });

  // ---------- 1. Room availability ----------
  let rooms = [];

  function renderRooms() {
    const count = s => rooms.filter(r => r.status === s).length;
    $("roomStats").innerHTML =
      statBox("Total rooms", rooms.length) +
      statBox("Available", count("Available")) +
      statBox("Occupied", count("Occupied")) +
      statBox("Maintenance", count("Maintenance"));

    $("roomsBody").innerHTML = rooms.map(r => {
      const control = r.status === "Occupied"
        ? '<span class="badge info">Occupied (guest checked in)</span>'
        : `<select data-room="${r.id}">
             <option ${r.status === "Available" ? "selected" : ""}>Available</option>
             <option ${r.status === "Maintenance" ? "selected" : ""}>Maintenance</option>
           </select>`;
      return `<tr><td>${esc(r.room_no)}</td><td>${esc(r.room_type)}</td><td>${money(r.price)}</td><td>${control}</td></tr>`;
    }).join("");
  }

  async function loadRooms() {
    try {
      const data = await api("GET", "/api/rooms");
      if (!data.ok) { msg("roomMsg", data.message, true); return; }
      rooms = data.rooms;
      renderRooms();
    } catch (err) { msg("roomMsg", "Problem: " + err.message, true); }
  }

  $("roomsBody").addEventListener("change", async function (e) {
    if (e.target.dataset.room === undefined) return;
    try {
      const data = await api("PATCH", "/api/rooms/" + e.target.dataset.room + "/status", { status: e.target.value });
      msg("roomMsg", data.ok ? "Room status updated." : data.message, !data.ok);
    } catch (err) { msg("roomMsg", "Problem: " + err.message, true); }
    loadRooms();   // always reload so the screen shows the truth
  });

  // ---------- 2. Bookings ----------
  let bookings = [];

  function renderBookings() {
    const filter = $("bookingFilter").value;
    const list = filter === "All" ? bookings : bookings.filter(b => b.status === filter);
    $("bookingsBody").innerHTML = list.length
      ? list.map(b => `
        <tr>
          <td>${esc(b.booking_code)}</td><td>${esc(b.guest)}</td><td>${esc(b.room_no)}</td>
          <td>${esc(b.arrival)} to ${esc(b.departure)}</td>
          <td><span class="badge ${badgeClass(b.status)}">${esc(b.status)}</span></td>
        </tr>`).join("")
      : "<tr><td colspan='5'>No bookings found.</td></tr>";
  }
  $("bookingFilter").addEventListener("change", renderBookings);

  async function loadBookings() {
    try {
      const data = await api("GET", "/api/bookings");
      if (!data.ok) return;
      bookings = data.bookings;
      renderBookings();
    } catch (err) {
      $("bookingsBody").innerHTML = "<tr><td colspan='5'>Problem: " + esc(err.message) + "</td></tr>";
    }
  }

  // ---------- 4 and 5. Reports and payment totals ----------
  async function loadReport() {
    try {
      const data = await api("GET", "/api/manager/report");
      if (!data.ok) return;

      // Last 7 days, filling in days with no payments
      const days = [];
      for (let i = 6; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const key = d.toLocaleDateString("en-CA");
        const found = data.revenue.find(r => r.day === key);
        days.push({ label: d.toLocaleDateString("en-GB", { weekday: "short" }), amount: found ? found.total : 0 });
      }
      const weekTotal = days.reduce((s, d) => s + d.amount, 0);

      const totalRooms = Object.values(data.rooms).reduce((s, n) => s + n, 0);
      const occupied = data.rooms.Occupied || 0;
      const rate = totalRooms ? Math.round((occupied / totalRooms) * 100) : 0;
      const totalBookings = Object.values(data.bookings).reduce((s, n) => s + n, 0);

      $("reportStats").innerHTML =
        statBox("Revenue (7 days)", money(weekTotal)) +
        statBox("Occupancy now", rate + "%") +
        statBox("Bookings", totalBookings) +
        statBox("Open complaints", data.openComplaints);

      const max = Math.max(1, ...days.map(d => d.amount));
      $("revenueChart").innerHTML = days.map(d => `
        <div class="bar-col">
          <em>${d.amount}</em>
          <div class="bar" style="height:${Math.round((d.amount / max) * 140)}px"></div>
          <small>${esc(d.label)}</small>
        </div>`).join("");

      $("paymentStats").innerHTML =
        statBox("Received (all time)", money(data.received)) +
        statBox("Still owed", money(data.outstanding));
    } catch (err) {
      $("reportStats").innerHTML = "<p class='msg error'>Problem: " + esc(err.message) + "</p>";
    }
  }

  async function loadPayments() {
    try {
      const data = await api("GET", "/api/payments");
      if (!data.ok) return;
      $("paymentsBody").innerHTML = data.payments.length
        ? data.payments.map(p => `
          <tr>
            <td>${esc(p.receipt_no)}</td>
            <td>${esc(p.guest)} (${esc(p.booking_code)})</td>
            <td>${money(p.amount)}</td>
            <td>${esc(p.method)}</td>
            <td><span class="badge active">Received</span> ${esc(p.paid_at)}</td>
          </tr>`).join("")
        : "<tr><td colspan='5'>No payments recorded yet.</td></tr>";
    } catch (err) {
      $("paymentsBody").innerHTML = "<tr><td colspan='5'>Problem: " + esc(err.message) + "</td></tr>";
    }
  }

  // ---------- Not connected yet (next step) ----------
  $("tasksBody").innerHTML = "<tr><td colspan='5'>This section is connected in the next step.</td></tr>";
  $("complaintsBody").innerHTML = "<tr><td colspan='4'>This section is connected in the next step.</td></tr>";
  $("decisionsBody").innerHTML = "<tr><td colspan='4'>This section is connected in the next step.</td></tr>";

  // ---------- Start ----------
  loadRooms();
  loadBookings();
  loadReport();
  loadPayments();
})();