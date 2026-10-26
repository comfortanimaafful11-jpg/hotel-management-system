(function () {
  const body = document.getElementById("activityBody");
  const filter = document.getElementById("activityFilter");
  const msg = document.getElementById("activityMsg");

  function esc(text) {
    const div = document.createElement("div");
    div.textContent = text === null || text === undefined ? "" : String(text);
    return div.innerHTML;
  }

  async function load() {
    try {
      const res = await fetch("/api/admin/activity?result=" + encodeURIComponent(filter.value));
      if (res.status === 401) { window.location.href = "/login.html"; return; }
      const data = await res.json();
      if (!data.ok) { msg.textContent = data.message; msg.className = "msg error"; return; }

      msg.textContent = "";
      body.innerHTML = data.entries.length
        ? data.entries.map(function (e) {
            return `<tr>
              <td>${esc(new Date(e.created_at).toLocaleString())}</td>
              <td>${esc(e.username_tried)}</td>
              <td>${esc(e.action)}</td>
              <td>${esc(e.details)}</td>
              <td>${esc(e.ip_address)}</td>
              <td><span class="badge ${e.result === "Success" ? "active" : "disabled"}">${esc(e.result)}</span></td>
            </tr>`;
          }).join("")
        : "<tr><td colspan='6'>No activity found.</td></tr>";
    } catch (err) {
      msg.textContent = "Problem: " + err.message;
      msg.className = "msg error";
    }
  }

  document.getElementById("activityRefresh").addEventListener("click", load);
  filter.addEventListener("change", load);
  document.querySelector('#nav button[data-target="activity"]').addEventListener("click", load);
  load();
})();