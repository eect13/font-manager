# Keep **1.0.0**

**TL;DR.** A Dropbox / Google Drive you run on your own machine. Browser app, share links, trash + versions, Windows folder via WebDAV, a desktop sync agent, and a REST API so Atrium (and the rest of the studio apps) can store files later.

Nothing leaves the box you start. No Dropbox account. No Google account.

---

## What you get

| Feature | How Keep does it |
| --- | --- |
| **Cloud syncing** | Web UI on every device. Desktop agent watches a local folder. WebDAV so Windows Explorer is just another client. Phones: add the PWA to the home screen. |
| **File sharing** | One link per file or folder. Optional password and expiry. Recipients do not need an account. |
| **Data recovery** | Trash is soft-delete. Overwrites keep old blobs as versions. Restore a version or a trashed item. |
| **Accessibility** | Browser at `:4747`. Mobile as a standalone PWA. Windows folder via `\\http://host:4747\dav\` / Map network drive. Agent for a real `~\Keep` directory. |

This is the self-host core. Native App Store clients are not in this folder — the API is what those would speak.

---

## Run it (free, local)

Needs **Node 22+** (24 is fine).

```bash
cd keep
set KEEP_SECRET=pick-a-long-random-string
set KEEP_ADMIN_EMAIL=eect13@gmail.com
set KEEP_ADMIN_PASSWORD=change-me-now
node server.js
```

No `npm install`. Keep uses Node’s built-in HTTP + `node:sqlite` only.

Open [http://127.0.0.1:4747](http://127.0.0.1:4747). First boot creates that admin and seeds `Welcome to Keep.txt`, `Documents`, `Photos`, and `Apps/` (Atrium, Finance Manager, Font Manager).

Docker, if you prefer:

```bash
docker compose up --build
```

Data lives in `./data` (or the `keep-data` volume): SQLite + file blobs. Back that folder up. That *is* the drive.

---

## Windows folder (no extra app)

1. Start Keep.
2. File Explorer → This PC → **Map network drive**.
3. Folder: `http://127.0.0.1:4747/dav/`
4. Check **Connect using different credentials**.
5. Email + password from Keep.

Windows may want the WebClient service running (`services.msc` → WebClient → Start). Some builds prefer `\\127.0.0.1@4747\dav` after enabling Basic auth over HTTP via the registry. HTTPS on a reverse proxy avoids that fight.

---

## Desktop sync agent

Creates `%USERPROFILE%\Keep` and keeps it aligned with the server.

1. Sign in on the web UI → **Settings** → **Mint token**.
2. Edit `agent/keep-sync.bat`:

```bat
set KEEP_URL=http://127.0.0.1:4747
set KEEP_TOKEN=keep_…
set KEEP_FOLDER=%USERPROFILE%\Keep
```

3. Run the bat, or `npm run sync`.

Same file changed on both sides: the agent keeps yours as `name (conflict-timestamp).ext` and then takes the server copy. Interval is 15 seconds; `fs.watch` also fires a pass.

---

## Phone / tablet

Open the site in the mobile browser → Add to Home Screen. The UI is a single-column file manager. Upload and download work. Background OS-level camera-roll sync is what a later native client would add; the API is ready.

---

## API for the next apps

Mint a token in Settings. Then:

```bash
curl -H "Authorization: Bearer keep_…" http://127.0.0.1:4747/api/v1/files
curl -H "Authorization: Bearer keep_…" -F path=Apps/Atrium/note.txt -F file=@note.txt http://127.0.0.1:4747/api/v1/put
curl -H "Authorization: Bearer keep_…" http://127.0.0.1:4747/api/v1/tree
curl -H "Authorization: Bearer keep_…" http://127.0.0.1:4747/api/sync/changes?cursor=0
```

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/auth/login` | Session JWT |
| GET | `/api/me` | User + quota |
| GET | `/api/v1/files?parent=` | List a folder |
| POST | `/api/files/upload` | Multipart `files` |
| POST | `/api/v1/put` | Agent/app put by `path` |
| GET | `/api/files/:id/download` | Bytes |
| POST | `/api/files/:id/share` | Link |
| GET | `/api/files/:id/versions` | History |
| POST | `/api/files/:id/revert` | Restore a version |
| POST | `/api/files/:id/trash` | Soft delete |
| POST | `/api/files/:id/restore` | Out of trash |
| GET | `/api/v1/tree` | Full tree for the agent |
| GET | `/api/sync/changes?cursor=` | Event log |

Suggested drop paths when you wire the other tools:

- Atrium notes / ICS → `Apps/Atrium/`
- Finance Manager exports → `Apps/Finance Manager/`
- Font Manager library backup → `Apps/Font Manager/`

---

## Layout

```
keep/
  server.js          HTTP + API + static
  src/               SQLite, crypto, files, WebDAV
  public/            web app + PWA + share page
  agent/             folder watcher
  data/              created at runtime (gitignored)
  docker-compose.yml
```

Stack: Node 22+ `node:sqlite` and `node:http`. No npm packages. No Postgres. No cloud vendor.

Default port **4747**. Quota **50 GB** (`KEEP_QUOTA_GB=0` is unlimited).

---

## What this is not

Not Nextcloud. Not a collaborative office suite. Not end-to-end encrypted (the server can read blobs — it is *your* server). Not a replacement for off-site backup: copy `data/` somewhere else on a schedule.

If you later want block-level sync like Seafile, that becomes a second engine behind the same API. Keep 1.0 is whole-file sync, which is enough for documents, exports, and app data.

---

## Reset the admin password

```bash
set KEEP_ADMIN_EMAIL=eect13@gmail.com
set KEEP_ADMIN_PASSWORD=new-one
node src/reset-admin.js
```
