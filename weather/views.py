"""The web page and the JSON API that app.js calls.

The browser never talks to Open-Meteo directly. It asks our own API, and
we ask Open-Meteo. That way we check the input, choose the error messages
and send back only the fields the page needs.

Status codes the API uses:
  200 OK          - here is the data (an empty search result is still OK)
  400 Bad Request - the query fields are wrong; {"errors": {field: message}}
  502 Bad Gateway - Open-Meteo failed or sent data we can't read
  503 Service Unavailable - Open-Meteo said "too many requests" (its 429)
  504 Gateway Timeout - Open-Meteo didn't answer in time
When Open-Meteo answered with an error status, the JSON also has
"upstream_status" (its code), so you can see it in DevTools.
"""
from flask import Blueprint, current_app, render_template, request

from . import client
from .parsing import parse_cities, parse_forecast, parse_place
from .validation import validate_coordinates, validate_search, validate_weather

bp = Blueprint("weather", __name__)

# kind -> (message for people, HTTP status)
SERVICE_ERRORS = {
    "timeout": ("The weather service is taking too long to answer. Please try again.", 504),
    "connection": ("We couldn't reach the weather service. Please try again in a moment.", 502),
    "busy": ("The weather service is too busy right now. Please try again in a few minutes.", 503),
    "upstream": ("The weather service has a problem right now. Please try again in a minute.", 502),
    "bad_data": ("The weather service sent data we couldn't read. Please try again.", 502),
}

# What parsing raises when Open-Meteo's JSON isn't shaped as we expect.
PARSE_ERRORS = (KeyError, IndexError, TypeError, ValueError)


def service_error(kind, error=None):
    """The JSON error answer for a WeatherServiceError kind."""
    upstream_status = getattr(error, "status", None)
    reason = getattr(error, "reason", "")
    # The log (Render -> Logs) shows the real cause, e.g. "busy (429) Daily API request limit exceeded".
    current_app.logger.warning("Open-Meteo request failed: %s (%s) %s", kind, upstream_status, reason)
    message, status = SERVICE_ERRORS[kind]
    body = {"error": message, "kind": kind}
    if upstream_status:
        body["upstream_status"] = upstream_status
    return body, status


@bp.get("/")
def index():
    return render_template("index.html")


@bp.get("/api/search")
def search():
    data, errors = validate_search(request.args)
    if errors:
        return {"errors": errors}, 400
    try:
        results = parse_cities(client.search_cities(data["q"]))
    except client.WeatherServiceError as error:
        return service_error(error.kind, error)
    except PARSE_ERRORS:
        return service_error("bad_data")
    return {"query": data["q"], "results": results}


@bp.get("/api/place")
def place():
    """The name of the town at lat/lon, for "my location"."""
    data, errors = validate_coordinates(request.args)
    if errors:
        return {"errors": errors}, 400
    try:
        # Rounded to about 1 km: enough for a town name, and nearby visitors share the cache.
        found = parse_place(client.reverse_geocode(round(data["lat"], 2), round(data["lon"], 2)))
    except client.WeatherServiceError as error:
        return service_error(error.kind, error)
    except PARSE_ERRORS:
        return service_error("bad_data")
    if found is None:
        return {"error": "There is no town or city here.", "kind": "not_found"}, 404
    return found


@bp.get("/api/weather")
def weather():
    data, errors = validate_weather(request.args)
    if errors:
        return {"errors": errors}, 400
    try:
        forecast = parse_forecast(client.get_forecast(data["lat"], data["lon"], data["units"]))
    except client.WeatherServiceError as error:
        return service_error(error.kind, error)
    except PARSE_ERRORS:
        return service_error("bad_data")
    return forecast
