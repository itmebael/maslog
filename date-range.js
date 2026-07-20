/**
 * Date range filter dropdown: Day | Week | Month | Custom
 * Usage: [data-date-range] with select[data-preset-select]
 */
(function () {
  function startOfDay(d) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
  }

  function endOfDay(d) {
    const x = new Date(d);
    x.setHours(23, 59, 59, 999);
    return x;
  }

  function fmt(d) {
    return d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }

  function toInputDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return y + "-" + m + "-" + day;
  }

  function parseInputDate(str) {
    if (!str) return null;
    const [y, m, d] = str.split("-").map(Number);
    if (!y || !m || !d) return null;
    return new Date(y, m - 1, d);
  }

  function rangeFor(preset, fromEl, toEl) {
    const now = new Date();
    if (preset === "day") {
      return { from: startOfDay(now), to: endOfDay(now), label: "Today · " + fmt(now) };
    }
    if (preset === "week") {
      const from = startOfDay(now);
      from.setDate(from.getDate() - from.getDay());
      const to = endOfDay(new Date(from));
      to.setDate(from.getDate() + 6);
      return { from, to, label: "This week · " + fmt(from) + " – " + fmt(to) };
    }
    if (preset === "month") {
      const from = new Date(now.getFullYear(), now.getMonth(), 1);
      const to = endOfDay(new Date(now.getFullYear(), now.getMonth() + 1, 0));
      return {
        from: startOfDay(from),
        to,
        label: "This month · " + from.toLocaleDateString("en-US", { month: "long", year: "numeric" }),
      };
    }
    let from = parseInputDate(fromEl?.value) || startOfDay(now);
    let to = parseInputDate(toEl?.value) || endOfDay(now);
    if (to < from) {
      const tmp = from;
      from = to;
      to = tmp;
    }
    from = startOfDay(from);
    to = endOfDay(to);
    return { from, to, label: "Custom · " + fmt(from) + " – " + fmt(to) };
  }

  function filterRows(root, from, to) {
    const table = root.dataset.filterTable
      ? document.querySelector(root.dataset.filterTable)
      : root.closest(".content")?.querySelector("tbody");
    if (!table) return;

    const rows = table.querySelectorAll("tr[data-date]");
    if (!rows.length) return;

    let visible = 0;
    rows.forEach((row) => {
      const d = parseInputDate(row.dataset.date);
      const show = d && d >= from && d <= to;
      row.style.display = show ? "" : "none";
      if (show) visible += 1;
    });

    const info = root.closest(".content")?.querySelector(".pagination .info");
    if (info) {
      info.textContent = "Showing " + visible + " of " + rows.length + " transactions";
    }
  }

  function ensureSelect(root) {
    let select = root.querySelector("[data-preset-select]");
    if (select) return select;

    // Upgrade legacy button presets to a dropdown
    const legacy = root.querySelector(".date-range-presets");
    const wrap = root.querySelector(".date-range") || root;
    select = document.createElement("select");
    select.setAttribute("data-preset-select", "");
    select.setAttribute("aria-label", "Date range");
    select.innerHTML = `
      <option value="day">Day</option>
      <option value="week">Week</option>
      <option value="month">Month</option>
      <option value="custom">Custom</option>`;
    if (legacy) {
      legacy.replaceWith(select);
    } else {
      wrap.prepend(select);
    }
    return select;
  }

  function initOne(root) {
    const select = ensureSelect(root);
    const customBox = root.querySelector(".date-range-custom");
    const fromEl = root.querySelector("[data-from]");
    const toEl = root.querySelector("[data-to]");
    const labelEl = root.querySelector("[data-label]");
    const initial = root.dataset.default || "day";
    select.value = initial;

    function apply(preset) {
      select.value = preset;
      if (customBox) customBox.classList.toggle("open", preset === "custom");

      if (preset === "custom" && fromEl && toEl && !fromEl.value) {
        const now = new Date();
        const weekAgo = new Date(now);
        weekAgo.setDate(now.getDate() - 6);
        fromEl.value = toInputDate(weekAgo);
        toEl.value = toInputDate(now);
      }

      const range = rangeFor(preset, fromEl, toEl);
      if (labelEl) labelEl.textContent = range.label;
      root.dataset.from = toInputDate(range.from);
      root.dataset.to = toInputDate(range.to);
      root.dataset.preset = preset;

      filterRows(root, range.from, range.to);

      root.dispatchEvent(
        new CustomEvent("daterangechange", {
          bubbles: true,
          detail: { preset, from: range.from, to: range.to, label: range.label },
        })
      );
    }

    select.addEventListener("change", () => apply(select.value));

    fromEl?.addEventListener("change", () => {
      if (select.value === "custom") apply("custom");
    });
    toEl?.addEventListener("change", () => {
      if (select.value === "custom") apply("custom");
    });

    const form = root.closest("form");
    form?.addEventListener("submit", (e) => {
      e.preventDefault();
      apply(select.value);
    });

    apply(initial);
  }

  function boot() {
    document.querySelectorAll("[data-date-range]").forEach(initOne);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  window.MaslogDateRange = { init: boot, rangeFor };
})();
