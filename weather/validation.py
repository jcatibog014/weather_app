"""Checking the query fields before we call Open-Meteo.

Plain functions without Flask: the URL's fields go in, clean data plus
error messages come out (see tests/test_validation.py).

Never trust input. A URL can hold anything, so we check it here instead of
sending nonsense to Open-Meteo and getting a confusing error back.
"""
import math

QUERY_MIN_LENGTH = 2
QUERY_MAX_LENGTH = 80
COORDINATE_MAX_LENGTH = 20
UNITS = ("metric", "imperial")


def validate_search(params):
    """Check the city search box. Returns (data, errors)."""
    query = " ".join(params.get("q", "").split())  # trim and squash extra spaces
    if len(query) < QUERY_MIN_LENGTH:
        return None, {"q": f"Type at least {QUERY_MIN_LENGTH} letters."}
    if len(query) > QUERY_MAX_LENGTH:
        return None, {"q": f"Use {QUERY_MAX_LENGTH} characters or fewer."}
    return {"q": query}, {}


def parse_coordinate(text, limit):
    """Return a number between -limit and limit, or None if `text` isn't one."""
    text = (text or "").strip()
    if not text or len(text) > COORDINATE_MAX_LENGTH:
        return None
    try:
        number = float(text)
    except ValueError:
        return None
    # float() also accepts "nan" and "inf", which aren't places on Earth.
    if not math.isfinite(number) or abs(number) > limit:
        return None
    return number


def validate_weather(params):
    """Check lat, lon and units for a forecast. Returns (data, errors)."""
    errors = {}
    lat = parse_coordinate(params.get("lat"), 90)
    if lat is None:
        errors["lat"] = "Latitude must be a number from -90 to 90."
    lon = parse_coordinate(params.get("lon"), 180)
    if lon is None:
        errors["lon"] = "Longitude must be a number from -180 to 180."
    units = params.get("units") or "metric"
    if units not in UNITS:
        errors["units"] = "Units must be metric or imperial."

    if errors:
        return None, errors
    return {"lat": lat, "lon": lon, "units": units}, {}
