"""Tests for checking the query fields."""
import pytest

from weather.validation import parse_coordinate, validate_coordinates, validate_search, validate_weather


def test_search_trims_and_squashes_spaces():
    assert validate_search({"q": "  New   York "}) == ({"q": "New York"}, {})


@pytest.mark.parametrize("query", ["", " ", "a", "  b  "])
def test_search_needs_two_letters(query):
    data, errors = validate_search({"q": query})
    assert data is None
    assert "at least 2" in errors["q"]


def test_search_refuses_very_long_text():
    data, errors = validate_search({"q": "x" * 81})
    assert "80 characters" in errors["q"]


def test_search_without_q_is_an_error():
    assert validate_search({})[1]


def test_weather_accepts_good_coordinates():
    data, errors = validate_weather({"lat": "14.6042", "lon": "-120.98", "units": "imperial"})
    assert errors == {}
    assert data == {"lat": 14.6042, "lon": -120.98, "units": "imperial"}


def test_weather_units_default_to_metric():
    data, _ = validate_weather({"lat": "0", "lon": "0"})
    assert data["units"] == "metric"


@pytest.mark.parametrize("text", ["", "abc", "nan", "inf", "-inf", "91", "-90.5", "1" * 21])
def test_bad_latitudes_are_refused(text):
    assert parse_coordinate(text, 90) is None


@pytest.mark.parametrize("text, number", [("90", 90), ("-90", -90), (" 12.5 ", 12.5), ("1e1", 10)])
def test_good_latitudes_are_accepted(text, number):
    assert parse_coordinate(text, 90) == number


def test_weather_reports_every_bad_field():
    data, errors = validate_weather({"lat": "100", "lon": "200", "units": "kelvin"})
    assert data is None
    assert set(errors) == {"lat", "lon", "units"}


def test_coordinates_without_units():
    assert validate_coordinates({"lat": "14.58", "lon": "121.03"}) == ({"lat": 14.58, "lon": 121.03}, {})


def test_bad_coordinates():
    data, errors = validate_coordinates({"lat": "x"})
    assert data is None
    assert set(errors) == {"lat", "lon"}
