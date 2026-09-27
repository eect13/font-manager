/* Atrium — modular personal dashboard
   Local-first. Data lives in localStorage under atrium.v1 */
(function () {
  const KEY = "atrium.v1";
  const TZ = "Asia/Manila";
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  const MODULES = [
    { id: "dashboard", label: "Dashboard", icon: "⌂", canDisable: false },
    { id: "calendar", label: "Calendar", icon: "▦", canDisable: false },
    { id: "notes", label: "Sticky notes", icon: "✎", canDisable: true },
    { id: "finance", label: "Finance", icon: "₱", canDisable: true },
    { id: "news", label: "News", icon: "☰", canDisable: true },
    { id: "settings", label: "Modules", icon: "⚙", canDisable: false },
  ];

  const NOTE_COLORS = ["#f5e6a8", "#ffd0d6", "#c7f0d8", "#cde4ff", "#e4d6ff", "#ffd9b8"];
  const CAT_COLORS = {
    work: "#7eb4ff",
    personal: "#e2b657",
    family: "#fb7185",
    health: "#6ee7b7",
    other: "#c4b5fd",
  };

  const DEFAULT_FEEDS = [
    { id: "gnews", name: "Top stories", url: "https://news.google.com/rss?hl=en-PH&gl=PH&ceid=PH:en", category: "Top" },
    { id: "bbc", name: "BBC World", url: "https://feeds.bbci.co.uk/news/world/rss.xml", category: "World" },
    { id: "tech", name: "The Verge", url: "https://www.theverge.com/rss/index.xml", category: "Tech" },
    { id: "ph", name: "Rappler", url: "https://www.rappler.com/feed/", category: "PH" },
    { id: "biz", name: "CNBC", url: "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114", category: "Markets" },
  ];

  const QUOTES = [
    ["Attention is the rarest and purest form of generosity.", "Simone Weil"],
    ["We are what we repeatedly do.", "Aristotle"],
    ["The calendar is a map of intention.", "Atrium"],
    ["Make it work, make it right, make it fast.", "Kent Beck"],
    ["Small hinges swing big doors.", "W. Clement Stone"],
  ];

  function uid() {
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  }

  function seed() {
    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth();
    const d = now.getDate();
    const at = (day, h, min = 0) => new Date(y, m, day, h, min).toISOString();
    return {
      profile: { name: "Eric", city: "Las Piñas", lat: 14.4508, lon: 120.9828 },
      theme: "dark",
      modules: { dashboard: true, calendar: true, notes: true, finance: true, news: true, settings: true },
      widgets: { weather: true, agenda: true, notes: true, finance: true, news: true, quote: true, watch: true },
      events: [
        { id: uid(), title: "Weekly planning", start: at(d, 9, 0), end: at(d, 10, 0), cat: "work", loc: "" },
        { id: uid(), title: "Lunch with family", start: at(d, 12, 30), end: at(d, 14, 0), cat: "family", loc: "Home" },
        { id: uid(), title: "Deep work block", start: at(Math.min(d + 1, 28), 14, 0), end: at(Math.min(d + 1, 28), 17, 0), cat: "work", loc: "" },
        { id: uid(), title: "Gym", start: at(d + 2 > 28 ? d : d + 2, 18, 0), end: at(d + 2 > 28 ? d : d + 2, 19, 0), cat: "health", loc: "" },
      ],
      calendars: [
        { id: "local", name: "Atrium", color: "#e2b657", enabled: true, type: "local" },
      ],
      notes: [
        { id: uid(), text: "Ship Atrium dashboard v1\n— calendar ICS\n— finance watcher", color: NOTE_COLORS[0], x: 36, y: 40, z: 1 },
        { id: uid(), text: "Read Rappler + markets before 9am.", color: NOTE_COLORS[3], x: 280, y: 80, z: 2 },
        { id: uid(), text: "Pay Meralco · review grocery budget", color: NOTE_COLORS[1], x: 160, y: 250, z: 3 },
      ],
      accounts: [
        { id: "cash", name: "Cash / wallet", balance: 8500 },
        { id: "bank", name: "BDO checking", balance: 126400 },
        { id: "gcash", name: "GCash", balance: 4320 },
      ],
      budgets: [
        { id: "food", name: "Food", limit: 15000 },
        { id: "trans", name: "Transport", limit: 4000 },
        { id: "bills", name: "Bills", limit: 18000 },
        { id: "fun", name: "Discretionary", limit: 6000 },
      ],
      txs: [
        { id: uid(), date: isoDate(now), payee: "Grocery — S&R", amount: -2850, cat: "food" },
        { id: uid(), date: isoDate(now), payee: "Salary", amount: 72000, cat: "income" },
        { id: uid(), date: isoDate(addDays(now, -1)), payee: "Grab", amount: -248, cat: "trans" },
        { id: uid(), date: isoDate(addDays(now, -2)), payee: "Meralco", amount: -4200, cat: "bills" },
        { id: uid(), date: isoDate(addDays(now, -3)), payee: "Coffee", amount: -180, cat: "food" },
      ],
      watch: [
        { id: "btc", symbol: "bitcoin", label: "BTC", kind: "crypto" },
        { id: "eth", symbol: "ethereum", label: "ETH", kind: "crypto" },
        { id: "usdphp", symbol: "usd-php", label: "USD/PHP", kind: "fx" },
      ],
      quotes: QUOTES,
      feeds: DEFAULT_FEEDS.map((f) => ({ ...f, enabled: true })),
      newsCache: { at: 0, items: [] },
      prices: {},
    };
  }

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return seed();
      return { ...seed(), ...JSON.parse(raw) };
    } catch {
      return seed();
    }
  }
  function save() {
    localStorage.setItem(KEY, JSON.stringify(state));
  }

  let state = load();
  let view = "dashboard";
  let calCursor = new Date();
  let calMode = "month";
  let newsFilter = "All";
  let weather = null;

  function isoDate(d) {
    const z = new Date(d);
    const y = z.getFullYear();
    const m = String(z.getMonth() + 1).padStart(2, "0");
    const day = String(z.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }
  function addDays(d, n) {
    const x = new Date(d);
    x.setDate(x.getDate() + n);
    return x;
  }
  function fmtTime(iso) {
    return new Date(iso).toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit", timeZone: TZ });
  }
  function fmtDate(iso) {
    return new Date(iso).toLocaleDateString("en-PH", { weekday: "short", month: "short", day: "numeric", timeZone: TZ });
  }
  function sameDay(a, b) {
    const x = new Date(a), y = new Date(b);
    return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
  }
  function monthName(d) {
    return d.toLocaleDateString("en-PH", { month: "long", year: "numeric" });
  }
  function peso(n) {
    return "₱" + Number(n).toLocaleString("en-PH", { maximumFractionDigits: 0 });
  }
  function toast(msg) {
    let el = $(".toast");
    if (!el) {
      el = document.createElement("div");
      el.className = "toast";
      el.id = "toast";
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(el._t);
    el._t = setTimeout(() => (el.hidden = true), 2400);
  }

  /* ---------- Natural language event parse (Fantastical-lite) ---------- */
  function parseWhen(text) {
    const now = new Date();
    let title = text.trim();
    let start = new Date(now);
    start.setMinutes(0, 0, 0);
    start.setHours(start.getHours() + 1);
    let dur = 60;
    const days = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
    const lower = title.toLowerCase();

    if (/\btomorrow\b/.test(lower)) {
      start = addDays(now, 1);
      start.setHours(9, 0, 0, 0);
      title = title.replace(/tomorrow/ig, "").trim();
    } else if (/\btoday\b/.test(lower)) {
      start = new Date(now);
      start.setHours(now.getHours() + 1, 0, 0, 0);
      title = title.replace(/today/ig, "").trim();
    }
    for (const [name, idx] of Object.entries(days)) {
      if (new RegExp("\\b" + name + "\\b", "i").test(lower)) {
        const cur = now.getDay();
        let add = (idx - cur + 7) % 7;
        if (add === 0) add = 7;
        start = addDays(now, add);
        start.setHours(9, 0, 0, 0);
        title = title.replace(new RegExp(name, "ig"), "").trim();
      }
    }
    const tm = lower.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
    if (tm) {
      let h = +tm[1];
      const min = tm[2] ? +tm[2] : 0;
      const ap = tm[3];
      if (ap === "pm" && h < 12) h += 12;
      if (ap === "am" && h === 12) h = 0;
      start.setHours(h, min, 0, 0);
      title = title.replace(/\b\d{1,2}(?::\d{2})?\s*(am|pm)?\b/i, "").trim();
    }
    title = title.replace(/\s+(at|on)\s*$/i, "").replace(/\s+/g, " ").replace(/^[-–—]\s*/, "");
    if (!title) title = "New event";
    const end = new Date(start.getTime() + dur * 60000);
    return { title, start: start.toISOString(), end: end.toISOString() };
  }

  /* ---------- ICS ---------- */
  function icsEscape(s) {
    return String(s || "").replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
  }
  function toICSDate(iso) {
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}00Z`;
  }
  function exportICS() {
    const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Atrium//EN", "CALSCALE:GREGORIAN"];
    for (const ev of state.events) {
      lines.push("BEGIN:VEVENT");
      lines.push("UID:" + ev.id + "@atrium.local");
      lines.push("DTSTAMP:" + toICSDate(new Date().toISOString()));
      lines.push("DTSTART:" + toICSDate(ev.start));
      lines.push("DTEND:" + toICSDate(ev.end));
      lines.push("SUMMARY:" + icsEscape(ev.title));
      if (ev.loc) lines.push("LOCATION:" + icsEscape(ev.loc));
      if (ev.cat) lines.push("CATEGORIES:" + ev.cat);
      lines.push("END:VEVENT");
    }
    lines.push("END:VCALENDAR");
    const blob = new Blob([lines.join("\r\n")], { type: "text/calendar" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "atrium.ics";
    a.click();
    toast("Exported atrium.ics");
  }
  function parseICS(text) {
    const events = [];
    const blocks = text.split(/BEGIN:VEVENT/i).slice(1);
    for (const b of blocks) {
      const body = b.split(/END:VEVENT/i)[0];
      const get = (k) => {
        const re = new RegExp("^" + k + "(?:;[^:]*)?:(.*)$", "im");
        const m = body.match(re);
        return m ? m[1].trim().replace(/\\n/g, "\n").replace(/\\,/g, ",") : "";
      };
      const rawS = get("DTSTART");
      const rawE = get("DTEND");
      const parseDt = (s) => {
        if (!s) return new Date().toISOString();
        const compact = s.replace(/[^0-9T]/g, "");
        if (/^\d{8}$/.test(compact)) {
          return new Date(+compact.slice(0, 4), +compact.slice(4, 6) - 1, +compact.slice(6, 8)).toISOString();
        }
        const y = +compact.slice(0, 4), mo = +compact.slice(4, 6) - 1, d = +compact.slice(6, 8);
        const h = +compact.slice(9, 11) || 0, mi = +compact.slice(11, 13) || 0;
        if (s.endsWith("Z") || /UTC/.test(s)) return new Date(Date.UTC(y, mo, d, h, mi)).toISOString();
        return new Date(y, mo, d, h, mi).toISOString();
      };
      events.push({
        id: uid(),
        title: get("SUMMARY") || "Imported event",
        start: parseDt(rawS),
        end: rawE ? parseDt(rawE) : parseDt(rawS),
        cat: (get("CATEGORIES") || "other").toLowerCase().split(",")[0] || "other",
        loc: get("LOCATION") || "",
      });
    }
    return events;
  }

  async function subscribeICS(url) {
    const proxies = [
      (u) => "https://corsproxy.io/?" + encodeURIComponent(u),
      (u) => "https://api.allorigins.win/raw?url=" + encodeURIComponent(u),
    ];
    let lastErr;
    for (const p of proxies) {
      try {
        const res = await fetch(p(url));
        if (!res.ok) throw new Error("HTTP " + res.status);
        const text = await res.text();
        const evs = parseICS(text);
        if (!evs.length) throw new Error("No events in feed");
        state.events.push(...evs);
        state.calendars.push({ id: uid(), name: url.replace(/^https?:\/\//, "").slice(0, 28), color: "#7eb4ff", enabled: true, type: "ics", url });
        save();
        toast("Imported " + evs.length + " events");
        render();
        return;
      } catch (e) {
        lastErr = e;
      }
    }
    toast("Could not fetch calendar. Try importing an .ics file.");
    console.warn(lastErr);
  }

  /* ---------- Weather ---------- */
  async function loadWeather() {
    try {
      const { lat, lon } = state.profile;
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=${encodeURIComponent(TZ)}`;
      const res = await fetch(url);
      weather = await res.json();
      renderWeather();
    } catch (e) {
      weather = null;
    }
  }
  function wmo(code) {
    if (code == null) return "—";
    if (code === 0) return "Clear";
    if (code <= 3) return "Partly cloudy";
    if (code <= 48) return "Fog";
    if (code <= 67) return "Rain";
    if (code <= 77) return "Snow";
    if (code <= 82) return "Showers";
    return "Storms";
  }

  /* ---------- News ---------- */
  async function loadNews(force) {
    if (!force && state.newsCache.items.length && Date.now() - state.newsCache.at < 20 * 60 * 1000) return;
    const items = [];
    const enabled = state.feeds.filter((f) => f.enabled);
    await Promise.all(
      enabled.map(async (f) => {
        try {
          const res = await fetch("https://api.rss2json.com/v1/api.json?rss_url=" + encodeURIComponent(f.url) + "&count=12");
          const json = await res.json();
          if (json.status !== "ok" || !json.items) return;
          for (const it of json.items) {
            items.push({
              title: it.title,
              link: it.link,
              desc: (it.description || "").replace(/<[^>]+>/g, "").slice(0, 180),
              date: it.pubDate,
              src: f.name,
              category: f.category,
            });
          }
        } catch {}
      })
    );
    items.sort((a, b) => new Date(b.date) - new Date(a.date));
    state.newsCache = { at: Date.now(), items: items.slice(0, 40) };
    save();
  }

  /* ---------- Prices ---------- */
  async function loadPrices() {
    const cryptos = state.watch.filter((w) => w.kind === "crypto").map((w) => w.symbol);
    try {
      if (cryptos.length) {
        const res = await fetch(
          "https://api.coingecko.com/api/v3/simple/price?ids=" + cryptos.join(",") + "&vs_currencies=usd,php&include_24hr_change=true"
        );
        const json = await res.json();
        state.prices = { ...state.prices, ...json };
      }
      const fx = await fetch("https://api.exchangerate-api.com/v4/latest/USD");
      if (fx.ok) {
        const j = await fx.json();
        if (j && j.rates && j.rates.PHP) {
          state.prices["usd-php"] = { php: j.rates.PHP, usd: 1, php_24h_change: 0 };
        }
      }
      save();
    } catch {}
  }

  /* ---------- Render shell ---------- */
  function greet() {
    const h = new Date().toLocaleString("en-PH", { hour: "numeric", hour12: false, timeZone: TZ });
    const hour = +h;
    if (hour < 12) return "Good morning";
    if (hour < 18) return "Good afternoon";
    return "Good evening";
  }

  function renderNav() {
    const nav = $(".nav");
    nav.innerHTML = MODULES.map((m) => {
      if (m.canDisable && !state.modules[m.id]) return "";
      return `<button data-view="${m.id}" class="${view === m.id ? "active" : ""}"><span class="ico">${m.icon}</span>${m.label}</button>`;
    }).join("");
    nav.onclick = (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      view = b.dataset.view;
      render();
    };
  }

  function tickClock() {
    const el = $("#live-clock");
    if (!el) return;
    const now = new Date();
    el.textContent = now.toLocaleString("en-PH", {
      weekday: "short",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      timeZone: TZ,
    });
  }

  /* ---------- Views ---------- */
  function todayEvents() {
    const now = new Date();
    return state.events
      .filter((e) => sameDay(e.start, now))
      .sort((a, b) => new Date(a.start) - new Date(b.start));
  }

  function renderDashboard() {
    const q = state.quotes[new Date().getDate() % state.quotes.length];
    const evs = todayEvents();
    const monthSpend = spendThisMonth();
    const cash = state.accounts.reduce((s, a) => s + Number(a.balance || 0), 0);
    const headlines = state.newsCache.items.slice(0, 5);
    const notes = state.notes.slice(0, 3);

    return `
      <div class="grid">
        <section class="card span-5 hello">
          <h3>Today</h3>
          <p class="serif">${greet()}, ${esc(state.profile.name)}.</p>
          <p class="sub">${new Date().toLocaleDateString("en-PH", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: TZ })} · ${esc(state.profile.city)}</p>
          <div id="weather-slot">${weatherHTML()}</div>
        </section>
        <section class="card span-4">
          <h3>Up next</h3>
          ${
            evs.length
              ? evs
                  .map(
                    (e) => `<div class="event-row">
                    <span class="dot" style="background:${CAT_COLORS[e.cat] || CAT_COLORS.other}"></span>
                    <div class="grow"><div class="what">${esc(e.title)}</div><div class="when">${fmtTime(e.start)} – ${fmtTime(e.end)}${e.loc ? " · " + esc(e.loc) : ""}</div></div>
                  </div>`
                  )
                  .join("")
              : `<p class="empty">Nothing on the calendar. Add with natural language above, or open Calendar.</p>`
          }
        </section>
        <section class="card span-3">
          <h3>Quote</h3>
          <p class="quote">${esc(q[0])}<cite>— ${esc(q[1])}</cite></p>
        </section>

        ${
          state.modules.finance
            ? `<section class="card span-4">
            <h3>Finance watcher</h3>
            <div class="kpi" style="border:0;padding:0;background:transparent">
              <div class="lbl">Liquid</div>
              <div class="val">${peso(cash)}</div>
              <div class="delta ${monthSpend > 0 ? "neg" : "pos"}">Spent this month ${peso(monthSpend)}</div>
            </div>
            <div class="watch" style="margin-top:10px">${watchHTML()}</div>
          </section>`
            : ""
        }

        ${
          state.modules.notes
            ? `<section class="card span-4">
            <h3>Pinned notes</h3>
            ${
              notes.length
                ? notes
                    .map(
                      (n) =>
                        `<div class="event-row"><span class="dot" style="background:${n.color}"></span><div class="what">${esc(n.text.split("\n")[0])}</div></div>`
                    )
                    .join("")
                : `<p class="empty">No stickies yet.</p>`
            }
          </section>`
            : ""
        }

        ${
          state.modules.news
            ? `<section class="card span-4">
            <h3>Headlines</h3>
            ${
              headlines.length
                ? headlines
                    .map(
                      (n) =>
                        `<a class="news-row" href="${esc(n.link)}" target="_blank" rel="noopener" style="text-decoration:none;color:inherit">
                          <div class="grow"><div class="what">${esc(n.title)}</div><div class="when">${esc(n.src)}</div></div>
                        </a>`
                    )
                    .join("")
                : `<p class="empty">Fetching feeds…</p>`
            }
          </section>`
            : ""
        }
      </div>`;
  }

  function weatherHTML() {
    if (!weather || !weather.current) return `<p class="empty">Weather loading…</p>`;
    const c = weather.current;
    const days = weather.daily || {};
    let f = "";
    if (days.time) {
      f = `<div class="forecast">${days.time
        .slice(0, 5)
        .map((t, i) => {
          const label = new Date(t + "T12:00:00").toLocaleDateString("en-PH", { weekday: "short" });
          return `<div>${label}<strong>${Math.round(days.temperature_2m_max[i])}°</strong></div>`;
        })
        .join("")}</div>`;
    }
    return `<div class="weather-now"><div class="temp">${Math.round(c.temperature_2m)}°</div><div class="meta">${wmo(c.weather_code)}<br>Wind ${Math.round(c.wind_speed_10m)} km/h</div></div>${f}`;
  }
  function renderWeather() {
    const slot = $("#weather-slot");
    if (slot) slot.innerHTML = weatherHTML();
  }

  function watchHTML() {
    if (!state.watch.length) return `<p class="empty">No instruments.</p>`;
    return state.watch
      .map((w) => {
        const p = state.prices[w.symbol] || {};
        const php = p.php;
        const ch = p.php_24h_change || p.usd_24h_change || 0;
        const val = php != null ? (w.kind === "fx" ? Number(php).toFixed(2) : "₱" + Number(php).toLocaleString("en-PH", { maximumFractionDigits: 0 })) : "—";
        return `<div class="watch-item"><span class="sym">${esc(w.label)}</span><span class="${ch >= 0 ? "pos" : "neg"}">${val} ${ch ? (ch >= 0 ? "▲" : "▼") + Math.abs(ch).toFixed(1) + "%" : ""}</span></div>`;
      })
      .join("");
  }

  function monthCells(cursor) {
    const y = cursor.getFullYear(),
      m = cursor.getMonth();
    const first = new Date(y, m, 1);
    const startDow = first.getDay();
    const daysIn = new Date(y, m + 1, 0).getDate();
    const prevIn = new Date(y, m, 0).getDate();
    const cells = [];
    for (let i = 0; i < startDow; i++) cells.push({ day: prevIn - startDow + 1 + i, out: true, date: new Date(y, m - 1, prevIn - startDow + 1 + i) });
    for (let d = 1; d <= daysIn; d++) cells.push({ day: d, out: false, date: new Date(y, m, d) });
    while (cells.length % 7) {
      const n = cells.length - (startDow + daysIn) + 1;
      cells.push({ day: n, out: true, date: new Date(y, m + 1, n) });
    }
    return cells;
  }

  function eventsOn(date) {
    return state.events.filter((e) => sameDay(e.start, date)).sort((a, b) => new Date(a.start) - new Date(b.start));
  }

  function renderCalendar() {
    const cells = monthCells(calCursor);
    const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    let body = "";
    if (calMode === "month") {
      body = `<div class="month-grid">
        ${weekdays.map((d) => `<div class="dow">${d}</div>`).join("")}
        ${cells
          .map((c) => {
            const evs = eventsOn(c.date);
            const isToday = sameDay(c.date, new Date());
            return `<div class="day ${c.out ? "out" : ""} ${isToday ? "today" : ""}" data-date="${isoDate(c.date)}">
              <div class="n">${c.day}</div>
              ${evs
                .slice(0, 3)
                .map((e) => `<div class="pill" style="background:${(CAT_COLORS[e.cat] || CAT_COLORS.other)}22;color:${CAT_COLORS[e.cat] || CAT_COLORS.other}">${esc(e.title)}</div>`)
                .join("")}
            </div>`;
          })
          .join("")}
      </div>`;
    } else if (calMode === "week") {
      const start = addDays(calCursor, -calCursor.getDay());
      body = `<div class="month-grid">
        ${weekdays.map((d, i) => {
          const day = addDays(start, i);
          const evs = eventsOn(day);
          return `<div>
            <div class="dow">${d} ${day.getDate()}</div>
            <div class="day ${sameDay(day, new Date()) ? "today" : ""}" data-date="${isoDate(day)}" style="min-height:280px">
              ${evs.map((e) => `<div class="pill" style="background:${(CAT_COLORS[e.cat] || CAT_COLORS.other)}22;color:${CAT_COLORS[e.cat] || CAT_COLORS.other}">${fmtTime(e.start)} ${esc(e.title)}</div>`).join("") || '<p class="empty">Free</p>'}
            </div>
          </div>`;
        }).join("")}
      </div>`;
    } else {
      const list = [...state.events].sort((a, b) => new Date(a.start) - new Date(b.start));
      const groups = {};
      for (const e of list) {
        const k = isoDate(e.start);
        (groups[k] = groups[k] || []).push(e);
      }
      body = Object.keys(groups)
        .slice(0, 24)
        .map((k) => {
          return `<div class="list-day"><h4>${fmtDate(groups[k][0].start)}</h4>
            ${groups[k]
              .map(
                (e) => `<div class="event-row" data-eid="${e.id}">
                  <span class="dot" style="background:${CAT_COLORS[e.cat] || CAT_COLORS.other}"></span>
                  <div class="grow"><div class="what">${esc(e.title)}</div><div class="when">${fmtTime(e.start)} – ${fmtTime(e.end)} · ${esc(e.cat)}</div></div>
                  <button class="icon-btn" data-del="${e.id}">✕</button>
                </div>`
              )
              .join("")}</div>`;
        })
        .join("") || `<p class="empty">No events yet.</p>`;
    }

    return `
      <div class="cal-head">
        <h2>${monthName(calCursor)}</h2>
        <button class="btn ghost" id="cal-prev">‹</button>
        <button class="btn ghost" id="cal-today">Today</button>
        <button class="btn ghost" id="cal-next">›</button>
        <div class="seg">
          <button data-mode="month" class="${calMode === "month" ? "on" : ""}">Month</button>
          <button data-mode="week" class="${calMode === "week" ? "on" : ""}">Week</button>
          <button data-mode="list" class="${calMode === "list" ? "on" : ""}">Agenda</button>
        </div>
        <div class="grow"></div>
        <button class="btn ghost" id="ics-import">Import .ics</button>
        <button class="btn ghost" id="ics-sub">Subscribe URL</button>
        <button class="btn ghost" id="ics-export">Export</button>
        <button class="btn" id="cal-add">New event</button>
        <input type="file" id="ics-file" accept=".ics,text/calendar" hidden>
      </div>
      <p class="sub" style="color:var(--muted);font-size:12px;margin:-6px 0 12px">Integration: import Apple / Google / Outlook .ics, paste a public iCal URL, or export Atrium as .ics. Natural language: “Lunch with Ana Friday 1pm”.</p>
      ${body}
    `;
  }

  function renderNotes() {
    return `
      <div class="cal-head">
        <h2>Sticky notes</h2>
        <div class="grow"></div>
        ${NOTE_COLORS.map((c) => `<button class="icon-btn add-note" data-color="${c}" style="background:${c}" title="New note"></button>`).join("")}
      </div>
      <div class="board" id="board">
        ${state.notes
          .map(
            (n) => `<article class="sticky" data-id="${n.id}" style="left:${n.x}px;top:${n.y}px;background:${n.color};z-index:${n.z || 1}">
              <textarea>${esc(n.text)}</textarea>
              <div class="meta"><span>drag to move</span><button class="x" data-kill="${n.id}">delete</button></div>
            </article>`
          )
          .join("")}
      </div>`;
  }

  function spendThisMonth() {
    const now = new Date();
    const prefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    return state.txs.filter((t) => t.date.startsWith(prefix) && t.amount < 0).reduce((s, t) => s + Math.abs(t.amount), 0);
  }
  function incomeThisMonth() {
    const now = new Date();
    const prefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    return state.txs.filter((t) => t.date.startsWith(prefix) && t.amount > 0).reduce((s, t) => s + t.amount, 0);
  }

  function renderFinance() {
    const liquid = state.accounts.reduce((s, a) => s + Number(a.balance || 0), 0);
    const spent = spendThisMonth();
    const income = incomeThisMonth();
    const byCat = {};
    const prefix = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}`;
    for (const t of state.txs) {
      if (!t.date.startsWith(prefix) || t.amount >= 0) continue;
      byCat[t.cat] = (byCat[t.cat] || 0) + Math.abs(t.amount);
    }
    return `
      <div class="cal-head">
        <h2>Finance watcher</h2>
        <div class="grow"></div>
        <button class="btn ghost" id="tx-add">Add transaction</button>
        <button class="btn ghost" id="acct-edit">Accounts</button>
      </div>
      <div class="kpis">
        <div class="kpi"><div class="lbl">Liquid cash</div><div class="val">${peso(liquid)}</div></div>
        <div class="kpi"><div class="lbl">Income MTD</div><div class="val pos">${peso(income)}</div></div>
        <div class="kpi"><div class="lbl">Spent MTD</div><div class="val neg">${peso(spent)}</div></div>
        <div class="kpi"><div class="lbl">Net MTD</div><div class="val ${income - spent >= 0 ? "pos" : "neg"}">${peso(income - spent)}</div></div>
      </div>
      <div class="grid">
        <section class="card span-6">
          <h3>Budgets this month</h3>
          <div class="bars">
            ${state.budgets
              .map((b) => {
                const used = byCat[b.id] || byCat[b.name.toLowerCase()] || 0;
                const pct = Math.min(100, Math.round((used / b.limit) * 100));
                return `<div class="bar-row"><span>${esc(b.name)}</span><div class="track"><div class="fill" style="width:${pct}%;background:${pct > 90 ? "var(--bad)" : "linear-gradient(90deg,var(--gold),#f0d084)"}"></div></div><span>${peso(used)} / ${peso(b.limit)}</span></div>`;
              })
              .join("")}
          </div>
        </section>
        <section class="card span-6">
          <h3>Market watch</h3>
          ${watchHTML()}
          <p class="empty" style="margin-top:10px">Crypto via CoinGecko · FX via public USD rates. Stocks can be added later as a module.</p>
        </section>
        <section class="card span-12">
          <h3>Ledger</h3>
          <table class="table">
            <thead><tr><th>Date</th><th>Payee</th><th>Category</th><th>Amount</th><th></th></tr></thead>
            <tbody>
              ${[...state.txs]
                .sort((a, b) => b.date.localeCompare(a.date))
                .map(
                  (t) => `<tr>
                    <td>${esc(t.date)}</td><td>${esc(t.payee)}</td><td>${esc(t.cat)}</td>
                    <td class="${t.amount < 0 ? "neg" : "pos"}">${t.amount < 0 ? "−" : "+"}${peso(Math.abs(t.amount))}</td>
                    <td><button class="icon-btn" data-deltx="${t.id}">✕</button></td>
                  </tr>`
                )
                .join("")}
            </tbody>
          </table>
        </section>
      </div>`;
  }

  function renderNews() {
    const cats = ["All", ...new Set(state.feeds.map((f) => f.category))];
    const items = state.newsCache.items.filter((i) => newsFilter === "All" || i.category === newsFilter);
    const hero = items[0];
    const rest = items.slice(1);
    return `
      <div class="cal-head">
        <h2>Briefing</h2>
        <div class="grow"></div>
        <button class="btn ghost" id="news-refresh">Refresh feeds</button>
        <button class="btn ghost" id="news-feeds">Manage RSS</button>
      </div>
      <div class="chips">
        ${cats.map((c) => `<button class="chip ${newsFilter === c ? "on" : ""}" data-cat="${esc(c)}">${esc(c)}</button>`).join("")}
      </div>
      ${
        hero
          ? `<div class="news-hero" style="margin-bottom:14px">
          <a class="hero-card" href="${esc(hero.link)}" target="_blank" rel="noopener">
            <div><div class="src" style="color:var(--gold);font-size:11px;letter-spacing:.08em;text-transform:uppercase">${esc(hero.src)}</div>
            <h2>${esc(hero.title)}</h2>
            <p style="color:var(--muted);margin:0">${esc(hero.desc)}</p></div>
          </a>
          <div>
            ${rest
              .slice(0, 4)
              .map(
                (n) => `<a class="news-row" href="${esc(n.link)}" target="_blank" rel="noopener" style="text-decoration:none;color:inherit">
                  <div class="grow"><div class="what">${esc(n.title)}</div><div class="when">${esc(n.src)}</div></div>
                </a>`
              )
              .join("")}
          </div>
        </div>`
          : `<p class="empty">No stories yet — check your connection or manage RSS feeds.</p>`
      }
      <div class="news-grid">
        ${rest
          .slice(4)
          .map(
            (n) => `<a class="story" href="${esc(n.link)}" target="_blank" rel="noopener">
              <div class="src">${esc(n.src)} · ${esc(n.category)}</div>
              <h4>${esc(n.title)}</h4>
              <p>${esc(n.desc)}</p>
            </a>`
          )
          .join("")}
      </div>`;
  }

  function renderSettings() {
    return `
      <div class="cal-head"><h2>Modules & integrations</h2></div>
      <section class="card">
        <h3>Module rack — KatanOS-style</h3>
        <p class="sub" style="color:var(--muted);font-size:13px;margin:0 0 8px">Disable a module to hide it from the rail and strip its dashboard widgets. Calendar stays core.</p>
        ${MODULES.filter((m) => m.id !== "settings" && m.id !== "dashboard")
          .map((m) => {
            const on = !!state.modules[m.id];
            return `<div class="mod-row">
              <div><strong>${m.icon} ${esc(m.label)}</strong><div class="sub" style="color:var(--muted);font-size:12px">${m.canDisable ? "Optional" : "Core — always on"}</div></div>
              <button class="toggle ${on ? "on" : ""}" data-mod="${m.id}" ${m.canDisable ? "" : "disabled"}><i></i></button>
            </div>`;
          })
          .join("")}
      </section>
      <section class="card" style="margin-top:14px">
        <h3>Profile</h3>
        <div class="row2">
          <div class="field"><label>Name</label><input id="set-name" value="${esc(state.profile.name)}"></div>
          <div class="field"><label>City</label><input id="set-city" value="${esc(state.profile.city)}"></div>
        </div>
        <div class="row2">
          <div class="field"><label>Latitude</label><input id="set-lat" value="${state.profile.lat}"></div>
          <div class="field"><label>Longitude</label><input id="set-lon" value="${state.profile.lon}"></div>
        </div>
        <button class="btn" id="save-profile">Save profile</button>
        <button class="btn ghost" id="reset-data" style="margin-left:8px">Reset demo data</button>
      </section>
      <section class="card" style="margin-top:14px">
        <h3>Calendar integrations</h3>
        <p style="color:var(--muted);font-size:13px;line-height:1.5">Atrium is local-first. Hook external calendars by exporting an .ics from Fantastical, Google Calendar (Settings → Integrate calendar → Secret address in iCal format), Outlook, or Apple Calendar, then Import or Subscribe. Export writes every Atrium event back out as a standard .ics.</p>
        ${state.calendars.map((c) => `<div class="mod-row"><div>${esc(c.name)} <span style="color:var(--faint);font-size:12px">${esc(c.type)}</span></div><span class="dot" style="background:${c.color}"></span></div>`).join("")}
      </section>
    `;
  }

  function esc(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function render() {
    document.documentElement.dataset.theme = state.theme;
    renderNav();
    $("#view-title").textContent = MODULES.find((m) => m.id === view)?.label || "Atrium";
    const root = $("#view");
    root.hidden = false;
    if (view === "dashboard") root.innerHTML = renderDashboard();
    else if (view === "calendar") root.innerHTML = renderCalendar();
    else if (view === "notes") root.innerHTML = renderNotes();
    else if (view === "finance") root.innerHTML = renderFinance();
    else if (view === "news") root.innerHTML = renderNews();
    else if (view === "settings") root.innerHTML = renderSettings();
    bindView();
  }

  function bindView() {
    if (view === "calendar") {
      $("#cal-prev").onclick = () => {
        calCursor = new Date(calCursor.getFullYear(), calCursor.getMonth() - 1, 1);
        render();
      };
      $("#cal-next").onclick = () => {
        calCursor = new Date(calCursor.getFullYear(), calCursor.getMonth() + 1, 1);
        render();
      };
      $("#cal-today").onclick = () => {
        calCursor = new Date();
        render();
      };
      $$(".seg [data-mode]").forEach((b) => {
        b.onclick = () => {
          calMode = b.dataset.mode;
          render();
        };
      });
      $("#cal-add").onclick = () => openEventModal();
      $("#ics-export").onclick = exportICS;
      $("#ics-import").onclick = () => $("#ics-file").click();
      $("#ics-file").onchange = async (e) => {
        const f = e.target.files[0];
        if (!f) return;
        const text = await f.text();
        const evs = parseICS(text);
        state.events.push(...evs);
        save();
        toast("Imported " + evs.length + " events");
        render();
      };
      $("#ics-sub").onclick = () => {
        const url = prompt("Public iCal / webcal URL (Google secret address, Outlook ICS, etc.)");
        if (url) subscribeICS(url.replace(/^webcal:/, "https:"));
      };
      $$(".day[data-date]").forEach((el) => {
        el.onclick = () => openEventModal({ date: el.dataset.date });
      });
      $$("[data-del]").forEach((b) => {
        b.onclick = (e) => {
          e.stopPropagation();
          state.events = state.events.filter((x) => x.id !== b.dataset.del);
          save();
          render();
        };
      });
    }

    if (view === "notes") bindNotes();

    if (view === "finance") {
      $("#tx-add").onclick = openTxModal;
      $("#acct-edit").onclick = openAcctModal;
      $$("[data-deltx]").forEach((b) => {
        b.onclick = () => {
          state.txs = state.txs.filter((t) => t.id !== b.dataset.deltx);
          save();
          render();
        };
      });
    }

    if (view === "news") {
      $$(".chip[data-cat]").forEach((c) => {
        c.onclick = () => {
          newsFilter = c.dataset.cat;
          render();
        };
      });
      $("#news-refresh").onclick = async () => {
        toast("Refreshing feeds…");
        await loadNews(true);
        render();
      };
      $("#news-feeds").onclick = openFeedsModal;
    }

    if (view === "settings") {
      $$(".toggle[data-mod]").forEach((t) => {
        t.onclick = () => {
          const id = t.dataset.mod;
          const def = MODULES.find((m) => m.id === id);
          if (!def?.canDisable) return;
          state.modules[id] = !state.modules[id];
          save();
          if (view === id && !state.modules[id]) view = "dashboard";
          render();
        };
      });
      $("#save-profile").onclick = () => {
        state.profile.name = $("#set-name").value.trim() || "Eric";
        state.profile.city = $("#set-city").value.trim() || "Las Piñas";
        state.profile.lat = parseFloat($("#set-lat").value) || 14.4508;
        state.profile.lon = parseFloat($("#set-lon").value) || 120.9828;
        save();
        loadWeather();
        toast("Profile saved");
      };
      $("#reset-data").onclick = () => {
        if (!confirm("Reset all local Atrium data?")) return;
        localStorage.removeItem(KEY);
        state = load();
        render();
        bootLive();
        toast("Reset");
      };
    }
  }

  function bindNotes() {
    $$(".add-note").forEach((b) => {
      b.onclick = () => {
        const z = state.notes.reduce((m, n) => Math.max(m, n.z || 1), 1) + 1;
        state.notes.push({
          id: uid(),
          text: "",
          color: b.dataset.color,
          x: 40 + Math.random() * 180,
          y: 40 + Math.random() * 120,
          z,
        });
        save();
        render();
      };
    });
    $$(".sticky [data-kill]").forEach((b) => {
      b.onclick = (e) => {
        e.stopPropagation();
        state.notes = state.notes.filter((n) => n.id !== b.dataset.kill);
        save();
        render();
      };
    });
    $$(".sticky textarea").forEach((ta) => {
      ta.oninput = () => {
        const id = ta.closest(".sticky").dataset.id;
        const n = state.notes.find((x) => x.id === id);
        if (n) {
          n.text = ta.value;
          save();
        }
      };
    });
    $$(".sticky").forEach((el) => {
      el.onpointerdown = (e) => {
        if (e.target.tagName === "TEXTAREA" || e.target.tagName === "BUTTON") return;
        const id = el.dataset.id;
        const n = state.notes.find((x) => x.id === id);
        const z = state.notes.reduce((m, x) => Math.max(m, x.z || 1), 1) + 1;
        n.z = z;
        el.style.zIndex = z;
        const ox = e.clientX - n.x;
        const oy = e.clientY - n.y;
        el.setPointerCapture(e.pointerId);
        const move = (ev) => {
          n.x = Math.max(0, ev.clientX - ox);
          n.y = Math.max(0, ev.clientY - oy);
          el.style.left = n.x + "px";
          el.style.top = n.y + "px";
        };
        const up = () => {
          el.removeEventListener("pointermove", move);
          el.removeEventListener("pointerup", up);
          save();
        };
        el.addEventListener("pointermove", move);
        el.addEventListener("pointerup", up);
      };
    });
  }

  /* ---------- Modals ---------- */
  function modal(html) {
    closeModal();
    const bg = document.createElement("div");
    bg.className = "modal-bg";
    bg.id = "modal-bg";
    bg.innerHTML = `<div class="modal">${html}</div>`;
    bg.addEventListener("click", (e) => {
      if (e.target === bg) closeModal();
    });
    document.body.appendChild(bg);
  }
  function closeModal() {
    $("#modal-bg")?.remove();
  }

  function openEventModal(opts = {}) {
    const date = opts.date || isoDate(new Date());
    modal(`
      <h3>New event</h3>
      <div class="field"><label>Title</label><input id="ev-title" placeholder="Design review"></div>
      <div class="row2">
        <div class="field"><label>Start</label><input id="ev-start" type="datetime-local"></div>
        <div class="field"><label>End</label><input id="ev-end" type="datetime-local"></div>
      </div>
      <div class="row2">
        <div class="field"><label>Category</label>
          <select id="ev-cat">${Object.keys(CAT_COLORS)
            .map((c) => `<option value="${c}">${c}</option>`)
            .join("")}</select>
        </div>
        <div class="field"><label>Location</label><input id="ev-loc" placeholder="Optional"></div>
      </div>
      <div class="modal-actions">
        <button class="btn ghost" id="ev-cancel">Cancel</button>
        <button class="btn" id="ev-save">Save</button>
      </div>`);
    const start = new Date(date + "T09:00:00");
    const end = new Date(date + "T10:00:00");
    const toLocal = (d) => {
      const p = (n) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
    };
    $("#ev-start").value = toLocal(start);
    $("#ev-end").value = toLocal(end);
    $("#ev-cancel").onclick = closeModal;
    $("#ev-save").onclick = () => {
      const title = $("#ev-title").value.trim() || "Event";
      state.events.push({
        id: uid(),
        title,
        start: new Date($("#ev-start").value).toISOString(),
        end: new Date($("#ev-end").value).toISOString(),
        cat: $("#ev-cat").value,
        loc: $("#ev-loc").value.trim(),
      });
      save();
      closeModal();
      render();
    };
  }

  function openTxModal() {
    modal(`
      <h3>Transaction</h3>
      <div class="field"><label>Payee</label><input id="tx-payee" placeholder="Merchant or source"></div>
      <div class="row2">
        <div class="field"><label>Amount (− expense)</label><input id="tx-amt" type="number" step="1" value="-500"></div>
        <div class="field"><label>Date</label><input id="tx-date" type="date" value="${isoDate(new Date())}"></div>
      </div>
      <div class="field"><label>Category</label>
        <select id="tx-cat">
          ${["food", "trans", "bills", "fun", "income", "other"].map((c) => `<option>${c}</option>`).join("")}
        </select>
      </div>
      <div class="modal-actions"><button class="btn ghost" id="tx-cancel">Cancel</button><button class="btn" id="tx-save">Save</button></div>`);
    $("#tx-cancel").onclick = closeModal;
    $("#tx-save").onclick = () => {
      const amount = Number($("#tx-amt").value);
      const cat = $("#tx-cat").value;
      state.txs.unshift({ id: uid(), date: $("#tx-date").value, payee: $("#tx-payee").value.trim() || "Entry", amount, cat });
      if (cat !== "income") {
        /* keep balances as manual accounts — user edits in Accounts */
      } else {
        if (state.accounts[0]) state.accounts[0].balance += amount;
      }
      save();
      closeModal();
      render();
    };
  }

  function openAcctModal() {
    modal(`
      <h3>Accounts</h3>
      ${state.accounts
        .map(
          (a) => `<div class="row2" style="margin-bottom:8px">
            <div class="field"><label>Name</label><input data-aname="${a.id}" value="${esc(a.name)}"></div>
            <div class="field"><label>Balance</label><input data-abal="${a.id}" type="number" value="${a.balance}"></div>
          </div>`
        )
        .join("")}
      <div class="modal-actions"><button class="btn" id="acct-save">Save</button></div>`);
    $("#acct-save").onclick = () => {
      state.accounts.forEach((a) => {
        const n = document.querySelector(`[data-aname="${a.id}"]`);
        const b = document.querySelector(`[data-abal="${a.id}"]`);
        if (n) a.name = n.value;
        if (b) a.balance = Number(b.value);
      });
      save();
      closeModal();
      render();
    };
  }

  function openFeedsModal() {
    modal(`
      <h3>RSS feeds</h3>
      <p style="color:var(--muted);font-size:13px">MSN-style briefing assembled from the feeds you keep on. Add any RSS/Atom URL.</p>
      ${state.feeds
        .map(
          (f) => `<div class="mod-row">
            <div><strong>${esc(f.name)}</strong><div style="color:var(--faint);font-size:11px">${esc(f.category)}</div></div>
            <button class="toggle ${f.enabled ? "on" : ""}" data-feed="${f.id}"><i></i></button>
          </div>`
        )
        .join("")}
      <div class="row2">
        <div class="field"><label>Name</label><input id="nf-name" placeholder="Hacker News"></div>
        <div class="field"><label>Category</label><input id="nf-cat" placeholder="Tech"></div>
      </div>
      <div class="field"><label>RSS URL</label><input id="nf-url" placeholder="https://…"></div>
      <div class="modal-actions"><button class="btn ghost" id="nf-add">Add feed</button><button class="btn" id="nf-done">Done</button></div>`);
    $$("#modal-bg [data-feed]").forEach((t) => {
      t.onclick = () => {
        const f = state.feeds.find((x) => x.id === t.dataset.feed);
        f.enabled = !f.enabled;
        t.classList.toggle("on", f.enabled);
        save();
      };
    });
    $("#nf-add").onclick = () => {
      const name = $("#nf-name").value.trim();
      const url = $("#nf-url").value.trim();
      if (!name || !url) return;
      state.feeds.push({ id: uid(), name, url, category: $("#nf-cat").value.trim() || "Other", enabled: true });
      save();
      openFeedsModal();
    };
    $("#nf-done").onclick = async () => {
      closeModal();
      await loadNews(true);
      render();
    };
  }

  /* ---------- Command bar ---------- */
  function handleCommand(q) {
    const s = q.trim();
    if (!s) return;
    $("#omni").value = "";
    if (/^(note:|sticky:)/i.test(s)) {
      state.notes.push({
        id: uid(),
        text: s.replace(/^(note:|sticky:)/i, "").trim(),
        color: NOTE_COLORS[Math.floor(Math.random() * NOTE_COLORS.length)],
        x: 48,
        y: 48,
        z: 99,
      });
      save();
      view = "notes";
      render();
      toast("Note added");
      return;
    }
    if (/^(spend|paid|expense)\s/i.test(s)) {
      const num = s.match(/-?\d[\d,]*/);
      const amount = num ? -Math.abs(Number(num[0].replace(/,/g, ""))) : -0;
      state.txs.unshift({ id: uid(), date: isoDate(new Date()), payee: s.replace(/^(spend|paid|expense)\s/i, ""), amount, cat: "other" });
      save();
      view = "finance";
      render();
      toast("Logged expense");
      return;
    }
    const ev = parseWhen(s);
    state.events.push({ id: uid(), ...ev, cat: "personal", loc: "" });
    save();
    view = "calendar";
    render();
    toast("Event: " + ev.title);
  }

  async function bootLive() {
    loadWeather();
    loadPrices();
    await loadNews(false);
    if (view === "dashboard" || view === "news") render();
  }

  function init() {
    $("#omni").addEventListener("keydown", (e) => {
      if (e.key === "Enter") handleCommand(e.target.value);
    });
    $("#theme-btn").onclick = () => {
      state.theme = state.theme === "dark" ? "light" : "dark";
      save();
      render();
    };
    document.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        $("#omni").focus();
      }
    });
    tickClock();
    setInterval(tickClock, 1000);
    render();
    bootLive();
  }

  window.Atrium = { state, render, save };
  document.addEventListener("DOMContentLoaded", init);
})();
