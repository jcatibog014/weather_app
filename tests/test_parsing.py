"""Tests for turning Open-Meteo's JSON into our own JSON.

forecast.json is a real answer for Manila, saved at 15:30 local time on
2026-10-27. search.json is a real search for "Manila".
"""
import pytest

from weather.parsing import compass, parse_cities, parse_forecast, rows


@pytest.mark.parametrize(
    "degrees, point",
    [(0, "N"), (22, "N"), (23, "NE"), (90, "E"), (180, "S"), (270, "W"), (337, "NW"), (338, "N"), (360, "N")],
)
def test_compass(degrees, point):
    assert compass(degrees) == point


def test_rows_zips_parallel_lists():
    assert rows({"a": [1, 2], "b": ["x", "y"]}) == [{"a": 1, "b": "x"}, {"a": 2, "b": "y"}]


def test_parse_cities(search_json):
    cities = parse_cities(search_json)
    assert len(cities) == 5
    assert cities[0] == {
        "name": "Manila",
        "label": "Manila, National Capital Region, Philippines",
        "country_code": "PH",
        "lat": 14.6042,
        "lon": 120.9822,
    }


def test_no_results_gives_an_empty_list():
    # Open-Meteo's real answer when nothing matches has no "results" key.
    assert parse_cities({"generationtime_ms": 0.18}) == []


def test_city_label_skips_missing_parts():
    raw = {"results": [{"name": "Somewhere", "country": "Nowhere", "latitude": 1, "longitude": 2}]}
    assert parse_cities(raw)[0]["label"] == "Somewhere, Nowhere"


def test_current_weather(forecast_json):
    forecast = parse_forecast(forecast_json)
    assert forecast["timezone"] == "Asia/Manila"
    assert forecast["units"] == {"temperature": "°C", "wind": "km/h", "precipitation": "mm"}
    current = forecast["current"]
    assert current["temperature"] == 33.7
    assert current["feels_like"] == 37.2
    assert current["humidity"] == 48
    assert current["wind_compass"] == "NE"  # 59 degrees
    assert current["is_day"] is True
    assert current["condition"]["label"] == "Light drizzle"


def test_imperial_wind_unit_reads_mph(forecast_json):
    forecast_json["current_units"]["wind_speed_10m"] = "mp/h"  # what Open-Meteo really sends
    assert parse_forecast(forecast_json)["units"]["wind"] == "mph"


def test_hourly_starts_at_the_current_hour(forecast_json):
    hourly = parse_forecast(forecast_json)["hourly"]
    assert len(hourly) == 24
    assert hourly[0]["time"] == "2026-10-27T15:00"
    assert hourly[-1]["time"] == "2026-10-28T14:00"
    assert set(hourly[0]) == {"time", "temperature", "precipitation_chance", "condition"}


def test_seven_days(forecast_json):
    daily = parse_forecast(forecast_json)["daily"]
    assert len(daily) == 7
    assert daily[0] == {
        "date": "2026-10-27",
        "high": 34.7,
        "low": 27.2,
        "precipitation_chance": 100,
        "sunrise": "2026-10-27T05:49",
        "sunset": "2026-10-27T17:29",
        "uv_index": 6.8,
        "condition": {"code": 53, "label": "Drizzle", "icon": "drizzle", "mood": "rain"},
    }


def test_missing_section_raises(forecast_json):
    del forecast_json["current"]
    with pytest.raises(KeyError):
        parse_forecast(forecast_json)


def test_current_hour_missing_from_hourly_raises(forecast_json):
    forecast_json["current"]["time"] = "2030-01-01T00:00"
    with pytest.raises(ValueError):
        parse_forecast(forecast_json)
