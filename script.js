const defaultStationId = "11320";
const pageParams = new URLSearchParams(window.location.search);
const stationId =
  pageParams.get("station_id") || pageParams.get("station_ids") || defaultStationId;
const valueEl = document.querySelector("#value");
const unitEl = document.querySelector("#unit");
const measuredEl = document.querySelector("#measured");
const coordinatesEl = document.querySelector("#coordinates");
const precipitationEl = document.querySelector("#precipitation");
const windEl = document.querySelector("#wind");
const windDirectionEl = document.querySelector("#wind-direction");
const statusEl = document.querySelector("#status");
const refreshButton = document.querySelector("#refresh");
const stationEl = document.querySelector("#station");
const chartEl = document.querySelector("#temperature-chart");
const chartTitleEl = document.querySelector("#chart-title");
const rangeSelectEl = document.querySelector("#range-select");
const metricSelectEl = document.querySelector("#metric-select");
const dashboardEl = document.querySelector("main");
const stationMap = L.map("map", {
  zoomControl: true,
}).setView([47.26, 11.384166666666665], 12);
const apiResponseCache = new Map();
const compassPoints = [
  "N",
  "NNE",
  "NE",
  "ENE",
  "E",
  "ESE",
  "SE",
  "SSE",
  "S",
  "SSW",
  "SW",
  "WSW",
  "W",
  "WNW",
  "NW",
  "NNW",
];
let stationMarker;
let weatherChart;
let chartSeries = [];
let chartMetric = "temperature";
let temperatureSeries = [];
let precipitationSeries = [];

stationEl.textContent = `Station ${stationId}`;

L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
  attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
  maxZoom: 19,
}).addTo(stationMap);

function buildApiUrl() {
  const end = toMinutePrecision(new Date());
  //const end = new Date("2026-06-25T00:00:00Z");
  const start = new Date(end);
  start.setUTCHours(start.getUTCHours() - getSelectedRangeHours());

  const apiUrl = new URL(
    "https://dataset.api.hub.geosphere.at/v1/station/historical/tawes-v1-10min",
  );

  apiUrl.search = new URLSearchParams({
    parameters: "TL,RR,FF,DD",
    start: start.toISOString(),
    end: end.toISOString(),
    station_ids: stationId,
  });

  return apiUrl;
}

function toMinutePrecision(date) {
  const rounded = new Date(date);
  rounded.setUTCSeconds(0, 0);
  return rounded;
}

function getSelectedRangeHours() {
  const hours = Number.parseInt(rangeSelectEl.value, 10);
  return Number.isFinite(hours) ? hours : 24;
}

function getSelectedMetric() {
  return metricSelectEl?.value === "precipitation" ? "precipitation" : "temperature";
}

function formatRangeLabel(hours) {
  if (hours === 1) {
    return "Past hour";
  }

  if (hours < 24) {
    return `Past ${hours} hours`;
  }

  if (hours === 24) {
    return "Past 24 hours";
  }

  return `Past ${hours / 24} days`;
}

function formatChartTitle() {
  const metricLabel = getSelectedMetric() === "precipitation" ? "Precipitation" : "Temperature";
  return `${metricLabel} · ${formatRangeLabel(getSelectedRangeHours())}`;
}

function formatDateTime(timestamp) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
    hour12: false,
  }).format(new Date(timestamp));
}

function getCachedPayload(url) {
  if (apiResponseCache.has(url)) {
    return apiResponseCache.get(url);
  }

  try {
    const stored = sessionStorage.getItem(`tawes:${url}`);

    if (stored) {
      const payload = JSON.parse(stored);
      apiResponseCache.set(url, payload);
      return payload;
    }
  } catch {
    return null;
  }

  return null;
}

function cachePayload(url, payload) {
  apiResponseCache.set(url, payload);

  try {
    sessionStorage.setItem(`tawes:${url}`, JSON.stringify(payload));
  } catch {
    // The in-memory cache is enough if browser storage is unavailable.
  }
}

function isRateLimitPayload(payload) {
  return payload?.message === "API rate limit exceeded";
}

