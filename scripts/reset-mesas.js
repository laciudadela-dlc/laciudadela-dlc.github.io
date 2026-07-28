/**
 * reset-mesas.js
 * Sincroniza mesas y actividades desde los eventos futuros del calendario.
 * A diferencia de versiones anteriores, NO borra y recrea los documentos:
 * hace upsert por _key, así se conservan campos custom (ej. imágenes subidas
 * a mano) y solo se eliminan/marcan-desactualizadas las mesas/actividades
 * que ya no tienen eventos vigentes en el calendario.
 * 1. Lee eventos de Firestore desde HOY en adelante (4 meses)
 * 2. Upsert de mesas y actividades por _key (título + DM normalizados)
 * 3. Marca como "desactualizada" (o elimina si no tiene jugadores/inscriptos)
 *    las mesas/actividades que ya no aparecen en el calendario
 */

const admin = require('firebase-admin');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId:  'ciudadela-portal-88111'
});
const db = admin.firestore();

const SISTEMAS = {
  'dnd':'D&D 5e (2014)', 'd55':'D&D 5e (2024)', 'pf':'Pathfinder 2e',
  'vam':'Vampiro: La Mascarada', 'hw':'Hombre Lobo: El Apocalipsis',
  'mag':'Mago: La Ascensión', 'hun':'Hunter: The Reckoning', 'oth':'Otro sistema',
};

const CAMPOS_MINIMOS = ['nombre','sistema','dm','periodicidad','sinopsis'];
const CAMPOS_MINIMOS_ACT = ['nombre','dm','sinopsis'];
const TIPO_ACTIVIDAD = ['taller', 'evento', 'ludoteca'];

function detectarTipo(periodicidad) {
  if (!periodicidad) return 'mesa';
  const p = periodicidad.toLowerCase().trim().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  for (const t of TIPO_ACTIVIDAD) { if (p.includes(t)) return 'actividad'; }
  return 'mesa';
}

function detectarSubtipo(periodicidad) {
  if (!periodicidad) return null;
  const p = periodicidad.toLowerCase().trim().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  if (p.includes('taller'))   return 'taller';
  if (p.includes('ludoteca')) return 'ludoteca';
  if (p.includes('evento'))   return 'evento';
  return null;
}

function normalizeKey(s) {
  return (s||'')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // sin acentos (evita duplicar por tildes)
    .trim()
    .replace(/\s*\([^)]*\)\s*$/, '')  // quitar anotaciones finales entre paréntesis, ej: "(@proteus100)"
    .replace(/[.\s]+$/, '')          // quitar puntos/espacios sueltos al final, ej: "Armin."
    .replace(/\s+/g, ' ')
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

async function leerEventosFuturos() {
  const ahora = new Date();
  const eventos = [];
  for (let i = 0; i <= 3; i++) {
    const d = new Date(ahora);
    d.setMonth(d.getMonth() + i);
    const colId = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
    try {
      const snap = await db.collection('eventos').doc(colId).collection('items').get();
      let count = 0;
      snap.docs.forEach(doc => {
        const ev = { id: doc.id, ...doc.data() };
        if (ev.dateISO && new Date(ev.dateISO) >= ahora) { eventos.push(ev); count++; }
      });
      console.log(`  ${colId}: ${count} eventos futuros`);
    } catch(e) { console.log(`  ${colId}: error - ${e.message}`); }
  }
  return eventos;
}

