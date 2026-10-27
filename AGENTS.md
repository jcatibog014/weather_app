# AGENTS.md

This file guides AI coding agents (Claude Code, Codex, Cursor, Copilot and others) working in this repository.

## Overview

**Ambon Alert**, a weather web app in Python (Flask, no database, no login). The repo and the Python package are still called `weather_app` and `weather`. It shows the current weather and forecasts from [Open-Meteo](https://open-meteo.com/en/docs), which is free and needs no API key. Town names for the visitor's location come from OpenStreetMap's [Nominatim](https://nominatim.org/release-docs/latest/api/Reverse/), because Open-Meteo has no reverse geocoding. It is a learning project for HTTP, JSON, API integration and loading/error states. Keep the code readable for a learner: short comments that explain *why*, and no extra libraries unless the owner asks for them. Write the README in simple (A1-level) English.

Python 3.13 is at `%LOCALAPPDATA%\Programs\Python\Python313\python.exe`. Use the virtual environment:

- Install: `.venv\Scripts\python -m pip install -r requirements.txt` (create `.venv` with `python -m venv .venv` first if it's missing).
- Run: `.venv\Scripts\flask --app weather run --debug --port 5001`, then open http://127.0.0.1:5001. (Port 5001, because Swap Meter uses 5000.)
- Test: `.venv\Scripts\python -m pytest`. Tests never use the internet.

## Architecture

The browser calls only our own `/api/...` routes; Flask calls Open-Meteo.

- `weather/__init__.py` holds `create_app(test_config)` and the 404 handler (JSON for `/api/...`, `error.html` for pages).
- `weather/client.py` is the only module that does network I/O (`requests.get` with `TIMEOUT`). `get_json()` turns every failure into `WeatherServiceError(kind)`, where `kind` is `timeout`, `connection`, `upstream` (status ≥ 400) or `bad_data` (not a JSON object). `search_cities(name)` calls the geocoding API. `reverse_geocode(lat, lon)` calls Nominatim with the `USER_AGENT` header (Nominatim's usage policy requires one) and is wrapped in `lru_cache`; callers round to 2 decimals, and `tests/conftest.py` clears the cache for each test. `get_forecast(lat, lon, units)` calls the forecast API with `CURRENT_FIELDS`/`HOURLY_FIELDS`/`DAILY_FIELDS`, and adds `IMPERIAL_PARAMS` for `units="imperial"` (Open-Meteo does the unit conversion).
- `weather/parsing.py` holds pure functions. `parse_cities()` returns `name`, `region` ("admin1, country"), `label`, `country_code`, `lat`, `lon`, and `[]` when Open-Meteo leaves out `results` (no matches). `parse_forecast()` zips Open-Meteo's parallel lists with `rows()` and returns `timezone`, `time`, `units`, `current`, `hourly` (24 hours from the current hour) and `daily` (7 days). A missing field raises `KeyError`/`IndexError`/`TypeError`/`ValueError`. `parse_place()` picks the town from `PLACE_NAME_FIELDS` and the area from `PLACE_REGION_FIELDS` (Metro Manila uses `region`, not `state`); it returns `None` for Nominatim's `{"error": ...}` (e.g. the sea).
- `weather/conditions.py` is data: `WMO_CODES` maps a weather code to a label and icon group; `condition(code, is_day)` adds the `-night` icon for clear/partly cloudy and a background `mood` (`clear`, `night`, `cloudy`, `rain`, `snow`, `storm`).
- `weather/validation.py` must not import Flask. `validate_search()`, `validate_coordinates()` and `validate_weather()` return `(data, errors)`; errors map a field (`q`, `lat`, `lon`, `units`) to a message.
- `weather/views.py` is the `weather` blueprint:
  - `GET /` renders `index.html`.
  - `GET /api/search?q=` returns `{query, results}`. An empty result is still 200.
  - `GET /api/place?lat=&lon=` returns `{name, region}`, or 404 `{error, kind: "not_found"}` when there is no town there.
  - `GET /api/weather?lat=&lon=&units=` returns the parsed forecast.
  - Bad input → 400 `{errors}`. Open-Meteo problems → `{error, kind}` with 504 (timeout) or 502 (everything else), from `SERVICE_ERRORS`. Parse errors (`PARSE_ERRORS`) count as `bad_data`.
- Tests: `tests/fixtures/` holds real Open-Meteo answers (Manila, saved 2026-10-27 15:30 local time). `test_client.py` fakes `requests.get`; `test_views.py` fakes `client.search_cities`/`client.get_forecast`.

### Front end

- `templates/index.html` holds every state as markup. `app.js` shows one view at a time with `showView()`: `welcome`, `loading` (`#skeleton`), `error` (`#error-card`) or `weather`. Hours and days are cloned from `<template id="hour-template">` / `"day-template"`.
- `templates/_icons.html` is an SVG sprite. `wx-*` symbols are the weather drawings, one per icon name from `conditions.py` (`test_every_weather_icon_has_a_drawing` checks this); `i-*` are interface icons. A new icon group needs a symbol there. The `icon(name)` macro draws one. `static/icons/logo.svg` (favicon) copies the partly-cloudy drawing.
- `static/app.js`:
  - `fetchJSON(url, signal)` is the one place that calls `fetch`. It adds a 15 s timeout (`AbortSignal.timeout`) and turns every failure into an `ApiError` with a message for people.
  - `loadWeather(place)` aborts the previous request, so only the newest one counts. For the same place (Refresh, °C/°F) it keeps the old weather faded (`.is-refreshing`) and, on failure, shows a `#notice` instead of the error card.
  - Search is an ARIA combobox: a 300 ms debounce, aborts older searches, and supports arrow keys, Enter (the first match) and Esc.
  - localStorage keys (each read/write wrapped in try/catch): `theme`, `weather.units`, `weather.recent` (5), `weather.favourites` (8), `weather.lastPlace`.
  - Start: the URL (`?name=&region=&lat=&lon=&here=1`) wins. Otherwise `startWithMyLocation()` runs: it skips asking if the permission is already `denied`, else calls `locateMe(true)`. On failure `fallBack()` loads `weather.lastPlace`, or else shows the welcome card's message (`setWelcome()`). There are no example cities.
  - `locateMe(auto)` gets the position, then `nameOf()` asks `/api/place` (6 s timeout). If the name lookup fails, the place is `{name: "Your location", unnamed: true}`, with no star and not in recent. Never show raw coordinates. Places from geolocation have `isMyLocation` (the "Your location" badge). `loadWeather()` calls `stopLocating()`, so a city picked while the location is still loading wins.
  - It refreshes when the tab comes back after 10 minutes, and when the browser comes back online.
  - Date and time: `localNow(timezone, fallbackTime)` gives the place's current date and clock, using the IANA `timezone` from the forecast (or Open-Meteo's `time` if the browser doesn't know the zone). `tick()` runs at the start of every minute (`tickEveryMinute()`). Forecast times are already in the place's clock, so they are formatted with `placeDate()` + `timeZone: "UTC"`. The 7-day rows show the weekday and date; the hourly strip labels midnight "Wed 12 AM" (`.new-day`).
  - DOM text goes in with `textContent`, never `innerHTML`.
- `body[data-mood]` (from the condition's `mood`) picks the page gradient (`--sky-*`).

## Conventions

- Brand: the name is "Ambon Alert" in `base.html` (header: `Ambon <em>Alert</em>`, one line, also on phones), the `<title>`s, `APP_NAME` in `app.js` and `static/site.webmanifest` (`name` and `short_name`); keep them in sync. `Alert` uses `--highlight` (sun orange, darkened for 4.5:1). The logo is `static/icons/logo.svg`, a vector redraw of the owner's original `docs/brand/ambon-alert-logo.png`; the header, welcome card and favicon use it as an `<img>`. `icon-32.png`, `apple-touch-icon.png` (180) and `icon-192/512.png` (white tile, 14% padding for maskable) are rendered from it. Re-render them when the logo changes. `test_app_manifest_and_icons` checks that every linked icon exists.
- Font: Fredoka from Google Fonts (`wght@400..700`, linked in `base.html`), set on `body`. Everything inherits it (`button { font: inherit }`). 700 is its boldest weight, so don't use 800.
- Styling: `static/style.css`, colours as CSS variables on `:root`. Dark mode redefines them under `prefers-color-scheme: dark` (unless `data-theme="light"`) and under `[data-theme="dark"]`; change both blocks together. The phone breakpoint is 520px.
- Coloured borders come from the logo. Each `.card` has a 2px border that fades `--edge-sun` → `--edge-sky` → `--edge-deep`; it is drawn as a second background (`border-box`) under a transparent border, because `border-image` ignores rounded corners. So set a card's colour through `--card`, not by overriding `background`. The boxes inside cards (`.detail`, `.hour`, the `.daily` table and its row lines), the search dropdown and the notice use `--tile-border`.
- Accessibility: text colours ≥ 4.5:1 and `--control-border` ≥ 3:1 against the card in both themes; text over the page gradient (header, footer) must also reach 4.5:1 on every `--sky-*`. Touch targets ≥ 44px on phones. Every icon-only button has an `aria-label`. `#announcer` (aria-live) says what changed. Things that are `position: absolute` (like `.visually-hidden` labels) inside a scrolling row need a positioned parent, or the page scrolls sideways on phones.
- Keep comments teaching-oriented but brief. Add or update a test with every behaviour change.
- Never call Open-Meteo from a test. Save a new fixture instead.
- README screenshots live in `docs/screenshots/`. Retake them when the UI changes visibly.
- Deploy: `render.yaml` (Render Blueprint, free plan, `gunicorn "weather:create_app()"`). The owner does the Render steps.
- `docs/PLAN.md` is the roadmap: the UI/UX layout, the loading/empty/error/offline states, and the build stages (one PR each).
