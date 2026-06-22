/**
 * sync-mesas.js
 * Lee eventos de Firestore (estructura del calendario de La Ciudadela),
 * deduplica por title+dm, crea/actualiza colección `mesas/`.
 */

const admin = require('firebase-admin');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId:  'ciudadela-portal-88111'
});
const db = admin.firestore();

const CAMPOS_MINIMOS = ['nombre', 'sistema', 'dm', 'periodicidad', 'sinopsis'];

// Mapa completo de códigos → nombres legibles
const SISTEMAS = {
  'dnd':     'D&D 5e (2014)',
  'd55':     'D&D 5e (2024)',
  'pf':      'Pathfinder 2e',
  'vam':     'Vampiro: La Mascarada',
  'hw':      'Hombre Lobo: El Apocalipsis',
  'mag':     'Mago: La Ascensión',
  'hun':     'Hunter: The Reckoning',
  'oth':     'Otro sistema',
  // Códigos alternativos
  'dnd5e':   'D&D 5e (2014)',
  'dnd55e':  'D&D 5e (2024)',
  'pf2e':    'Pathfinder 2e',
  'vtm':     'Vampiro: La Mascarada',
  'wta':     'Hombre Lobo: El Apocalipsis',
  'mta':     'Mago: La Ascensión',
};

function nombreSistema(cod) {
  return SISTEMAS[cod] || cod || '';
}

function mesaKey(title, dm) {
  const t = (title || '').toLowerCase().trim().replace(/\s+/g, ' ');
  const d = (dm || '').toLowerCase().trim();
  return `${t}||${d}`;
}

function camposFaltantes(datos) {
  return CAMPOS_MINIMOS.filter(c => !datos[c] || datos[c].toString().trim() === '');
}

function proximaFecha(fechas) {
  const ahora = new Date();
  const futuras = fechas.map(f => new Date(f)).filter(f => f >= ahora).sort((a,b) => a-b);
  return futuras.length > 0 ? futuras[0].toISOString() : null;
}

async function leerEventos() {
  const ahora = new Date();
  const eventos = [];
  for (let i = -1; i < 3; i++) {
    const d = new Date(ahora);
    d.setMonth(d.getMonth() + i);
    const colId = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
    try {
      const snap = await db.collection('eventos').doc(colId).collection('items').get();
      snap.docs.forEach(doc => { eventos.push({ id: doc.id, ...doc.data() }); });
      console.log(`  ${colId}: ${snap.size} eventos`);
    } catch(e) { console.log(`  ${colId}: sin eventos`); }
  }
  console.log(`Total eventos leídos: ${eventos.length}`);
  return eventos;
}

async function syncMesas(eventos) {
  const grupos = new Map();
  for (const ev of eventos) {
    const nombre = (ev.title || '').trim();
    if (!nombre) continue;
    const dm           = (ev.dm || '').trim();
    const sistema      = nombreSistema(ev.sys);
    const periodicidad = (ev.periodicidad || '').trim();
    const sinopsis     = (ev.sinopsis || '').trim();
    const cupos        = (ev.cupos || '').toString().trim();
    const dateISO      = ev.dateISO || '';
    const key          = mesaKey(nombre, dm);
    if (!grupos.has(key)) {
      grupos.set(key, { nombre, dm, sistema, periodicidad, sinopsis, cupos, fechas:[], eventosIds:[] });
    }
    const g = grupos.get(key);
    if (!g.dm && dm)               g.dm = dm;
    if (!g.sistema && sistema)     g.sistema = sistema;
    if (!g.periodicidad && periodicidad) g.periodicidad = periodicidad;
    if (!g.sinopsis && sinopsis)   g.sinopsis = sinopsis;
    if (!g.cupos && cupos)         g.cupos = cupos;
    if (dateISO) g.fechas.push(dateISO);
    g.eventosIds.push(ev.id);
  }
  console.log(`Grupos de mesas detectados: ${grupos.size}`);

  const existentesSnap = await db.collection('mesas').get();
  const existentes = new Map();
  existentesSnap.docs.forEach(d => { const k = d.data()._key; if (k) existentes.set(k, d.ref); });

  const batch = db.batch();
  let creadas = 0, actualizadas = 0;

  for (const [key, g] of grupos) {
    const faltantes = camposFaltantes(g);
    const estado    = faltantes.length === 0 ? 'activa' : 'incompleta';
    const proxFecha = proximaFecha(g.fechas);
    const mesaData  = {
      _key: key, nombre: g.nombre, sistema: g.sistema || '',
      dm: g.dm || '', periodicidad: g.periodicidad || '',
      sinopsis: g.sinopsis || '', cupos: g.cupos || '',
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
  console.log(`Mesas creadas: ${creadas}, actualizadas: ${actualizadas}`);
  return { creadas, actualizadas, total: grupos.size };
}

async function enviarNotificacionesAsistencia() {
  const ahora  = new Date();
  const en7dias = new Date(ahora);
  en7dias.setDate(en7dias.getDate() + 7);
  const mesasSnap = await db.collection('mesas').where('estado','==','activa').get();
  let notifEnviadas = 0;
  for (const mesaDoc of mesasSnap.docs) {
    const mesa = mesaDoc.data();
    if (!mesa.proximaFecha) continue;
    const proxFecha = new Date(mesa.proximaFecha);
    if (proxFecha < ahora || proxFecha > en7dias) continue;
    for (const jugador of (mesa.jugadores || [])) {
      if (jugador.estado !== 'pendiente') continue;
      const hoy      = ahora.toISOString().slice(0,10);
      const notifKey = `asistencia_${mesaDoc.id}_${hoy}`;
      const existente = await db.collection('notificaciones').doc(jugador.uid)
        .collection('items').where('notifKey','==',notifKey).limit(1).get();
      if (!existente.empty) continue;
      const fechaStr = proxFecha.toLocaleDateString('es-AR',
        { weekday:'long', day:'numeric', month:'long' });
      await db.collection('notificaciones').doc(jugador.uid).collection('items').add({
        tipo: 'confirmar_asistencia',
        titulo: `¿Vas a la mesa del ${fechaStr}?`,
        cuerpo: `Confirmá tu asistencia a "${mesa.nombre}" con ${mesa.dm}.`,
        mesaId: mesaDoc.id, mesaNombre: mesa.nombre,
        proxFecha: mesa.proximaFecha, notifKey, leida: false,
        creadoEn: admin.firestore.FieldValue.serverTimestamp(),
      });
      notifEnviadas++;
    }
  }
  console.log(`Notificaciones de asistencia enviadas: ${notifEnviadas}`);
  return notifEnviadas;
}

async function main() {
  console.log('=== sync-mesas.js iniciado ===');
  console.log(`Timestamp: ${new Date().toISOString()}`);
  try {
    const eventos   = await leerEventos();
    const resultado = await syncMesas(eventos);
    const notifs    = await enviarNotificacionesAsistencia();
    console.log('=== Resultado final ===');
    console.log(JSON.stringify({ ...resultado, notificaciones: notifs }, null, 2));
    process.exit(0);
  } catch(e) {
    console.error('ERROR:', e);
    process.exit(1);
  }
}

main();