async function crearDesdeEventos(eventos) {
  const gruposMesas = new Map();
  const gruposAct   = new Map();

  for (const ev of eventos) {
    const nombre      = (ev.title||'').trim();
    if (!nombre) continue;
    const dm          = (ev.dm||'').trim();
    const sistema     = SISTEMAS[ev.sys] || 'Otro sistema';
    const periodicidad= (ev.periodicidad||'').split('.')[0].trim(); // tomar solo hasta el primer punto
    const sinopsis    = (ev.sinopsis||'').trim();
    const cupos       = (ev.cupos||'').toString().trim();
    const tipo        = detectarTipo(periodicidad);
    const subtipo     = detectarSubtipo(periodicidad);
    const key         = mesaKey(nombre, dm);

    const grupos = tipo === 'actividad' ? gruposAct : gruposMesas;
    if (!grupos.has(key)) {
      grupos.set(key, { nombre, dm, sistema, periodicidad, sinopsis, cupos, tipo, subtipo, fechas:[], eventosIds:[] });
    }
    const g = grupos.get(key);
    if (dm)            g.dm           = dm;
    if (sistema && sistema !== 'Otro sistema') g.sistema = sistema;
    if (periodicidad)  g.periodicidad = periodicidad;
    if (sinopsis)      g.sinopsis     = sinopsis;
    if (cupos)         g.cupos        = cupos;
    if (ev.dateISO)    g.fechas.push(ev.dateISO);
    g.eventosIds.push(ev.id);
  }

  console.log(`\nGrupos: ${gruposMesas.size} mesas, ${gruposAct.size} actividades`);

  // ── Mesas: upsert (nunca borra+recrea, así se conservan campos custom como imágenes) ──
  const existMesasSnap = await db.collection('mesas').get();
  const existMesas = new Map();
  existMesasSnap.docs.forEach(d => { const k=d.data()._key; if(k) existMesas.set(k, d); });

  let mesasCreadas = 0, mesasActualizadas = 0;
  const batchMesas = db.batch();
  for (const [key, g] of gruposMesas) {
    const faltantes = CAMPOS_MINIMOS.filter(c => !g[c] || g[c].toString().trim() === '');
    const estado    = faltantes.length === 0 ? 'activa' : 'incompleta';
    const mesaData  = {
      _key: key, nombre: g.nombre, sistema: g.sistema||'',
      dm: g.dm||'', periodicidad: g.periodicidad||'',
      sinopsis: g.sinopsis||'', cupos: g.cupos||'',
      estado, camposFaltantes: faltantes,
      proximaFecha: proximaFecha(g.fechas),
      todasLasFechas: g.fechas.sort(),
      eventosIds: g.eventosIds, creadaDe: 'calendario',
      actualizadaEn: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (faltantes.length > 0) console.log(`  ⚠ Incompleta: "${g.nombre}" — faltan: ${faltantes.join(', ')}`);
    if (existMesas.has(key)) {
      batchMesas.update(existMesas.get(key).ref, mesaData);
      mesasActualizadas++;
    } else {
      const ref = db.collection('mesas').doc();
      mesaData.creadaEn  = admin.firestore.FieldValue.serverTimestamp();
      mesaData.jugadores = [];
      batchMesas.set(ref, mesaData);
      mesasCreadas++;
    }
  }
  await batchMesas.commit();
  console.log(`Mesas: ${mesasCreadas} creadas, ${mesasActualizadas} actualizadas`);

  // Mesas obsoletas: ya no tienen eventos en el calendario
  const keysMesasActivas = new Set(gruposMesas.keys());
  const batchMesasObs = db.batch();
  let mesasDesactualizadas = 0, mesasEliminadas = 0;
  for (const [key, doc] of existMesas) {
    if (keysMesasActivas.has(key)) continue;
    const data = doc.data();
    const tieneJugadores = (data.jugadores||[]).length > 0;
    if (tieneJugadores) {
      batchMesasObs.update(doc.ref, {
        estado: 'desactualizada', proximaFecha: null, todasLasFechas: [], eventosIds: [],
        actualizadaEn: admin.firestore.FieldValue.serverTimestamp(),
      });
      console.log(`  ⚠ Mesa desactualizada (tiene jugadores): "${data.nombre}"`);
      mesasDesactualizadas++;
    } else {
      batchMesasObs.delete(doc.ref);
      mesasEliminadas++;
    }
  }
  if (mesasDesactualizadas + mesasEliminadas > 0) await batchMesasObs.commit();
  console.log(`Mesas obsoletas: ${mesasDesactualizadas} desactualizadas, ${mesasEliminadas} eliminadas`);

  // ── Actividades: mismo patrón de upsert, respeta las que tienen inscriptos ──
  const existActSnap = await db.collection('actividades').get();
  const existAct = new Map();
  existActSnap.docs.forEach(d => { const k=d.data()._key; if(k) existAct.set(k, d); });

  let actCreadas = 0, actActualizadas = 0;
  const batchAct = db.batch();
  for (const [key, g] of gruposAct) {
    const faltantesAct = CAMPOS_MINIMOS_ACT.filter(c => !g[c] || g[c].toString().trim() === '');
    const estadoAct    = faltantesAct.length === 0 ? 'activa' : 'incompleta';
    const actData = {
      _key: key, nombre: g.nombre, tipo: g.subtipo||'evento',
      dm: g.dm||'', periodicidad: g.periodicidad||'',
      sinopsis: g.sinopsis||'', cupos: g.cupos||'',
      costo: '', estado: estadoAct, camposFaltantes: faltantesAct,
      proximaFecha: proximaFecha(g.fechas),
      todasLasFechas: g.fechas.sort(),
      eventosIds: g.eventosIds, creadaDe: 'calendario',
      actualizadaEn: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (existAct.has(key)) {
      batchAct.update(existAct.get(key).ref, actData);
      actActualizadas++;
    } else {
      const ref = db.collection('actividades').doc();
      actData.creadaEn   = admin.firestore.FieldValue.serverTimestamp();
      actData.inscriptos = [];
      batchAct.set(ref, actData);
      actCreadas++;
    }
  }
  await batchAct.commit();
  console.log(`Actividades: ${actCreadas} creadas, ${actActualizadas} actualizadas`);

  // Actividades obsoletas: ya no tienen eventos en el calendario
  const keysActActivas = new Set(gruposAct.keys());
  const batchActObs = db.batch();
  let actDesactualizadas = 0, actEliminadas = 0;
  for (const [key, doc] of existAct) {
    if (keysActActivas.has(key)) continue;
    const data = doc.data();
    const tieneInscriptos = (data.inscriptos||[]).length > 0;
    if (tieneInscriptos) {
      batchActObs.update(doc.ref, {
        estado: 'desactualizada', proximaFecha: null, todasLasFechas: [], eventosIds: [],
        actualizadaEn: admin.firestore.FieldValue.serverTimestamp(),
      });
      console.log(`  ⚠ Actividad desactualizada (tiene inscriptos): "${data.nombre}"`);
      actDesactualizadas++;
    } else {
      batchActObs.delete(doc.ref);
      actEliminadas++;
    }
  }
  if (actDesactualizadas + actEliminadas > 0) await batchActObs.commit();
  console.log(`Actividades obsoletas: ${actDesactualizadas} desactualizadas, ${actEliminadas} eliminadas`);

  return { mesasCreadas, mesasActualizadas, mesasEliminadas, mesasDesactualizadas,
            actCreadas, actActualizadas, actEliminadas, actDesactualizadas };
}

async function main() {
  console.log('=== reset-mesas.js ===');
  console.log(`Timestamp: ${new Date().toISOString()}`);
  try {
    console.log('\nLeyendo eventos futuros...');
    const eventos = await leerEventosFuturos();
    console.log(`Total: ${eventos.length} eventos futuros`);
    console.log('\nSincronizando mesas y actividades (upsert, sin perder imágenes ni inscriptos)...');
    const r = await crearDesdeEventos(eventos);
    console.log('\n=== Reset completo ===');
    console.log(JSON.stringify(r, null, 2));
    process.exit(0);
  } catch(e) { console.error('ERROR:', e); process.exit(1); }
}

main();
