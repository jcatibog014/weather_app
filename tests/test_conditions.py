"""Tests for the weather-code table."""
from weather.conditions import MOODS, WMO_CODES, condition


def test_known_code_has_label_and_icon():
    assert condition(61) == {"code": 61, "label": "Light rain", "icon": "rain", "mood": "rain"}


def test_clear_sky_at_night_shows_the_moon():
    night = condition(0, is_day=False)
    assert night["icon"] == "clear-night"
    assert night["mood"] == "night"


def test_rain_looks_the_same_at_night():
    assert condition(63, is_day=False)["icon"] == "rain"


def test_unknown_code_does_not_crash():
    assert condition(1234)["label"] == "Unknown"


def test_every_icon_group_has_a_mood():
    for label, group in WMO_CODES.values():
        assert group in MOODS, label
