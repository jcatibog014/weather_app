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
- `weather/parsing.py` holds pure functions. `parse_cities()` returns `[]` when Open-Meteo leaves out `results` (no matches). `parse_forecast()` zips Open-Meteo's parallel lists with `rows()` and returns `timezone`, `time`, `units`, `current`, `hourly` (24 hours from the current hour) and `daily` (7 days). A missing field raises `KeyError`/`IndexError`/`TypeError`/`ValueError`.
- `weather/conditions.py` is data: `WMO_CODES` maps a weather code to a label and icon group; `condition(code, is_day)` adds the `-night` icon for clear/partly cloudy and a background `mood` (`clear`, `night`, `cloudy`, `rain`, `snow`, `storm`).
- `weather/validation.py` must not import Flask. `validate_search()` and `validate_weather()` return `(data, errors)`; errors map a field (`q`, `lat`, `lon`, `units`) to a message.
- `weather/views.py` is the `weather` blueprint:
  - `GET /` renders `index.html`.
  - `GET /api/search?q=` returns `{query, results}`. An empty result is still 200.
  - `GET /api/weather?lat=&lon=&units=` returns the parsed forecast.
  - Bad input → 400 `{errors}`. Open-Meteo problems → `{error, kind}` with 504 (timeout) or 502 (everything else), from `SERVICE_ERRORS`. Parse errors (`PARSE_ERRORS`) count as `bad_data`.
- Tests: `tests/fixtures/` holds real Open-Meteo answers (Manila, saved 2026-10-27 15:30 local time). `test_client.py` fakes `requests.get`; `test_views.py` fakes `client.search_cities`/`client.get_forecast`.

## Conventions

- Keep comments teaching-oriented but brief. Add or update a test with every behaviour change.
- Never call Open-Meteo from a test. Save a new fixture instead.
- `docs/PLAN.md` is the roadmap: the UI/UX layout, the loading/empty/error/offline states, and the build stages (one PR each).
