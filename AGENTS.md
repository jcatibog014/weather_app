# AGENTS.md

This file guides AI coding agents (Claude Code, Codex, Cursor, Copilot and others) working in this repository.

## Overview

A weather web app in Python (Flask, no database, no login). It shows the current weather and forecasts from [Open-Meteo](https://open-meteo.com/en/docs), which is free and needs no API key. It is a learning project for HTTP, JSON, API integration and loading/error states. Keep the code readable for a learner: short comments that explain *why*, and no extra libraries unless the owner asks for them. Write the README in simple (A1-level) English.

Python 3.13 is at `%LOCALAPPDATA%\Programs\Python\Python313\python.exe`. Use the virtual environment:

- Install: `.venv\Scripts\python -m pip install -r requirements.txt` (create `.venv` with `python -m venv .venv` first if it's missing).
- Run: `.venv\Scripts\flask --app weather run --debug --port 5001`, then open http://127.0.0.1:5001. (Port 5001, because Swap Meter uses 5000.)
- Test: `.venv\Scripts\python -m pytest`. Tests never use the internet.

## Architecture

The browser calls only our own `/api/...` routes; Flask calls Open-Meteo.

- `weather/__init__.py` holds `create_app(test_config)` and the 404 handler (JSON for `/api/...`, `error.html` for pages).
- `weather/client.py` is the only module that does network I/O (`requests.get` with `TIMEOUT`). `get_json()` turns every failure into `WeatherServiceError(kind)`, where `kind` is `timeout`, `connection`, `upstream` (status ≥ 400) or `bad_data` (not a JSON object). `search_cities(name)` calls the geocoding API; `get_forecast(lat, lon, units)` calls the forecast API with `CURRENT_FIELDS`/`HOURLY_FIELDS`/`DAILY_FIELDS`, and adds `IMPERIAL_PARAMS` for `units="imperial"` (Open-Meteo does the unit conversion).
- `weather/parsing.py` holds pure functions. `parse_cities()` returns `name`, `region` ("admin1, country"), `label`, `country_code`, `lat`, `lon`, and `[]` when Open-Meteo leaves out `results` (no matches). `parse_forecast()` zips Open-Meteo's parallel lists with `rows()` and returns `timezone`, `time`, `units`, `current`, `hourly` (24 hours from the current hour) and `daily` (7 days). A missing field raises `KeyError`/`IndexError`/`TypeError`/`ValueError`.
- `weather/conditions.py` is data: `WMO_CODES` maps a weather code to a label and icon group; `condition(code, is_day)` adds the `-night` icon for clear/partly cloudy and a background `mood` (`clear`, `night`, `cloudy`, `rain`, `snow`, `storm`).
- `weather/validation.py` must not import Flask. `validate_search()` and `validate_weather()` return `(data, errors)`; errors map a field (`q`, `lat`, `lon`, `units`) to a message.
- `weather/views.py` is the `weather` blueprint:
  - `GET /` renders `index.html`.
  - `GET /api/search?q=` returns `{query, results}`. An empty result is still 200.
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
  - localStorage keys (each read/write wrapped in try/catch): `theme`, `weather.units`, `weather.recent` (5), `weather.favourites` (8), `weather.lastPlace`. On start the URL (`?name=&region=&lat=&lon=&here=1`) wins, then `weather.lastPlace`, else the welcome card.
  - It refreshes when the tab comes back after 10 minutes, and when the browser comes back online.
  - DOM text goes in with `textContent`, never `innerHTML`.
- `body[data-mood]` (from the condition's `mood`) picks the page gradient (`--sky-*`).

## Conventions

- Styling: `static/style.css`, colours as CSS variables on `:root`. Dark mode redefines them under `prefers-color-scheme: dark` (unless `data-theme="light"`) and under `[data-theme="dark"]`; change both blocks together. The phone breakpoint is 520px.
- Accessibility: text colours ≥ 4.5:1 and `--control-border` ≥ 3:1 against the card in both themes; text over the page gradient (header, footer) must also reach 4.5:1 on every `--sky-*`. Touch targets ≥ 44px on phones. Every icon-only button has an `aria-label`. `#announcer` (aria-live) says what changed. Things that are `position: absolute` (like `.visually-hidden` labels) inside a scrolling row need a positioned parent, or the page scrolls sideways on phones.
- Keep comments teaching-oriented but brief. Add or update a test with every behaviour change.
- Never call Open-Meteo from a test. Save a new fixture instead.
- README screenshots live in `docs/screenshots/`. Retake them when the UI changes visibly.
- Deploy: `render.yaml` (Render Blueprint, free plan, `gunicorn "weather:create_app()"`). The owner does the Render steps.
- `docs/PLAN.md` is the roadmap: the UI/UX layout, the loading/empty/error/offline states, and the build stages (one PR each).
