# weather_app

A weather website. It shows the weather now and the weather for the next days.

The weather data comes from [Open-Meteo](https://open-meteo.com/). Open-Meteo is free. You do not need a key.

> This app is still being built. Right now the API works. The web page comes next.

## How to start it

1. Make a virtual environment:
   `python -m venv .venv`
2. Install the tools:
   `.venv\Scripts\python -m pip install -r requirements.txt`
3. Start the app:
   `.venv\Scripts\flask --app weather run --debug`
4. Open http://127.0.0.1:5000 in your browser.

## How to test it

`.venv\Scripts\python -m pytest`

The tests do not use the internet.

## The API

| Address | What it gives you |
|---|---|
| `/api/search?q=Manila` | Places with this name |
| `/api/weather?lat=14.6&lon=121` | Weather now, the next 24 hours and the next 7 days |
| `/api/weather?lat=14.6&lon=121&units=imperial` | The same, in °F, mph and inches |
