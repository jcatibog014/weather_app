"""Tests for the page and the JSON API, through Flask's test client.

The client functions are replaced with fakes, so no test uses the internet.
"""
import pytest

from weather import client as weather_client
from weather.client import WeatherServiceError
from weather.conditions import WMO_CODES, condition


def raise_error(kind):
    def fake(*args, **kwargs):
        raise WeatherServiceError(kind)

    return fake


def test_home_page(client):
    response = client.get("/")
    assert response.status_code == 200
    html = response.get_data(as_text=True)
    assert "<title>Weather" in html
    assert 'role="combobox"' in html
    # Every state app.js switches between is on the page.
    for view in ("welcome", "skeleton", "error-card", "weather"):
        assert f'id="{view}"' in html
    assert "open-meteo.com" in html  # Open-Meteo's licence asks for credit


def test_every_weather_icon_has_a_drawing(client):
    html = client.get("/").get_data(as_text=True)
    for code in WMO_CODES:
        for is_day in (True, False):
            icon = condition(code, is_day)["icon"]
            assert f'<symbol id="wx-{icon}"' in html, icon


def test_missing_page_is_html(client):
    response = client.get("/nope")
    assert response.status_code == 404
    assert "We couldn&#39;t find that page." in response.get_data(as_text=True)


def test_missing_api_address_is_json(client):
    response = client.get("/api/nope")
    assert response.status_code == 404
    assert response.get_json()["kind"] == "not_found"


def test_search(client, monkeypatch, search_json):
    asked = []
    monkeypatch.setattr(weather_client, "search_cities", lambda name: asked.append(name) or search_json)
    response = client.get("/api/search?q=%20manila%20")
    assert response.status_code == 200
    assert asked == ["manila"]
    body = response.get_json()
    assert body["query"] == "manila"
    assert body["results"][0]["label"] == "Manila, National Capital Region, Philippines"


def test_search_with_no_matches_is_still_ok(client, monkeypatch):
    monkeypatch.setattr(weather_client, "search_cities", lambda name: {"generationtime_ms": 0.2})
    response = client.get("/api/search?q=zzzzqq")
    assert response.status_code == 200
    assert response.get_json()["results"] == []


def test_search_too_short(client):
    response = client.get("/api/search?q=a")
    assert response.status_code == 400
    assert "q" in response.get_json()["errors"]


def test_weather(client, monkeypatch, forecast_json):
    asked = []
    monkeypatch.setattr(
        weather_client, "get_forecast", lambda lat, lon, units: asked.append((lat, lon, units)) or forecast_json
    )
    response = client.get("/api/weather?lat=14.6&lon=121&units=imperial")
    assert response.status_code == 200
    assert asked == [(14.6, 121.0, "imperial")]
    body = response.get_json()
    assert body["current"]["temperature"] == 33.7
    assert len(body["hourly"]) == 24
    assert len(body["daily"]) == 7


def test_weather_bad_input(client):
    response = client.get("/api/weather?lat=north&lon=121")
    assert response.status_code == 400
    assert set(response.get_json()["errors"]) == {"lat"}


@pytest.mark.parametrize(
    "kind, status", [("timeout", 504), ("connection", 502), ("upstream", 502), ("bad_data", 502)]
)
def test_weather_service_errors(client, monkeypatch, kind, status):
    monkeypatch.setattr(weather_client, "get_forecast", raise_error(kind))
    response = client.get("/api/weather?lat=14.6&lon=121")
    assert response.status_code == status
    body = response.get_json()
    assert body["kind"] == kind
    assert "try again" in body["error"]


def test_search_service_error(client, monkeypatch):
    monkeypatch.setattr(weather_client, "search_cities", raise_error("timeout"))
    response = client.get("/api/search?q=Manila")
    assert response.status_code == 504


def test_weather_with_strange_json_is_bad_data(client, monkeypatch):
    monkeypatch.setattr(weather_client, "get_forecast", lambda *args: {"something": "else"})
    response = client.get("/api/weather?lat=14.6&lon=121")
    assert response.status_code == 502
    assert response.get_json()["kind"] == "bad_data"


def test_search_with_strange_json_is_bad_data(client, monkeypatch):
    monkeypatch.setattr(weather_client, "search_cities", lambda name: {"results": [{"no": "name"}]})
    response = client.get("/api/search?q=Manila")
    assert response.get_json()["kind"] == "bad_data"
