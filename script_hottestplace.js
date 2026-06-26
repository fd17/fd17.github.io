const apiBaseUrl = "https://dataset.api.hub.geosphere.at/v1/station/current/tawes-v1-10min";
const metadataUrl = `${apiBaseUrl}/metadata`;
const stationEl = document.querySelector("#station");
const valueEl = document.querySelector("#value");
const unitEl = document.querySelector("#unit");
const measuredEl = document.querySelector("#measured");
const coordinatesEl = document.querySelector("#coordinates");
const statusEl = document.querySelector("#status");
const refreshButton = document.querySelector("#refresh");
const pageTitleEl = document.querySelector("#page-title");
const modeInputs = [...document.querySelectorAll("input[name='temperature-mode']")];
const currentDataCache = new Map();
const parameterModes = {
  TL: {
    title: "Hottest place right now",
    loadingText: "Loading hottest place...",
  },
  TLMAX: {
    title: "Hottest place today",
    loadingText: "Loading today's hottest place...",
  },
};

const stationMap = L.map("map", {
  zoomControl: true,
}).setView([47.6, 13.4], 6);

let stationMarker;
const hotMarkerIcon = L.divIcon({
  className: "hot-marker",
  iconSize: [28, 28],
  iconAnchor: [14, 28],
  popupAnchor: [0, -26],
});

L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
  attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
  maxZoom: 19,
}).addTo(stationMap);

function formatDateTime(timestamp) {
  if (!timestamp) {
    return "--";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
    hour12: false,
  }).format(new Date(timestamp));
}

function getCachedPayload(url) {
  if (currentDataCache.has(url)) {
    return currentDataCache.get(url);
  }

  try {
    const stored = sessionStorage.getItem(`current-data:${url}`);

    if (stored) {
      const payload = JSON.parse(stored);
      currentDataCache.set(url, payload);
      return payload;
    }
  } catch {
    return null;
  }

  return null;
}

function cachePayload(url, payload) {
  currentDataCache.set(url, payload);

  try {
    sessionStorage.setItem(`current-data:${url}`, JSON.stringify(payload));
  } catch {
    // The in-memory cache is enough if browser storage is unavailable.
  }
}

async function fetchJsonWithCache(url) {
  const cachedPayload = getCachedPayload(url);

  if (cachedPayload) {
    return {
      payload: cachedPayload,
      fromCache: true,
    };
  }

  let response;

  try {
    response = await fetch(url);
  } catch (error) {
    throw new Error(
      "The GeoSphere dataset API request could not be loaded.",
    );
  }

  if (!response.ok) {
    throw new Error(`Could not load GeoSphere data (${response.status}).`);
  }

  const payload = await response.json();
  cachePayload(url, payload);

  return {
    payload,
    fromCache: false,
  };
}

function getActiveStationIds(metadata) {
  const stationIds = (metadata?.stations ?? [])
    .filter((station) => station.is_active)
    .map((station) => station.id)
    .filter(Boolean);

  if (stationIds.length === 0) {
    throw new Error("No active TAWES stations were found.");
  }

  return stationIds;
}

function getStationNames(metadata) {
  return new Map(
    (metadata?.stations ?? [])
      .filter((station) => station.id)
      .map((station) => [station.id, station.name]),
  );
}

function getSelectedParameter() {
  return modeInputs.find((input) => input.checked)?.value ?? "TL";
}

function getSelectedMode() {
  return parameterModes[getSelectedParameter()] ?? parameterModes.TL;
}

function buildCurrentDataUrl(stationIds) {
  const apiUrl = new URL(apiBaseUrl);

  apiUrl.search = new URLSearchParams({
    parameters: "TL,TLMAX",
    station_ids: stationIds.join(","),
    output_format: "geojson",
  });

  return apiUrl.toString();
}

async function fetchCurrentDataPayload() {
  const { payload: metadata } = await fetchJsonWithCache(metadataUrl);
  const stationIds = getActiveStationIds(metadata);
  const stationNames = getStationNames(metadata);
  const currentDataUrl = buildCurrentDataUrl(stationIds);
  const { payload, fromCache } = await fetchJsonWithCache(currentDataUrl);

  return {
    payload,
    stationNames,
    fromCache,
  };
}

