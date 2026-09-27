(() => {
  const authEl = document.getElementById("auth");
  const appEl = document.getElementById("app");
  const toastEl = document.getElementById("toast");
  const modal = document.getElementById("modal");
  const sheet = document.getElementById("sheet");

  let token = localStorage.getItem("keep_token") || "";
  let parentId = null;
  let crumbs = [];
  let view = "files";
  let register = false;
  let me = null;

  const $ = (id) => document.getElementById(id);

  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.remove("hidden");
    setTimeout(() => toastEl.classList.add("hidden"), 2400);
  }

  async function api(path, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (token) headers.Authorization = "Bearer " + token;
    if (opts.body && !(opts.body instanceof FormData) && typeof opts.body !== "string") {
      headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(opts.body);
    }
    const r = await fetch(path, { ...opts, headers });
    const text = await r.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!r.ok) throw new Error(data.error || r.statusText);
    return data;
  }

  function fmt(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
    if (n < 1073741824) return (n / 1048576).toFixed(1) + " MB";
    return (n / 1073741824).toFixed(2) + " GB";
  }

  function ico(item) {
    if (item.kind === "folder") return "📁";
    const m = item.mime || "";
    if (m.startsWith("image/")) return "🖼";
    if (m.startsWith("video/")) return "🎞";
    if (m.startsWith("audio/")) return "♪";
    if (m.includes("pdf")) return "📄";
    if (m.includes("zip")) return "🗜";
    return "📄";
  }

  function setView(name) {
    view = name;
    document.querySelectorAll(".rail nav button").forEach((b) => b.classList.toggle("on", b.dataset.view === name));
    ["files", "recent", "shares", "trash", "settings"].forEach((v) => {
      $("view-" + v).classList.toggle("hidden", v !== name);
    });
    if (name === "files") loadFiles();
    if (name === "recent") loadRecent();
    if (name === "shares") loadShares();
    if (name === "trash") loadTrash();
    if (name === "settings") loadSettings();
  }

  function renderCrumbs() {
    const el = $("crumbs");
    el.innerHTML = "";
    const home = document.createElement("button");
    home.textContent = "My Potion";
    home.onclick = () => { parentId = null; loadFiles(); };
    el.appendChild(home);
    crumbs.forEach((c, i) => {
      const sep = document.createElement("span");
      sep.textContent = "/";
      sep.className = "mono";
      el.appendChild(sep);
      const b = document.createElement("button");
      b.textContent = c.name;
      b.onclick = () => { parentId = c.id; loadFiles(); };
      if (i === crumbs.length - 1) b.style.color = "var(--text)";
      el.appendChild(b);
    });
  }

  function card(item, mode) {
    const el = document.createElement("div");
    el.className = "card";
    el.innerHTML = `
      <div class="ico">${ico(item)}</div>
      <div class="nm" title="${item.name}">${item.name}</div>
      <div class="meta">${item.kind === "folder" ? "Folder" : fmt(item.size)}${item.version > 1 ? " · v" + item.version : ""}</div>
      <div class="acts"></div>`;
    const acts = el.querySelector(".acts");
    const add = (label, fn) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.onclick = (e) => { e.stopPropagation(); fn(); };
      acts.appendChild(b);
    };
    if (mode === "trash") {
      add("Restore", () => act(`/api/files/${item.id}/restore`, "POST"));
      add("Delete", () => confirm("Permanently delete?") && act(`/api/files/${item.id}`, "DELETE"));
    } else {
      if (item.kind === "file") {
        add("Open", () => window.open(`/api/files/${item.id}/download?access_token=${encodeURIComponent(token)}`, "_blank"));
        add("Get", () => {
          const a = document.createElement("a");
          a.href = `/api/files/${item.id}/download?dl=1&access_token=${encodeURIComponent(token)}`;
          a.download = item.name;
          a.click();
        });
        add("Versions", () => openVersions(item));
      }
      add("Share", () => openShare(item));
      add("Rename", () => renameItem(item));
      add("Trash", () => act(`/api/files/${item.id}/trash`, "POST"));
    }
    el.onclick = () => {
      if (item.kind === "folder" && mode !== "trash") {
        parentId = item.id;
        loadFiles();
      }
    };
    return el;
  }

  async function act(url, method) {
    try {
      await api(url, { method });
      refresh();
    } catch (e) { toast(e.message); }
  }

  async function loadFiles(q) {
    const qs = new URLSearchParams();
    if (parentId) qs.set("parent", parentId);
    if (q) qs.set("q", q);
    const data = await api("/api/files?" + qs.toString());
    crumbs = data.crumbs || [];
    renderCrumbs();
    const grid = $("grid");
    grid.innerHTML = "";
    (data.items || []).forEach((it) => grid.appendChild(card(it)));
    $("empty").classList.toggle("hidden", (data.items || []).length > 0 || Boolean(q));
  }

  async function loadRecent() {
    const data = await api("/api/files?recent=1");
    const grid = $("grid-recent");
    grid.innerHTML = "";
    (data.items || []).forEach((it) => grid.appendChild(card(it)));
  }

  async function loadTrash() {
    const data = await api("/api/files?trash=1");
    const grid = $("grid-trash");
    grid.innerHTML = "";
    (data.items || []).forEach((it) => grid.appendChild(card(it, "trash")));
  }

  async function loadShares() {
    const data = await api("/api/shares");
    const el = $("share-list");
    el.innerHTML = "";
    if (!data.shares.length) {
      el.innerHTML = "<p class='empty'>No shared links yet.</p>";
      return;
    }
    data.shares.forEach((s) => {
      const row = document.createElement("div");
      row.className = "row";
      row.innerHTML = `<div><strong>${s.name}</strong><code>${s.url}</code></div>`;
      const b = document.createElement("button");
      b.className = "btn ghost danger";
      b.textContent = "Revoke";
      b.onclick = async () => { await api("/api/shares/" + s.token, { method: "DELETE" }); loadShares(); };
      const c = document.createElement("button");
      c.className = "btn ghost";
      c.textContent = "Copy";
      c.onclick = async () => { await navigator.clipboard.writeText(s.url); toast("Copied"); };
      const wrap = document.createElement("div");
      wrap.style.display = "flex";
      wrap.style.gap = "0.4rem";
      wrap.append(c, b);
      row.appendChild(wrap);
      el.appendChild(row);
    });
  }

  async function loadSettings() {
    $("dav-url").textContent = location.origin + "/dav/";
    const tokens = await api("/api/tokens");
    const list = $("token-list");
    list.innerHTML = "";
    tokens.tokens.forEach((t) => {
      const row = document.createElement("div");
      row.className = "row";
      row.innerHTML = `<div><strong>${t.label}</strong><div class="hint">Created ${new Date(t.created_at).toLocaleString()}</div></div>`;
      const b = document.createElement("button");
      b.className = "btn ghost danger";
      b.textContent = "Revoke";
      b.onclick = async () => { await api("/api/tokens/" + t.id, { method: "DELETE" }); loadSettings(); };
      row.appendChild(b);
      list.appendChild(row);
    });
    const devices = await api("/api/devices");
    const dl = $("device-list");
    dl.innerHTML = "";
    if (!devices.devices.length) dl.innerHTML = "<p class='hint'>No sync agents have checked in yet.</p>";
    devices.devices.forEach((d) => {
      const row = document.createElement("div");
      row.className = "row";
      row.innerHTML = `<div><strong>${d.name}</strong><div class="hint">${d.platform} · ${new Date(d.last_seen).toLocaleString()}</div></div>`;
      dl.appendChild(row);
    });
  }

  function refresh() {
    if (view === "files") loadFiles($("search").value.trim());
    if (view === "recent") loadRecent();
    if (view === "shares") loadShares();
    if (view === "trash") loadTrash();
    if (view === "settings") loadSettings();
    refreshQuota();
  }

  async function refreshQuota() {
    me = await api("/api/me");
    $("who").textContent = me.user.email;
    const q = me.storage.quota;
    const u = me.storage.used;
    $("quota-label").textContent = q ? `${fmt(u)} / ${fmt(q)}` : fmt(u);
    $("quota-fill").style.width = q ? Math.min(100, (u / q) * 100) + "%" : "4%";
  }

  function closeModal() { modal.classList.add("hidden"); }

  function openShare(item) {
    sheet.innerHTML = `
      <h3>Share ${item.name}</h3>
      <label>Optional password<input id="sh-pw" type="text" placeholder="Leave blank for an open link" /></label>
      <label>Expires in hours<input id="sh-exp" type="number" min="0" placeholder="Never" /></label>
      <div class="actions">
        <button class="btn ghost" type="button" id="sh-x">Cancel</button>
        <button class="btn" type="button" id="sh-go">Create link</button>
      </div>`;
    modal.classList.remove("hidden");
    $("sh-x").onclick = closeModal;
    $("sh-go").onclick = async () => {
      try {
        const s = await api(`/api/files/${item.id}/share`, {
          method: "POST",
          body: {
            password: document.getElementById("sh-pw").value || undefined,
            expiresHours: document.getElementById("sh-exp").value || undefined,
          },
        });
        await navigator.clipboard.writeText(s.url);
        toast("Link copied");
        closeModal();
      } catch (e) { toast(e.message); }
    };
  }

  async function openVersions(item) {
    try {
      const v = await api(`/api/files/${item.id}/versions`);
      const rows = (v.history || []).map((h) => `
        <div class="row">
          <div>Version ${h.version} · ${fmt(h.size)} · ${new Date(h.created_at).toLocaleString()}</div>
          <div style="display:flex;gap:.4rem">
            <a class="btn ghost" href="/api/versions/${h.id}/download?access_token=${encodeURIComponent(token)}" target="_blank">Get</a>
            <button class="btn ghost" data-ver="${h.version}">Restore</button>
          </div>
        </div>`).join("") || "<p class='hint'>No older versions yet. Overwrite the file to start a history.</p>";
      sheet.innerHTML = `<h3>Versions of ${item.name}</h3><p class="hint">Current v${v.current.version} · ${fmt(v.current.size)}</p><div class="list compact">${rows}</div>
        <div class="actions"><button class="btn ghost" id="vx">Close</button></div>`;
      modal.classList.remove("hidden");
      document.getElementById("vx").onclick = closeModal;
      sheet.querySelectorAll("[data-ver]").forEach((b) => {
        b.onclick = async () => {
          await api(`/api/files/${item.id}/revert`, { method: "POST", body: { version: Number(b.dataset.ver) } });
          toast("Restored");
          closeModal();
          refresh();
        };
      });
    } catch (e) { toast(e.message); }
  }

  async function renameItem(item) {
    const name = prompt("New name", item.name);
    if (!name || name === item.name) return;
    try {
      await api(`/api/files/${item.id}/rename`, { method: "POST", body: { name } });
      refresh();
    } catch (e) { toast(e.message); }
  }

  async function uploadFiles(fileList) {
    if (!fileList || !fileList.length) return;
    const fd = new FormData();
    if (parentId) fd.append("parentId", parentId);
    [...fileList].forEach((f) => fd.append("files", f));
    try {
      await api("/api/files/upload", { method: "POST", body: fd });
      toast("Uploaded " + fileList.length);
      loadFiles();
      refreshQuota();
    } catch (e) { toast(e.message); }
  }

  async function boot() {
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
    if (!token) return showAuth();
    try {
      await refreshQuota();
      authEl.classList.add("hidden");
      appEl.classList.remove("hidden");
      setView("files");
    } catch {
      token = "";
      localStorage.removeItem("keep_token");
      showAuth();
    }
  }

  function showAuth() {
    authEl.classList.remove("hidden");
    appEl.classList.add("hidden");
  }

  $("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const body = { email: $("email").value, password: $("password").value, name: $("name").value };
      const data = await api(register ? "/api/auth/register" : "/api/auth/login", { method: "POST", body });
      token = data.token;
      localStorage.setItem("keep_token", token);
      await boot();
    } catch (err) { toast(err.message); }
  });

  $("toggle-auth").onclick = () => {
    register = !register;
    document.querySelector(".name-field").classList.toggle("hidden", !register);
    $("auth-submit").textContent = register ? "Create account" : "Sign in";
    $("toggle-auth").textContent = register ? "Have an account?" : "Need an account?";
  };

  document.querySelectorAll(".rail nav button").forEach((b) => {
    b.onclick = () => setView(b.dataset.view);
  });

  $("btn-new-folder").onclick = async () => {
    const name = prompt("Folder name");
    if (!name) return;
    try {
      await api("/api/files/mkdir", { method: "POST", body: { name, parentId } });
      loadFiles();
    } catch (e) { toast(e.message); }
  };

  $("file-input").onchange = (e) => uploadFiles(e.target.files);
  $("search").addEventListener("input", () => {
    if (view === "files") loadFiles($("search").value.trim());
  });

  const drop = $("drop");
  ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", (e) => uploadFiles(e.dataTransfer.files));

  $("btn-empty").onclick = async () => {
    if (!confirm("Permanently delete everything in trash?")) return;
    await api("/api/trash/empty", { method: "POST" });
    loadTrash();
  };

  $("btn-token").onclick = async () => {
    const label = $("token-label").value || "App token";
    const d = await api("/api/tokens", { method: "POST", body: { label } });
    $("token-once").textContent = "Copy now — shown once: " + d.token;
    await navigator.clipboard.writeText(d.token).catch(() => {});
    loadSettings();
  };

  $("btn-pw").onclick = async () => {
    try {
      await api("/api/me/password", { method: "POST", body: { current: $("pw-now").value, next: $("pw-next").value } });
      toast("Password updated");
    } catch (e) { toast(e.message); }
  };

  $("btn-out").onclick = () => {
    localStorage.removeItem("keep_token");
    token = "";
    showAuth();
  };

  modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });

  boot();
})();
