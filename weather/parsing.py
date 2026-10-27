"""Turning Open-Meteo's JSON into the small, tidy JSON that app.js uses.

These are pure functions: a dict goes in, a dict comes out, no network.
tests/test_parsing.py feeds them real answers saved in tests/fixtures/.

Open-Meteo sends hourly and daily data as parallel lists, one list per
field: {"time": [t0, t1], "temperature_2m": [20.1, 19.5]}. We zip them into
one dict per hour or day, which is much easier to draw.

If a field we need is missing, these functions raise KeyError, IndexError,
TypeError or ValueError; views.py turns that into a "bad_data" error.
"""
from .conditions import condition

HOURS_SHOWN = 24
COMPASS_POINTS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]

# Open-Meteo writes some units in an unusual way; show the familiar spelling.
UNIT_NAMES = {"mp/h": "mph"}


def compass(degrees):
    """Wind direction in degrees -> one of 8 compass points (0 = N, 90 = E)."""
    return COMPASS_POINTS[int((degrees % 360) / 45 + 0.5) % 8]


def join_parts(*parts):
    """Join the parts that aren't empty: ("Manila", None, "PH") -> "Manila, PH"."""
    return ", ".join(part for part in parts if part)


def parse_cities(raw):
    """The geocoding answer -> a list of places (empty if nothing matched)."""
    # When nothing matches, Open-Meteo leaves out "results" instead of sending [].
    return [
        {
            "name": city["name"],
            "region": join_parts(city.get("admin1"), city.get("country")),  # "National Capital Region, Philippines"
            "label": join_parts(city["name"], city.get("admin1"), city.get("country")),
            "country_code": city.get("country_code", ""),
            "lat": city["latitude"],
            "lon": city["longitude"],
        }
        for city in raw.get("results", [])
    ]


# Address fields to try, from small to big. Nominatim fills in the ones that
# exist there: a city in one country, a "municipality" or "region" in another.
PLACE_NAME_FIELDS = ["city", "town", "village", "municipality", "hamlet", "suburb", "county", "state_district"]
PLACE_REGION_FIELDS = ["state", "region", "province", "state_district"]


def parse_place(raw):
    """Nominatim's answer -> {"name", "region"}, or None if there is no place there (e.g. the sea)."""
    if "error" in raw:  # Nominatim's way of saying "nothing here": {"error": "Unable to geocode"}
        return None
    address = raw.get("address", {})
    name = next((address[field] for field in PLACE_NAME_FIELDS if address.get(field)), None)
    name = name or raw.get("name")
    if not name:
        return None
    area = next((address[field] for field in PLACE_REGION_FIELDS if address.get(field)), None)
    if area == name:  # e.g. a city that is also its own region
        area = None
    return {"name": name, "region": join_parts(area, address.get("country"))}


def rows(table):
    """Parallel lists -> one dict per row: {"a": [1, 2]} -> [{"a": 1}, {"a": 2}]."""
    keys = list(table)
    return [dict(zip(keys, values)) for values in zip(*table.values())]


def parse_forecast(raw):
    """The forecast answer -> current weather, the next 24 hours and 7 days."""
    now = raw["current"]
    units = raw["current_units"]
    is_day = bool(now["is_day"])

    # "current" is updated every 15 minutes ("15:30"); the hourly list starts at
    # midnight. Start the hourly strip at the hour we are in now ("15:00").
    this_hour = now["time"][:13] + ":00"
    hours = rows(raw["hourly"])
    start = [hour["time"] for hour in hours].index(this_hour)  # ValueError if missing

    return {
        "timezone": raw["timezone"],
        "time": now["time"],
        "units": {
            "temperature": units["temperature_2m"],
            "wind": UNIT_NAMES.get(units["wind_speed_10m"], units["wind_speed_10m"]),
            "precipitation": units["precipitation"],
        },
        "current": {
            "temperature": now["temperature_2m"],
            "feels_like": now["apparent_temperature"],
            "humidity": now["relative_humidity_2m"],
            "precipitation": now["precipitation"],
            "wind_speed": now["wind_speed_10m"],
            "wind_direction": now["wind_direction_10m"],
            "wind_compass": compass(now["wind_direction_10m"]),
            "is_day": is_day,
            "condition": condition(now["weather_code"], is_day),
        },
        "hourly": [
            {
                "time": hour["time"],
                "temperature": hour["temperature_2m"],
                "precipitation_chance": hour["precipitation_probability"],
                "condition": condition(hour["weather_code"], bool(hour["is_day"])),
            }
            for hour in hours[start : start + HOURS_SHOWN]
        ],
        "daily": [
            {
                "date": day["time"],
                "high": day["temperature_2m_max"],
                "low": day["temperature_2m_min"],
                "precipitation_chance": day["precipitation_probability_max"],
                "sunrise": day["sunrise"],
                "sunset": day["sunset"],
                "uv_index": day["uv_index_max"],
                "condition": condition(day["weather_code"]),
            }
            for day in rows(raw["daily"])
        ],
    }
