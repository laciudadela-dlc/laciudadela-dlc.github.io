/**
 * sync-mesas.js
 * 
 * Corre en GitHub Actions (cron diario).
 * Lee eventos de Firestore, deduplica por nombre+DM,
 * crea/actualiza colección `mesas/` y envía notificaciones
 * de asistencia pendiente a jugadores.
 * 
 * Deps: firebase-admin (npm install firebase-admin)
 */

const admin = require('firebase-admin');

// ── Auth via Service Account (GitHub Secret) ──────────────
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: 'ciudadela-portal-88111'
});
const db = admin.firestore();

// ── Campos mínimos para que una mesa sea "activa" ──────────
const CAMPOS_MINIMOS = ['nombre', 'sistema', 'dm', 'periodicidad', 'sinopsis'];

// ── Sistemas conocidos ─────────────────────────────────────
const SISTEMAS = {
  'D&D 5e': 'dnd5e',
  'D&D 5.5e': 'dnd55e',
  'Pathfinder 2e': 'pf2e',
  'Vampiro': 'vtm',
  'Hombre Lobo': 'hombre-lobo',
  'Mago': 'mago',
  'Hunter': 'hunter',
  'Otro sistema': 'otro',
};

// ── Helpers ────────────────────────────────────────────────
function normalizeSistema(str) {
  if (!str) return '';
  const s = str.trim();
  for (const [nombre] of Object.entries(SISTEMAS)) {
    if (s.toLowerCase().includes(nombre.toLowerCase())) return nombre;
  }
  return s;
}

function parsearDescripcion(desc) {
  if (!desc) return {};
  const out = {};
  const lines = desc.split('\n');
  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const val = line.slice(idx + 1).trim();
    out[key] = val;
  }
  return out;
}

function extraerDatos(evento) {
  const campos = parsearDescripcion(evento.description || '');
  return {
    nombre:       evento.summary?.split('—')[0]?.trim() || evento.summary || '',
    sistema:      normalizeSistema(campos['sistema'] || campos['juego'] || evento.summary?.split('—')[1]?.trim() || ''),
    dm:           campos['dm'] || campos['narrador'] || campos['director'] || '',
    periodicidad: campos['periodicidad'] || campos['modalidad'] || '',
    sinopsis:     campos['sinopsis'] || campos['descripcion'] || campos['descripción'] || '',
    cupos:        campos['cupos'] || '',
  };
}

function mesaKey(datos) {
  // Clave de deduplicación: nombre normalizado + dm normalizado
  const nombre = (datos.nombre || '').toLowerCase().trim().replace(/\s+/g, ' ');
  const dm = (datos.dm || '').toLowerCase().trim();
  return `${nombre}||${dm}`;
}

function camposFaltantes(datos) {
  return CAMPOS_MINIMOS.filter(c => !datos[c] || datos[c].trim() === '');
}

function proximaFecha(fechas) {
  const ahora = new Date();
  const futuras = fechas
    .map(f => new Date(f))
    .filter(f => f >= ahora)
    .sort((a, b) => a - b);
  return futuras.length > 0 ? futuras[0].toISOString() : null;
}

// ── Leer todos los eventos de Firestore desde hoy ──────────
async function leerEventos() {
  const ahora = new Date();
  const eventos = [];

  // Leer los próximos 3 meses
  for (let i = 0; i < 3; i++) {
    const d = new Date(ahora);
    d.setMonth(d.getMonth() + i);
    const colId = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

    try {
      const snap = await db.collection('eventos').doc(colId).collection('items').get();
      snap.docs.forEach(doc => {
        const data = doc.data();
        eventos.push({ id: doc.id, ...data });
      });
    } catch (e) {
      console.log(`Sin eventos para ${colId}: ${e.message}`);
    }
  }

  console.log(`Total eventos leídos: ${eventos.length}`);
  return eventos;
}

