/**
 * services/weather.js — Open-Meteo weather service
 * Free API, no key needed. Caches results for 1 hour.
 * API: https://api.open-meteo.com/v1/forecast
 */

const axios = require('axios');
const { getSetting, saveSetting } = require('../db/index.js');

const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast';
const CACHE_DURATION = 60 * 60; // 1 hour in seconds

/**
 * WMO Weather Code → human readable + emoji
 */
function weatherCodeToInfo(code) {
  const map = {
    0: { condition: 'Clear sky', emoji: '☀️' },
    1: { condition: 'Mainly clear', emoji: '🌤️' },
    2: { condition: 'Partly cloudy', emoji: '⛅' },
    3: { condition: 'Overcast', emoji: '☁️' },
    45: { condition: 'Fog', emoji: '🌫️' },
    48: { condition: 'Depositing rime fog', emoji: '🌫️' },
    51: { condition: 'Light drizzle', emoji: '🌦️' },
    53: { condition: 'Moderate drizzle', emoji: '🌦️' },
    55: { condition: 'Dense drizzle', emoji: '🌧️' },
    56: { condition: 'Freezing drizzle', emoji: '🌧️' },
    57: { condition: 'Dense freezing drizzle', emoji: '🌧️' },
    61: { condition: 'Slight rain', emoji: '🌦️' },
    63: { condition: 'Moderate rain', emoji: '🌧️' },
    65: { condition: 'Heavy rain', emoji: '🌧️' },
    66: { condition: 'Freezing rain', emoji: '🌧️' },
    67: { condition: 'Heavy freezing rain', emoji: '🌧️' },
    71: { condition: 'Slight snow', emoji: '🌨️' },
    73: { condition: 'Moderate snow', emoji: '🌨️' },
    75: { condition: 'Heavy snow', emoji: '❄️' },
    77: { condition: 'Snow grains', emoji: '❄️' },
    80: { condition: 'Slight rain showers', emoji: '🌦️' },
    81: { condition: 'Moderate rain showers', emoji: '🌧️' },
    82: { condition: 'Violent rain showers', emoji: '⛈️' },
    85: { condition: 'Slight snow showers', emoji: '🌨️' },
    86: { condition: 'Heavy snow showers', emoji: '❄️' },
    95: { condition: 'Thunderstorm', emoji: '⛈️' },
    96: { condition: 'Thunderstorm with hail', emoji: '⛈️' },
    99: { condition: 'Thunderstorm with heavy hail', emoji: '⛈️' }
  };
  return map[code] || { condition: 'Unknown', emoji: '🌡️' };
}

/**
 * Auto-detect location via IP geolocation (first run)
 */
async function autoDetectLocation() {
  try {
    const res = await axios.get('https://ipapi.co/json/', { timeout: 5000 });
    const { latitude, longitude, city } = res.data;
    if (latitude && longitude) {
      saveSetting('weather_latitude', String(latitude));
      saveSetting('weather_longitude', String(longitude));
      saveSetting('weather_city', city || 'Unknown');
      console.log(`[Weather] Auto-detected location: ${city} (${latitude}, ${longitude})`);
      return { latitude, longitude, city };
    }
  } catch (err) {
    console.error('[Weather] Auto-detect location failed:', err.message);
  }
  // Default fallback: Bengaluru, India
  return { latitude: 12.9716, longitude: 77.5946, city: 'Bengaluru' };
}

/**
 * Get weather data. Uses cache (1 hour), fetches fresh if stale.
 * @returns {Promise<object>} - { temp, condition, emoji, high, low, rain_chance, wind, city }
 */
async function getWeather() {
  // Check cache
  const cachedData = getSetting('weather_cache');
  const cachedAt = getSetting('weather_cached_at');

  if (cachedData && cachedAt) {
    const age = Math.floor(Date.now() / 1000) - parseInt(cachedAt);
    if (age < CACHE_DURATION) {
      try {
        return JSON.parse(cachedData);
      } catch {
        // Cache corrupt, fetch fresh
      }
    }
  }

  // Get coordinates
  let lat = getSetting('weather_latitude');
  let lon = getSetting('weather_longitude');
  let city = getSetting('weather_city');

  if (!lat || !lon) {
    const detected = await autoDetectLocation();
    lat = detected.latitude;
    lon = detected.longitude;
    city = detected.city;
  }

  try {
    const res = await axios.get(OPEN_METEO_URL, {
      params: {
        latitude: lat,
        longitude: lon,
        current: 'temperature_2m,weathercode,windspeed_10m,apparent_temperature',
        daily: 'temperature_2m_max,temperature_2m_min,precipitation_probability_max',
        timezone: 'auto',
        forecast_days: 1
      },
      timeout: 10000
    });

    const current = res.data.current;
    const daily = res.data.daily;
    const weatherInfo = weatherCodeToInfo(current.weathercode);

    const weather = {
      temp: Math.round(current.temperature_2m),
      feels_like: Math.round(current.apparent_temperature),
      condition: weatherInfo.condition,
      emoji: weatherInfo.emoji,
      high: Math.round(daily.temperature_2m_max[0]),
      low: Math.round(daily.temperature_2m_min[0]),
      rain_chance: daily.precipitation_probability_max[0] || 0,
      wind: Math.round(current.windspeed_10m),
      city: city || 'Your location'
    };

    // Cache the result
    saveSetting('weather_cache', JSON.stringify(weather));
    saveSetting('weather_cached_at', String(Math.floor(Date.now() / 1000)));

    return weather;
  } catch (err) {
    console.error('[Weather] Fetch failed:', err.message);

    // Return cached data if available, even if stale
    if (cachedData) {
      try {
        return { ...JSON.parse(cachedData), stale: true };
      } catch {
        // ignore
      }
    }

    return {
      temp: null,
      condition: 'Unable to fetch weather',
      emoji: '❓',
      error: err.message
    };
  }
}

module.exports = { getWeather, weatherCodeToInfo };
