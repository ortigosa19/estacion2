// Agente local CumulusMX -> Render. Requiere Node.js 18 o superior.
// Env: CUMULUS_PUSH_TOKEN, RENDER_URL y opcional CUMULUS_DATA_DIR (por defecto C:\\CumulusMX\\data).
const fs = require('node:fs');
const path = require('node:path');
const CUMULUS_URL = (process.env.CUMULUS_URL || 'http://127.0.0.1:8998').replace(/\/+$/, '');
const RENDER_URL = (process.env.RENDER_URL || 'https://estacion2.onrender.com').replace(/\/+$/, '');
const TOKEN = process.env.CUMULUS_PUSH_TOKEN || '';
const DATA_DIR = process.env.CUMULUS_DATA_DIR || 'C:\\CumulusMX\\data';
const HISTORY_YEARS = (process.env.HISTORY_YEARS || String(new Date().getFullYear())).split(',').map(x => Number(x.trim())).filter(y => Number.isInteger(y) && y >= 2000 && y <= 2100);
const INTERVAL_MS = 10 * 60 * 1000;
if (!TOKEN) { console.error('Falta CUMULUS_PUSH_TOKEN. Debe coincidir con la variable configurada en Render.'); process.exit(1); }

async function leerMes(year, month) {
  const response = await fetch(`${CUMULUS_URL}/api/tags/process.txt`, {
    method: 'POST', headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Accept': 'text/plain,text/html,*/*' },
    body: `<#MonthRainfall y="${year}" m="${month}">`, signal: AbortSignal.timeout(8000)
  });
  const text = (await response.text()).trim();
  if (!response.ok) throw new Error(`CumulusMX HTTP ${response.status}: ${text.slice(0,120)}`);
  const match = text.replace(',', '.').match(/-?\d+(?:\.\d+)?/);
  if (!match) throw new Error(`No se pudo interpretar MonthRainfall: ${text}`);
  const value = Number(match[0]);
  if (!Number.isFinite(value) || value < 0) throw new Error(`Lluvia no válida: ${text}`);
  return Number(value.toFixed(2));
}
async function enviarLluvia(year, month, total_mm) {
  const response = await fetch(`${RENDER_URL}/api/cumulus/lluvia`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-cumulus-token': TOKEN }, body: JSON.stringify({ year, month, total_mm }), signal: AbortSignal.timeout(15000) });
  const body = await response.text(); if (!response.ok) throw new Error(`Render lluvia HTTP ${response.status}: ${body.slice(0,180)}`);
}
function csv(line) {
  const out = []; let value = '', quoted = false;
  for (let i=0;i<line.length;i++) { const c=line[i]; if (c==='"' && line[i+1]==='"' && quoted) { value+='"'; i++; } else if (c==='"') quoted=!quoted; else if (c===',' && !quoted) { out.push(value.trim()); value=''; } else value+=c; }
  out.push(value.trim()); return out;
}
function numeric(value) { if (value === undefined || value === null || value.trim() === '') return null; const n=Number(value.replace(',', '.')); return Number.isFinite(n) ? n : null; }
function dateIso(value, fallback) {
  const s=(value||'').trim();
  let m=s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/); if(m) return `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
  m=s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/); if(m) { let y=Number(m[3]); if(y<100)y+=2000; return `${y}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`; }
  return fallback || null;
}
function parseLogFile(file, year) {
  const base=path.basename(file); const fm=base.match(/^(\d{4})(\d{2})(\d{2})log\.txt$/i); if(!fm) return [];
  const fallback=`${fm[1]}-${fm[2]}-${fm[3]}`; if(Number(fm[1])!==year) return [];
  const lines=fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'').split(/\r?\n/).filter(Boolean); const result=[]; let headers=null;
  for(const line of lines) {
    const cols=csv(line); if(!cols.length) continue;
    if(cols.some(c=>/^(date|fecha)$/i.test(c))) { headers=cols.map(c=>c.toLowerCase().replace(/[^a-z]/g,'')); continue; }
    const hasHeader=!!headers;
    const get=(names,index)=>{ if(hasHeader){ const i=headers.findIndex(h=>names.includes(h)); return i>=0?cols[i]:''; } return cols[index]??''; };
    const fecha=dateIso(get(['date','fecha'],0),fallback); const hora=(get(['time','hora'],1)||'').trim();
    if(!fecha || !fecha.startsWith(`${year}-`) || !/^\d{1,2}:\d{2}(?::\d{2})?$/.test(hora)) continue;
    // Orden estándar de los logs de CumulusMX cuando no existe cabecera:
    // fecha,hora,temp,humedad,punto de rocío,viento,rumbo,racha,rumbo racha,presión,lluvia hoy,tasa lluvia...
    const pick=(names,index)=>numeric(get(names,index));
    result.push({ fecha, hora: hora.length===5?`${hora}:00`:hora, temperatura:pick(['temperature','temp','temperatura'],2), humedad:pick(['humidity','humedad'],3), viento:pick(['windspeed','windspd','viento'],5), racha:pick(['recentwindgust','windgust','gust','racha'],7), presion:pick(['pressure','press','presion'],9), lluvia:pick(['raintoday','rainfalltoday','lluviahoy'],10) });
  }
  return result;
}
async function enviarHistorial(year) {
  if (!fs.existsSync(DATA_DIR)) throw new Error(`No encuentro la carpeta de datos de CumulusMX: ${DATA_DIR}. Define CUMULUS_DATA_DIR con la ruta correcta.`);
  const files=fs.readdirSync(DATA_DIR).filter(n=>/^\d{8}log\.txt$/i.test(n)).map(n=>path.join(DATA_DIR,n));
  const rows=files.flatMap(file=>parseLogFile(file,year));
  if (!rows.length) { console.warn(`${year}: no encontré registros en archivos YYYYMMDDlog.txt dentro de ${DATA_DIR}`); return; }
  const unique=new Map(rows.map(r=>[`${r.fecha} ${r.hora}`,r])); const datos=Array.from(unique.values()).sort((a,b)=>`${a.fecha} ${a.hora}`.localeCompare(`${b.fecha} ${b.hora}`));
  for(let i=0;i<datos.length;i+=3000) {
    const response=await fetch(`${RENDER_URL}/api/cumulus/historial`, { method:'POST', headers:{'Content-Type':'application/json','x-cumulus-token':TOKEN}, body:JSON.stringify({year,datos:datos.slice(i,i+3000)}), signal:AbortSignal.timeout(30000) });
    const body=await response.text(); if(!response.ok) throw new Error(`Render historial HTTP ${response.status}: ${body.slice(0,200)}`);
  }
  console.log(`${year}: ${datos.length} registros históricos enviados a Render.`);
}
async function ciclo() {
  const now=new Date(); const year=now.getFullYear();
  for(let month=1;month<=now.getMonth()+1;month++) try { const total_mm=await leerMes(year,month); await enviarLluvia(year,month,total_mm); console.log(`${year}-${String(month).padStart(2,'0')}: ${total_mm} mm enviado a Render`); } catch(e) { console.error(`Lluvia ${year}-${String(month).padStart(2,'0')}: ${e.message}`); }
  for(const y of HISTORY_YEARS) try { await enviarHistorial(y); } catch(e) { console.error(`Historial ${y}: ${e.message}`); }
}
async function main(){ console.log(`Agente CumulusMX iniciado. Origen: ${CUMULUS_URL} | Destino: ${RENDER_URL} | Datos: ${DATA_DIR} | Años: ${HISTORY_YEARS.join(',')}`); await ciclo(); setInterval(ciclo,INTERVAL_MS); }
main().catch(e=>{console.error(e);process.exit(1);});
