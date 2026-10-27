// The weather page. It asks our own Flask API for data and draws it:
//   /api/search?q=Manila            -> places for the search box
//   /api/place?lat=..&lon=..        -> the town name for "my location"
//   /api/weather?lat=..&lon=..      -> the weather now, the next 24 hours and 7 days
// Much of this file is about the moments in between: loading, nothing
// found, errors and being offline (see docs/PLAN.md for the list of states).
// Text always goes in with textContent, never innerHTML, so a place name
// can't inject HTML into the page.
(function () {
  "use strict";

  const APP_NAME = "Ambon Alert";
  const SEARCH_DELAY_MS = 300; // wait for a pause in typing, so we don't search on every key
  const REQUEST_TIMEOUT_MS = 15000; // a bit longer than the server's own wait for Open-Meteo
  const PLACE_TIMEOUT_MS = 6000; // a town name is nice to have; don't hold the weather back for long
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
    welcomeStatus: byId("welcome-status"),
    welcomeSpinner: byId("welcome-spinner"),
    welcomeLocate: byId("welcome-locate"),
    hereBadge: byId("here-badge"),
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
    localDate: byId("local-date"),
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
    // The place we are showing or loading: {name, region, lat, lon}, plus
    // isMyLocation for the visitor's own location, and unnamed when we
    // couldn't find its town name.
    place: null,
    shown: null, // what is on screen: {place, data, units, loadedAt}
    weatherRequest: null, // AbortController of the forecast request in flight
    locateRequest: null, // AbortController while we look for the visitor's location
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
    constructor(message, kind, body) {
      super(message);
      this.kind = kind;
      this.body = body || {}; // the whole error answer, e.g. Plan B's instructions
    }
  }

  // GET a URL and return its JSON, or throw an ApiError with a message for people.
  // `signal` lets the caller cancel the request (a newer search replaces an older one).
  // With `postBody`, it POSTs that object as JSON instead.
  async function fetchJSON(url, signal, timeoutMs, postBody) {
    const stopAfter = AbortSignal.timeout(timeoutMs || REQUEST_TIMEOUT_MS);
    const options = {
      signal: AbortSignal.any([signal, stopAfter]),
      headers: { Accept: "application/json" },
    };
    if (postBody) {
      options.method = "POST";
      options.headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(postBody);
    }
    let response;
    try {
      response = await fetch(url, options);
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
      // (Open-Meteo itself sends {"error": true, "reason": ...}, so check it's text.)
      const ownMessage = typeof body.error === "string" ? body.error : "";
      const message = ownMessage || fieldErrors[0] || "Something went wrong. Please try again.";
      throw new ApiError(message, body.kind || "http_" + response.status, body);
    }
    return body;
  }

  // Plan A: our server asks Open-Meteo (/api/weather).
  // Plan B: Open-Meteo says our server asked too often ("busy"). Open-Meteo's free
  // limit is per IP address, and our free host shares its address with many apps.
  // So this browser asks Open-Meteo itself (its own address, its own limit) and
  // sends the answer to /api/forecast, which reads it with the same Python code.
  async function getWeather(params, signal) {
    try {
      return await fetchJSON("/api/weather?" + params, signal);
    } catch (error) {
      const planB = error instanceof ApiError && error.kind === "busy" && error.body.plan_b;
      if (!planB) throw error;
      let raw;
      try {
        raw = await fetchJSON(planB.url + "?" + new URLSearchParams(planB.params), signal);
      } catch (planBError) {
        if (signal.aborted) throw planBError;
        throw error; // Plan B failed too: show the first, friendlier message
      }
      return fetchJSON("/api/forecast", signal, null, raw);
    }
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
    shortDate: new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" }), // "Oct 28"
  };

  // The real date and time there right now, e.g. {date: "Tuesday, October 27, 2026", time: "6:09 PM"}.
  // timezone is a name like "Asia/Manila"; Open-Meteo sends it with the forecast.
  function localNow(timezone, fallbackTime) {
    let now = new Date();
    let zone = timezone;
    try {
      new Intl.DateTimeFormat("en", { timeZone: timezone });
    } catch (e) {
      // A time zone name this browser doesn't know: use the time Open-Meteo sent instead.
      now = placeDate(fallbackTime);
      zone = "UTC";
    }
    return {
      date: new Intl.DateTimeFormat("en", {
        weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: zone,
      }).format(now),
      time: new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit", timeZone: zone }).format(now),
    };
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
      document.title = APP_NAME + " · Current weather and 7-day forecast";
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
    stopLocating(); // the visitor picked a place, so a slow location answer mustn't replace it
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
      const data = await getWeather(params, request.signal);
      state.shown = { place: place, data: data, units: state.units, loadedAt: Date.now() };
      renderWeather();
      showView("weather");
      announce(place.name + ": " + degrees(data.current.temperature) + ", " + data.current.condition.label + ".");
      save("weather.lastPlace", place);
      if (!place.unnamed) addRecent(place);
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
    document.title = place.name + " · " + APP_NAME;

    el.hereBadge.hidden = !place.isMyLocation;
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
      const time = placeDate(hour.time);
      let label = formats.hour.format(time);
      if (index === 0) label = "Now";
      else if (hour.time.endsWith("T00:00")) label = formats.weekday.format(time) + " " + label; // a new day starts: "Wed 12 AM"
      item.querySelector(".hour-time").textContent = label;
      item.classList.toggle("new-day", index > 0 && hour.time.endsWith("T00:00"));
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
      const date = placeDate(day.date);
      item.querySelector(".day-weekday").textContent = index === 0 ? "Today" : formats.weekday.format(date);
      item.querySelector(".day-date").textContent = formats.shortDate.format(date);
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

  // The clock, the date and "Updated 3 minutes ago" keep moving while the page is open.
  function tick() {
    if (!state.shown) return;
    const now = localNow(state.shown.data.timezone, state.shown.data.time);
    el.localDate.textContent = now.date;
    el.localTime.textContent = now.time;
    el.updated.textContent = "Updated " + timeAgo(state.shown.loadedAt);
  }

  // Tick right after each new minute starts, so the clock is never a minute behind.
  function tickEveryMinute() {
    setTimeout(function () {
      tick();
      tickEveryMinute();
    }, 60000 - (Date.now() % 60000) + 50);
  }
  tickEveryMinute();

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
    el.favourite.hidden = Boolean(place.unnamed); // a star for "Your location" would mean nothing later
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

  const LOCATION_BLOCKED = "Location is blocked, so we can't show your weather. Search for a city above, or allow location for this site in your browser.";
  const LOCATION_NOT_FOUND = "We couldn't find your location. Search for a city above, or try again.";

  // The welcome card's line: what is happening with the location.
  function setWelcome(text, busy, canRetry) {
    el.welcomeStatus.textContent = text;
    el.welcomeSpinner.hidden = !busy;
    el.welcomeLocate.hidden = busy || !canRetry || !("geolocation" in navigator);
  }

  function resetLocateButton() {
    el.locate.classList.remove("is-busy");
    el.locate.disabled = false;
  }

  // Forget a location search that is still running (the visitor chose another place).
  function stopLocating() {
    if (state.locateRequest) state.locateRequest.abort();
    state.locateRequest = null;
    resetLocateButton();
  }

  // Open-Meteo can't turn coordinates into a name, so our server asks
  // OpenStreetMap. Without a name, the weather still works: "Your location".
  async function nameOf(lat, lon, signal) {
    const place = { name: "Your location", region: "", lat: lat, lon: lon, isMyLocation: true, unnamed: true };
    try {
      const found = await fetchJSON("/api/place?" + new URLSearchParams({ lat: lat, lon: lon }), signal, PLACE_TIMEOUT_MS);
      return Object.assign(place, { name: found.name, region: found.region, unnamed: false });
    } catch (error) {
      return place;
    }
  }

  // auto: true when the app does this by itself on start. Then a failure
  // quietly falls back to the last place seen, or the welcome card.
  function locateMe(auto) {
    stopLocating();
    const request = new AbortController();
    state.locateRequest = request;
    el.locate.classList.add("is-busy");
    el.locate.disabled = true;
    hideNotice();
    if (!views.welcome.hidden) setWelcome("Finding your location… Allow location if your browser asks.", true);
    announce("Finding your location…");

    navigator.geolocation.getCurrentPosition(
      async function (position) {
        if (request.signal.aborted) return; // the visitor picked a city in the meantime
        // 4 decimals is about 10 m: close enough for weather, and kinder to privacy in the URL.
        const lat = Number(position.coords.latitude.toFixed(4));
        const lon = Number(position.coords.longitude.toFixed(4));
        showView("loading");
        const place = await nameOf(lat, lon, request.signal);
        if (request.signal.aborted) return;
        state.locateRequest = null;
        resetLocateButton();
        loadWeather(place);
      },
      function (error) {
        if (request.signal.aborted) return;
        state.locateRequest = null;
        resetLocateButton();
        const blocked = error.code === error.PERMISSION_DENIED;
        const message = blocked ? LOCATION_BLOCKED : LOCATION_NOT_FOUND;
        if (auto) {
          fallBack(message, !blocked);
        } else if (!views.welcome.hidden) {
          setWelcome(message, false, !blocked);
        } else {
          showNotice(message);
        }
      },
      { timeout: 10000, maximumAge: 10 * 60 * 1000 }
    );
  }

  // When the location can't be used on start: the last place seen, or the welcome card.
  function fallBack(message, canRetry) {
    const lastPlace = load("weather.lastPlace", null);
    if (isPlace(lastPlace)) {
      loadWeather(lastPlace);
    } else {
      showView("welcome");
      setWelcome(message, false, canRetry);
      announce(message);
    }
  }

  async function startWithMyLocation() {
    showView("welcome");
    if (!("geolocation" in navigator)) {
      fallBack("Search for a city above to see its weather.", false);
      return;
    }
    // A browser that already said "no" would only say it again; don't ask.
    let permission = "prompt";
    try {
      permission = (await navigator.permissions.query({ name: "geolocation" })).state;
    } catch (e) {
      // Older browsers can't tell us; just ask.
    }
    if (permission === "denied") {
      fallBack(LOCATION_BLOCKED, false);
    } else {
      locateMe(true);
    }
  }

  if ("geolocation" in navigator) {
    el.locate.hidden = false;
    el.locate.addEventListener("click", function () {
      locateMe(false);
    });
    el.welcomeLocate.addEventListener("click", function () {
      locateMe(false);
    });
  }

  // ---------- The address bar ----------

  // The URL always names the place on screen, so it can be bookmarked or shared.
  function updateUrl(place) {
    const params = new URLSearchParams({ lat: place.lat, lon: place.lon });
    if (!place.unnamed) params.set("name", place.name);
    if (place.region) params.set("region", place.region);
    if (place.isMyLocation) params.set("here", "1");
    history.replaceState(null, "", "?" + params);
  }

  function placeFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const here = params.get("here") === "1";
    const name = params.get("name");
    const place = {
      name: name || (here ? "Your location" : "Selected place"),
      region: params.get("region") || "",
      lat: parseFloat(params.get("lat")),
      lon: parseFloat(params.get("lon")),
      isMyLocation: here,
      unnamed: !name,
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

  setUnits(load("weather.units", "metric") === "imperial" ? "imperial" : "metric", false);
  updateOnline();
  renderSavedPlaces();

  // A shared link wins. Otherwise: where the visitor is now, then the last
  // place seen, else the welcome card with a search box.
  const linkedPlace = placeFromUrl();
  if (linkedPlace) {
    loadWeather(linkedPlace);
  } else {
    startWithMyLocation();
  }
})();
