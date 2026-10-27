"""Tests for the HTTP calls to Open-Meteo, without using the internet.

monkeypatch swaps requests.get for a fake one, so we can pretend the
server answered, failed or never answered at all.
"""
import pytest
import requests

from weather import client
from weather.client import WeatherServiceError, get_forecast, get_json, search_cities


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

    def get(url, params=None, timeout=None):
        if calls is not None:
            calls.append({"url": url, "params": params, "timeout": timeout})
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


@pytest.mark.parametrize("status", [400, 429, 500, 503])
def test_error_status_is_upstream(monkeypatch, status):
    monkeypatch.setattr(client.requests, "get", fake_get(FakeResponse(status, data={"error": True})))
    with pytest.raises(WeatherServiceError) as caught:
        get_json("https://example.com", {})
    assert caught.value.kind == "upstream"


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
