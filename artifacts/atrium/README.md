# Atrium

Personal command center — a modular dashboard in the spirit of **KatanOS**, with a **Fantastical**-style calendar and **Rainmeter**-like widgets you can turn on and off.

Everything is local-first. Events, stickies, ledgers, and feed lists live in `localStorage`. No account. No server of your own.

## Open it

Open `index.html` in a browser, or from this folder:

```bash
python3 -m http.server 4173
```

Then visit `http://localhost:4173`.

## Modules

| Module | What it does |
| --- | --- |
| **Dashboard** | Greeting, Open-Meteo weather, today’s agenda, quote, finance snapshot, headlines, pinned notes |
| **Calendar** | Month / week / agenda. Natural-language add. **ICS import, export, and public iCal subscribe** (Google secret address, Outlook, Apple, Fantastical) |
| **Sticky notes** | Colored, draggable board (KatanOS todo-board energy) |
| **Finance watcher** | Liquid cash, MTD income/spend, budgets vs actual, CoinGecko crypto + USD/PHP |
| **News** | MSN-style briefing from RSS (Google News PH, BBC, The Verge, Rappler, CNBC). Add any feed |
| **Modules** | Enable / disable optional racks the way KatanOS gates widgets |

Calendar cannot be turned off. Notes, finance, and news can.

## Command bar

Focus with **⌘K / Ctrl+K**.

- `Lunch with Ana Friday 1pm` → event
- `note: call the bank` → sticky
- `spend 500 Grab` → expense

## Stack

Static HTML + CSS + vanilla JS. Weather via [Open-Meteo](https://open-meteo.com/) (CC BY). Headlines via rss2json. Prices via CoinGecko.

Seeded for Las Piñas / Asia/Manila. Change city and coordinates under Modules.

## What this is not

Not a fork of KatanOS (Electron / encrypted vault / habits / journal). Atrium is the dashboard layer you asked for: calendar integrations, stickies, finance watcher, RSS news, modular rail — ready to grow those other rooms later.
