/**
 * sync-calendar.js
 * 
 * Sincroniza eventos de Google Calendar → Firestore → Mesas
 * Sin necesitar el browser. Corre en GitHub Actions.
 */

const admin = require('firebase-admin');
const https  = require('https');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId:  'ciudadela-portal-88111'
});
const db = admin.firestore();

const GOOGLE_API_KEY = process.env.GOOGLE_CALENDAR_API_KEY || 'AIzaSyDzOx_J54fC6L1-O1hzyeTmg9U4LROB3nk';
const CALENDAR_ID    = 'laciudadeladelosconfines@gmail.com';

const SISTEMAS = {
  'dnd':'D&D 5e (2014)', 'd55':'D&D 5e (2024)', 'pf':'Pathfinder 2e',
  'vam':'Vampiro: La Mascarada', 'hw':'Hombre Lobo: El Apocalipsis',
  'mag':'Mago: La Ascensión', 'hun':'Hunter: The Reckoning', 'oth':'Otro sistema',
};

const SYS_KEYS = {
  'd&d 5e (2014)':'dnd','d&d 5e':'dnd','d&d':'dnd','dnd':'dnd',
  'dungeons and dragons':'dnd','dungeons & dragons':'dnd',
  'd&d 2014':'dnd','dnd 2014':'dnd',
  'd&d 5.5':'d55','d&d5.5':'d55','d&d 5.5e':'d55','dnd 5.5':'d55',
  'd&d 5e (2024)':'d55','dnd 2024':'d55','d&d 2024':'d55',
  'dungeons and dragons 5.5':'d55','one d&d':'d55',
  'pathfinder':'pf','pathfinder 2':'pf','pathfinder 2e':'pf','pf':'pf','pf2e':'pf',
  'pathfinder 2 remastered':'pf','pathfinder remastered':'pf',
  'vampiro':'vam','vampire':'vam','vampiro: la mascarada':'vam','vtm':'vam',
  'hombre lobo':'hw','werewolf':'hw','hombre lobo: el apocalipsis':'hw',
  'mago':'mag','mage':'mag','mago: la ascensión':'mag',
  'hunter':'hun','hunter: the reckoning':'hun',
};

function resolveSys(texto) {
  if (!texto) return null;
  const k = texto.toLowerCase().trim()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const sorted = Object.entries(SYS_KEYS).sort((a,b) => b[0].length - a[0].length);
  for (const [key, val] of sorted) {
    const kn = key.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (k === kn || k.includes(kn)) return val;
  }
  return null;
}

function parseDesc(raw) {
  const out = { sistema:'', dm:'', cupos:'', periodicidad:'', sinopsis:'' };
  if (!raw) return out;
  const text = raw.replace(/<br\s*\/?>/gi,'\n').replace(/<[^>]*>/g,'').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&');
  for (const line of text.split('\n')) {
    const m = line.match(/^(nombre de partida|juego|sistema|modalidad|periodicidad|sinopsis|narra|narrador|dm|director|game master|cupos)\s*:\s*(.+)$/i);
    if (!m) continue;
    const k = m[1].toLowerCase(), v = m[2].trim();
    if (['juego','sistema'].includes(k))                         out.sistema    = v;
    if (['narra','narrador','dm','director','game master'].includes(k)) out.dm = v;
    if (['modalidad','periodicidad'].includes(k))                out.periodicidad = v;
    if (k === 'sinopsis')                                        out.sinopsis   = v;
    if (k === 'cupos')                                           out.cupos      = v;
  }
  return out;
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('JSON parse: ' + data.substring(0,200))); }
      });
    }).on('error', reject);
  });
}

async function fetchGCalMonth(year, month) {
  const tMin = new Date(year, month, 1).toISOString();
  const tMax = new Date(year, month+1, 0, 23, 59, 59).toISOString();
  const url  = 'https://www.googleapis.com/calendar/v3/calendars/'
    + encodeURIComponent(CALENDAR_ID) + '/events'
    + '?key=' + GOOGLE_API_KEY
    + '&timeMin=' + encodeURIComponent(tMin)
    + '&timeMax=' + encodeURIComponent(tMax)
    + '&singleEvents=true&orderBy=startTime&maxResults=250&showDeleted=true';
  const data = await httpGet(url);
  return data.items || [];
}

async function syncEventos(year, month, items) {
  const colId = year + '-' + String(month+1).padStart(2,'0');
  const batch = db.batch();
  let changes = 0;
  for (const item of items) {
    const ref = db.collection('eventos').doc(colId).collection('items').doc(item.id);
    if (item.status === 'cancelled') {
      batch.delete(ref);
    } else {
      const start = new Date(item.start.dateTime || item.start.date);
      const end   = new Date(item.end.dateTime   || item.end.date);
      const dur   = Math.round((end - start) / 60000);
      const p     = parseDesc(item.description || '');
      const sysCode = resolveSys(p.sistema) || resolveSys(item.summary) || 'oth';
      batch.set(ref, {
        id:          item.id,
        title:       item.summary || '(Sin título)',
        dateISO:     start.toISOString(),
        h:           start.getHours(),
        mn:          start.getMinutes(),
        dur,
        sys:         sysCode,
        dm:          p.dm,
        cupos:       p.cupos,
        periodicidad: p.periodicidad,
        sinopsis:    p.sinopsis,
        updatedRaw:  item.updated || '',
        description: item.description || '',
      }, { merge: true });
    }
    changes++;
  }
  if (changes > 0) await batch.commit();
  console.log(`  ${colId}: ${changes} eventos sincronizados`);
  return changes;
}

