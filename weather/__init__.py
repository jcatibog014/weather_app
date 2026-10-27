"""A weather app: current weather and forecasts from Open-Meteo.

Flask builds the app inside create_app() (the "app factory" pattern).
Tests call it with their own settings, so each test gets a fresh app.
"""
from flask import Flask, render_template, request


def create_app(test_config=None):
    app = Flask(__name__)
    if test_config:
        app.config.update(test_config)

    from . import views

    app.register_blueprint(views.bp)

    @app.errorhandler(404)
    def not_found(error):
        # app.js reads JSON, so the API answers in JSON even when the page is missing.
        if request.path.startswith("/api/"):
            return {"error": "There is no such API address.", "kind": "not_found"}, 404
        return render_template("error.html", code=404, message="We couldn't find that page."), 404

    return app
