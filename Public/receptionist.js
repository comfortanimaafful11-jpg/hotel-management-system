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
  function today() { return new Date().toLocaleDateString("en-CA"); }
  function nights(a, b) { return Math.round((Date.parse(b) - Date.parse(a)) / 86400000); }
  function statBox(label, value) {
    return `<div class="stat"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`;
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

  // ---------- Navigation ----------
  $("nav").addEventListener("click", function (e) {
    const btn = e.target.closest("button");
    if (!btn) return;
    document.querySelectorAll("#nav button").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
    btn.classList.add("active");
    $(btn.dataset.target).classList.add("active");
  });

  // ---------- Register guest ----------
  $("registerBtn").addEventListener("click", async function () {
    const payload = {
      fullName: $("gName").value,
      phone: $("gPhone").value,
      email: $("gEmail").value,
      idType: $("gIdType").value,
      idNumber: $("gIdNo").value,
      country: $("gCountry").value
    };
    try {
      const data = await api("POST", "/api/guests", payload);
      if (data.ok) {
        ["gName", "gPhone", "gEmail", "gIdNo"].forEach(id => { $(id).value = ""; });
        msg("registerMsg", "");
        loadGuestTable();
        await loadGuestSelect(data.id);
        $("nav").querySelector('button[data-target="reserve"]').click();
        msg("reserveMsg", "Guest registered. Now choose the dates and room.");
        $("rFrom").focus();
      } else {
        msg("registerMsg", data.message, true);
      }
    } catch (err) { msg("registerMsg", "Problem: " + err.message, true); }
  });

  // ---------- Guest records ----------
  let tableGuests = [];
  let editingId = null;

  async function loadGuestTable() {
    try {
      const data = await api("GET", "/api/guests?q=" + encodeURIComponent($("searchGuest").value.trim()));
      if (!data.ok) return;
      tableGuests = data.guests;
      $("guestsBody").innerHTML = tableGuests.length
        ? tableGuests.map(g => `
          <tr>
            <td>${esc(g.full_name)}</td><td>${esc(g.phone)}</td><td>${esc(g.email)}</td>
            <td><button class="small" data-edit="${g.id}">Edit</button></td>
          </tr>`).join("")
        : "<tr><td colspan='4'>No guests found.</td></tr>";
    } catch (err) { msg("editMsg", "Problem: " + err.message, true); }
  }
  $("searchGuest").addEventListener("input", loadGuestTable);

  $("guestsBody").addEventListener("click", function (e) {
    if (e.target.dataset.edit === undefined) return;
    editingId = Number(e.target.dataset.edit);
    const g = tableGuests.find(x => x.id === editingId);
    if (!g) return;
    $("editTitle").textContent = "Edit " + g.full_name;
    $("eName").value = g.full_name;
    $("ePhone").value = g.phone;
    $("eEmail").value = g.email || "";
    msg("editMsg", "");
    $("editBox").style.display = "block";
  });

  $("saveEditBtn").addEventListener("click", async function () {
    try {
      const data = await api("PATCH", "/api/guests/" + editingId, {
        fullName: $("eName").value, phone: $("ePhone").value, email: $("eEmail").value
      });
      if (data.ok) {
        $("editBox").style.display = "none";
        loadGuestTable();
        loadGuestSelect();
      } else {
        msg("editMsg", data.message, true);
      }
    } catch (err) { msg("editMsg", "Problem: " + err.message, true); }
  });

  // ---------- Room availability (tonight) ----------
  let rooms = [];

  function roomState(r) {
    if (r.status === "Maintenance") return "Maintenance";
    return r.free ? "Available" : "Occupied";
  }
  function badge(state) {
    if (state === "Available") return "active";
    if (state === "Occupied") return "info";
    return "warn";
  }

  function renderAvailability() {
    const count = s => rooms.filter(r => roomState(r) === s).length;
    $("availStats").innerHTML =
      statBox("Available tonight", count("Available")) +
      statBox("Occupied tonight", count("Occupied")) +
      statBox("Maintenance", count("Maintenance"));

    const filter = $("availFilter").value;
    const list = filter === "All" ? rooms : rooms.filter(r => roomState(r) === filter);
    $("availBody").innerHTML = list.map(r => `
      <tr>
        <td>${esc(r.room_no)}</td><td>${esc(r.room_type)}</td><td>${money(r.price)}</td>
        <td><span class="badge ${badge(roomState(r))}">${roomState(r)}</span></td>
      </tr>`).join("");
  }
  $("availFilter").addEventListener("change", renderAvailability);

  async function loadAvailability() {
    try {
      const data = await api("GET", "/api/rooms");
      if (!data.ok) return;
      rooms = data.rooms;
      renderAvailability();
    } catch (err) { /* shown elsewhere */ }
  }

  // ---------- Make a reservation ----------
  let freeRooms = [];

  async function loadGuestSelect(selectId) {
    try {
      const keep = $("rGuest").value;
      const data = await api("GET", "/api/guests?q=");
      if (!data.ok) return;
      $("rGuest").innerHTML = data.guests.map(g =>
        `<option value="${g.id}">${esc(g.full_name)} (${esc(g.phone)})</option>`).join("");
      if (selectId) $("rGuest").value = String(selectId);
      else if (keep) $("rGuest").value = keep;
    } catch (err) { /* shown elsewhere */ }
  }

  function updateTotal() {
    const from = $("rFrom").value;
    const to = $("rTo").value;
    const room = freeRooms.find(r => String(r.id) === $("rRoom").value);
    if (from && to && room && nights(from, to) > 0) {
      const n = nights(from, to);
      msg("rTotal", n + " night(s) = " + money(n * room.price));
    }
  }

  async function refreshReserveRooms() {
    const from = $("rFrom").value;
    const to = $("rTo").value;
    if (!from || !to || nights(from, to) < 1) {
      freeRooms = [];
      $("rRoom").innerHTML = "";
      msg("rTotal", "Choose arrival and departure dates to see the free rooms.");
      return;
    }
    try {
      const data = await api("GET", "/api/rooms?arrival=" + from + "&departure=" + to);
      if (!data.ok) return;
      freeRooms = data.rooms.filter(r => r.free);
      $("rRoom").innerHTML = freeRooms.map(r =>
        `<option value="${r.id}">Room ${esc(r.room_no)} - ${esc(r.room_type)} (${money(r.price)})</option>`).join("");
      if (freeRooms.length === 0) msg("rTotal", "No rooms are free for those dates.", true);
      else updateTotal();
    } catch (err) { msg("reserveMsg", "Problem: " + err.message, true); }
  }

  $("rFrom").min = today();
  $("rTo").min = today();
  $("rFrom").addEventListener("change", function () {
    $("rTo").min = $("rFrom").value || today();
    refreshReserveRooms();
  });
  $("rTo").addEventListener("change", refreshReserveRooms);
  $("rRoom").addEventListener("change", updateTotal);

  $("reserveBtn").addEventListener("click", async function () {
    const payload = {
      guestId: Number($("rGuest").value),
      roomId: Number($("rRoom").value),
      arrival: $("rFrom").value,
      departure: $("rTo").value
    };
    try {
      const data = await api("POST", "/api/bookings", payload);
      if (data.ok) {
        msg("reserveMsg", "Reservation " + data.code + " confirmed. Total " + money(data.total) + ".");
        refreshReserveRooms();
        loadAvailability();
        window.dispatchEvent(new CustomEvent("reservation-made", {
          detail: { code: data.code, total: data.total }
        }));
      } else {
        msg("reserveMsg", data.message, true);
      }
    } catch (err) { msg("reserveMsg", "Problem: " + err.message, true); }
  });

  // ---------- Not connected yet (next step) ----------
  const later = "<tr><td colspan='5'>This section is connected in the next step.</td></tr>";
  ["checkinBody", "checkoutBody", "payBody", "enquiriesBody"].forEach(id => { $(id).innerHTML = later; });

  window.addEventListener("hotel-data-changed", loadAvailability); 

  // ---------- Start ----------
  loadGuestTable();
  loadGuestSelect();
  loadAvailability();
})();