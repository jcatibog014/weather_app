"""Tests for the HTTP calls to Open-Meteo, without using the internet.

monkeypatch swaps requests.get for a fake one, so we can pretend the
server answered, failed or never answered at all.
"""
import pytest
import requests

from weather import client
from weather.client import WeatherServiceError, get_forecast, get_json, reverse_geocode, search_cities


class FakeResponse:
    def __init__(self, status=200, data=None, text=None):
        self.status_code = status
        self.ok = status < 400
        self._data = data
        self._text = text

    def json(self):
        if self._text is not None:  # pretend the body isn't JSON
            raise requests.exceptions.JSONDecodeError("Expecting value", self._text, 0)
        return self._data


def fake_get(response=None, error=None, calls=None):
    """A stand-in for requests.get that records its arguments."""

    def get(url, params=None, headers=None, timeout=None):
        if calls is not None:
            calls.append({"url": url, "params": params, "headers": headers, "timeout": timeout})
        if error:
            raise error
        return response

    return get


def test_returns_the_json(monkeypatch):
    monkeypatch.setattr(client.requests, "get", fake_get(FakeResponse(data={"ok": True})))
    assert get_json("https://example.com", {}) == {"ok": True}


@pytest.mark.parametrize(
    "error, kind",
    [
        (requests.Timeout(), "timeout"),
        (requests.ConnectTimeout(), "timeout"),
        (requests.ConnectionError(), "connection"),
    ],
)
def test_network_problems(monkeypatch, error, kind):
    monkeypatch.setattr(client.requests, "get", fake_get(error=error))
    with pytest.raises(WeatherServiceError) as caught:
        get_json("https://example.com", {})
    assert caught.value.kind == kind


@pytest.mark.parametrize("status", [400, 500, 503])
def test_error_status_is_upstream(monkeypatch, status):
    monkeypatch.setattr(client.requests, "get", fake_get(FakeResponse(status, data={"error": True})))
    with pytest.raises(WeatherServiceError) as caught:
        get_json("https://example.com", {})
    assert caught.value.kind == "upstream"
    assert caught.value.status == status


def test_too_many_requests_is_busy_and_keeps_the_reason(monkeypatch):
    answer = {"error": True, "reason": "Daily API request limit exceeded. Please try again tomorrow."}
    monkeypatch.setattr(client.requests, "get", fake_get(FakeResponse(429, data=answer)))
    with pytest.raises(WeatherServiceError) as caught:
        get_json("https://example.com", {})
    assert caught.value.kind == "busy"
    assert caught.value.status == 429
    assert caught.value.reason.startswith("Daily API request limit")


def test_error_page_that_is_not_json_has_no_reason(monkeypatch):
    monkeypatch.setattr(client.requests, "get", fake_get(FakeResponse(502, text="<html>Bad Gateway</html>")))
    with pytest.raises(WeatherServiceError) as caught:
        get_json("https://example.com", {})
    assert (caught.value.kind, caught.value.reason) == ("upstream", "")


@pytest.mark.parametrize("response", [FakeResponse(text="<html>oops</html>"), FakeResponse(data=[1, 2])])
def test_unreadable_body_is_bad_data(monkeypatch, response):
    monkeypatch.setattr(client.requests, "get", fake_get(response))
    with pytest.raises(WeatherServiceError) as caught:
        get_json("https://example.com", {})
    assert caught.value.kind == "bad_data"


def test_search_sends_the_right_request(monkeypatch):
    calls = []
    monkeypatch.setattr(client.requests, "get", fake_get(FakeResponse(data={}), calls=calls))
    search_cities("Manila")
    assert calls[0]["url"] == client.GEOCODING_URL
    assert calls[0]["params"]["name"] == "Manila"
    assert calls[0]["timeout"] == client.TIMEOUT


def test_metric_forecast_uses_open_meteo_defaults(monkeypatch):
    calls = []
    monkeypatch.setattr(client.requests, "get", fake_get(FakeResponse(data={}), calls=calls))
    get_forecast(14.6, 121.0)
    params = calls[0]["params"]
    assert (params["latitude"], params["longitude"]) == (14.6, 121.0)
    assert params["timezone"] == "auto"
    assert "temperature_unit" not in params


def test_imperial_forecast_asks_for_fahrenheit_and_mph(monkeypatch):
    calls = []
    monkeypatch.setattr(client.requests, "get", fake_get(FakeResponse(data={}), calls=calls))
    get_forecast(14.6, 121.0, "imperial")
    params = calls[0]["params"]
    assert params["temperature_unit"] == "fahrenheit"
    assert params["wind_speed_unit"] == "mph"


def test_reverse_geocode_says_who_we_are(monkeypatch):
    calls = []
    monkeypatch.setattr(client.requests, "get", fake_get(FakeResponse(data={}), calls=calls))
    reverse_geocode(14.58, 121.03)
    assert calls[0]["url"] == client.REVERSE_GEOCODING_URL
    assert (calls[0]["params"]["lat"], calls[0]["params"]["lon"]) == (14.58, 121.03)
    # Nominatim blocks apps that don't name themselves.
    assert "weather_app" in calls[0]["headers"]["User-Agent"]


def test_reverse_geocode_remembers_answers(monkeypatch):
    calls = []
    monkeypatch.setattr(client.requests, "get", fake_get(FakeResponse(data={"name": "X"}), calls=calls))
    reverse_geocode(14.58, 121.03)
    reverse_geocode(14.58, 121.03)
    assert len(calls) == 1


def test_reverse_geocode_does_not_remember_errors(monkeypatch):
    calls = []
    monkeypatch.setattr(client.requests, "get", fake_get(error=requests.Timeout(), calls=calls))
    for _ in range(2):
        with pytest.raises(WeatherServiceError):
            reverse_geocode(14.58, 121.03)
    assert len(calls) == 2
