const BASE_URL = "https://archive-api.open-meteo.com/v1/archive";

const WMO_CODES = {
  0: "晴朗", 1: "大部晴朗", 2: "大部多云", 3: "多云",
  45: "雾", 48: "雾凇",
  51: "小毛毛雨", 53: "中毛毛雨", 55: "大毛毛雨",
  56: "冻毛毛雨", 57: "冻毛毛雨",
  61: "小雨", 63: "中雨", 65: "大雨",
  66: "冻雨", 67: "冻雨",
  71: "小雪", 73: "中雪", 75: "大雪",
  77: "雪粒",
  80: "小阵雨", 81: "中阵雨", 82: "大阵雨",
  85: "小阵雪", 86: "大阵雪",
  95: "雷暴", 96: "雷暴+冰雹", 99: "雷暴+冰雹",
};

function wmoCodeToZh(code) {
  return WMO_CODES[code] || "未知";
}

export async function fetchWeather(lat, lon, dateStr) {
  const params = new URLSearchParams({
    latitude: lat,
    longitude: lon,
    start_date: dateStr,
    end_date: dateStr,
    daily: [
      "temperature_2m_max",
      "temperature_2m_min",
      "apparent_temperature_max",
      "apparent_temperature_min",
      "weather_code",
      "precipitation_sum",
      "relative_humidity_2m_max",
      "wind_speed_10m_max",
    ].join(","),
    timezone: "Asia/Shanghai",
  });

  const url = `${BASE_URL}?${params}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo returned ${res.status}`);

  const body = await res.json();
  const daily = body.daily;
  if (!daily) return null;

  return {
    tempMax: daily.temperature_2m_max?.[0] ?? null,
    tempMin: daily.temperature_2m_min?.[0] ?? null,
    feelsLikeMax: daily.apparent_temperature_max?.[0] ?? null,
    feelsLikeMin: daily.apparent_temperature_min?.[0] ?? null,
    weatherCode: daily.weather_code?.[0] ?? null,
    weatherDesc: wmoCodeToZh(daily.weather_code?.[0]),
    precipitation: daily.precipitation_sum?.[0] ?? null,
    humidity: daily.relative_humidity_2m_max?.[0] ?? null,
    windSpeed: daily.wind_speed_10m_max?.[0] ?? null,
  };
}
