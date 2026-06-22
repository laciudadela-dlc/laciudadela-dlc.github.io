/**
 * generate-flyers.js
 * 
 * Corre en GitHub Actions cuando se dispara repository_dispatch con event_type: 'generate_flyers'
 * Genera imágenes con HF para cada mesa y guarda las URLs en Firestore flyers/{mesaId}
 */

const admin = require('firebase-admin');
const https = require('https');
const fs    = require('fs');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId:  'ciudadela-portal-88111'
});
const db = admin.firestore();

const HF_TOKEN  = process.env.HF_TOKEN;
const MESA_IDS  = process.env.MESA_IDS ? JSON.parse(process.env.MESA_IDS) : [];
const JOB_ID    = process.env.JOB_ID || Date.now().toString();

const SYS_PROMPTS = {
  dnd:  "medieval fantasy dungeon scene, adventurers fighting dragons, epic battle, vintage engraving style, black and white illustration, ink crosshatching",
  d55:  "fantasy heroes casting spells, dark dungeon, cinematic epic scene, vintage engraving illustration, ink art",
  pf:   "exotic fantasy world, arcane creatures, pathfinder adventure, vintage engraving style, detailed linework",
  vam:  "gothic vampire city at night, blood moon, neo-gothic architecture, dark and mysterious, vintage engraving",
  hw:   "werewolf in dark forest, full moon, gothic horror atmosphere, vintage engraving style, black and white",
  mag:  "wizard casting arcane magic, mystical library, portals and spells, vintage engraving illustration",
  hun:  "hunter versus supernatural creatures, dark urban gothic, noir atmosphere, vintage engraving style",
  oth:  "tabletop rpg fantasy adventure scene, dramatic epic moment, vintage engraving illustration, ink art",
};

function sistemaToCode(s) {
  if (!s) return "oth";
  const n = s.toLowerCase();
  if (n.includes("d&d 5.5")||n.includes("5.5e")) return "d55";
  if (n.includes("d&d")||n.includes("dnd"))       return "dnd";
  if (n.includes("pathfinder"))                    return "pf";
  if (n.includes("vampiro"))                       return "vam";
  if (n.includes("hombre lobo"))                   return "hw";
  if (n.includes("mago"))                          return "mag";
  if (n.includes("hunter"))                        return "hun";
  return "oth";
}

function buildPrompt(mesa) {
  const code = sistemaToCode(mesa.sistema);
  const base = SYS_PROMPTS[code] || SYS_PROMPTS.oth;
  const sin  = (mesa.sinopsis || "").substring(0, 80);
  return `${base}, ${sin}, no text, no letters, newspaper illustration style, sepia tones, high contrast, detailed`;
}

async function generarImagen(prompt, mesaId) {
  return new Promise((resolve, reject) => {
    // Endpoint correcto: router.huggingface.co (inference providers 2025)
    const bodyStr = JSON.stringify({
      model:  "black-forest-labs/FLUX.1-schnell",
      prompt: prompt,
      n:      1,
      size:   "1024x576"
    });

    const opts = {
      hostname: 'router.huggingface.co',
      path:     '/together/v1/images/generations',
      method:   'POST',
      headers:  {
        'Authorization': 'Bearer ' + HF_TOKEN,
        'Content-Type':  'application/json',
        'Content-Length': Buffer.byteLength(bodyStr)
      }
    };

    const req = https.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const txt = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) {
          reject(new Error(`HF ${res.statusCode}: ${txt.substring(0,200)}`));
          return;
        }
        try {
          const json = JSON.parse(txt);
          const item = json?.data?.[0];
          if (!item) { reject(new Error('Sin datos: ' + txt.substring(0,100))); return; }
          if (item.url)      { resolve(item.url); return; }
          if (item.b64_json) { resolve('data:image/png;base64,' + item.b64_json); return; }
          reject(new Error('Formato inesperado: ' + JSON.stringify(item).substring(0,100)));
        } catch(e) {
          reject(new Error('JSON parse error: ' + txt.substring(0,150)));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(120000, () => { req.destroy(); reject(new Error('Timeout 120s')); });
    req.write(bodyStr);
    req.end();
  });
}


