/**
 * reset-mesas.js
 * Limpieza completa y recarga de mesas desde cero.
 * 1. Elimina TODOS los documentos de mesas y actividades
 * 2. Lee eventos de Firestore desde HOY en adelante (4 meses)
 * 3. Crea mesas y actividades limpias
 * USAR SOLO EN PREPRODUCCION
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

function mesaKey(title) {
  return (title||'').toLowerCase().trim().replace(/\s+/g,' ');
}

function proximaFecha(fechas) {
  const ahora = new Date();
  return fechas.map(f => new Date(f)).filter(f => f >= ahora)
    .sort((a,b) => a-b)[0]?.toISOString() || null;
}

async function eliminarColeccion(nombre) {
  console.log(`\nEliminando ${nombre}...`);
  const snap = await db.collection(nombre).get();
  if (snap.empty) { console.log('  Ya estaba vacía'); return 0; }
  const chunks = [];
  for (let i = 0; i < snap.docs.length; i += 499) chunks.push(snap.docs.slice(i, i+499));
  let total = 0;
  for (const chunk of chunks) {
    const batch = db.batch();
    chunk.forEach(d => batch.delete(d.ref));
    await batch.commit();
    total += chunk.length;
  }
  console.log(`  ${total} documentos eliminados`);
  return total;
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
    const key         = mesaKey(nombre);

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

  // Crear mesas
  let mc = 0;
  for (const [key, g] of gruposMesas) {
    const faltantes = CAMPOS_MINIMOS.filter(c => !g[c] || g[c].toString().trim() === '');
    const estado    = faltantes.length === 0 ? 'activa' : 'incompleta';
    await db.collection('mesas').add({
      _key: key, nombre: g.nombre, sistema: g.sistema||'',
      dm: g.dm||'', periodicidad: g.periodicidad||'',
      sinopsis: g.sinopsis||'', cupos: g.cupos||'',
      estado, camposFaltantes: faltantes,
      proximaFecha: proximaFecha(g.fechas),
      todasLasFechas: g.fechas.sort(),
      eventosIds: g.eventosIds, creadaDe: 'calendario', jugadores: [],
      creadaEn: admin.firestore.FieldValue.serverTimestamp(),
      actualizadaEn: admin.firestore.FieldValue.serverTimestamp(),
    });
    if (faltantes.length > 0) console.log(`  ⚠ Incompleta: "${g.nombre}" — faltan: ${faltantes.join(', ')}`);
    mc++;
  }
  console.log(`Mesas creadas: ${mc}`);

  // Crear actividades
  let ac = 0;
  for (const [key, g] of gruposAct) {
    await db.collection('actividades').add({
      _key: key, nombre: g.nombre, tipo: g.subtipo||'evento',
      dm: g.dm||'', periodicidad: g.periodicidad||'',
      sinopsis: g.sinopsis||'', cupos: g.cupos||'',
      costo: '', estado: 'activa',
      proximaFecha: proximaFecha(g.fechas),
      todasLasFechas: g.fechas.sort(),
      eventosIds: g.eventosIds, creadaDe: 'calendario', inscriptos: [],
      creadaEn: admin.firestore.FieldValue.serverTimestamp(),
      actualizadaEn: admin.firestore.FieldValue.serverTimestamp(),
    });
    ac++;
  }
  console.log(`Actividades creadas: ${ac}`);
  return { mc, ac };
}

async function main() {
  console.log('=== reset-mesas.js ===');
  console.log(`Timestamp: ${new Date().toISOString()}`);
  try {
    await eliminarColeccion('mesas');
    await eliminarColeccion('actividades');
    console.log('\nLeyendo eventos futuros...');
    const eventos = await leerEventosFuturos();
    console.log(`Total: ${eventos.length} eventos futuros`);
    console.log('\nCreando mesas y actividades limpias...');
    const r = await crearDesdeEventos(eventos);
    console.log(`\n=== Reset completo: ${r.mc} mesas, ${r.ac} actividades ===`);
    process.exit(0);
  } catch(e) { console.error('ERROR:', e); process.exit(1); }
}

main();
