"""Ambon Alert, a weather app: current weather and forecasts from Open-Meteo.

Flask builds the app inside create_app() (the "app factory" pattern).
Tests call it with their own settings, so each test gets a fresh app.
"""
import mimetypes

from flask import Flask, render_template, request

# Python doesn't know this file type, and browsers want the right one for
# the app manifest (the name and icons used by "Add to Home Screen").
mimetypes.add_type("application/manifest+json", ".webmanifest")


def create_app(test_config=None):
    app = Flask(__name__)
    # The biggest body we accept (POST /api/forecast). A 7-day forecast is about 20 KB.
    app.config["MAX_CONTENT_LENGTH"] = 256 * 1024
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

    @app.errorhandler(413)
    def too_large(error):
        return {"error": "That's too much data to send.", "kind": "too_large"}, 413

    return app