// ── Sync Mesas (inline) ──────────────────────────────────
const CAMPOS_MINIMOS = ['nombre','sistema','dm','periodicidad','sinopsis'];

function mesaKey(title, dm) {
  return (title||'').toLowerCase().trim().replace(/\s+/g,' ')
    + '||' + (dm||'').toLowerCase().trim();
}

function proximaFecha(fechas) {
  const ahora = new Date();
  return fechas.map(f => new Date(f)).filter(f => f >= ahora)
    .sort((a,b) => a-b)[0]?.toISOString() || null;
}

async function syncMesas() {
  const ahora = new Date();
  const eventos = [];
  for (let i = -1; i < 3; i++) {
    const d = new Date(ahora); d.setMonth(d.getMonth()+i);
    const colId = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
    try {
      const snap = await db.collection('eventos').doc(colId).collection('items').get();
      snap.docs.forEach(doc => eventos.push({ id:doc.id, ...doc.data() }));
    } catch(e) {}
  }

  const grupos = new Map();
  for (const ev of eventos) {
    const nombre = (ev.title||'').trim();
    if (!nombre) continue;
    const dm           = (ev.dm||'').trim();
    const sistema      = SISTEMAS[ev.sys] || 'Otro sistema';
    const periodicidad = (ev.periodicidad||'').trim();
    const sinopsis     = (ev.sinopsis||'').trim();
    const cupos        = (ev.cupos||'').toString().trim();
    const key          = mesaKey(nombre, dm);
    if (!grupos.has(key)) {
      grupos.set(key, { nombre, dm, sistema, periodicidad, sinopsis, cupos, fechas:[], eventosIds:[] });
    }
    const g = grupos.get(key);
    if (dm)           g.dm = dm;
    if (sistema && sistema !== 'Otro sistema') g.sistema = sistema;
    if (periodicidad) g.periodicidad = periodicidad;
    if (sinopsis)     g.sinopsis = sinopsis;
    if (cupos)        g.cupos = cupos;
    if (ev.dateISO)   g.fechas.push(ev.dateISO);
    g.eventosIds.push(ev.id);
  }

  const existentesSnap = await db.collection('mesas').get();
  const existentes = new Map();
  existentesSnap.docs.forEach(d => {
    const k = d.data()._key; if (k) existentes.set(k, d.ref);
  });

  const batch = db.batch();
  let creadas = 0, actualizadas = 0;
  for (const [key, g] of grupos) {
    const faltantes = CAMPOS_MINIMOS.filter(c => !g[c]||g[c].toString().trim()==='');
    const estado    = faltantes.length === 0 ? 'activa' : 'incompleta';
    const proxFecha = proximaFecha(g.fechas);
    const mesaData  = {
      _key: key, nombre: g.nombre, sistema: g.sistema||'',
      dm: g.dm||'', periodicidad: g.periodicidad||'',
      sinopsis: g.sinopsis||'', cupos: g.cupos||'',
      estado, camposFaltantes: faltantes,
      proximaFecha: proxFecha, todasLasFechas: g.fechas.sort(),
      eventosIds: g.eventosIds, creadaDe: 'calendario',
      actualizadaEn: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (existentes.has(key)) {
      batch.update(existentes.get(key), mesaData);
      actualizadas++;
    } else {
      const ref = db.collection('mesas').doc();
      mesaData.creadaEn  = admin.firestore.FieldValue.serverTimestamp();
      mesaData.jugadores = [];
      batch.set(ref, mesaData);
      creadas++;
    }
  }
  await batch.commit();
  console.log(`Mesas: ${creadas} creadas, ${actualizadas} actualizadas`);
}

async function main() {
  console.log('=== sync-calendar.js ===');
  console.log(`Timestamp: ${new Date().toISOString()}`);

  const ahora = new Date();
  let totalEventos = 0;

  // Sincronizar mes anterior, actual y próximo
  for (let i = -1; i <= 1; i++) {
    const d = new Date(ahora); d.setMonth(d.getMonth()+i);
    const y = d.getFullYear(), m = d.getMonth();
    console.log(`\nFetching Google Calendar ${y}-${String(m+1).padStart(2,'0')}...`);
    try {
      const items = await fetchGCalMonth(y, m);
      console.log(`  ${items.length} eventos desde Google Calendar`);
      const changes = await syncEventos(y, m, items);
      totalEventos += changes;
    } catch(e) {
      console.error(`  Error: ${e.message}`);
    }
  }

  console.log(`\nTotal eventos actualizados: ${totalEventos}`);
  console.log('\nSincronizando mesas...');
  await syncMesas();

  console.log('\n=== Sync completo ===');
  process.exit(0);
}

main().catch(e => { console.error('ERROR:', e); process.exit(1); });