async function fetchTawesPayload(apiUrl) {
  const url = apiUrl.toString();
  const cachedPayload = getCachedPayload(url);

  if (cachedPayload) {
    return {
      payload: cachedPayload,
      fromCache: true,
    };
  }

  const response = await fetch(url);
  const payload = await response.json().catch(() => null);

  if (response.status === 429 || isRateLimitPayload(payload)) {
    const requestId = payload?.request_id ? ` Request ID: ${payload.request_id}` : "";
    throw new Error(`API rate limit exceeded. Please wait before refreshing.${requestId}`);
  }

  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}.`);
  }

  cachePayload(url, payload);

  return {
    payload,
    fromCache: false,
  };
}

function isMeasuredValue(value) {
  return value !== null && value !== undefined && Number.isFinite(value);
}

function getLatestParameterReading(payload, parameterKey) {
  const timestamps = payload.timestamps ?? [];
  const feature = payload.features?.[0];
  const parameter = feature?.properties?.parameters?.[parameterKey];
  const values = parameter?.data ?? [];

  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index];

    if (isMeasuredValue(value)) {
      return {
        value,
        timestamp: timestamps[index],
        name: parameter.name ?? parameterKey,
        unit: parameter.unit ?? "",
        coordinates: feature?.geometry?.coordinates,
      };
    }
  }

  return null;
}

function getLatestReading(payload) {
  const reading = getLatestParameterReading(payload, "TL");

  if (!reading) {
    throw new Error("No measured temperature value was found.");
  }

  return {
    ...reading,
    name: reading.name || "Air temperature",
    unit: reading.unit || "°C",
  };
}

function getLatestWind(payload) {
  const timestamps = payload.timestamps ?? [];
  const feature = payload.features?.[0];
  const speedParameter = feature?.properties?.parameters?.FF;
  const directionParameter = feature?.properties?.parameters?.DD;
  const speedValues = speedParameter?.data ?? [];
  const directionValues = directionParameter?.data ?? [];
  const lastIndex = Math.max(speedValues.length, directionValues.length) - 1;

  for (let index = lastIndex; index >= 0; index -= 1) {
    const speed = speedValues[index];

    if (!isMeasuredValue(speed)) {
      continue;
    }

    return {
      speed,
      direction: isMeasuredValue(directionValues[index]) ? directionValues[index] : null,
      timestamp: timestamps[index],
      speedUnit: speedParameter?.unit ?? "m/s",
      directionUnit: directionParameter?.unit ?? "°",
    };
  }

  return null;
}

function degreesToCompass(degrees) {
  const normalized = ((degrees % 360) + 360) % 360;
  const index = Math.round(normalized / 22.5) % compassPoints.length;
  return compassPoints[index];
}

function formatPrecipitation(reading) {
  if (!reading) {
    return "--";
  }

  return `${reading.value.toFixed(1)} ${reading.unit || "mm"}`;
}

function formatWindSpeed(wind) {
  if (!wind) {
    return "--";
  }

  return `${wind.speed.toFixed(1)} ${wind.speedUnit}`;
}

function formatWindDirection(wind) {
  if (!wind) {
    return "Speed and direction";
  }

  if (wind.speed < 0.1) {
    return "Calm";
  }

  if (!isMeasuredValue(wind.direction)) {
    return "Direction unavailable";
  }

  return `${degreesToCompass(wind.direction)} (${Math.round(wind.direction)}°)`;
}

function getParameterSeries(payload, parameterKey) {
  const timestamps = payload.timestamps ?? [];
  const values = payload.features?.[0]?.properties?.parameters?.[parameterKey]?.data ?? [];

  return values
    .map((value, index) => ({
      timestamp: timestamps[index],
      value,
    }))
    .filter((point) => point.timestamp && isMeasuredValue(point.value));
}

function formatChartLabel(timestamp) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(timestamp));
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function mixColor(start, end, amount) {
  const startRgb = start.match(/\w\w/g).map((channel) => parseInt(channel, 16));
  const endRgb = end.match(/\w\w/g).map((channel) => parseInt(channel, 16));

  return startRgb
    .map((channel, index) =>
      Math.round(channel + (endRgb[index] - channel) * amount)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("");
}

function hexToRgba(hex, opacity) {
  const [red, green, blue] = hex.match(/\w\w/g).map((channel) => parseInt(channel, 16));
  return `rgba(${red}, ${green}, ${blue}, ${opacity})`;
}

function getTemperatureColor(value) {
  if (value < 15) {
    const intensity = clamp((15 - value) / 10, 0, 1);
    return `#${mixColor("9ca3af", "1d4ed8", intensity)}`;
  }

  if (value > 25) {
    const intensity = clamp((value - 25) / 5, 0, 1);
    return `#${mixColor("9ca3af", "b91c1c", intensity)}`;
  }

  return "#9ca3af";
}

