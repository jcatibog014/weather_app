# Weather App: plan and roadmap

## Context
New learning project to practise **HTTP, JSON, API integration, and loading/error states**. The GitHub repo `jcatibog014/weather_app` exists (`main` has only a 13-byte README). It will match the user's other Workspace projects (Swap Meter / unit_converter): Flask + plain-function modules, pytest, `.venv`, `AGENTS.md` + `CLAUDE.md`, feature branch + PR through `gh`, and later deployment on Render.

Decisions made:
- **API:** Open-Meteo (free, no key). It has a forecast API and a geocoding API.
- **Architecture:** Flask calls Open-Meteo with `requests` and returns clean JSON from its own `/api/...` routes. The browser's JS calls those routes with `fetch()` and handles the loading, error and empty states.
- **v1 features:** city search with suggestions, current weather, 24-hour hourly forecast, 7-day forecast, "Use my location", °C/°F and km/h/mph toggle, and recent and favourite cities.

## 1. Project setup
- `git clone https://github.com/jcatibog014/weather_app C:\Users\USER\Documents\Workspace\weather_app`
- Create a branch, e.g. `feature/initial-app`.
- `.venv` with Python 3.13 (`%LOCALAPPDATA%\Programs\Python\Python313\python.exe -m venv .venv`).
- `requirements.txt`: `Flask>=3.1,<4`, `requests>=2.32`, `gunicorn>=23`, `pytest>=8`.
- Copy `.gitignore` and `.python-version` from `unit_converter`.
- Add `AGENTS.md` (same structure as unit_converter's) and `CLAUDE.md` (`@AGENTS.md`).

## 2. File layout (package `weather`)
```
weather/
  __init__.py      create_app(test_config), 404 handler
  client.py        HTTP only: calls Open-Meteo, raises WeatherServiceError
  parsing.py       pure functions: raw Open-Meteo JSON -> clean dicts
  conditions.py    data: WMO weather_code -> label + icon key (day/night)
  validation.py    no Flask: checks q, lat, lon, units
  views.py         blueprint: page + JSON API routes
  templates/ base.html, index.html, error.html, _icons.html
  static/ style.css, app.js, icons/
tests/
  fixtures/        saved real Open-Meteo responses (forecast.json, search.json, search_empty.json)
  conftest.py, test_parsing.py, test_conditions.py, test_validation.py, test_client.py, test_views.py
docs/UI_UX_PLAN.md, docs/screenshots/
render.yaml, README.md (A1-level English, screenshots, tools table)
```

## 3. Backend
**`client.py`**: the only file that does network I/O.
- `search_cities(name)` → `GET https://geocoding-api.open-meteo.com/v1/search?name=…&count=5&language=en&format=json`
- `get_forecast(lat, lon, units)` → `GET https://api.open-meteo.com/v1/forecast` with:
  - `current=temperature_2m,apparent_temperature,relative_humidity_2m,is_day,precipitation,weather_code,wind_speed_10m,wind_direction_10m`
  - `hourly=temperature_2m,precipitation_probability,weather_code,is_day`
  - `daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset,uv_index_max`
  - `timezone=auto&forecast_days=7`, plus `temperature_unit=fahrenheit&wind_speed_unit=mph` when `units=imperial`. Open-Meteo converts the units, so there is no conversion code to write.
- Always pass `timeout=(3, 10)`. Turn failures into `WeatherServiceError(kind)`, where `kind` is `timeout`, `connection`, `upstream` (non-2xx) or `bad_data` (JSON that can't be parsed). This is the core HTTP lesson.

**`parsing.py`** (pure, tested with fixture files):
- `parse_cities(raw)` → `[{name, admin1, country, country_code, lat, lon}]`; returns `[]` when `results` is missing (Open-Meteo leaves the key out when nothing matches).
- `parse_forecast(raw)` → `{location_time, current{…}, hourly[24 from the current hour], daily[7], units{temp, wind}}`.
- Helpers: `compass(deg)` → "NE", `condition(code, is_day)` from `conditions.py`.

**`validation.py`**: `q` must be 2–80 characters after trimming. `lat` must be in −90..90 and `lon` in −180..180. `units` must be `metric` or `imperial`. Returns `(data, errors)` like Swap Meter.

**`views.py`** routes:
| Route | Success | Errors |
|---|---|---|
| `GET /` | page shell | — |
| `GET /api/search?q=` | `{results: [...]}` (an empty list is still a 200) | 400 `{errors}` |
| `GET /api/weather?lat=&lon=&units=` | parsed forecast | 400 bad input; 504 timeout; 502 upstream/bad_data |

Error bodies are `{error: "friendly message", kind: "..."}` so the JS can show the right message.

## 4. Frontend UI/UX
**Layout (desktop):**
```
[logo]  [ 🔍 Search city…          ][📍][°C|°F][◐]
        recent: (Manila ★) (Tokyo) (London)
┌ Current ───────────────────────────────────────┐
│ Manila, PH · Tue 3:40 PM  · updated 2 min ago ↻│
│ ☀  31°   Sunny       Feels 36° · H 32° L 26°   │
│ Humidity 70% | Wind 12 km/h NE ↗ | Rain 0 mm    │
│ UV 9 | Sunrise 5:52 | Sunset 5:31               │
└────────────────────────────────────────────────┘
Next 24 hours  → horizontal scroll strip (time, icon, temp, rain %)
7 days         → rows: day · icon · rain % · L ▬▬▬▬●▬ H (range bar)
```
- **Phone (≤520px):** one column. The search bar is on top and the controls sit in a row under it. The hourly strip scrolls sideways, and the 7-day rows stay compact.
- **Weather mood:** a soft background gradient that changes with the condition and day/night (clear-day, clear-night, cloudy, rain, snow, storm). Text must keep 4.5:1 contrast on every gradient.
- **Icons:** inline SVG in `_icons.html` for about 9 groups (clear, partly cloudy, cloudy, fog, drizzle, rain, snow, thunder; clear and partly cloudy have day and night versions).
- **Light/dark theme toggle:** same CSS-variable pattern as Swap Meter.

**States** (the main learning goal; each one is designed on purpose):
| State | What the user sees |
|---|---|
| First visit | Friendly empty card: "Search for a city or use your location", with 3 sample city chips |
| Loading | Skeleton blocks shaped like the real cards; `aria-busy="true"`; old data stays dimmed while it refreshes |
| Searching | Small spinner inside the search box |
| No results | "No city called 'Xyz'. Check the spelling." |
| Timeout / server down | Error card with the message and a **Try again** button |
| Offline | Banner "You're offline", using the `navigator.onLine` and `online`/`offline` events |
| Location denied | "Location is blocked. You can still search for a city." |
| Success | Data plus "Updated X min ago" and a refresh ↻ button |

**`app.js` behaviour:**
- Search suggestions use the ARIA combobox pattern (arrow keys, Enter, Esc). They wait 300 ms after typing stops (debounce), and an `AbortController` cancels older requests so a slow answer can't overwrite a newer one.
- One `fetchJSON(url)` helper does the timeout, the `res.ok` check and the JSON parsing, and maps failures to a message.
- **Use my location:** `navigator.geolocation.getCurrentPosition`, with the label "Your location". Open-Meteo has no reverse geocoding, so there is no city name here.
- **Unit toggle:** fetches the forecast again with `units=imperial|metric`.
- **Recent (last 5) and favourites (★):** stored in `localStorage` inside try/catch, shown as chips. The last city opens on the next visit.
- The URL stays in step (`?lat=&lon=&name=`) through `history.replaceState`, so the page can be shared.
- DOM is built with `textContent`, never `innerHTML`.
- `<noscript>` message: the app needs JavaScript.

**Accessibility:** the same rules as Swap Meter (4.5:1 text, 3:1 borders, 44px touch targets, an `aria-label` on every icon button). A single `aria-live` region announces "Loaded weather for Manila" or the error message.

## 5. Build order (one PR per stage)
1. **Backend + tests:** setup, client, parsing, validation, API routes, pytest with fixtures.
2. **Core UI:** search, current card, hourly, 7-day, all loading/error/empty states.
3. **Extras:** location, unit toggle, recent and favourites, theme, weather-mood backgrounds.
4. **Polish and ship:** logo/icons, `docs/UI_UX_PLAN.md`, README with screenshots, `render.yaml` (`gunicorn "weather:create_app()"`). The user does the Render deploy steps.

Optional later: a small in-memory 10-minute cache in `client.py`, and an air-quality card (Open-Meteo air-quality API).

## 6. Verification
- `.venv\Scripts\python -m pytest`. Tests never touch the real network: `monkeypatch` replaces `requests.get` with fakes that return fixture JSON, raise `requests.Timeout` or `ConnectionError`, return a 500, or return bad JSON. Each case is checked for the right 4xx/5xx and error message.
- `.venv\Scripts\flask --app weather run --debug`, then open http://127.0.0.1:5000. Search "Manila", check the cards, toggle °F, star a city and reload.
- Check the states by hand: DevTools → Network → **Offline** and **Slow 3G** (shows the skeletons, then the offline/timeout errors); block location permission; search "zzzzqq" (no results).
- Check the phone width (≤520px) and dark mode, then take screenshots for the README.
