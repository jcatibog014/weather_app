"""Talking to Open-Meteo over HTTP.

This is the only file that uses the network. Everything that can go wrong
on the way (no answer, a slow answer, an error page, broken JSON) becomes
one WeatherServiceError with a "kind", so views.py can choose a friendly
message and the right status code.

Open-Meteo is free and needs no API key: https://open-meteo.com/en/docs
Open-Meteo can't turn coordinates back into a place name, so for "my
location" we ask OpenStreetMap's Nominatim instead (also free, no key):
https://nominatim.org/release-docs/latest/api/Reverse/
"""
from functools import lru_cache

import requests

GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search"
FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
REVERSE_GEOCODING_URL = "https://nominatim.openstreetmap.org/reverse"

# Nominatim's rules: say who you are in the User-Agent, and don't ask twice for
# the same thing (see the cache on reverse_geocode below).
USER_AGENT = "weather_app learning project (https://github.com/jcatibog014/weather_app)"

# (seconds to connect, seconds to wait for the answer). Without a timeout,
# requests can wait forever and the page would spin forever too.
TIMEOUT = (3, 10)

CURRENT_FIELDS = [
    "temperature_2m",
    "apparent_temperature",
    "relative_humidity_2m",
    "is_day",
    "precipitation",
    "weather_code",
    "wind_speed_10m",
    "wind_direction_10m",
]
HOURLY_FIELDS = ["temperature_2m", "precipitation_probability", "weather_code", "is_day"]
DAILY_FIELDS = [
    "weather_code",
    "temperature_2m_max",
    "temperature_2m_min",
    "precipitation_probability_max",
    "sunrise",
    "sunset",
    "uv_index_max",
]

# Open-Meteo converts the units for us; metric is its default.
IMPERIAL_PARAMS = {
    "temperature_unit": "fahrenheit",
    "wind_speed_unit": "mph",
    "precipitation_unit": "inch",
}


class WeatherServiceError(Exception):
    """Open-Meteo didn't give us usable data.

    kind is one of: "timeout", "connection", "upstream" (an error status
    like 500) or "bad_data" (the answer isn't the JSON we expected).
    """

    def __init__(self, kind):
        super().__init__(kind)
        self.kind = kind


def get_json(url, params, headers=None):
    """GET a URL and return its JSON object, or raise WeatherServiceError."""
    try:
        response = requests.get(url, params=params, headers=headers, timeout=TIMEOUT)
    except requests.Timeout as error:  # check this first: a Timeout is also a RequestException
        raise WeatherServiceError("timeout") from error
    except requests.RequestException as error:  # no internet, DNS failure, refused connection…
        raise WeatherServiceError("connection") from error

    if not response.ok:  # any status from 400 up
        raise WeatherServiceError("upstream")

    try:
        data = response.json()
    except ValueError as error:  # the body isn't JSON (e.g. an HTML error page)
        raise WeatherServiceError("bad_data") from error
    if not isinstance(data, dict):
        raise WeatherServiceError("bad_data")
    return data


def search_cities(name):
    """Find up to 5 places called `name` (Open-Meteo's geocoding API)."""
    params = {"name": name, "count": 5, "language": "en", "format": "json"}
    return get_json(GEOCODING_URL, params)


# Remembers the last 256 answers. Callers round lat/lon to 2 decimals (about
# 1 km), so people nearby share one answer. Errors are not remembered.
@lru_cache(maxsize=256)
def reverse_geocode(lat, lon):
    """The town or city at a point (OpenStreetMap's Nominatim)."""
    params = {
        "lat": lat,
        "lon": lon,
        "format": "jsonv2",
        "zoom": 10,  # city level: "Mandaluyong", not a street address
        "addressdetails": 1,
        "accept-language": "en",
    }
    return get_json(REVERSE_GEOCODING_URL, params, headers={"User-Agent": USER_AGENT})


def get_forecast(lat, lon, units="metric"):
    """Current weather, 7 days of hourly data and a 7-day summary for one place."""
    params = {
        "latitude": lat,
        "longitude": lon,
        "current": ",".join(CURRENT_FIELDS),
        "hourly": ",".join(HOURLY_FIELDS),
        "daily": ",".join(DAILY_FIELDS),
        "timezone": "auto",  # times come back in the place's own local time
        "forecast_days": 7,
    }
    if units == "imperial":
        params.update(IMPERIAL_PARAMS)
    return get_json(FORECAST_URL, params)
