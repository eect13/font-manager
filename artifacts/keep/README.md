# Potion **1.1.0**

**TL;DR.** A Dropbox / Google Drive you run on a machine you own. Browser app, share links, trash + versions, Windows folder via **WebDAV** (RFC 4918, including locks), a desktop sync agent, and a REST API for Atrium and the rest of the studio.

It used to be called Keep. Same data folder, same env vars (`KEEP_*`).

---

## Potion, or Nextcloud?

| | Potion | Nextcloud |
| --- | --- | --- |
| Files, folders, share links | Yes | Yes |
| Trash + versions | Yes | Yes |
| Official Windows / Mac / Linux / iOS / Android **sync apps** | No — use WebDAV or the agent | **Yes** — this is the reason people pick it |
| Calendar, contacts, Talk, Collabora | No | Yes |
| RAM on a small VPS | tens of MB | often 2–4 GB |
| First-class API for Atrium / Font Manager | Yes (`/api/v1`) | Generic WebDAV + OCS |
| Nextcloud desktop client | Will not sync (needs OCS + chunked upload) | Native |

**Install Nextcloud** if you want a full personal Google Workspace today — calendar, phone backup, office docs, and apps that already exist.

**Run Potion** if you want a small branded drive the studio apps can talk to, plus a Windows folder, without PHP/MySQL.

They can coexist. Nextcloud for the family photos; Potion `Apps/` for Atrium.

---

## WebDAV (what actually mounts a Windows folder)

WebDAV is HTTP with extra verbs so a server behaves like a disk. Spec: RFC 4918.

| Method | Meaning |
| --- | --- |
| `OPTIONS` | Advertise `DAV: 1, 2` and `MS-Author-Via: DAV` (Windows looks for this) |
| `PROPFIND` | List a folder. `Depth: 0` = self, `1` = children. Returns **207 Multi-Status** XML |
| `GET` / `PUT` / `DELETE` | Read / write / remove a file |
| `MKCOL` | mkdir |
| `COPY` / `MOVE` | `Destination` header; `Overwrite: F` → 412 |
| `LOCK` / `UNLOCK` | Class 2. Office on a mapped drive needs this |
| `PROPPATCH` | Set properties (Windows timestamps) |

Live properties Potion returns: `displayname`, `getcontentlength`, `getcontenttype`, `getlastmodified`, `creationdate`, **`getetag`** (clients use this to skip downloads), `resourcetype`, `supportedlock`, `lockdiscovery`, `quota-available-bytes`, `quota-used-bytes`.

Mounts:

```
/dav/
/remote.php/dav/files/{username}/     ← Nextcloud-shaped, so rclone/Cyberduck recipes transfer
/remote.php/webdav/                   ← Nextcloud legacy
```

Generic clients that work: Windows Map Network Drive, macOS Finder ⌘K, rclone, Cyberduck, WinSCP, davfs2, FolderSync.

The **official Nextcloud desktop app is not a generic WebDAV client**. Pointing it at Potion will fail. That is expected.

Windows notes:

- Explorer → This PC → Map network drive → `http://HOST:4747/dav/`
- Check “connect using different credentials”
- HTTP (not HTTPS) often needs the WebClient service + Basic auth over non-SSL
- Default Windows download cap is 50 MB (`FileSizeLimitInBytes`)

---

## Run it

Needs Node 22+. No npm packages.

```bash
cd keep
set KEEP_SECRET=pick-a-long-random-string
set KEEP_ADMIN_EMAIL=eect13@gmail.com
set KEEP_ADMIN_PASSWORD=change-me-now
node server.js
```

First boot seeds `Welcome to Potion.txt`, `Documents`, `Photos`, and `Apps/` (Atrium, Finance Manager, Font Manager).

Docker: `docker compose up --build`. Data is `./data` — that folder *is* the drive.

---

## Desktop agent

Mint a token in Settings, then `agent/keep-sync.bat` (or `npm run sync`). Default folder `%USERPROFILE%\Keep` still works; point `KEEP_FOLDER` wherever you want.

---

## API

```bash
curl -H "Authorization: Bearer keep_…" -F path=Apps/Atrium/note.txt -F file=@note.txt http://127.0.0.1:4747/api/v1/put
```

---

## Other names that were in the running

Potion is the one on the tin. Shortlist if you want to rename again: **Phial**, **Vial**, **Alembic**, **Cellar**, **Cask**, **Well**, **Reliquary**, **Tonic**, **Extract**, **Still**, **Larder**.
