// Mock portal behaviour. Everything stays in the page - no network requests.
document.querySelectorAll("form[data-receipt]").forEach((form) => {
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const err = form.querySelector(".error");
    const bad = Array.from(form.elements).filter((f) => f.willValidate && !f.checkValidity());
    if (bad.length) {
      err.textContent = "Please complete: " + bad.map((f) => (f.labels?.[0]?.innerText || f.name).replace("*", "").trim()).join(", ");
      err.classList.add("show");
      return;
    }
    err.classList.remove("show");
    const id = `${form.dataset.receipt}-${new Date().getFullYear() + 1}-${Math.floor(10000 + Math.random() * 89999)}`;
    const r = form.querySelector(".receipt");
    r.innerHTML = `<b>Submitted successfully.</b> Reference number <b>${id}</b>. A confirmation has been queued to your registered contact (demo - nothing was sent).`;
    r.classList.add("show");
    Array.from(form.elements).forEach((f) => (f.disabled = true));
    r.scrollIntoView({ block: "center" });
  });
});

document.querySelectorAll("input[type=file][data-preview]").forEach((input) => {
  input.addEventListener("change", () => {
    const img = document.getElementById(input.dataset.preview);
    const file = input.files[0];
    if (img && file) img.src = URL.createObjectURL(file);
  });
});

document.querySelectorAll("[data-danger]").forEach((b) =>
  b.addEventListener("click", () => alert("Demo: this destructive action would have run. SafeScreen should never reach here without your explicit approval."))
);