function updateTemperatureTheme(value) {
  dashboardEl.classList.toggle("temp-cold", value < 15);
  dashboardEl.classList.toggle("temp-warm", value > 25);
}

function getTemperatureGradient(chart, opacity) {
  const { chartArea, scales } = chart;

  if (!chartArea || !scales.y) {
    return hexToRgba("9ca3af", opacity);
  }

  const gradient = chart.ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
  const yScale = scales.y;
  const stops = [
    { offset: 0, color: hexToRgba("b91c1c", opacity) },
    {
      offset: clamp(
        (yScale.getPixelForValue(30) - chartArea.top) /
          (chartArea.bottom - chartArea.top),
        0,
        1,
      ),
      color: hexToRgba("b91c1c", opacity),
    },
    {
      offset: clamp(
        (yScale.getPixelForValue(25) - chartArea.top) /
          (chartArea.bottom - chartArea.top),
        0,
        1,
      ),
      color: hexToRgba("9ca3af", opacity),
    },
    {
      offset: clamp(
        (yScale.getPixelForValue(15) - chartArea.top) /
          (chartArea.bottom - chartArea.top),
        0,
        1,
      ),
      color: hexToRgba("9ca3af", opacity),
    },
    {
      offset: clamp(
        (yScale.getPixelForValue(10) - chartArea.top) /
          (chartArea.bottom - chartArea.top),
        0,
        1,
      ),
      color: hexToRgba("1d4ed8", opacity),
    },
    { offset: 1, color: hexToRgba("1d4ed8", opacity) },
  ].sort((a, b) => a.offset - b.offset);

  stops.forEach((stop) => gradient.addColorStop(stop.offset, stop.color));

  return gradient;
}

function getSelectedSeries() {
  return getSelectedMetric() === "precipitation" ? precipitationSeries : temperatureSeries;
}

function buildChartData(series, metric) {
  if (metric === "precipitation") {
    return {
      labels: series.map((point) => formatChartLabel(point.timestamp)),
      datasets: [
        {
          label: "Precipitation mm",
          data: series.map((point) => point.value),
          borderColor: "#2563eb",
          backgroundColor: "rgba(37, 99, 235, 0.18)",
          borderWidth: 2,
          pointBackgroundColor: "#2563eb",
          pointBorderColor: "#ffffff",
          pointBorderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 5,
          tension: 0.2,
          fill: true,
          segment: undefined,
        },
      ],
    };
  }

  return {
    labels: series.map((point) => formatChartLabel(point.timestamp)),
    datasets: [
      {
        label: "Temperature °C",
        data: series.map((point) => point.value),
        borderColor: (context) => getTemperatureGradient(context.chart, 1),
        backgroundColor: "transparent",
        borderWidth: 3,
        pointBackgroundColor: (context) => getTemperatureColor(context.parsed?.y ?? 22),
        pointBorderColor: "#ffffff",
        pointBorderWidth: 2,
        pointRadius: 0,
        pointHoverRadius: 5,
        tension: 0.28,
        fill: false,
        segment: {
          borderColor: (context) =>
            getTemperatureColor((context.p0.parsed.y + context.p1.parsed.y) / 2),
        },
      },
    ],
  };
}

function getChartScaleOptions(series, metric) {
  if (metric === "precipitation") {
    const maxValue = Math.max(0, ...series.map((point) => point.value));

    return {
      beginAtZero: true,
      suggestedMin: 0,
      suggestedMax: Math.max(1, maxValue),
      title: {
        display: true,
        text: "mm / 10 min",
      },
      ticks: {
        callback: (value) => `${value}`,
      },
    };
  }

  return {
    beginAtZero: false,
    suggestedMin: 15,
    suggestedMax: 30,
    title: {
      display: true,
      text: "°C",
    },
    ticks: {
      callback: (value) => `${value}°`,
    },
  };
}

function formatChartTooltip(item) {
  if (getSelectedMetric() === "precipitation") {
    return `${item.parsed.y.toFixed(1)} mm`;
  }

  return `${item.parsed.y.toFixed(1)} °C`;
}

