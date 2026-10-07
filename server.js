// server.js — sesión única + APIs Weather.com (WU) + lluvia YTD por meses
// Node >=18 (fetch nativo). Listo para Railway.

// Carga variables locales; Railway proporciona las suyas directamente.
require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

const app = express();
app.set('trust proxy', 1);

/* ============ CORS ============ */
const ALLOWED = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map(s => s.trim().replace(/\/+$/, ''))
  .filter(Boolean);

app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (ALLOWED.length === 0) return cb(null, true);
    const ok = ALLOWED.includes(origin.replace(/\/+$/, ''));
    cb(ok ? null : new Error('Not allowed by CORS'), ok);
  },
  credentials: true
}));
app.options('*', cors());
app.use((req,res,next)=>{ res.header('Vary','Origin'); next(); });

/* ============ Carpetas ============ */
const DB_DIR = path.join(__dirname, 'db');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
const PUBLIC_DIR = path.join(__dirname, 'public');
if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });

/* ============ Body + estáticos ============ */
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

/* ============ Healthcheck ============ */
app.get('/health', (_,res)=>res.status(200).send('OK'));
app.get('/salud',  (_,res)=>res.status(200).send('OK'));

/* ============ Acceso público sin login ============ */
app.get('/', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'inicio.html')));
app.get('/inicio', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'inicio.html')));
app.get('/login.html', (_req, res) => res.redirect('/'));
app.get('/verificar-sesion', (_req, res) => res.json({ activo: true }));

/* ============ Historial URL (front lo usa) ============ */
const HISTORIAL_FALLBACK = 'https://prueba2-production-50d4.up.railway.app/';
app.get('/historial-url', (req, res) => {
  res.json({ url: process.env.HISTORIAL_URL || HISTORIAL_FALLBACK });
});

/* ============ Proxies Weather.com PWS ============ */
const UA = process.env.USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari';

app.get('/api/weather/current', async (req, res) => {
  try {
    const base = (process.env.CUMULUS_URL || 'http://localhost:8998').replace(/\/+$/, '');
    const url = `${base}/websitedataT.json`;

    const r = await fetch(url, {
      headers: {
        'Accept': 'application/json,text/plain,*/*',
        'User-Agent': UA
      }
    });

    const body = await r.text();

    if (!r.ok) {
      return res.status(502).json({
        error: 'cumulus_unavailable',
        detalle: `CumulusMX respondió HTTP ${r.status}`
      });
    }

    try {
      const data = JSON.parse(body);
      res.set('Cache-Control', 'no-store');
      return res.json(data);
    } catch (e) {
      return res.status(502).json({
        error: 'cumulus_invalid_json',
        detalle: 'websitedataT.json no contiene JSON válido'
      });
    }
  } catch (e) {
    console.error('Error CumulusMX:', e);
    return res.status(500).json({
      error: 'cumulus_connection_failed',
      detalle: String(e.message || e)
    });
  }
});

/* ============ Índice UV estimado (Open-Meteo) ============ */
app.get('/api/uv/current', async (req, res) => {
  try {
    const lat = 36.985;
    const lon = -4.223;

    const url =
      `https://api.open-meteo.com/v1/forecast` +
      `?latitude=${lat}` +
      `&longitude=${lon}` +
      `&current=uv_index` +
      `&timezone=Europe%2FMadrid`;

    const r = await fetch(url);
    const data = await r.json();

    if (!r.ok) {
      return res.status(502).json({ error: 'uv_unavailable' });
    }

    return res.json({
      uv: data?.current?.uv_index ?? null,
      origen: 'Open-Meteo',
      time: data?.current?.time ?? null
    });
  } catch (e) {
    console.error('Error UV:', e);
    return res.status(500).json({
      error: 'uv_failed',
      detalle: String(e.message || e)
    });
  }
});

