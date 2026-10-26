(function () {
  // Menu: show one section at a time
  document.getElementById("nav").addEventListener("click", function (e) {
    const btn = e.target.closest("button");
    if (!btn) return;
    document.querySelectorAll("#nav button").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(btn.dataset.target).classList.add("active");
  });

  // Backup section is connected in the next step
  document.getElementById("backupBody").innerHTML =
    "<tr><td colspan='4'>This section is connected in the next step.</td></tr>";
})();