const RefinedProducts = (() => {
  const state = {
    mode: "crude",
    data: null,
    period: null,
    originalTitle: document.title,
    hidden: [],
    observer: null,
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]);
  const format = (value) => Number.isFinite(Number(value))
    ? Number(value).toLocaleString(undefined, { minimumFractionDigits: Number(value) < 10 ? 1 : 0, maximumFractionDigits: 1 })
    : "—";

  function monthName(period) {
    if (!period) return "";
    const [year, month] = period.split("-").map(Number);
    return new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric", timeZone: "UTC" })
      .format(new Date(Date.UTC(year, month - 1, 1)));
  }

  function currentPeriod() {
    const text = (document.body.innerText || "").slice(0, 18000);
    const iso = [...text.matchAll(/\b(202[5-9])[-/. ](0?[1-9]|1[0-2])\b/g)]
      .map((match) => `${match[1]}-${String(match[2]).padStart(2, "0")}`);
    if (iso.length) return iso.at(-1);
    const months = "January February March April May June July August September October November December".split(" ");
    for (let index = 0; index < months.length; index += 1) {
      const match = text.match(new RegExp(`\\b${months[index]}\\s+(202[5-9])\\b`, "i"));
      if (match) return `${match[1]}-${String(index + 1).padStart(2, "0")}`;
    }
    return state.data?.latestPeriod;
  }

  function selectedRecord() {
    const wanted = currentPeriod();
    const records = state.data?.months || [];
    let found = records.find((record) => record.period === wanted);
    if (!found) found = [...records].reverse().find((record) => record.period <= wanted) || records.at(-1);
    state.period = found?.period;
    return found;
  }

  function installUi() {
    const toggle = document.createElement("div");
    toggle.id = "oilStreamToggle";
    toggle.setAttribute("role", "group");
    toggle.setAttribute("aria-label", "Oil stream");
    toggle.innerHTML = '<button type="button" data-stream="crude" aria-pressed="true">Crude oil</button><button type="button" data-stream="refined" aria-pressed="false">Refined products</button>';
    document.body.append(toggle);
    toggle.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-stream]");
      if (button) setMode(button.dataset.stream);
    });

    const hud = document.createElement("section");
    hud.id = "refinedProductsHud";
    hud.setAttribute("aria-live", "polite");
    hud.innerHTML = '<div class="rp-kicker">Global oil flow atlas · secondary stream</div><div class="rp-title">Refined petroleum products</div><div class="rp-date"></div><div class="rp-metrics"></div><div class="rp-detail"><div class="rp-card trade"><h3>Largest reported cross-border flows</h3><div class="rp-trade"></div><div class="rp-note"></div></div><div class="rp-card products"><h3>Latest reported product mix</h3><div class="rp-products"></div></div></div>';
    document.body.append(hud);

    const disclosure = document.createElement("div");
    disclosure.className = "rp-stream-disclosure";
    disclosure.textContent = "Refined products include gasoline, diesel/gasoil, jet/kerosene, LPG, fuel oil, naphtha and other reported petroleum products. JODI reporting coverage varies by country and month.";
    document.body.append(disclosure);
  }

  function findMapSvg() {
    return $$('svg')
      .map((element) => ({ element, box: element.getBoundingClientRect() }))
      .filter(({ box }) => box.width > 360 && box.height > 180)
      .sort((a, b) => b.box.width * b.box.height - a.box.width * a.box.height)[0]?.element;
  }

  function keysFor(element) {
    const values = ["data-iso3", "data-iso", "data-country-code", "data-code", "id", "aria-label"]
      .map((attribute) => element.getAttribute(attribute))
      .filter(Boolean);
    const title = $("title", element)?.textContent;
    if (title) values.push(title);
    return values.map((value) => String(value).trim().toUpperCase());
  }

  function pointFor(country, svg) {
    const code = String(country.code || "").toUpperCase();
    const name = String(country.name || "").toUpperCase();
    for (const element of $$('path,polygon,g[data-iso],g[data-code]', svg)) {
      const keys = keysFor(element);
      const matched = keys.some((key) => key === code || key === name || (code.length >= 3 && key.includes(code)));
      if (!matched) continue;
      try {
        const box = element.getBBox();
        if (box.width || box.height) return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      } catch {
        // Some SVG nodes do not expose a usable box.
      }
    }
    return null;
  }

  function renderMap(record) {
    $$(".rp-map-overlay").forEach((element) => element.remove());
    const svg = findMapSvg();
    if (!svg || !record) return;
    const namespace = "http://www.w3.org/2000/svg";
    const group = document.createElementNS(namespace, "g");
    group.classList.add("rp-map-overlay");
    svg.append(group);

    const exporters = [...record.countries].filter((country) => country.exports > 0).sort((a, b) => b.exports - a.exports).slice(0, 10);
    const importers = [...record.countries].filter((country) => country.imports > 0).sort((a, b) => b.imports - a.imports).slice(0, 10);
    const points = new Map();
    for (const country of [...exporters, ...importers]) {
      const point = pointFor(country, svg);
      if (point) points.set(country.code, point);
    }
    const maximum = Math.max(1, ...exporters.map((country) => country.exports), ...importers.map((country) => country.imports));

    for (const [countries, className, field] of [[exporters, "rp-export", "exports"], [importers, "rp-import", "imports"]]) {
      for (const country of countries) {
        const point = points.get(country.code);
        if (!point) continue;
        const circle = document.createElementNS(namespace, "circle");
        circle.setAttribute("cx", point.x);
        circle.setAttribute("cy", point.y);
        circle.setAttribute("r", String(2.5 + 8 * Math.sqrt(country[field] / maximum)));
        circle.setAttribute("class", className);
        group.append(circle);
      }
    }

    for (let index = 0; index < Math.min(6, exporters.length, importers.length); index += 1) {
      const start = points.get(exporters[index].code);
      const end = points.get(importers[index].code);
      if (!start || !end) continue;
      const distance = Math.hypot(end.x - start.x, end.y - start.y);
      const middleX = (start.x + end.x) / 2;
      const middleY = (start.y + end.y) / 2 - Math.min(40, distance * 0.18);
      const path = document.createElementNS(namespace, "path");
      path.setAttribute("d", `M${start.x},${start.y} Q${middleX},${middleY} ${end.x},${end.y}`);
      path.setAttribute("class", "rp-route");
      group.prepend(path);
    }
  }

  function suppressCrudeAnimation() {
    if (state.hidden.length) return;
    const pattern = /(particle|barrel|tanker|ship|route|flow-line|animated-flow|traffic)/i;
    $$('[class],[id]').forEach((element) => {
      if (element.closest("#refinedProductsHud,#oilStreamToggle,.rp-stream-disclosure")) return;
      const key = `${element.className?.baseVal || element.className || ""} ${element.id || ""}`;
      if (!pattern.test(key) || element.closest("header") || element.getBoundingClientRect().width <= 0) return;
      element.dataset.rpCrudeLayerHidden = "true";
      state.hidden.push(element);
    });
  }

  function restoreCrudeAnimation() {
    state.hidden.forEach((element) => delete element.dataset.rpCrudeLayerHidden);
    state.hidden = [];
    $$(".rp-map-overlay").forEach((element) => element.remove());
  }

  function render() {
    if (state.mode !== "refined" || !state.data) return;
    const record = selectedRecord();
    if (!record) return;
    $(".rp-date").textContent = `${monthName(record.period)} · ${state.data.unit} · ${record.countries.length} reporting economies shown`;

    const metrics = [["Refinery output", "output"], ["Product demand", "demand"], ["Exports", "exports"], ["Imports", "imports"]];
    $(".rp-metrics").innerHTML = metrics.map(([label, field]) => `<div class="rp-metric"><div class="rp-metric-label">${label}</div><div class="rp-metric-value">${format(record.global[field])}<span class="rp-unit">mb/d</span></div></div>`).join("");

    const exporters = [...record.countries].sort((a, b) => b.exports - a.exports).slice(0, 5);
    const importers = [...record.countries].sort((a, b) => b.imports - a.imports).slice(0, 5);
    $(".rp-trade").innerHTML = `<div class="rp-row"><span><i class="rp-swatch"></i>Top exporters</span><b>mb/d</b></div>${exporters.map((country) => `<div class="rp-row"><span>${escapeHtml(country.name)}</span><b>${format(country.exports)}</b></div>`).join("")}<div class="rp-row" style="margin-top:5px"><span><i class="rp-swatch import"></i>Top importers</span><b>mb/d</b></div>${importers.map((country) => `<div class="rp-row"><span>${escapeHtml(country.name)}</span><b>${format(country.imports)}</b></div>`).join("")}`;
    $(".rp-note").textContent = `Source: ${state.data.source}. Reported total: ${state.data.reportedProduct}. Coverage is not a complete bilateral trade matrix; arcs pair leading reported exporters and importers to show scale, not documented cargo routes.`;

    const mix = state.data.productMix || [];
    const maximum = Math.max(1, ...mix.map((item) => item.mbd));
    $(".rp-products").innerHTML = mix.slice(0, 8).map((item) => `<div class="rp-product"><span>${escapeHtml(item.product)}</span><span class="rp-product-bar"><i style="width:${Math.min(100, item.mbd / maximum * 100)}%"></i></span><b>${format(item.mbd)}</b></div>`).join("");

    suppressCrudeAnimation();
    renderMap(record);
  }

  function setMode(mode) {
    state.mode = mode === "refined" ? "refined" : "crude";
    document.body.classList.toggle("refined-products-active", state.mode === "refined");
    $$("#oilStreamToggle button").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.stream === state.mode)));
    if (state.mode === "refined") {
      document.title = `Refined products · ${state.originalTitle}`;
      render();
    } else {
      document.title = state.originalTitle;
      restoreCrudeAnimation();
    }
    try { localStorage.setItem("oil-atlas-stream", state.mode); } catch { /* Storage may be disabled. */ }
  }

  async function start() {
    installUi();
    try {
      state.data = await fetch("/refined-products-data.json", { cache: "no-store" }).then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      });
    } catch (error) {
      console.error("Refined products data unavailable", error);
      $("#oilStreamToggle button[data-stream=refined]").disabled = true;
      return;
    }

    const parameters = new URL(location.href).searchParams;
    const preferred = parameters.get("stream") || localStorage.getItem("oil-atlas-stream") || "crude";
    setMode(preferred);

    let timer;
    state.observer = new MutationObserver(() => {
      if (state.mode !== "refined") return;
      clearTimeout(timer);
      timer = setTimeout(render, 180);
    });
    state.observer.observe(document.body, { subtree: true, childList: true, characterData: true });

    window.__OIL_ATLAS_STREAM__ = {
      setMode,
      getState: () => ({ mode: state.mode, period: state.period, data: state.data, installed: true }),
    };
  }

  return { start };
})();

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", RefinedProducts.start, { once: true });
else RefinedProducts.start();
