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

// Modalidades que definen el tipo
const TIPO_MESA = ['campaña', 'campaña corta', 'modulo', 'módulo', 'modulo oficial',
  'módulo oficial', 'one-shot', 'one shot', 'oneshot', 'aventura corta', 'mini serie',
  'miniserie', 'mini-serie'];
const TIPO_ACTIVIDAD = ['taller', 'evento', 'ludoteca'];

function detectarTipo(periodicidad) {
  if (!periodicidad) return 'mesa';
  const p = periodicidad.toLowerCase().trim()
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  for (const t of TIPO_ACTIVIDAD) {
    if (p.includes(t)) return 'actividad';
  }
  return 'mesa';
}

function detectarSubtipo(periodicidad) {
  if (!periodicidad) return null;
  const p = periodicidad.toLowerCase().trim()
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  if (p.includes('taller'))    return 'taller';
  if (p.includes('ludoteca'))  return 'ludoteca';
  if (p.includes('evento'))    return 'evento';
  return null;
}


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
  // Reemplazar tags de párrafo y saltos con newlines ANTES de quitar tags
  const text = raw
    .replace(/<\/p>/gi, '\n')
    .replace(/<p[^>]*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
  // Normalizar: punto seguido de mayúscula → salto de línea
  const textNorm = text.replace(/\.\s*([A-ZÁÉÍÓÚÑ])/g, '.\n$1');
  for (const line of textNorm.split('\n')) {
    const m = line.match(/^(nombre de partida|juego|sistema|modalidad|periodicidad|sinopsis|narra|narrador|dm|director|game master|cupos)\s*:\s*(.+)$/i);
    if (!m) continue;
    const k = m[1].toLowerCase(), v = m[2].trim();
    // Ignorar valores placeholder
    const esPlaceholder = /^(\?+|tbd|a confirmar|sin confirmar|por confirmar|-+|n\/a)$/i.test(v.trim());
    if (esPlaceholder) continue;
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

  // Obtener IDs actuales en Firestore para este mes
  const existSnap = await db.collection('eventos').doc(colId).collection('items').get();
  const existIds  = new Set(existSnap.docs.map(d => d.id));

  // IDs que vienen de Google Calendar (activos)
  const gcalIds = new Set(items.filter(i => i.status !== 'cancelled').map(i => i.id));

  // Eliminar los que ya no están en Google Calendar
  const batch = db.batch();
  let eliminados = 0;
  for (const id of existIds) {
    if (!gcalIds.has(id)) {
      batch.delete(db.collection('eventos').doc(colId).collection('items').doc(id));
      eliminados++;
    }
  }

  let changes = eliminados;
  for (const item of items) {
    const ref = db.collection('eventos').doc(colId).collection('items').doc(item.id);
    if (item.status === 'cancelled') {
      batch.delete(ref);
      changes++;
    } else {
      const start = new Date(item.start.dateTime || item.start.date);
      const end   = new Date(item.end.dateTime   || item.end.date);
      const dur   = Math.round((end - start) / 60000);
      const p     = parseDesc(item.description || '');
      const sysCode = resolveSys(p.sistema) || resolveSys(item.summary) || 'oth';
      const tipo = detectarTipo(p.periodicidad);
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
        tipo:        tipo,
      }, { merge: true });
    }
    changes++;
  }
  if (changes > 0) await batch.commit();
  console.log(`  ${colId}: ${gcalIds.size} eventos de GCal, ${eliminados} eliminados de Firestore`);
  return changes;
}

// ── Sync Mesas (inline) ──────────────────────────────────
const CAMPOS_MINIMOS = ['nombre','sistema','dm','periodicidad','sinopsis'];

function normalizeKey(s) {
  return (s||'').toLowerCase().trim()
    .replace(/\.$/, '')      // quitar punto final
    .replace(/\s+/g, ' ')    // normalizar espacios
    .trim();
}

function mesaKey(title, dm) {
  const t = normalizeKey(title);
  const d = normalizeKey(dm);
  return d ? `${t}||${d}` : t;
}

