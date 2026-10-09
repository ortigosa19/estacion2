// Agente para el PC donde funciona CumulusMX. Requiere Node.js 18 o superior.
// Variables: RENDER_URL=https://estacion2.onrender.com, CUMULUS_PUSH_TOKEN=el_mismo_token_de_Render
const CUMULUS_URL = (process.env.CUMULUS_URL || 'http://127.0.0.1:8998').replace(/\/+$/, '');
const RENDER_URL = (process.env.RENDER_URL || 'https://estacion2.onrender.com').replace(/\/+$/, '');
const TOKEN = process.env.CUMULUS_PUSH_TOKEN || '';
const INTERVAL_MS = 10 * 60 * 1000;
if (!TOKEN) {
  console.error('Falta CUMULUS_PUSH_TOKEN. Debe coincidir con la variable configurada en Render.');
  process.exit(1);
}
async function leerMes(year, month) {
  const url = `${CUMULUS_URL}/api/tags/process.txt`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Accept': 'text/plain,text/html,*/*' },
    body: `<#MonthRainfall y="${year}" m="${month}">`,
    signal: AbortSignal.timeout(8000)
  });
  const text = (await response.text()).trim();
  if (!response.ok) throw new Error(`CumulusMX HTTP ${response.status}: ${text.slice(0,120)}`);
  const match = text.replace(',', '.').match(/-?\d+(?:\.\d+)?/);
  if (!match) throw new Error(`No se pudo interpretar MonthRainfall: ${text}`);
  const value = Number(match[0]);
  if (!Number.isFinite(value) || value < 0) throw new Error(`Lluvia no válida: ${text}`);
  return Number(value.toFixed(2));
}
async function enviar(year, month, total_mm) {
  const response = await fetch(`${RENDER_URL}/api/cumulus/lluvia`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-cumulus-token': TOKEN },
    body: JSON.stringify({ year, month, total_mm }),
    signal: AbortSignal.timeout(15000)
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Render HTTP ${response.status}: ${body.slice(0,180)}`);
}
async function ciclo() {
  const now = new Date();
  const year = now.getFullYear();
  // Envía todos los meses del año, incluido el mes actual, para que el histórico se complete.
  for (let month = 1; month <= now.getMonth() + 1; month++) {
    try {
      const total_mm = await leerMes(year, month);
      await enviar(year, month, total_mm);
      console.log(`${new Date().toLocaleString('es-ES')} | ${year}-${String(month).padStart(2,'0')}: ${total_mm} mm enviado a Render`);
    } catch (err) {
      console.error(`${year}-${String(month).padStart(2,'0')}: ${err.message}`);
    }
  }
}
async function main() {
  console.log(`Agente CumulusMX iniciado. Origen: ${CUMULUS_URL} | Destino: ${RENDER_URL}`);
  await ciclo();
  setInterval(ciclo, INTERVAL_MS);
}
main().catch(err => { console.error(err); process.exit(1); });
