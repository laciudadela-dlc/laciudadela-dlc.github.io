/**
 * send-timbre-push.js
 * 
 * Corre en GitHub Actions cuando se dispara repository_dispatch con event_type: 'timbre'
 * Lee el timbre de Firestore y envía Web Push solo a admins cercanos a La Ciudadela.
 * 
 * Reglas:
 * - Admin debe tener ultimaUbicacion en Firestore
 * - Ubicación debe tener menos de 1 hora de antigüedad
 * - Admin debe estar a ≤500m de La Ciudadela
 * - Si el admin no tiene ubicación registrada, NO recibe notificación
 */

const admin   = require('firebase-admin');
const webpush = require('web-push');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId:  'ciudadela-portal-88111'
});
const db = admin.firestore();

webpush.setVapidDetails(
  'mailto:' + process.env.VAPID_EMAIL,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// Coordenadas de La Ciudadela
const CIUDADELA_LAT = -34.614915916509204;
const CIUDADELA_LNG = -58.381865638383225;
const RADIO_ADMIN_M = 500;   // metros para recibir notificación
const MAX_EDAD_MS   = 60 * 60 * 1000; // 1 hora máximo de antigüedad

// Haversine distance en metros
function distanciaMetros(lat1, lng1, lat2, lng2) {
  const R  = 6371000;
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lng2 - lng1) * Math.PI / 180;
  const a  = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function adminEstaCerca(adminData) {
  const ub = adminData.ultimaUbicacion;
  if (!ub || !ub.lat || !ub.lng || !ub.timestamp) {
    console.log(`  ${adminData.displayName || adminData.uid}: sin ubicación registrada — no notificado`);
    return false;
  }

  // Verificar antigüedad
  const edad = Date.now() - new Date(ub.timestamp).getTime();
  if (edad > MAX_EDAD_MS) {
    const mins = Math.round(edad / 60000);
    console.log(`  ${adminData.displayName || adminData.uid}: ubicación de hace ${mins}min (> 60min) — no notificado`);
    return false;
  }

  // Verificar distancia
  const dist = distanciaMetros(ub.lat, ub.lng, CIUDADELA_LAT, CIUDADELA_LNG);
  if (dist > RADIO_ADMIN_M) {
    console.log(`  ${adminData.displayName || adminData.uid}: a ${Math.round(dist)}m (> ${RADIO_ADMIN_M}m) — no notificado`);
    return false;
  }

  console.log(`  ${adminData.displayName || adminData.uid}: a ${Math.round(dist)}m — ✓ notificar`);
  return true;
}

const timbreId   = process.env.TIMBRE_ID   || '';
const timbreData = process.env.TIMBRE_DATA ? JSON.parse(process.env.TIMBRE_DATA) : {};

async function main() {
  console.log('=== send-timbre-push.js ===');
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log(`Timbre: ${timbreId} | Quien: ${timbreData.nombre || '?'}`);

  // Obtener admins
  const adminsSnap = await db.collection('usuarios')
    .where('roles', 'array-contains', 'admin')
    .get();

  const admins = adminsSnap.docs.map(d => ({ uid: d.id, ...d.data() }));
  console.log(`\nAdmins totales: ${admins.length}`);
  console.log('Verificando ubicación:');

  // Filtrar admins cercanos con ubicación reciente
  const adminsANotificar = admins.filter(a => adminEstaCerca(a));
  console.log(`\nAdmins a notificar: ${adminsANotificar.length}`);

  if (!adminsANotificar.length) {
    console.log('No hay admins cercanos con ubicación reciente. Push no enviado.');
    process.exit(0);
  }

  // Preparar payload
  const hora = new Date(timbreData.timestamp || Date.now()).toLocaleTimeString('es-AR', {
    hour: '2-digit', minute: '2-digit', timeZone: 'America/Argentina/Buenos_Aires'
  });
  const nombre  = timbreData.nombre || 'Alguien';
  const payload = JSON.stringify({
    title: '🔔 Timbre — La Ciudadela',
    body:  `${nombre} tocó el timbre a las ${hora}hs`,
    url:   'https://laciudadela-dlc.github.io/'
  });

  let enviadas = 0, errores = 0;

  for (const adminUser of adminsANotificar) {
    const subsSnap = await db.collection('push_subscriptions')
      .where('uid', '==', adminUser.uid)
      .get();

    if (subsSnap.empty) {
      console.log(`  ${adminUser.displayName || adminUser.uid}: sin suscripción push`);
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
        console.error(`  ✗ Error ${adminUser.uid}:`, e.statusCode);
        // Suscripción expirada → eliminar
        if (e.statusCode === 410 || e.statusCode === 404) {
          await subDoc.ref.delete();
          console.log('    Suscripción expirada eliminada');
        }
      }
    }
  }

  console.log(`\nResumen: ${enviadas} push enviadas, ${errores} errores`);

  // Limpieza semanal (sábados)
  const hoy = new Date();
  if (hoy.getDay() === 6) {
    console.log('\nLimpieza semanal de timbres...');
    const hace7dias = new Date(hoy - 7 * 24 * 60 * 60 * 1000);
    const viejosSnap = await db.collection('timbres')
      .where('timestamp', '<', hace7dias.toISOString())
      .get();
    if (viejosSnap.size > 0) {
      const batch = db.batch();
      viejosSnap.docs.forEach(d => batch.delete(d.ref));
      await batch.commit();
      console.log(`  ${viejosSnap.size} timbres eliminados`);
    }
  }

  process.exit(0);
}

main().catch(e => {
  console.error('ERROR:', e);
  process.exit(1);
});
