import json
from pathlib import Path

import pytest

from weather import client as weather_client
from weather import create_app

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture(autouse=True)
def empty_caches():
    """reverse_geocode() and get_forecast() remember answers; start every test with an empty memory."""
    weather_client.reverse_geocode.cache_clear()
    weather_client.FORECAST_CACHE.clear()
    yield
    weather_client.reverse_geocode.cache_clear()
    weather_client.FORECAST_CACHE.clear()


def load_fixture(name):
    """A real Open-Meteo answer, saved so tests never need the internet."""
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


@pytest.fixture
def app():
    return create_app({"TESTING": True})


@pytest.fixture
def client(app):
    return app.test_client()


@pytest.fixture
def forecast_json():
    return load_fixture("forecast.json")


@pytest.fixture
def search_json():
    return load_fixture("search.json")


@pytest.fixture
def place_json():
    """Nominatim's answer for 14.58, 121.03 (Mandaluyong, Metro Manila)."""
    return load_fixture("place.json")
