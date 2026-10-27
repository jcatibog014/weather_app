import json
from pathlib import Path

import pytest

from weather import create_app

FIXTURES = Path(__file__).parent / "fixtures"


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