function proximaFecha(fechas) {
  const ahora = new Date();
  return fechas.map(f => new Date(f)).filter(f => f >= ahora)
    .sort((a,b) => a-b)[0]?.toISOString() || null;
}

async function syncMesas() {
  const ahora = new Date();
  const eventos = [];
  for (let i = -1; i <= 4; i++) {
    const d = new Date(ahora); d.setMonth(d.getMonth()+i);
    const colId = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
    try {
      const snap = await db.collection('eventos').doc(colId).collection('items').get();
      snap.docs.forEach(doc => eventos.push({ id:doc.id, ...doc.data() }));
    } catch(e) {}
  }

  // Separar en grupos por tipo
  const gruposMesas = new Map();
  const gruposActividades = new Map();

  for (const ev of eventos) {
    const nombre = (ev.title||'').trim();
    if (!nombre) continue;
    const dm           = (ev.dm||'').trim();
    const sistema      = SISTEMAS[ev.sys] || 'Otro sistema';
    const periodicidad = (ev.periodicidad||'').trim();
    const sinopsis     = (ev.sinopsis||'').trim();
    const cupos        = (ev.cupos||'').toString().trim();
    const tipo         = detectarTipo(periodicidad);
    const subtipo      = detectarSubtipo(periodicidad);
    const key          = mesaKey(nombre, dm);

    const grupos = tipo === 'actividad' ? gruposActividades : gruposMesas;
    if (!grupos.has(key)) {
      grupos.set(key, { nombre, dm, sistema, periodicidad, sinopsis, cupos,
        tipo, subtipo, fechas:[], eventosIds:[] });
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

  // Sync mesas
  const existMesasSnap = await db.collection('mesas').get();
  const existMesas = new Map();      // key → ref
  const existMesasData = new Map();  // key → data completa
  existMesasSnap.docs.forEach(d => {
    const k = d.data()._key;
    if (k) {
      existMesas.set(k, d.ref);
      existMesasData.set(k, d.data());
    }
  });

  const batchMesas = db.batch();
  let mesasCreadas = 0, mesasActualizadas = 0;
  for (const [key, g] of gruposMesas) {
    const faltantes = CAMPOS_MINIMOS.filter(c => !g[c]||g[c].toString().trim()==='');
    const estado    = faltantes.length === 0 ? 'activa' : 'incompleta';
    const proxFecha = proximaFecha(g.fechas);
    const data = {
      _key: key, nombre: g.nombre.replace(/\.$/, '').trim(), sistema: g.sistema||'',
      dm: (g.dm||'').replace(/\.$/, '').trim(), periodicidad: g.periodicidad||'',
      sinopsis: g.sinopsis||'', cupos: g.cupos||'',
      estado, camposFaltantes: faltantes,
      proximaFecha: proxFecha, todasLasFechas: g.fechas.sort(),
      eventosIds: g.eventosIds, creadaDe: 'calendario',
      actualizadaEn: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (existMesas.has(key)) {
      batchMesas.update(existMesas.get(key), data);
      mesasActualizadas++;
    } else {
      const ref = db.collection('mesas').doc();
      data.creadaEn = admin.firestore.FieldValue.serverTimestamp();
      data.jugadores = [];
      batchMesas.set(ref, data);
      mesasCreadas++;
    }
  }
  await batchMesas.commit();
  console.log(`Mesas: ${mesasCreadas} creadas, ${mesasActualizadas} actualizadas`);

  // Detectar mesas que ya no tienen eventos en el calendario
  let desactualizadas = 0, eliminadasSinJug = 0;
  const keysActivas = new Set(gruposMesas.keys());
  const batchObsoletas = db.batch();
  for (const [key, ref] of existMesas) {
    if (!keysActivas.has(key)) {
      const data = existMesasData.get(key);
      const tieneJugadores = (data.jugadores||[]).length > 0;
      if (tieneJugadores) {
        // Conservar pero marcar como desactualizada
        batchObsoletas.update(ref, {
          estado: 'desactualizada',
          proximaFecha: null,
          todasLasFechas: [],
          eventosIds: [],
          actualizadaEn: admin.firestore.FieldValue.serverTimestamp(),
        });
        console.log(`  ⚠ Desactualizada (tiene jugadores): "${data.nombre}"`);
        desactualizadas++;
      } else {
        // Sin jugadores → eliminar
        batchObsoletas.delete(ref);
        console.log(`  ✗ Eliminada (sin jugadores): "${data.nombre}"`);
        eliminadasSinJug++;
      }
    }
  }
  if (desactualizadas + eliminadasSinJug > 0) await batchObsoletas.commit();
  console.log(`Mesas obsoletas: ${desactualizadas} desactualizadas, ${eliminadasSinJug} eliminadas`);

  // Sync actividades
  const existActSnap = await db.collection('actividades').get();
  const existAct = new Map();
  existActSnap.docs.forEach(d => { const k=d.data()._key; if(k) existAct.set(k,d.ref); });

  const batchAct = db.batch();
  let actCreadas = 0, actActualizadas = 0;
  for (const [key, g] of gruposActividades) {
    const proxFecha = proximaFecha(g.fechas);
    const data = {
      _key: key, nombre: g.nombre, tipo: g.subtipo || g.tipo,
      dm: g.dm||'', periodicidad: g.periodicidad||'',
      sinopsis: g.sinopsis||'', cupos: g.cupos||'',
      costo: '', estado: 'activa',
      proximaFecha: proxFecha, todasLasFechas: g.fechas.sort(),
      eventosIds: g.eventosIds, creadaDe: 'calendario',
      actualizadaEn: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (existAct.has(key)) {
      batchAct.update(existAct.get(key), data);
      actActualizadas++;
    } else {
      const ref = db.collection('actividades').doc();
      data.creadaEn = admin.firestore.FieldValue.serverTimestamp();
      data.inscriptos = [];
      batchAct.set(ref, data);
      actCreadas++;
    }
  }
  await batchAct.commit();
  console.log(`Actividades: ${actCreadas} creadas, ${actActualizadas} actualizadas`);
}

async function main() {
  console.log('=== sync-calendar.js ===');
  console.log(`Timestamp: ${new Date().toISOString()}`);

  const ahora = new Date();
  let totalEventos = 0;

  // Sincronizar mes anterior, actual y 4 meses adelante
  for (let i = -1; i <= 4; i++) {
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

  // Limpiar meses fuera del rango sincronizado (más de 1 mes atrás o más de 4 adelante)
  console.log('\nLimpiando meses fuera del rango...');
  const mesesSnap = await db.collection('eventos').get();
  const ahora2    = new Date();
  const minMes    = new Date(ahora2); minMes.setMonth(minMes.getMonth() - 1);
  const maxMes    = new Date(ahora2); maxMes.setMonth(maxMes.getMonth() + 4);
  const minKey    = `${minMes.getFullYear()}-${String(minMes.getMonth()+1).padStart(2,'0')}`;
  const maxKey    = `${maxMes.getFullYear()}-${String(maxMes.getMonth()+1).padStart(2,'0')}`;
  let mesesEliminados = 0;
  for (const mesDoc of mesesSnap.docs) {
    const mesId = mesDoc.id;
    if (mesId < minKey || mesId > maxKey) {
      // Eliminar todos los items de este mes
      const itemsSnap = await db.collection('eventos').doc(mesId).collection('items').get();
      if (!itemsSnap.empty) {
        const batchViejo = db.batch();
        itemsSnap.docs.forEach(d => batchViejo.delete(d.ref));
        await batchViejo.commit();
        console.log(`  Limpiado mes fuera de rango: ${mesId} (${itemsSnap.size} eventos)`);
        mesesEliminados += itemsSnap.size;
      }
    }
  }
  if (mesesEliminados === 0) console.log('  Sin meses fuera de rango');

  console.log('\nSincronizando mesas...');
  await syncMesas();

  console.log('\n=== Sync completo ===');
  process.exit(0);
}

main().catch(e => { console.error('ERROR:', e); process.exit(1); });
