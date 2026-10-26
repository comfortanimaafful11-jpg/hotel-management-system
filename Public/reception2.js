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
  function balance(b) {
    return (Math.round(Number(b.total_amount) * 100) - Math.round(Number(b.amount_paid) * 100)) / 100;
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

  let bookings = [];

  function goTo(target) {
    $("nav").querySelector('button[data-target="' + target + '"]').click();
  }
  function todayStr() { return new Date().toLocaleDateString("en-CA"); }

  // After a reservation: open Record Payment with that booking selected
  window.addEventListener("reservation-made", async function (e) {
    await loadBookings();
    const b = bookings.find(x => x.booking_code === e.detail.code);
    goTo("payment");
    if (b) $("pBooking").value = String(b.id);
    msg("payMsg", "Reservation " + e.detail.code + " confirmed. Total " + money(e.detail.total) +
      ". Record a payment now, or skip this step.");
    $("pAmount").focus();
  });

  // ---------- Bookings: check-in, check-out, payment list ----------
  function renderCheckin() {
    const list = bookings.filter(b => b.status === "Confirmed");
    $("checkinBody").innerHTML = list.length
      ? list.map(b => `
        <tr>
          <td>${esc(b.booking_code)}</td><td>${esc(b.guest)}</td><td>${esc(b.room_no)}</td>
          <td>${esc(b.arrival)} to ${esc(b.departure)}</td>
          <td><button class="small" data-checkin="${b.id}">Check in</button></td>
        </tr>`).join("")
      : "<tr><td colspan='5'>No guests waiting to check in.</td></tr>";
  }

  function renderCheckout() {
    const list = bookings.filter(b => b.status === "Checked in");
    $("checkoutBody").innerHTML = list.length
      ? list.map(b => `
        <tr>
          <td>${esc(b.booking_code)}</td><td>${esc(b.guest)}</td><td>${esc(b.room_no)}</td>
          <td>${money(balance(b))}</td>
          <td><button class="small" data-checkout="${b.id}">Check out</button></td>
        </tr>`).join("")
      : "<tr><td colspan='5'>No guests are currently checked in.</td></tr>";
  }

  function renderPaySelect() {
    const keep = $("pBooking").value;
    const open = bookings.filter(b => ["Confirmed", "Checked in"].includes(b.status) && balance(b) > 0);
    $("pBooking").innerHTML = open.map(b =>
      `<option value="${b.id}">${esc(b.booking_code)} - ${esc(b.guest)} (owes ${money(balance(b))})</option>`).join("");
    if (keep) $("pBooking").value = keep;
  }

  async function loadBookings() {
    try {
      const data = await api("GET", "/api/bookings");
      if (!data.ok) { msg("checkinMsg", data.message, true); return; }
      bookings = data.bookings;
      renderCheckin();
      renderCheckout();
      renderPaySelect();
    } catch (err) { msg("checkinMsg", "Problem: " + err.message, true); }
  }

  function tellOtherCode() {
    window.dispatchEvent(new Event("hotel-data-changed"));
  }

  $("checkinBody").addEventListener("click", async function (e) {
    const id = e.target.dataset.checkin;
    if (!id) return;
    try {
      const data = await api("POST", "/api/bookings/" + id + "/checkin");
      msg("checkinMsg", data.ok ? "Guest checked in." : data.message, !data.ok);
      loadBookings();
      tellOtherCode();
    } catch (err) { msg("checkinMsg", "Problem: " + err.message, true); }
  });

  $("checkoutBody").addEventListener("click", async function (e) {
    const id = e.target.dataset.checkout;
    if (!id) return;
    try {
      const data = await api("POST", "/api/bookings/" + id + "/checkout");
      msg("checkoutMsg", data.ok ? "Guest checked out. The room is available again." : data.message, !data.ok);
      loadBookings();
      tellOtherCode();
    } catch (err) { msg("checkoutMsg", "Problem: " + err.message, true); }
  });

  // ---------- Payments ----------
  async function loadPayments() {
    try {
      const data = await api("GET", "/api/payments");
      if (!data.ok) { msg("payMsg", data.message, true); return; }
      $("payBody").innerHTML = data.payments.length
        ? data.payments.map(p => `
          <tr>
            <td>${esc(p.receipt_no)}</td>
            <td>${esc(p.booking_code)} (${esc(p.guest)})</td>
            <td>${money(p.amount)}</td>
            <td>${esc(p.method)}</td>
          </tr>`).join("")
        : "<tr><td colspan='4'>No payments recorded yet.</td></tr>";
    } catch (err) { msg("payMsg", "Problem: " + err.message, true); }
  }

  $("payBtn").addEventListener("click", async function () {
    const payload = {
      bookingId: Number($("pBooking").value),
      amount: Number($("pAmount").value),
      method: $("pMethod").value
    };
    try {
      const data = await api("POST", "/api/payments", payload);
      if (data.ok) {
        $("pAmount").value = "";
        msg("payMsg", "Payment recorded. Receipt " + data.receipt + ". Balance left: " + money(data.balance) + ".");
        await loadBookings();
        loadPayments();

        // Guest arrives today? Move on to check-in.
        const paid = bookings.find(x => x.id === payload.bookingId);
        if (paid && paid.status === "Confirmed" && paid.arrival === todayStr()) {
          goTo("checkin");
          msg("checkinMsg", paid.booking_code + " arrives today. Ready to check in.");
        }
      } else {
        msg("payMsg", data.message, true);
      }
    } catch (err) { msg("payMsg", "Problem: " + err.message, true); }
  });

  // ---------- Enquiries ----------
  async function loadEnquiries() {
    try {
      const data = await api("GET", "/api/enquiries");
      if (!data.ok) { msg("enquiryMsg", data.message, true); return; }
      $("enquiriesBody").innerHTML = data.enquiries.length
        ? data.enquiries.map(q => `
          <tr>
            <td>${esc(q.from_name)}</td><td>${esc(q.details)}</td>
            <td><span class="badge ${q.status === "Open" ? "warn" : "active"}">${esc(q.status)}</span></td>
            <td>${q.status === "Open" ? `<button class="small" data-resolve="${q.id}">Mark resolved</button>` : ""}</td>
          </tr>`).join("")
        : "<tr><td colspan='4'>No enquiries yet.</td></tr>";
    } catch (err) { msg("enquiryMsg", "Problem: " + err.message, true); }
  }

  $("addEnquiryBtn").addEventListener("click", async function () {
    try {
      const data = await api("POST", "/api/enquiries", { fromName: $("qName").value, details: $("qText").value });
      if (data.ok) {
        $("qName").value = "";
        $("qText").value = "";
        msg("enquiryMsg", "Enquiry logged.");
        loadEnquiries();
      } else {
        msg("enquiryMsg", data.message, true);
      }
    } catch (err) { msg("enquiryMsg", "Problem: " + err.message, true); }
  });

  $("enquiriesBody").addEventListener("click", async function (e) {
    const id = e.target.dataset.resolve;
    if (!id) return;
    try {
      await api("PATCH", "/api/enquiries/" + id + "/resolve");
      loadEnquiries();
    } catch (err) { msg("enquiryMsg", "Problem: " + err.message, true); }
  });

  // Reload when you open these sections, so the lists are always fresh
  $("nav").addEventListener("click", function (e) {
    const btn = e.target.closest("button");
    if (!btn) return;
    const t = btn.dataset.target;
    if (t === "checkin" || t === "checkout" || t === "payment") loadBookings();
    if (t === "payment") loadPayments();
    if (t === "enquiries") loadEnquiries();
  });

  loadBookings();
  loadPayments();
  loadEnquiries();
})();