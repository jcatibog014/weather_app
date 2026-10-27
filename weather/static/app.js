// The weather page. It asks our own Flask API for data and draws it:
//   /api/search?q=Manila            -> places for the search box
//   /api/weather?lat=..&lon=..      -> the weather now, the next 24 hours and 7 days
// Much of this file is about the moments in between: loading, nothing
// found, errors and being offline (see docs/PLAN.md for the list of states).
// Text always goes in with textContent, never innerHTML, so a place name
// can't inject HTML into the page.
(function () {
  "use strict";

  const SEARCH_DELAY_MS = 300; // wait for a pause in typing, so we don't search on every key
  const REQUEST_TIMEOUT_MS = 15000; // a bit longer than the server's own wait for Open-Meteo
  const STALE_AFTER_MS = 10 * 60 * 1000; // refresh when the visitor comes back after 10 minutes
  const MAX_RECENT = 5;
  const MAX_FAVOURITES = 8;

  const root = document.documentElement;
  const byId = (id) => document.getElementById(id);

  // ---------- Dark mode (same as Swap Meter) ----------

  const themeButton = byId("theme-toggle");
  const systemDark = window.matchMedia("(prefers-color-scheme: dark)");
  const pageColour = { light: "#eef3f9", dark: "#0c141e" }; // same as --bg in style.css

  function currentTheme() {
    return root.dataset.theme || (systemDark.matches ? "dark" : "light");
  }

  function updateTheme() {
    const next = currentTheme() === "dark" ? "light" : "dark";
    themeButton.setAttribute("aria-label", "Switch to " + next + " mode");
    themeButton.title = "Switch to " + next + " mode";
    // Phones colour their browser bar with this.
    if (root.dataset.theme) {
      document.querySelectorAll('meta[name="theme-color"]').forEach(function (meta) {
        meta.content = pageColour[root.dataset.theme];
      });
    }
  }

  themeButton.hidden = false;
  updateTheme();
  systemDark.addEventListener("change", updateTheme);
  themeButton.addEventListener("click", function () {
    const next = currentTheme() === "dark" ? "light" : "dark";
    root.dataset.theme = next;
    try {
      localStorage.setItem("theme", next);
    } catch (e) {
      // Storage can be blocked (private mode). The theme still changes for this visit.
    }
    updateTheme();
  });

  // ---------- Page parts ----------

  const el = {
    main: byId("main"),
    searchForm: byId("search-form"),
    input: byId("search-input"),
    results: byId("search-results"),
    searchSpinner: byId("search-spinner"),
    searchClear: byId("search-clear"),
    searchMessage: byId("search-message"),
    locate: byId("locate"),
    unitButtons: document.querySelectorAll("[data-units]"),
    saved: byId("saved"),
    savedList: byId("saved-list"),
    clearRecent: byId("clear-recent"),
    offline: byId("offline-banner"),
    notice: byId("notice"),
    noticeText: byId("notice-text"),
    noticeAction: byId("notice-action"),
    noticeClose: byId("notice-close"),
    errorTitle: byId("error-title"),
    errorMessage: byId("error-message"),
    retry: byId("retry"),
    announcer: byId("announcer"),
    placeName: byId("place-name"),
    placeRegion: byId("place-region"),
    localTime: byId("local-time"),
    favourite: byId("favourite"),
    currentIcon: byId("current-icon"),
    currentTemp: byId("current-temp"),
    currentLabel: byId("current-label"),
    currentFeels: byId("current-feels"),
    currentRange: byId("current-range"),
    humidity: byId("humidity"),
    wind: byId("wind"),
    windArrow: document.querySelector(".wind-arrow"),
    rain: byId("rain"),
    uv: byId("uv"),
    sunrise: byId("sunrise"),
    sunset: byId("sunset"),
    updated: byId("updated"),
    refresh: byId("refresh"),
    hourly: byId("hourly"),
    daily: byId("daily"),
    hourTemplate: byId("hour-template"),
    dayTemplate: byId("day-template"),
  };

  // Only one of these is visible at a time.
  const views = {
    welcome: byId("welcome"),
    loading: byId("skeleton"),
    error: byId("error-card"),
    weather: byId("weather"),
  };

  const state = {
    units: "metric",
    place: null, // the place we are showing or loading: {name, region, lat, lon, isMyLocation}
    shown: null, // what is on screen: {place, data, units, loadedAt}
    weatherRequest: null, // AbortController of the forecast request in flight
    searchRequest: null,
    searchTimer: 0,
    results: [], // places in the search list
    resultsQuery: "", // the text those results are for
    activeIndex: -1, // the place picked with the arrow keys
  };

  // ---------- Saving in the browser ----------

  // localStorage can be blocked (private mode) or hold old junk, so every
  // read and write is wrapped. The app still works; it just forgets on reload.
  function load(key, fallback) {
    try {
      const text = localStorage.getItem(key);
      return text === null ? fallback : JSON.parse(text);
    } catch (e) {
      return fallback;
    }
  }

  function save(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      // Not saved, but the page keeps working.
    }
  }

  function isPlace(place) {
    return Boolean(place) && typeof place.name === "string" &&
      Number.isFinite(place.lat) && Number.isFinite(place.lon);
  }

  function loadPlaces(key) {
    const places = load(key, []);
    return Array.isArray(places) ? places.filter(isPlace) : [];
  }

  function toSaved(place) {
    return { name: place.name, region: place.region || "", lat: place.lat, lon: place.lon };
  }

  // Two places are the same if they are less than about 1 km apart.
  function samePlace(a, b) {
    return Boolean(a && b) && Math.abs(a.lat - b.lat) < 0.01 && Math.abs(a.lon - b.lon) < 0.01;
  }

  // ---------- Talking to our API ----------

  class ApiError extends Error {
    constructor(message, kind) {
      super(message);
      this.kind = kind;
    }
  }

  // GET a URL and return its JSON, or throw an ApiError with a message for people.
  // `signal` lets the caller cancel the request (a newer search replaces an older one).
  async function fetchJSON(url, signal) {
    const stopAfter = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(url, {
        signal: AbortSignal.any([signal, stopAfter]),
        headers: { Accept: "application/json" },
      });
    } catch (error) {
      if (signal.aborted) throw error; // cancelled on purpose; the caller ignores it
      if (stopAfter.aborted) {
        throw new ApiError("The weather is taking too long to load. Please try again.", "timeout");
      }
      if (!navigator.onLine) {
        throw new ApiError("You're offline. Check your internet connection and try again.", "offline");
      }
      throw new ApiError("We couldn't reach the server. Please try again.", "network");
    }

    let body;
    try {
      body = await response.json();
    } catch (error) {
      if (signal.aborted) throw error;
      throw new ApiError("The server sent an answer we couldn't read. Please try again.", "bad_data");
    }

    if (!response.ok) {
      // Our API sends {error, kind} for service problems and {errors: {field: message}} for bad input.
      const fieldErrors = Object.values(body.errors || {});
      const message = body.error || fieldErrors[0] || "Something went wrong. Please try again.";
      throw new ApiError(message, body.kind || "http_" + response.status);
    }
    return body;
  }

  // ---------- Words and numbers ----------

  function degrees(value) {
    return Math.round(value) + "°";
  }

  function percent(value) {
    return value == null ? "–" : Math.round(value) + "%";
  }

  function uvLevel(uv) {
    if (uv < 3) return "Low";
    if (uv < 6) return "Moderate";
    if (uv < 8) return "High";
    if (uv < 11) return "Very high";
    return "Extreme";
  }

  function coordinates(lat, lon) {
    return Math.abs(lat).toFixed(2) + "° " + (lat >= 0 ? "N" : "S") + ", " +
      Math.abs(lon).toFixed(2) + "° " + (lon >= 0 ? "E" : "W");
  }

  // Open-Meteo's times are already in the place's own clock, like
  // "2026-10-27T15:00", with no time zone. Reading them as UTC and printing
  // them as UTC shows exactly those numbers, whatever the visitor's own
  // time zone is.
  function placeDate(text) {
    return new Date(text.length === 10 ? text + "T00:00:00Z" : text + ":00Z");
  }

  const formats = {
    hour: new Intl.DateTimeFormat("en", { hour: "numeric", timeZone: "UTC" }), // "3 PM"
    clock: new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit", timeZone: "UTC" }), // "5:49 AM"
    weekday: new Intl.DateTimeFormat("en", { weekday: "short", timeZone: "UTC" }), // "Wed"
  };

  // The real time there right now. timezone is a name like "Asia/Manila".
  function localNow(timezone) {
    try {
      return new Intl.DateTimeFormat("en", {
        weekday: "long", hour: "numeric", minute: "2-digit", timeZone: timezone,
      }).format(new Date());
    } catch (e) {
      return ""; // a time zone name this browser doesn't know
    }
  }

  function timeAgo(time) {
    const minutes = Math.floor((Date.now() - time) / 60000);
    if (minutes < 1) return "just now";
    if (minutes === 1) return "1 minute ago";
    if (minutes < 60) return minutes + " minutes ago";
    const hours = Math.floor(minutes / 60);
    return hours === 1 ? "1 hour ago" : hours + " hours ago";
  }

  function setIcon(svg, name) {
    svg.querySelector("use").setAttribute("href", "#wx-" + name);
  }

  function makeIcon(name, className) {
    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("class", className);
    svg.setAttribute("width", "14");
    svg.setAttribute("height", "14");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    const use = document.createElementNS(svgNS, "use");
    use.setAttribute("href", "#" + name);
    svg.append(use);
    return svg;
  }

  // ---------- States ----------

  function showView(name) {
    Object.entries(views).forEach(function ([key, view]) {
      view.hidden = key !== name;
    });
    if (name !== "weather") {
      document.body.dataset.mood = "default";
      document.title = "Weather · Current weather and 7-day forecast";
    }
  }

  // Screen readers read this text out loud when it changes.
  function announce(text) {
    el.announcer.textContent = text;
  }

  let retryAction = null;

  function showError(title, message, retry) {
    el.errorTitle.textContent = title;
    el.errorMessage.textContent = message;
    retryAction = retry;
    showView("error");
  }

  el.retry.addEventListener("click", function () {
    if (retryAction) retryAction();
  });

  // A small message above the weather that doesn't hide anything (e.g. "Couldn't refresh").
  let noticeAction = null;

  function showNotice(text, actionLabel, action) {
    el.noticeText.textContent = text;
    el.noticeAction.textContent = actionLabel || "";
    el.noticeAction.hidden = !action;
    noticeAction = action || null;
    el.notice.hidden = false;
    announce(text);
  }

  function hideNotice() {
    el.notice.hidden = true;
    noticeAction = null;
  }

  el.noticeAction.addEventListener("click", function () {
    const action = noticeAction;
    hideNotice();
    if (action) action();
  });
  el.noticeClose.addEventListener("click", hideNotice);

  // ---------- Loading the weather ----------

  async function loadWeather(place) {
    if (state.weatherRequest) state.weatherRequest.abort(); // only the newest request counts
    const request = new AbortController();
    state.weatherRequest = request;
    state.place = place;
    hideNotice();
    updateUrl(place);
    renderSavedPlaces();

    // The same place is already on screen (Refresh, °C/°F): keep it, faded,
    // so nothing jumps. A new place: show grey cards shaped like the real ones.
    const refreshing = !views.weather.hidden && samePlace(state.shown && state.shown.place, place);
    if (refreshing) {
      views.weather.classList.add("is-refreshing");
    } else {
      showView("loading");
    }
    el.main.setAttribute("aria-busy", "true");
    el.refresh.disabled = true;
    announce("Loading the weather for " + place.name + "…");

    const params = new URLSearchParams({ lat: place.lat, lon: place.lon, units: state.units });
    try {
      const data = await fetchJSON("/api/weather?" + params, request.signal);
      state.shown = { place: place, data: data, units: state.units, loadedAt: Date.now() };
      renderWeather();
      showView("weather");
      announce(place.name + ": " + degrees(data.current.temperature) + ", " + data.current.condition.label + ".");
      save("weather.lastPlace", place);
      if (!place.isMyLocation) addRecent(place);
    } catch (error) {
      if (request.signal.aborted) return; // a newer request took over and shows its own result
      if (refreshing) {
        // Keep the older weather on screen and say how old it is, instead of hiding it.
        setUnits(state.shown.units, false); // the °C/°F buttons must match what is on screen
        showNotice(
          error.message + " You're seeing the weather from " + timeAgo(state.shown.loadedAt) + ".",
          "Try again",
          function () { loadWeather(place); }
        );
      } else {
        showError("Couldn't load the weather for " + place.name, error.message, function () {
          loadWeather(place);
        });
        announce(error.message);
      }
    } finally {
      if (state.weatherRequest === request) {
        state.weatherRequest = null;
        views.weather.classList.remove("is-refreshing");
        el.main.setAttribute("aria-busy", "false");
        el.refresh.disabled = false;
      }
    }
  }

  function isStale() {
    return !state.shown || Date.now() - state.shown.loadedAt > STALE_AFTER_MS;
  }

  el.refresh.addEventListener("click", function () {
    loadWeather(state.shown.place);
  });

  // ---------- Drawing the weather ----------

  function renderWeather() {
    const place = state.shown.place;
    const data = state.shown.data;
    const now = data.current;
    const today = data.daily[0];

    document.body.dataset.mood = now.condition.mood;
    document.title = place.name + " · Weather";

    el.placeName.textContent = place.name;
    el.placeRegion.textContent = place.region || "";
    el.placeRegion.hidden = !place.region;
    setIcon(el.currentIcon, now.condition.icon);
    el.currentTemp.textContent = degrees(now.temperature);
    el.currentLabel.textContent = now.condition.label;
    el.currentFeels.textContent = "Feels like " + degrees(now.feels_like);
    el.currentRange.textContent = "High " + degrees(today.high) + " · Low " + degrees(today.low);

    el.humidity.textContent = percent(now.humidity);
    el.wind.textContent = Math.round(now.wind_speed) + " " + data.units.wind + " from " + now.wind_compass;
    // The direction says where the wind comes FROM; the arrow points where it goes.
    el.windArrow.style.setProperty("--deg", now.wind_direction + 180 + "deg");
    el.rain.textContent = percent(today.precipitation_chance);
    el.uv.textContent = today.uv_index == null ? "–" : Math.round(today.uv_index) + " · " + uvLevel(today.uv_index);
    el.sunrise.textContent = formats.clock.format(placeDate(today.sunrise));
    el.sunset.textContent = formats.clock.format(placeDate(today.sunset));

    renderFavourite();
    renderHours(data.hourly);
    renderDays(data.daily);
    tick();
  }

  function fromTemplate(template) {
    return template.content.firstElementChild.cloneNode(true);
  }

  function renderHours(hours) {
    el.hourly.replaceChildren(...hours.map(function (hour, index) {
      const item = fromTemplate(el.hourTemplate);
      item.querySelector(".hour-time").textContent = index === 0 ? "Now" : formats.hour.format(placeDate(hour.time));
      setIcon(item.querySelector(".wx-icon"), hour.condition.icon);
      item.querySelector(".hour-label").textContent = hour.condition.label;
      item.querySelector(".hour-temp").textContent = degrees(hour.temperature);
      item.querySelector(".hour-rain").textContent = percent(hour.precipitation_chance);
      return item;
    }));
    el.hourly.scrollLeft = 0;
  }

  function renderDays(days) {
    // One scale for the whole week, so the bars can be compared.
    const lowest = Math.min(...days.map((day) => day.low));
    const highest = Math.max(...days.map((day) => day.high));
    const span = highest - lowest || 1;

    el.daily.replaceChildren(...days.map(function (day, index) {
      const item = fromTemplate(el.dayTemplate);
      item.querySelector(".day-name").textContent = index === 0 ? "Today" : formats.weekday.format(placeDate(day.date));
      setIcon(item.querySelector(".wx-icon"), day.condition.icon);
      item.querySelector(".day-label").textContent = day.condition.label;
      item.querySelector(".day-rain").textContent = percent(day.precipitation_chance);
      item.querySelector(".day-low .value").textContent = degrees(day.low);
      item.querySelector(".day-high .value").textContent = degrees(day.high);
      const fill = item.querySelector(".range-fill");
      fill.style.setProperty("--start", ((day.low - lowest) / span) * 100 + "%");
      fill.style.setProperty("--width", ((day.high - day.low) / span) * 100 + "%");
      return item;
    }));
  }

  // The clock and "Updated 3 minutes ago" keep moving while the page is open.
  function tick() {
    if (!state.shown) return;
    const time = localNow(state.shown.data.timezone);
    el.localTime.textContent = time ? "Local time: " + time : "";
    el.updated.textContent = "Updated " + timeAgo(state.shown.loadedAt);
  }
  setInterval(tick, 30000);

  // ---------- Units ----------

  function setUnits(units, reload) {
    state.units = units;
    save("weather.units", units);
    el.unitButtons.forEach(function (button) {
      button.setAttribute("aria-pressed", String(button.dataset.units === units));
    });
    if (reload && state.place) loadWeather(state.place); // Open-Meteo does the converting
  }

  el.unitButtons.forEach(function (button) {
    button.addEventListener("click", function () {
      if (button.dataset.units !== state.units) setUnits(button.dataset.units, true);
    });
  });

  // ---------- Favourites and recent places ----------

  function isFavourite(place) {
    return loadPlaces("weather.favourites").some((saved) => samePlace(saved, place));
  }

  function renderFavourite() {
    const place = state.shown.place;
    el.favourite.hidden = Boolean(place.isMyLocation); // "Your location" moves with you
    const on = isFavourite(place);
    el.favourite.setAttribute("aria-pressed", String(on));
    el.favourite.title = on ? "Remove from favourites" : "Add to favourites";
  }

  el.favourite.addEventListener("click", function () {
    const place = state.shown.place;
    let favourites = loadPlaces("weather.favourites");
    if (isFavourite(place)) {
      favourites = favourites.filter((saved) => !samePlace(saved, place));
      announce(place.name + " removed from favourites.");
    } else {
      favourites = favourites.concat(toSaved(place)).slice(-MAX_FAVOURITES);
      announce(place.name + " added to favourites.");
    }
    save("weather.favourites", favourites);
    renderFavourite();
    renderSavedPlaces();
  });

  function addRecent(place) {
    const others = loadPlaces("weather.recent").filter((saved) => !samePlace(saved, place));
    save("weather.recent", [toSaved(place)].concat(others).slice(0, MAX_RECENT));
    renderSavedPlaces();
  }

  function placeChip(place, favourite) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "chip";
    if (favourite) button.append(makeIcon("i-star", "ui-icon star"));
    button.append(place.name);
    button.title = place.region ? place.name + ", " + place.region : place.name;
    if (favourite) button.setAttribute("aria-label", place.name + " (favourite)");
    if (samePlace(place, state.place)) button.setAttribute("aria-current", "true");
    button.addEventListener("click", function () {
      loadWeather(place);
    });
    item.append(button);
    return item;
  }

  // Favourites first (with a star), then recent places that aren't favourites.
  function renderSavedPlaces() {
    const favourites = loadPlaces("weather.favourites");
    const recent = loadPlaces("weather.recent").filter(function (place) {
      return !favourites.some((saved) => samePlace(saved, place));
    });
    el.savedList.replaceChildren(
      ...favourites.map((place) => placeChip(place, true)),
      ...recent.map((place) => placeChip(place, false))
    );
    el.saved.hidden = favourites.length + recent.length === 0;
    el.clearRecent.hidden = recent.length === 0;
  }

  el.clearRecent.addEventListener("click", function () {
    save("weather.recent", []);
    renderSavedPlaces();
    announce("Recent places cleared.");
    el.input.focus();
  });

  // ---------- Search ----------

  function setSearchMessage(text, isError) {
    el.searchMessage.textContent = text;
    el.searchMessage.classList.toggle("is-error", Boolean(isError));
  }

  function openResults() {
    el.results.hidden = false;
    el.input.setAttribute("aria-expanded", "true");
  }

  function closeResults() {
    el.results.hidden = true;
    el.input.setAttribute("aria-expanded", "false");
    setActive(-1);
  }

  function setActive(index) {
    state.activeIndex = index;
    Array.from(el.results.children).forEach(function (option, i) {
      option.setAttribute("aria-selected", String(i === index));
    });
    if (index >= 0) {
      el.input.setAttribute("aria-activedescendant", "result-" + index);
      el.results.children[index].scrollIntoView({ block: "nearest" });
    } else {
      el.input.removeAttribute("aria-activedescendant");
    }
  }

  function showResults(results, query) {
    state.results = results;
    state.resultsQuery = query;
    el.results.replaceChildren(...results.map(function (place, index) {
      const option = document.createElement("li");
      option.id = "result-" + index;
      option.className = "result";
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", "false");
      const name = document.createElement("span");
      name.className = "result-name";
      name.textContent = place.name;
      const region = document.createElement("span");
      region.className = "result-region";
      region.textContent = place.region;
      option.append(name, region);
      option.addEventListener("click", function () {
        choose(index);
      });
      return option;
    }));
    setActive(-1);
    if (results.length) {
      setSearchMessage("");
      openResults();
    } else {
      closeResults();
      setSearchMessage("No places called “" + query + "”. Check the spelling, or try a bigger town nearby.");
    }
  }

  async function runSearch(pickFirst) {
    clearTimeout(state.searchTimer);
    state.searchTimer = 0;
    if (state.searchRequest) state.searchRequest.abort();
    state.searchRequest = null;

    const query = el.input.value.trim().replace(/\s+/g, " ");
    if (query.length < 2) {
      el.searchSpinner.hidden = true;
      state.results = [];
      closeResults();
      setSearchMessage(pickFirst && query ? "Type at least 2 letters." : "");
      return;
    }

    const request = new AbortController();
    state.searchRequest = request;
    el.searchSpinner.hidden = false;
    try {
      const data = await fetchJSON("/api/search?" + new URLSearchParams({ q: query }), request.signal);
      showResults(data.results, query);
      if (pickFirst && data.results.length) choose(0);
    } catch (error) {
      if (request.signal.aborted) return; // the visitor kept typing; a newer search is running
      state.results = [];
      closeResults();
      setSearchMessage(error.message, true);
    } finally {
      if (state.searchRequest === request) {
        state.searchRequest = null;
        el.searchSpinner.hidden = true;
      }
    }
  }

  function choose(index) {
    const place = state.results[index];
    el.input.value = "";
    el.searchClear.hidden = true;
    state.results = [];
    closeResults();
    setSearchMessage("");
    el.input.blur(); // on phones this closes the keyboard, so the weather is visible
    loadWeather({ name: place.name, region: place.region, lat: place.lat, lon: place.lon });
  }

  el.input.addEventListener("input", function () {
    el.searchClear.hidden = el.input.value === "";
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(runSearch, SEARCH_DELAY_MS, false);
  });

  el.input.addEventListener("keydown", function (event) {
    const count = state.results.length;
    if (event.key === "ArrowDown" && count) {
      event.preventDefault();
      openResults();
      setActive((state.activeIndex + 1) % count);
    } else if (event.key === "ArrowUp" && count) {
      event.preventDefault();
      openResults();
      setActive(state.activeIndex <= 0 ? count - 1 : state.activeIndex - 1);
    } else if (event.key === "Escape") {
      if (!el.results.hidden) {
        closeResults();
      } else {
        el.input.value = "";
        el.searchClear.hidden = true;
        runSearch(false);
      }
    }
  });

  // Enter: the place picked with the arrows, or else the first match.
  el.searchForm.addEventListener("submit", function (event) {
    event.preventDefault();
    const query = el.input.value.trim().replace(/\s+/g, " ");
    if (state.activeIndex >= 0 && !el.results.hidden) {
      choose(state.activeIndex);
    } else if (state.results.length && state.resultsQuery === query) {
      choose(0);
    } else {
      runSearch(true);
    }
  });

  // Clicking a place would blur the box first and close the list; this stops that.
  el.results.addEventListener("pointerdown", function (event) {
    event.preventDefault();
  });
  el.input.addEventListener("blur", closeResults);
  el.input.addEventListener("focus", function () {
    if (state.results.length) openResults();
  });

  el.searchClear.addEventListener("click", function () {
    el.input.value = "";
    el.searchClear.hidden = true;
    runSearch(false);
    el.input.focus();
  });

  // Press "/" anywhere to jump to the search box.
  document.addEventListener("keydown", function (event) {
    const typing = event.target.closest && event.target.closest("input, textarea, select, [contenteditable]");
    if (event.key === "/" && !typing && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      el.input.focus();
    }
  });

  // ---------- My location ----------

  function locationFailed(error) {
    const message = error.code === error.PERMISSION_DENIED
      ? "Location is blocked. You can still search for a city, or allow location for this site in your browser."
      : "We couldn't find your location. Please search for a city instead.";
    showNotice(message);
  }

  if ("geolocation" in navigator) {
    el.locate.hidden = false;
    el.locate.addEventListener("click", function () {
      el.locate.classList.add("is-busy");
      el.locate.disabled = true;
      hideNotice();
      announce("Finding your location…");

      function done() {
        el.locate.classList.remove("is-busy");
        el.locate.disabled = false;
      }

      navigator.geolocation.getCurrentPosition(
        function (position) {
          done();
          // 4 decimals is about 10 m: close enough for weather, and kinder to privacy in the URL.
          const lat = Number(position.coords.latitude.toFixed(4));
          const lon = Number(position.coords.longitude.toFixed(4));
          loadWeather({ name: "Your location", region: coordinates(lat, lon), lat: lat, lon: lon, isMyLocation: true });
        },
        function (error) {
          done();
          locationFailed(error);
        },
        { timeout: 10000, maximumAge: 10 * 60 * 1000 }
      );
    });
  }

  // ---------- The address bar ----------

  // The URL always names the place on screen, so it can be bookmarked or shared.
  function updateUrl(place) {
    const params = new URLSearchParams({ name: place.name, lat: place.lat, lon: place.lon });
    if (place.region) params.set("region", place.region);
    if (place.isMyLocation) params.set("here", "1");
    history.replaceState(null, "", "?" + params);
  }

  function placeFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const place = {
      name: params.get("name") || "Selected place",
      region: params.get("region") || "",
      lat: parseFloat(params.get("lat")),
      lon: parseFloat(params.get("lon")),
      isMyLocation: params.get("here") === "1",
    };
    return isPlace(place) ? place : null;
  }

  // ---------- Offline and coming back ----------

  function updateOnline() {
    el.offline.hidden = navigator.onLine;
  }

  window.addEventListener("offline", function () {
    updateOnline();
    announce("You're offline.");
  });

  window.addEventListener("online", function () {
    updateOnline();
    announce("You're back online.");
    if (state.place && !state.weatherRequest && (!views.error.hidden || isStale())) loadWeather(state.place);
  });

  // Coming back to a tab after a while: the weather may have changed.
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState !== "visible") return;
    tick();
    if (state.place && !state.weatherRequest && isStale() && navigator.onLine) loadWeather(state.place);
  });

  // ---------- Start ----------

  document.querySelectorAll("#welcome [data-lat]").forEach(function (button) {
    button.addEventListener("click", function () {
      const data = button.dataset;
      loadWeather({ name: data.name, region: data.region, lat: Number(data.lat), lon: Number(data.lon) });
    });
  });

  setUnits(load("weather.units", "metric") === "imperial" ? "imperial" : "metric", false);
  updateOnline();
  renderSavedPlaces();

  // A shared link wins, then the last place seen, else the welcome card.
  const lastPlace = load("weather.lastPlace", null);
  const startPlace = placeFromUrl() || (isPlace(lastPlace) ? lastPlace : null);
  if (startPlace) {
    loadWeather(startPlace);
  } else {
    showView("welcome");
  }
})();