app.get('/api/weather/history', async (req, res) => {
  try {
    const apiKey = process.env.WEATHER_API_KEY || process.env.WU_API_KEY;
    const stationId = req.query.stationId || process.env.WU_STATION_ID;
    const { startDate, endDate } = req.query;
    const units = req.query.units || 'm';
    if (!apiKey || !stationId) return res.status(400).json({ error:'config_missing', detalle:'Faltan WEATHER_API_KEY/WU_API_KEY o WU_STATION_ID' });
    if (!startDate || !endDate) return res.status(400).json({ error:'params_missing', detalle:'startDate y endDate son obligatorios (YYYYMMDD)' });

    const url = new URL('https://api.weather.com/v2/pws/history/daily');
    url.searchParams.set('stationId', stationId);
    url.searchParams.set('format', 'json');
    url.searchParams.set('units', units);
    url.searchParams.set('startDate', startDate);
    url.searchParams.set('endDate', endDate);
    url.searchParams.set('apiKey', apiKey);
    url.searchParams.set('numericPrecision', 'decimal');

    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept':'application/json,text/plain,*/*', 'Accept-Language':'es-ES,es;q=0.9' }});
    const ct = (r.headers.get('content-type') || '').toLowerCase();
    const body = await r.text();
    if (!r.ok) { console.error('Upstream /history', r.status, ct, body.slice(0,300)); return res.status(r.status).json({ error:'weather.com denied', status:r.status }); }
    if (!ct.includes('application/json')) return res.status(502).json({ error:'Invalid response from weather.com' });
    res.set('Cache-Control','public, max-age=300').type('application/json').send(body);
  } catch (e) { console.error(e); res.status(500).json({ error:'Weather history proxy failed' }); }
});

/* ============ Recepción de lluvia desde CumulusMX ============ */
/*
  CumulusMX (en el PC local) envía el valor de MonthRainfall a Render.
  Se mantiene en memoria: CumulusMX lo volverá a enviar automáticamente
  en cada intervalo, por lo que un reinicio de Render se recupera solo.
*/
const CUMULUS_MONTHLY = new Map();

app.get('/api/cumulus/lluvia', (req, res) => {
  try {
    const year = Number(req.query.year);
    const month = Number(req.query.month);
    const rain = Number(String(req.query.rain ?? '').replace(',', '.'));

    if (!Number.isInteger(year) || year < 2000 || year > 2100 ||
        !Number.isInteger(month) || month < 1 || month > 12 ||
        !Number.isFinite(rain) || rain < 0) {
      return res.status(400).json({
        error: 'params_invalid',
        detalle: 'year, month y rain deben ser válidos'
      });
    }

    const key = `${year}-${String(month).padStart(2, '0')}`;
    const dato = {
      year,
      month,
      total_mm: Number(rain.toFixed(2)),
      recibido: new Date().toISOString(),
      origen: 'CumulusMX MonthRainfall'
    };

    CUMULUS_MONTHLY.set(key, dato);

    console.log(`[CumulusMX] lluvia ${key}: ${dato.total_mm} mm`);
    return res.json({ ok: true, ...dato });
  } catch (e) {
    console.error('Error /api/cumulus/lluvia:', e);
    return res.status(500).json({ error: 'cumulus_receive_failed' });
  }
});

/* ============ Lluvia mensual desde CumulusMX ============ */
app.get('/api/lluvia/mensual', async (req, res) => {
  try {
    const base = (process.env.CUMULUS_URL || 'http://localhost:8998').replace(/\/+$/, '');
    const year = Number(req.query.year);
    const month = Number(req.query.month);

    if (!Number.isInteger(year) || year < 2000 || year > 2100 ||
        !Number.isInteger(month) || month < 1 || month > 12) {
      return res.status(400).json({ error: 'params_invalid', detalle: 'year y month son obligatorios y válidos' });
    }

    // Primero usamos el último dato que CumulusMX ha enviado a Render.
    // CumulusMX lo actualiza automáticamente en cada intervalo.
    const key = `${year}-${String(month).padStart(2, '0')}`;
    const pushed = CUMULUS_MONTHLY.get(key);
    if (pushed) {
      return res.json(pushed);
    }

    // No hay todavía un dato recibido desde CumulusMX.
    // No intentamos acceder a localhost:8998 desde Render porque localhost
    // en Render NO es el PC donde está instalado CumulusMX.
    return res.status(503).json({
      error: 'cumulus_waiting',
      detalle: 'Todavía no se ha recibido la lluvia mensual desde CumulusMX'
    });

    // Código antiguo de acceso directo a CumulusMX, conservado como referencia:
    const tagUrl = `${base}/api/tags/process.txt`;
    const tagBody = `<#MonthRainfall y="${year}" m="${month}">`;

    const tagResponse = await fetch(tagUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Accept': 'text/plain,text/html,*/*'
      },
      body: tagBody
    });

    const tagText = (await tagResponse.text()).trim();
    if (!tagResponse.ok) {
      return res.status(502).json({
        error: 'cumulus_unavailable',
        detalle: `CumulusMX respondió HTTP ${tagResponse.status}`
      });
    }

    // El valor devuelto por CumulusMX está en la unidad de lluvia configurada.
    const total = Number(String(tagText).replace(',', '.').replace(/[^0-9.+-]/g, ''));
    if (!Number.isFinite(total)) {
      return res.status(502).json({
        error: 'cumulus_invalid_value',
        detalle: `CumulusMX devolvió: ${tagText}`
      });
    }

    return res.json({
      year,
      month,
      total_mm: Number(total.toFixed(2)),
      origen: 'CumulusMX MonthRainfall'
    });
  } catch (e) {
    console.error('Error /api/lluvia/mensual:', e);
    return res.status(502).json({
      error: 'cumulus_connection_failed',
      detalle: String(e.message || e)
    });
  }
});

/* ============ Lluvia mensual de todo el año desde CumulusMX ============ */
app.get('/api/lluvia/anual', (req, res) => {
  try {
    const year = Number(req.query.year);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      return res.status(400).json({
        error: 'params_invalid',
        detalle: 'year debe ser válido'
      });
    }

    const meses = [];
    for (let month = 1; month <= 12; month++) {
      const key = `${year}-${String(month).padStart(2, '0')}`;
      const dato = CUMULUS_MONTHLY.get(key);

      meses.push({
        year,
        month,
        total_mm: dato ? dato.total_mm : null,
        recibido: dato ? dato.recibido : null,
        origen: dato ? dato.origen : 'CumulusMX MonthRainfall'
      });
    }

    return res.json({
      year,
      meses,
      recibidos: meses.filter(m => m.total_mm !== null).length,
      origen: 'CumulusMX MonthRainfall'
    });
  } catch (e) {
    console.error('Error /api/lluvia/anual:', e);
    return res.status(500).json({
      error: 'cumulus_annual_failed',
      detalle: String(e.message || e)
    });
  }
});

/* ============ Lluvia acumulada (YTD) por meses (evita 502) ============ */
app.get('/api/lluvia/total/year', async (req, res) => {
  try {
    const apiKey    = process.env.WU_API_KEY;
    const stationId = process.env.WU_STATION_ID;
    if (!apiKey || !stationId) {
      return res.status(400).json({ error:'config_missing', detalle:'Define WU_API_KEY y WU_STATION_ID' });
    }

    const now  = new Date();
    const YEAR = now.getFullYear();
    const pad  = (n) => String(n).padStart(2,'0');

    const toNum = (v) => (v === 'T' ? 0 : (Number.isFinite(Number(v)) ? Number(v) : null));
    const in2mm = (inch) => inch * 25.4;

    const dayMm = (d) => {
      let v = toNum(d?.metric?.precipTotal); if (v != null) return v;
      v = toNum(d?.imperial?.precipTotal);   if (v != null) return in2mm(v);
      v = toNum(d?.precipTotal);             if (v != null) return v;
      v = toNum(d?.metric?.precip);          if (v != null) return v;
      v = toNum(d?.precip);                  if (v != null) return v;
      v = toNum(d?.imperial?.precip);        if (v != null) return in2mm(v);
      return 0;
    };

    async function fetchRange(startDate, endDate) {
      const u =
        `https://api.weather.com/v2/pws/history/daily?stationId=${encodeURIComponent(stationId)}` +
        `&format=json&units=m&startDate=${startDate}&endDate=${endDate}` +
        `&numericPrecision=decimal&apiKey=${encodeURIComponent(apiKey)}`;

      const r = await fetch(u, {
        headers: {
          'User-Agent': process.env.USER_AGENT || 'Mozilla/5.0',
          'Accept': 'application/json,text/plain,*/*',
          'Accept-Language': 'es-ES,es;q=0.9'
        }
      });

      const ct = (r.headers.get('content-type') || '').toLowerCase();
      const text = await r.text();

      if (!r.ok || !ct.includes('application/json')) {
        console.warn('[WU chunk] status=', r.status, 'ct=', ct, 'range=', startDate, endDate, 'body=', text.slice(0,200));
        return { observations: [] };
      }
      try { return JSON.parse(text); } catch { return { observations: [] }; }
    }

    // Recorremos enero → hoy, mes a mes, acumulando por día (evitar duplicados)
    const perDay = new Map(); // YYYY-MM-DD -> mm
    for (let m = 0; m < 12; m++) {
      const monthStart = new Date(YEAR, m, 1);
      if (monthStart > now) break;

      const monthEnd = new Date(YEAR, m + 1, 0);
      const end = monthEnd > now ? now : monthEnd;

      const startDate = `${YEAR}${pad(m + 1)}01`;
      const endDate   = `${YEAR}${pad(end.getMonth() + 1)}${pad(end.getDate())}`;

      const data = await fetchRange(startDate, endDate);
      const obs = Array.isArray(data?.observations) ? data.observations : [];

      for (const d of obs) {
        const iso = (d?.obsTimeLocal || d?.obsTimeUtc || '').slice(0, 10); // YYYY-MM-DD
        if (!iso) continue;
        const mm = dayMm(d);
        perDay.set(iso, Math.max(perDay.get(iso) || 0, mm));
      }
    }

    const lista = Array.from(perDay.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    const total = lista.reduce((acc, [, mm]) => acc + (Number.isFinite(mm) ? mm : 0), 0);

    if (req.query.debug === '1') {
      return res.json({
        year: YEAR,
        desde: `${YEAR}-01-01`,
        hasta: `${YEAR}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
        dias_contados: lista.length,
        total_mm: Number(total.toFixed(2)),
        muestra: lista.slice(-10).map(([fecha, mm]) => ({ fecha, mm })),
      });
    }

    return res.json({
      year: YEAR,
      desde: `${YEAR}-01-01`,
      hasta: `${YEAR}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
      dias_contados: lista.length,
      total_mm: Number(total.toFixed(2)),
      origen: 'WU history/daily (mensual)'
    });

  } catch (e) {
    console.error('Error /api/lluvia/total/year:', e);
    return res.status(500).json({ error:'calc_failed', detalle:String(e.message || e) });
  }
});


/* ============ Arranque ============ */
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () =>
  console.log(`🚀 http://0.0.0.0:${PORT} — listo (rutas: /verificar-sesion, /api/weather/*, /api/uv/current, /api/lluvia/total/year)`)
);

