/**
 * send-timbre-push.js
 * 
 * Lógica de notificación:
 * - timbreActivo: false → nunca notificar (admin lo desactivó manualmente)
 * - timbreActivo: true (default) + ultimaUbicacion < 1h + ≤500m → notificar
 * - timbreActivo: true + sin ubicación reciente → NO notificar (no está en LC)
 * - timbreActivo: true + ubicación reciente pero lejos → NO notificar
 * 
 * Excepción: si gps_override está activo en meta/config, 
 * notificar a TODOS los admins con timbreActivo !== false
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

const CIUDADELA_LAT = -34.614915916509204;
const CIUDADELA_LNG = -58.381865638383225;
const RADIO_ADMIN_M = 500;
const MAX_EDAD_MS   = 60 * 60 * 1000; // 1 hora

const timbreId   = process.env.TIMBRE_ID   || '';
const timbreData = process.env.TIMBRE_DATA ? JSON.parse(process.env.TIMBRE_DATA) : {};

function distanciaMetros(lat1, lng1, lat2, lng2) {
  const R  = 6371000;
  const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lng2 - lng1) * Math.PI / 180;
  const a  = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function debeNotificar(adminData, gpsOverride) {
  const nombre = adminData.displayName || adminData.uid;

  // Desactivado manualmente → nunca
  if (adminData.timbreActivo === false) {
    console.log(`  ${nombre}: timbreActivo=false → no notificado`);
    return false;
  }

  // GPS override activo → notificar a todos con timbreActivo !== false
  if (gpsOverride) {
    console.log(`  ${nombre}: GPS override activo → notificado`);
    return true;
  }

  // Sin ubicación → no notificar
  const ub = adminData.ultimaUbicacion;
  if (!ub || !ub.lat || !ub.lng || !ub.timestamp) {
    console.log(`  ${nombre}: sin ubicación registrada → no notificado`);
    return false;
  }

  // Ubicación vieja → no notificar
  const edad = Date.now() - new Date(ub.timestamp).getTime();
  if (edad > MAX_EDAD_MS) {
    console.log(`  ${nombre}: ubicación de hace ${Math.round(edad/60000)}min (>60min) → no notificado`);
    return false;
  }

  // Verificar distancia
  const dist = distanciaMetros(ub.lat, ub.lng, CIUDADELA_LAT, CIUDADELA_LNG);
  if (dist > RADIO_ADMIN_M) {
    console.log(`  ${nombre}: a ${Math.round(dist)}m (>${RADIO_ADMIN_M}m) → no notificado`);
    return false;
  }

  console.log(`  ${nombre}: a ${Math.round(dist)}m, ubicación de hace ${Math.round(edad/60000)}min → ✓ notificar`);
  return true;
}

async function main() {
  console.log('=== send-timbre-push.js ===');
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log(`Timbre: ${timbreId} | Quien: ${timbreData.nombre || '?'}`);

  // Leer config (gps_override)
  let gpsOverride = false;
  try {
    const configSnap = await db.collection('meta').doc('config').get();
    if (configSnap.exists) gpsOverride = configSnap.data().gps_override === true;
  } catch(e) {}
  console.log(`GPS Override: ${gpsOverride}`);

  // Obtener admins
  const adminsSnap = await db.collection('usuarios')
    .where('roles', 'array-contains', 'admin')
    .get();

  const admins = adminsSnap.docs.map(d => ({ uid: d.id, ...d.data() }));
  console.log(`\nAdmins totales: ${admins.length}`);
  console.log('Verificando:');

  const adminsANotificar = admins.filter(a => debeNotificar(a, gpsOverride));
  console.log(`\nAdmins a notificar: ${adminsANotificar.length}`);

  if (!adminsANotificar.length) {
    console.log('Ningún admin cumple las condiciones. Push no enviado.');
    process.exit(0);
  }

  const hora = new Date(timbreData.timestamp || Date.now()).toLocaleTimeString('es-AR', {
    hour: '2-digit', minute: '2-digit', timeZone: 'America/Argentina/Buenos_Aires'
  });
  const payload = JSON.stringify({
    title: '🔔 Timbre — La Ciudadela',
    body:  `${timbreData.nombre || 'Alguien'} tocó el timbre a las ${hora}hs`,
    url:   'https://laciudadela-dlc.github.io/'
  });

  let enviadas = 0, errores = 0;

  for (const adminUser of adminsANotificar) {
    const subsSnap = await db.collection('push_subscriptions')
      .where('uid', '==', adminUser.uid)
      .get();

    if (subsSnap.empty) {
      console.log(`  ${adminUser.displayName||adminUser.uid}: sin suscripción push registrada`);
      continue;
    }

    for (const subDoc of subsSnap.docs) {
      try {
        await webpush.sendNotification(subDoc.data().subscription, payload);
        enviadas++;
        console.log(`  ✓ Push enviado a ${adminUser.displayName||adminUser.uid}`);
      } catch(e) {
        errores++;
        console.error(`  ✗ Error ${adminUser.uid}:`, e.statusCode);
        if (e.statusCode === 410 || e.statusCode === 404) {
          await subDoc.ref.delete();
          console.log('    Suscripción expirada eliminada');
        }
      }
    }
  }

  console.log(`\nResumen: ${enviadas} enviadas, ${errores} errores`);

  // Limpieza semanal (sábados)
  if (new Date().getDay() === 6) {
    const hace7dias = new Date(Date.now() - 7*24*60*60*1000);
    const viejosSnap = await db.collection('timbres')
      .where('timestamp', '<', hace7dias.toISOString()).get();
    if (viejosSnap.size > 0) {
      const batch = db.batch();
      viejosSnap.docs.forEach(d => batch.delete(d.ref));
      await batch.commit();
      console.log(`Limpieza: ${viejosSnap.size} timbres eliminados`);
    }
  }

  process.exit(0);
}

main().catch(e => { console.error('ERROR:', e); process.exit(1); });
