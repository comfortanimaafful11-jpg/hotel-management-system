(function () {
  const link = document.querySelector(".logout");
  if (!link) return;
  link.addEventListener("click", async function (event) {
    event.preventDefault();
    try { await fetch("/api/logout", { method: "POST" }); } catch (err) {}
    window.location.href = "/login.html";
  });
})();