async function urlToBase64(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? require('https') : require('http');
    mod.get(url, res => {
      // Seguir redirects
      if (res.statusCode === 301 || res.statusCode === 302) {
        urlToBase64(res.headers.location).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`Download error ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const b64 = Buffer.concat(chunks).toString('base64');
        const mime = res.headers['content-type'] || 'image/jpeg';
        resolve(`data:${mime};base64,${b64}`);
      });
    }).on('error', reject);
  });
}


async function actualizarEstado(jobId, mesaId, estado, extra) {
  await db.collection('flyer_jobs').doc(jobId).set({
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    [`mesas.${mesaId}`]: { estado, ...extra }
  }, { merge: true });
}

async function main() {
  console.log('=== generate-flyers.js ===');
  console.log(`Job: ${JOB_ID} | Mesas: ${MESA_IDS.length}`);

  if (!HF_TOKEN) {
    console.error('HF_TOKEN no configurado');
    process.exit(1);
  }

  // Marcar job como en progreso
  await db.collection('flyer_jobs').doc(JOB_ID).set({
    estado:    'en_progreso',
    total:     MESA_IDS.length,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // Leer datos de las mesas
  const mesasSnap = await db.collection('mesas').get();
  const mesasMap  = {};
  mesasSnap.docs.forEach(d => { mesasMap[d.id] = { id: d.id, ...d.data() }; });

  let ok = 0, errores = 0;

  for (const mesaId of MESA_IDS) {
    const mesa = mesasMap[mesaId];
    if (!mesa) {
      console.warn(`Mesa ${mesaId} no encontrada`);
      continue;
    }

    console.log(`\nGenerando imagen para: ${mesa.nombre}`);
    await actualizarEstado(JOB_ID, mesaId, 'generando', { nombre: mesa.nombre });

    try {
      const prompt  = buildPrompt(mesa);
      console.log(`  Prompt: ${prompt.substring(0, 80)}...`);
      const dataUrl = await generarImagen(prompt, mesaId);

      // Convertir URL a base64 para evitar CORS en el browser
      let imgFinal = dataUrl;
      if (dataUrl && dataUrl.startsWith('http')) {
        console.log('  Descargando imagen para convertir a base64...');
        try {
          imgFinal = await urlToBase64(dataUrl);
          console.log('  ✓ Convertida a base64 (' + Math.round(imgFinal.length/1024) + 'KB)');
        } catch(e) {
          console.warn('  No se pudo convertir a base64:', e.message);
          imgFinal = dataUrl; // usar URL original como fallback
        }
      }

      // Guardar en Firestore
      await db.collection('flyers').doc(mesaId).set({
        mesaId,
        nombre:    mesa.nombre,
        sistema:   mesa.sistema || '',
        dm:        mesa.dm || '',
        sinopsis:  mesa.sinopsis || '',
        periodicidad: mesa.periodicidad || '',
        proximaFecha: mesa.proximaFecha || null,
        imgDataUrl: imgFinal,
        generadoEn: admin.firestore.FieldValue.serverTimestamp(),
        jobId:      JOB_ID,
      });

      await actualizarEstado(JOB_ID, mesaId, 'listo', { nombre: mesa.nombre });
      console.log(`  ✓ Guardado en Firestore flyers/${mesaId}`);
      ok++;

    } catch(e) {
      console.error(`  ✗ Error: ${e.message}`);
      await actualizarEstado(JOB_ID, mesaId, 'error', { nombre: mesa.nombre, error: e.message });
      errores++;
    }
  }

  // Marcar job completo
  await db.collection('flyer_jobs').doc(JOB_ID).update({
    estado:    errores === 0 ? 'completo' : 'completo_con_errores',
    ok,
    errores,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  console.log(`\n=== Fin: ${ok} OK, ${errores} errores ===`);
  process.exit(0);
}

main().catch(e => { console.error('ERROR:', e); process.exit(1); });
