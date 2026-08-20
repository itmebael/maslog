/**
 * Keeps Admin vs Staff sidebars on the correct portal path.
 * Set localStorage.portal = "admin" | "staff" on login / dashboard entry.
 */
(function () {
  const page = (location.pathname.split("/").pop() || "").toLowerCase();
  const staffPages = new Set([
    "staff-dashboard.html",
    "walk-in-transaction.html",
    "online-booking.html",
    "transaction-history.html",
    "qr-verification.html",
    "staff-fees.html",
  ]);
  const adminOnlyPages = new Set([
    "admin-dashboard.html",
    "staff-account.html",
    "user-management.html",
    "sales-monitoring.html",
    "revenue-report.html",
    "system-configuration.html",
  ]);

  function getSavedSession() {
    try {
      return JSON.parse(localStorage.getItem("maslog_session_v2") || "null");
    } catch {
      return null;
    }
  }

  function currentPortal() {
    const session = getSavedSession();
    if (session?.role === "staff" || session?.portal === "staff") return "staff";
    if (session?.role === "admin" || session?.portal === "admin") return "admin";
    if (staffPages.has(page)) return "staff";
    return localStorage.getItem("portal") || "admin";
  }

  const portal = currentPortal();
  localStorage.setItem("portal", portal);

  function applyAdminMonitorShell() {
    if (page === "walk-in-transaction.html") {
      location.href = "transaction-history.html";
      return;
    }
    document.querySelectorAll('.sidebar .nav a[href="walk-in-transaction.html"]').forEach((link) => link.remove());
  }

  const staffLinks = [
    {
      href: "staff-dashboard.html",
      label: "Dashboard",
      match: ["staff-dashboard.html"],
      icon: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/></svg>',
    },
    {
      href: "walk-in-transaction.html",
      label: "Walk-in Transaction",
      match: ["walk-in-transaction.html"],
      icon: '<svg viewBox="0 0 24 24"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg>',
    },
    {
      href: "online-booking.html",
      label: "Online Booking",
      match: ["online-booking.html"],
      icon: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/></svg>',
    },
    {
      href: "transaction-history.html",
      label: "Sales History",
      match: ["transaction-history.html"],
      icon: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
    },
    {
      href: "qr-verification.html",
      label: "QR Verification",
      match: ["qr-verification.html"],
      icon: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3"/><path d="M14 17h7"/><path d="M17 14v7"/></svg>',
    },
    {
      href: "staff-fees.html",
      label: "Online Booking Setup",
      match: ["staff-fees.html"],
      icon: '<svg viewBox="0 0 24 24"><path d="M12 1v22"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>',
    },
  ];

  function applyStaffShell() {
    const brandP = document.querySelector(".brand p");
    if (brandP) brandP.textContent = "Staff Portal";

    const nav = document.querySelector(".sidebar .nav");
    if (nav) {
      nav.innerHTML = staffLinks
        .map((item) => {
          const active = item.match.includes(page) ? " active" : "";
          return `<a class="${active.trim()}" href="${item.href}">${item.icon}${item.label}</a>`;
        })
        .join("");
    }

    // Remove admin-only sidebar user blocks if any, keep logout
    document.querySelectorAll(".sidebar-user").forEach((el) => el.remove());

    const profile = document.querySelector(".profile");
    if (profile) {
      const av = profile.querySelector(".avatar-fallback");
      const strong = profile.querySelector("strong");
      const span = profile.querySelector("span");
      const session = getSavedSession();
      if (av) av.textContent = session?.fullName ? session.fullName.split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase() : "ST";
      if (strong) strong.textContent = session?.fullName || "Staff";
      if (span) span.textContent = "Staff";
    }
  }

  function applyShell() {
    let redirecting = false;
    try {
      if (portal === "staff") {
        if (adminOnlyPages.has(page)) {
          redirecting = true;
          location.replace("staff-dashboard.html");
          return;
        }
        applyStaffShell();
      } else {
        applyAdminMonitorShell();
      }
      refreshPendingBookingBadge();
    } finally {
      if (!redirecting) document.documentElement.classList.add("portal-nav-ready");
    }
  }

  function findOnlineBookingLink() {
    return document.querySelector('.sidebar .nav a[href="online-booking.html"]');
  }

  function setPendingBookingBadge(count) {
    const link = findOnlineBookingLink();
    if (!link) return;

    link.querySelector(".nav-badge")?.remove();
    if (!count) return;

    const badge = document.createElement("span");
    badge.className = "nav-badge";
    badge.textContent = String(count);
    badge.setAttribute("aria-label", `${count} pending booking${count === 1 ? "" : "s"}`);
    link.appendChild(badge);
  }

  function waitForMaslogDB(attemptsLeft = 20) {
    if (window.MaslogDB?.countPendingBookings) return Promise.resolve(window.MaslogDB);
    if (attemptsLeft <= 0) return Promise.resolve(null);
    return new Promise((resolve) => {
      setTimeout(() => resolve(waitForMaslogDB(attemptsLeft - 1)), 100);
    });
  }

  async function refreshPendingBookingBadge() {
    try {
      const db = await waitForMaslogDB();
      if (!db) return;
      const count = await db.countPendingBookings();
      setPendingBookingBadge(count);
    } catch {
      setPendingBookingBadge(0);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", applyShell);
  } else {
    applyShell();
  }
  window.addEventListener("maslog:booking-status-changed", refreshPendingBookingBadge);
})();
