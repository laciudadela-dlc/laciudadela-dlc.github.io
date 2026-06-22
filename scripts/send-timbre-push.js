/**
 * send-timbre-push.js
 * 
 * Corre en GitHub Actions cuando se dispara repository_dispatch con event_type: 'timbre'
 * Lee el timbre de Firestore y envía Web Push a los admins con timbreActivo=true
 * También limpia timbres de más de 7 días (si es sábado)
 */

const admin    = require('firebase-admin');
const webpush  = require('web-push');

// ── Firebase ──────────────────────────────────────────
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId:  'ciudadela-portal-88111'
});
const db = admin.firestore();

// ── VAPID ─────────────────────────────────────────────
webpush.setVapidDetails(
  'mailto:' + process.env.VAPID_EMAIL,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// ── Datos del timbre (pasados como env por el workflow) ──
const timbreId   = process.env.TIMBRE_ID   || '';
const timbreData = process.env.TIMBRE_DATA ? JSON.parse(process.env.TIMBRE_DATA) : {};

async function main() {
  console.log('=== send-timbre-push.js ===');
  console.log('Timbre ID:', timbreId);
  console.log('Timbre data:', JSON.stringify(timbreData));

  // ── 1. Obtener admins con timbreActivo=true ──
  const adminsSnap = await db.collection('usuarios')
    .where('roles', 'array-contains', 'admin')
    .get();

  const admins = adminsSnap.docs
    .map(d => ({ uid: d.id, ...d.data() }))
    .filter(u => u.timbreActivo !== false); // true por defecto

  console.log(`Admins a notificar: ${admins.length}`);

  // ── 2. Para cada admin, buscar sus suscripciones push ──
  const nombre = timbreData.nombre || 'Alguien';
  const hora   = new Date(timbreData.timestamp || Date.now()).toLocaleTimeString('es-AR', {
    hour: '2-digit', minute: '2-digit', timeZone: 'America/Argentina/Buenos_Aires'
  });

  const payload = JSON.stringify({
    title: '🔔 Timbre — La Ciudadela',
    body:  `${nombre} tocó el timbre a las ${hora}hs`,
    url:   'https://laciudadela-dlc.github.io/'
  });

  let enviadas = 0, errores = 0;

  for (const adminUser of admins) {
    // Leer suscripciones del admin
    const subsSnap = await db.collection('push_subscriptions')
      .where('uid', '==', adminUser.uid)
      .get();

    if (subsSnap.empty) {
      console.log(`  Admin ${adminUser.uid}: sin suscripciones push`);
      continue;
    }

    for (const subDoc of subsSnap.docs) {
      const sub = subDoc.data().subscription;
      try {
        await webpush.sendNotification(sub, payload);
        enviadas++;
        console.log(`  ✓ Push enviado a ${adminUser.displayName || adminUser.uid}`);
      } catch(e) {
        errores++;
        console.error(`  ✗ Error enviando a ${adminUser.uid}:`, e.statusCode, e.body);
        // Si la suscripción expiró (410), eliminarla
        if (e.statusCode === 410 || e.statusCode === 404) {
          await subDoc.ref.delete();
          console.log(`    Suscripción expirada eliminada`);
        }
      }
    }
  }

  console.log(`\nResumen: ${enviadas} enviadas, ${errores} errores`);

  // ── 3. Limpieza semanal (sábados) ──
  const hoy = new Date();
  if (hoy.getDay() === 6) { // sábado
    console.log('\nLimpieza semanal de timbres...');
    const hace7dias = new Date(hoy - 7 * 24 * 60 * 60 * 1000);
    const viejosSnap = await db.collection('timbres')
      .where('timestamp', '<', admin.firestore.Timestamp.fromDate(hace7dias))
      .get();

    if (viejosSnap.size > 0) {
      const batch = db.batch();
      viejosSnap.docs.forEach(d => batch.delete(d.ref));
      await batch.commit();
      console.log(`  ${viejosSnap.size} timbres eliminados`);
    } else {
      console.log('  Sin timbres viejos para eliminar');
    }
  }

  process.exit(0);
}

main().catch(e => {
  console.error('ERROR:', e);
  process.exit(1);
});
