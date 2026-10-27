"""What the weather codes mean.

Open-Meteo describes the sky with a number from the WMO (World
Meteorological Organization) list, e.g. 0 = clear sky, 61 = slight rain.
This file is data only: each code gets a label for people, an icon group
for the drawing, and a "mood" for the page's background colour.
"""

# code: (label, icon group)
WMO_CODES = {
    0: ("Clear sky", "clear"),
    1: ("Mainly clear", "clear"),
    2: ("Partly cloudy", "partly-cloudy"),
    3: ("Overcast", "cloudy"),
    45: ("Fog", "fog"),
    48: ("Freezing fog", "fog"),
    51: ("Light drizzle", "drizzle"),
    53: ("Drizzle", "drizzle"),
    55: ("Heavy drizzle", "drizzle"),
    56: ("Light freezing drizzle", "drizzle"),
    57: ("Freezing drizzle", "drizzle"),
    61: ("Light rain", "rain"),
    63: ("Rain", "rain"),
    65: ("Heavy rain", "rain"),
    66: ("Light freezing rain", "rain"),
    67: ("Freezing rain", "rain"),
    71: ("Light snow", "snow"),
    73: ("Snow", "snow"),
    75: ("Heavy snow", "snow"),
    77: ("Snow grains", "snow"),
    80: ("Light showers", "rain"),
    81: ("Showers", "rain"),
    82: ("Heavy showers", "rain"),
    85: ("Light snow showers", "snow"),
    86: ("Snow showers", "snow"),
    95: ("Thunderstorm", "thunder"),
    96: ("Thunderstorm with hail", "thunder"),
    99: ("Thunderstorm with heavy hail", "thunder"),
}

UNKNOWN = ("Unknown", "cloudy")

# Only these groups look different at night (a moon instead of a sun).
NIGHT_ICONS = {"clear", "partly-cloudy"}

# icon group -> background mood
MOODS = {
    "clear": "clear",
    "partly-cloudy": "clear",
    "cloudy": "cloudy",
    "fog": "cloudy",
    "drizzle": "rain",
    "rain": "rain",
    "snow": "snow",
    "thunder": "storm",
}


def condition(code, is_day=True):
    """Describe a weather code, e.g. {"label": "Clear sky", "icon": "clear-night", ...}."""
    label, group = WMO_CODES.get(code, UNKNOWN)
    icon = group if is_day or group not in NIGHT_ICONS else f"{group}-night"
    mood = MOODS[group]
    if mood == "clear" and not is_day:
        mood = "night"
    return {"code": code, "label": label, "icon": icon, "mood": mood}