function getLatestTimestampIndex(timestamps) {
  return Math.max((timestamps?.length ?? 1) - 1, 0);
}

function getTemperatureReading(feature, timestamps, parameter) {
  const values = feature?.properties?.parameters?.[parameter]?.data;
  const latestIndex = getLatestTimestampIndex(timestamps);

  if (Array.isArray(values)) {
    const value = values[latestIndex];

    if (Number.isFinite(value)) {
      return {
        value,
        timestamp: timestamps?.[latestIndex],
      };
    }

    return null;
  }

  if (Number.isFinite(values)) {
    return {
      value: values,
      timestamp: feature?.properties?.timestep,
    };
  }

  return null;
}

function getCoordinates(feature) {
  const [longitude, latitude] = feature?.geometry?.coordinates ?? [];

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null;
  }

  return {
    latitude,
    longitude,
  };
}

function findHottestFeature(payload, parameter) {
  const features = payload?.features ?? [];
  const timestamps = payload?.timestamps ?? [];
  let hottest = null;

  for (const feature of features) {
    const reading = getTemperatureReading(feature, timestamps, parameter);
    const coordinates = getCoordinates(feature);

    if (reading === null || coordinates === null) {
      continue;
    }

    if (!hottest || reading.value > hottest.temperature) {
      hottest = {
        feature,
        temperature: reading.value,
        timestamp: reading.timestamp,
        coordinates,
      };
    }
  }

  if (!hottest) {
    throw new Error("No station with a measured temperature was found.");
  }

  return hottest;
}

function updateMap(hottest, stationNames, parameter) {
  const { latitude, longitude } = hottest.coordinates;
  const position = [latitude, longitude];
  const station = hottest.feature.properties?.station ?? "--";
  const name = stationNames.get(station) ?? `Station ${station}`;
  const unit = hottest.feature.properties?.parameters?.[parameter]?.unit ?? "°C";
  const label = `${name}: <strong class="hot-popup-temp">${hottest.temperature.toFixed(1)} ${unit}</strong>`;

  if (stationMarker) {
    stationMarker.setLatLng(position);
  } else {
    stationMarker = L.marker(position, {
      icon: hotMarkerIcon,
    }).addTo(stationMap);
  }

  stationMarker.bindPopup(label).openPopup();
}

function updatePage(hottest, stationNames, parameter) {
  const { latitude, longitude } = hottest.coordinates;
  const properties = hottest.feature.properties ?? {};
  const station = properties.station ?? "--";
  const stationName = stationNames.get(station);

  stationEl.textContent = stationName ? `${stationName} · Station ${station}` : `Station ${station}`;
  valueEl.textContent = hottest.temperature.toFixed(1);
  unitEl.textContent = properties.parameters?.[parameter]?.unit ?? "°C";
  measuredEl.textContent = formatDateTime(hottest.timestamp);
  coordinatesEl.textContent = `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
  updateMap(hottest, stationNames, parameter);
}

async function loadHottestPlace() {
  const parameter = getSelectedParameter();
  const mode = getSelectedMode();

  refreshButton.disabled = true;
  modeInputs.forEach((input) => {
    input.disabled = true;
  });
  pageTitleEl.textContent = mode.title;
  statusEl.classList.remove("error");
  statusEl.textContent = mode.loadingText;

  try {
    const { payload, stationNames, fromCache } = await fetchCurrentDataPayload();
    const hottest = findHottestFeature(payload, parameter);

    updatePage(hottest, stationNames, parameter);
    statusEl.textContent = fromCache
      ? `Loaded from cache ${formatDateTime(new Date())}`
      : `Updated ${formatDateTime(new Date())}`;
  } catch (error) {
    statusEl.classList.add("error");
    statusEl.textContent = error.message;
  } finally {
    refreshButton.disabled = false;
    modeInputs.forEach((input) => {
      input.disabled = false;
    });
  }
}

refreshButton.addEventListener("click", loadHottestPlace);
modeInputs.forEach((input) => {
  input.addEventListener("change", loadHottestPlace);
});
loadHottestPlace();