function updateChart(series) {
  const metric = getSelectedMetric();
  const metricLabel = metric === "precipitation" ? "precipitation" : "temperature";

  if (series.length === 0) {
    throw new Error(`No ${metricLabel} values were found for the chart.`);
  }

  chartSeries = series;
  const chartData = buildChartData(series, metric);
  const yScale = getChartScaleOptions(series, metric);

  if (weatherChart && chartMetric !== metric) {
    weatherChart.destroy();
    weatherChart = undefined;
  }

  chartMetric = metric;

  if (weatherChart) {
    weatherChart.data = chartData;
    weatherChart.options.scales.y.beginAtZero = yScale.beginAtZero;
    weatherChart.options.scales.y.suggestedMin = yScale.suggestedMin;
    weatherChart.options.scales.y.suggestedMax = yScale.suggestedMax;
    weatherChart.options.scales.y.title.text = yScale.title.text;
    weatherChart.options.scales.y.ticks.callback = yScale.ticks.callback;
    weatherChart.update();
    return;
  }

  weatherChart = new Chart(chartEl, {
    type: "line",
    data: chartData,
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        intersect: false,
        mode: "index",
      },
      plugins: {
        legend: {
          display: false,
        },
        tooltip: {
          callbacks: {
            title: (items) => {
              const point = chartSeries[items[0].dataIndex];
              return formatDateTime(point.timestamp);
            },
            label: (item) => formatChartTooltip(item),
          },
        },
      },
      scales: {
        x: {
          ticks: {
            autoSkip: true,
            maxTicksLimit: 8,
          },
          grid: {
            display: false,
          },
        },
        y: yScale,
      },
    },
  });
}

function renderSelectedChart() {
  updateChart(getSelectedSeries());
  chartTitleEl.textContent = formatChartTitle();
}

function updateMap(coordinates) {
  const [longitude, latitude] = coordinates ?? [];

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new Error("No station coordinates were found.");
  }

  const position = [latitude, longitude];

  coordinatesEl.textContent = `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
  stationMap.setView(position, 12);

  if (stationMarker) {
    stationMarker.setLatLng(position);
  } else {
    stationMarker = L.marker(position).addTo(stationMap);
  }
}

function setControlsDisabled(disabled) {
  refreshButton.disabled = disabled;
  rangeSelectEl.disabled = disabled;
  if (metricSelectEl) {
    metricSelectEl.disabled = disabled;
  }
}

async function loadLatestValue() {
  setControlsDisabled(true);
  statusEl.classList.remove("error");
  statusEl.textContent = "Loading latest value...";

  try {
    const { payload, fromCache } = await fetchTawesPayload(buildApiUrl());
    const latest = getLatestReading(payload);
    const precipitation = getLatestParameterReading(payload, "RR");
    const wind = getLatestWind(payload);
    temperatureSeries = getParameterSeries(payload, "TL");
    precipitationSeries = getParameterSeries(payload, "RR");

    valueEl.textContent = latest.value.toFixed(1);
    unitEl.textContent = latest.unit;
    updateTemperatureTheme(latest.value);
    precipitationEl.textContent = formatPrecipitation(precipitation);
    windEl.textContent = formatWindSpeed(wind);
    windDirectionEl.textContent = formatWindDirection(wind);
    measuredEl.textContent = latest.timestamp
      ? formatDateTime(latest.timestamp)
      : "--";
    updateMap(latest.coordinates);
    renderSelectedChart();
    statusEl.textContent = fromCache
      ? `Loaded from cache ${formatDateTime(new Date())}`
      : `Updated ${formatDateTime(new Date())}`;
  } catch (error) {
    statusEl.classList.add("error");
    statusEl.textContent = error.message;
  } finally {
    setControlsDisabled(false);
  }
}

function showSelectedMetric() {
  statusEl.classList.remove("error");

  try {
    renderSelectedChart();
  } catch (error) {
    statusEl.classList.add("error");
    statusEl.textContent = error.message;
  }
}

refreshButton.addEventListener("click", loadLatestValue);
rangeSelectEl.addEventListener("change", loadLatestValue);
metricSelectEl.addEventListener("change", showSelectedMetric);
loadLatestValue();
