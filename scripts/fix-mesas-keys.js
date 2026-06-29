/**
 * fix-mesas-keys.js
 * 
 * Limpia duplicados en la colección mesas:
 * - Encuentra documentos con _key en formato viejo "titulo||dm"
 * - Los migra al formato nuevo "titulo" (solo título)
 * - Elimina duplicados manteniendo el que tiene más datos
 */

const admin = require('firebase-admin');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId:  'ciudadela-portal-88111'
});
const db = admin.firestore();

async function main() {
  console.log('=== fix-mesas-keys.js ===');

  const snap = await db.collection('mesas').get();
  const mesas = snap.docs.map(d => ({ docId: d.id, ref: d.ref, ...d.data() }));

  console.log(`Total mesas: ${mesas.length}`);

  // Agrupar por título normalizado
  const porTitulo = new Map();
  for (const m of mesas) {
    const titulo = (m.nombre || '').toLowerCase().trim().replace(/\s+/g, ' ');
    if (!porTitulo.has(titulo)) porTitulo.set(titulo, []);
    porTitulo.get(titulo).push(m);
  }

  let duplicados = 0, migrados = 0;

  for (const [titulo, grupo] of porTitulo) {
    if (grupo.length === 1) {
      // Solo uno — actualizar _key si tiene formato viejo
      const m = grupo[0];
      if (m._key && m._key.includes('||')) {
        await m.ref.update({ _key: titulo });
        migrados++;
        console.log(`  Migrado: "${m.nombre}"`);
      }
      continue;
    }

    // Múltiples documentos con el mismo título — hay duplicados
    console.log(`\nDuplicados para "${grupo[0].nombre}" (${grupo.length}):`);
    grupo.forEach(m => console.log(`  - ${m.docId} | _key: "${m._key}" | estado: ${m.estado} | jug: ${(m.jugadores||[]).length}`));

    // Elegir el "ganador": el que tiene más jugadores, o el más completo
    grupo.sort((a, b) => {
      const aScore = (a.jugadores||[]).length * 10
        + (a.sinopsis ? 5 : 0) + (a.dm ? 3 : 0) + (a.estado === 'activa' ? 2 : 0);
      const bScore = (b.jugadores||[]).length * 10
        + (b.sinopsis ? 5 : 0) + (b.dm ? 3 : 0) + (b.estado === 'activa' ? 2 : 0);
      return bScore - aScore;
    });

    const ganador = grupo[0];
    const perdedores = grupo.slice(1);

    // Merge: combinar jugadores de todos los documentos en el ganador
    const jugadoresMap = new Map();
    for (const m of grupo) {
      for (const j of (m.jugadores || [])) {
        if (!jugadoresMap.has(j.uid)) jugadoresMap.set(j.uid, j);
      }
    }
    const jugadoresMerge = Array.from(jugadoresMap.values());

    // Actualizar ganador con _key correcto y jugadores mergeados
    await ganador.ref.update({
      _key:      titulo,
      jugadores: jugadoresMerge,
    });
    console.log(`  ✓ Ganador: ${ganador.docId} (${jugadoresMerge.length} jugadores)`);

    // Eliminar perdedores
    const batch = db.batch();
    for (const m of perdedores) {
      batch.delete(m.ref);
      console.log(`  ✗ Eliminado: ${m.docId}`);
      duplicados++;
    }
    await batch.commit();
  }

  console.log(`\n=== Resultado: ${migrados} migrados, ${duplicados} duplicados eliminados ===`);
  process.exit(0);
}

main().catch(e => { console.error('ERROR:', e); process.exit(1); });