// ── Sincronizar mesas ──────────────────────────────────────
async function syncMesas(eventos) {
  // Agrupar eventos por clave nombre+DM
  const grupos = new Map();

  for (const ev of eventos) {
    const datos = extraerDatos(ev);
    if (!datos.nombre) continue;

    const key = mesaKey(datos);
    if (!grupos.has(key)) {
      grupos.set(key, { datos, fechas: [], eventosIds: [] });
    }
    const grupo = grupos.get(key);
    // Actualizar datos con el evento más reciente (puede tener más info)
    if (datos.sinopsis && !grupo.datos.sinopsis) grupo.datos.sinopsis = datos.sinopsis;
    if (datos.dm && !grupo.datos.dm) grupo.datos.dm = datos.dm;
    if (datos.sistema && !grupo.datos.sistema) grupo.datos.sistema = datos.sistema;
    if (datos.periodicidad && !grupo.datos.periodicidad) grupo.datos.periodicidad = datos.periodicidad;

    // Agregar fecha del evento
    const fechaInicio = ev.start?.dateTime || ev.start?.date;
    if (fechaInicio) grupo.fechas.push(fechaInicio);
    grupo.eventosIds.push(ev.id);
  }

  console.log(`Grupos de mesas detectados: ${grupos.size}`);

  const batch = db.batch();
  let creadas = 0, actualizadas = 0;

  for (const [key, grupo] of grupos) {
    const { datos, fechas, eventosIds } = grupo;
    const faltantes = camposFaltantes(datos);
    const estado = faltantes.length === 0 ? 'activa' : 'incompleta';
    const proxFecha = proximaFecha(fechas);

    // Buscar si ya existe esta mesa
    const existingSnap = await db.collection('mesas')
      .where('_key', '==', key)
      .limit(1)
      .get();

    const mesaData = {
      _key:          key,
      nombre:        datos.nombre,
      sistema:       datos.sistema || '',
      dm:            datos.dm || '',
      periodicidad:  datos.periodicidad || '',
      sinopsis:      datos.sinopsis || '',
      cupos:         datos.cupos || '',
      estado,
      camposFaltantes: faltantes,
      proximaFecha:  proxFecha,
      todasLasFechas: fechas.sort(),
      eventosIds,
      creadaDe:      'calendario',
      actualizadaEn: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (existingSnap.empty) {
      const ref = db.collection('mesas').doc();
      mesaData.creadaEn = admin.firestore.FieldValue.serverTimestamp();
      mesaData.jugadores = [];
      batch.set(ref, mesaData);
      creadas++;
    } else {
      const ref = existingSnap.docs[0].ref;
      // No sobreescribir jugadores ni creadaEn
      delete mesaData.jugadores;
      delete mesaData.creadaEn;
      batch.update(ref, mesaData);
      actualizadas++;
    }
  }

  await batch.commit();
  console.log(`Mesas creadas: ${creadas}, actualizadas: ${actualizadas}`);
  return { creadas, actualizadas, total: grupos.size };
}

// ── Notificaciones de asistencia pendiente ─────────────────
async function enviarNotificacionesAsistencia() {
  const ahora = new Date();
  const en7dias = new Date(ahora);
  en7dias.setDate(en7dias.getDate() + 7);

  // Buscar mesas activas con próxima fecha en los próximos 7 días
  const mesasSnap = await db.collection('mesas')
    .where('estado', '==', 'activa')
    .get();

  let notifEnviadas = 0;

  for (const mesaDoc of mesasSnap.docs) {
    const mesa = mesaDoc.data();
    if (!mesa.proximaFecha) continue;

    const proxFecha = new Date(mesa.proximaFecha);
    if (proxFecha < ahora || proxFecha > en7dias) continue;

    // Buscar jugadores de esta mesa con estado "pendiente"
    const jugadores = mesa.jugadores || [];
    for (const jugador of jugadores) {
      if (jugador.estado !== 'pendiente') continue;

      // Verificar si ya se envió notif hoy para esta mesa+sesión
      const hoy = ahora.toISOString().slice(0, 10);
      const notifKey = `asistencia_${mesaDoc.id}_${hoy}`;

      const notifExistente = await db
        .collection('notificaciones')
        .doc(jugador.uid)
        .collection('items')
        .where('notifKey', '==', notifKey)
        .limit(1)
        .get();

      if (!notifExistente.empty) continue; // Ya enviada hoy

      // Enviar notificación
      const fechaFormateada = proxFecha.toLocaleDateString('es-AR', {
        weekday: 'long', day: 'numeric', month: 'long'
      });

      await db
        .collection('notificaciones')
        .doc(jugador.uid)
        .collection('items')
        .add({
          tipo:       'confirmar_asistencia',
          titulo:     `¿Vas a la mesa del ${fechaFormateada}?`,
          cuerpo:     `Confirmá tu asistencia a "${mesa.nombre}" con ${mesa.dm}.`,
          mesaId:     mesaDoc.id,
          mesaNombre: mesa.nombre,
          proxFecha:  mesa.proximaFecha,
          notifKey,
          leida:      false,
          creadoEn:   admin.firestore.FieldValue.serverTimestamp(),
        });

      notifEnviadas++;
    }
  }

  console.log(`Notificaciones de asistencia enviadas: ${notifEnviadas}`);
  return notifEnviadas;
}

// ── Main ───────────────────────────────────────────────────
async function main() {
  console.log('=== sync-mesas.js iniciado ===');
  console.log(`Timestamp: ${new Date().toISOString()}`);

  try {
    const eventos = await leerEventos();
    const resultado = await syncMesas(eventos);
    const notifs = await enviarNotificacionesAsistencia();

    console.log('=== Resultado final ===');
    console.log(JSON.stringify({ ...resultado, notificaciones: notifs }, null, 2));
    process.exit(0);
  } catch (e) {
    console.error('ERROR:', e);
    process.exit(1);
  }
}

main();
