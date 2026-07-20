(function () {
  function ensureModal() {
    if (document.getElementById("logoutOverlay")) return;

    const overlay = document.createElement("div");
    overlay.id = "logoutOverlay";
    overlay.className = "logout-overlay";
    overlay.hidden = true;
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-labelledby", "logoutTitle");
    overlay.setAttribute("aria-hidden", "true");
    // Stay invisible until Log-Out is clicked (even before CSS loads)
    overlay.style.cssText = "display:none;";
    overlay.innerHTML = `
      <div class="logout-modal">
        <div class="modal-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
        </div>
        <h3 id="logoutTitle">Log out?</h3>
        <p>Are you sure you want to log out of the Maslog Cold Spring admin portal?</p>
        <div class="logout-actions">
          <button type="button" class="btn-cancel" id="logoutCancel">Cancel</button>
          <button type="button" class="btn-confirm" id="logoutConfirm">Log Out</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const close = () => {
      overlay.hidden = true;
      overlay.classList.remove("open");
      overlay.style.display = "none";
      overlay.setAttribute("aria-hidden", "true");
    };

    const open = () => {
      overlay.hidden = false;
      overlay.style.display = "flex";
      overlay.classList.add("open");
      overlay.setAttribute("aria-hidden", "false");
    };

    document.getElementById("logoutCancel").addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      close();
    });
    document.getElementById("logoutConfirm").addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      window.location.href = "index.html";
    });
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") close();
    });

    overlay._openLogout = open;
    overlay._closeLogout = close;
  }

  function openModal(e) {
    e.preventDefault();
    e.stopPropagation();
    ensureModal();
    const overlay = document.getElementById("logoutOverlay");
    if (overlay && overlay._openLogout) overlay._openLogout();
  }

  document.addEventListener("DOMContentLoaded", () => {
    ensureModal();
    document.querySelectorAll("a.btn-logout").forEach((link) => {
      link.addEventListener("click", openModal);
    });
  });
})();
