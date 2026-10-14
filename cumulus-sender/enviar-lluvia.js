// Agente CumulusMX -> Render: lluvia mensual + historial meteorológico anual.
// Node.js 18+. Variables: CUMULUS_PUSH_TOKEN, RENDER_URL, CUMULUS_DATA_DIR, HISTORY_YEARS.
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
  const body = (await response.text()).trim();
  if (!response.ok) throw new Error(`CumulusMX HTTP ${response.status}: ${body.slice(0,120)}`);
  const match = body.replace(',', '.').match(/-?\d+(?:\.\d+)?/);
  if (!match) throw new Error(`No se pudo interpretar MonthRainfall: ${body}`);
  const value = Number(match[0]);
  if (!Number.isFinite(value) || value < 0) throw new Error(`Lluvia no válida: ${body}`);
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
function num(value) { if (value === undefined || value === null || String(value).trim() === '') return null; const n=Number(String(value).trim().replace(',', '.')); return Number.isFinite(n) ? n : null; }
function dateIso(value) {
  const s=String(value||'').trim();
  let m=s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/); if(m) return `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
  m=s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/); if(m) { let y=Number(m[3]); if(y<100)y+=2000; return `${y}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`; }
  return null;
}
// CumulusMX en esta instalación guarda cada muestra en DOS líneas: fecha y, debajo, hora,timestamp,temp,humedad,rocío,viento,...
function parseMonthlyLog(file, year) {
  const base=path.basename(file); const fm=base.match(/^(\d{4})(\d{2})log\.txt$/i); if(!fm) return [];
  if(Number(fm[1])!==year) return [];
  const lines=fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'').split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  const result=[]; let currentDate=null;
  for(const line of lines) {
    const parsedDate=dateIso(line);
    if(parsedDate) { currentDate=parsedDate; continue; }
    if(!currentDate || !currentDate.startsWith(`${year}-`)) continue;
    const c=csv(line); if(c.length<8) continue;
    const hora=(c[0]||'').trim(); if(!/^\d{1,2}:\d{2}(?::\d{2})?$/.test(hora)) continue;
    // Formato observado: hora, timestamp Unix, temperatura, humedad, punto rocío,
    // velocidad viento, rumbo, racha, rumbo racha, tasa lluvia, lluvia hoy, presión...
    const hh=hora.length===5?`${hora}:00`:hora.padStart(8,'0');
    result.push({ fecha:currentDate, hora:hh, temperatura:num(c[2]), humedad:num(c[3]), viento:num(c[5]), racha:num(c[7]), lluvia:num(c[10]), presion:num(c[11]) });
  }
  return result;
}
async function enviarHistorial(year) {
  if (!fs.existsSync(DATA_DIR)) throw new Error(`No encuentro ${DATA_DIR}. Comprueba CUMULUS_DATA_DIR.`);
  const files=fs.readdirSync(DATA_DIR).filter(n=>/^\d{6}log\.txt$/i.test(n)).map(n=>path.join(DATA_DIR,n));
  const rows=files.flatMap(file=>parseMonthlyLog(file,year));
  if (!rows.length) { console.warn(`${year}: no encontré muestras en archivos YYYYMMlog.txt dentro de ${DATA_DIR}`); return; }
  const unique=new Map(rows.map(r=>[`${r.fecha} ${r.hora}`,r]));
  const datos=Array.from(unique.values()).sort((a,b)=>`${a.fecha} ${a.hora}`.localeCompare(`${b.fecha} ${b.hora}`));
  for(let i=0;i<datos.length;i+=3000) {
    const response=await fetch(`${RENDER_URL}/api/cumulus/historial`, { method:'POST', headers:{'Content-Type':'application/json','x-cumulus-token':TOKEN}, body:JSON.stringify({year,datos:datos.slice(i,i+3000)}), signal:AbortSignal.timeout(30000) });
    const body=await response.text(); if(!response.ok) throw new Error(`Render historial HTTP ${response.status}: ${body.slice(0,220)}`);
    let info={}; try{info=JSON.parse(body)}catch{}
    console.log(`Historial ${year}: lote enviado (${info.recibidos ?? Math.min(3000,datos.length-i)} registros; total servidor ${info.total ?? 'pendiente'}).`);
  }
  console.log(`${year}: ${datos.length} registros leídos de CumulusMX y enviados a Render.`);
}
async function ciclo() {
  const now=new Date(); const year=now.getFullYear();
  for(let month=1;month<=now.getMonth()+1;month++) try { const total_mm=await leerMes(year,month); await enviarLluvia(year,month,total_mm); console.log(`${year}-${String(month).padStart(2,'0')}: ${total_mm} mm enviado a Render`); } catch(e) { console.error(`Lluvia ${year}-${String(month).padStart(2,'0')}: ${e.message}`); }
  for(const y of HISTORY_YEARS) try { await enviarHistorial(y); } catch(e) { console.error(`Historial ${y}: ${e.message}`); }
}
async function main(){ console.log(`Agente CumulusMX iniciado. Origen: ${CUMULUS_URL} | Destino: ${RENDER_URL} | Datos: ${DATA_DIR} | Años: ${HISTORY_YEARS.join(',')}`); await ciclo(); setInterval(ciclo,INTERVAL_MS); }
main().catch(e=>{console.error(e);process.exit(1);});
