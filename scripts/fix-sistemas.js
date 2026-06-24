/**
 * fix-sistemas.js
 * 
 * Fix masivo: recorre todos los eventos en Firestore,
 * re-parsea el sistema desde descripción y título,
 * actualiza campo `sys` en eventos y `sistema` en mesas.
 * 
 * Correr UNA VEZ: node fix-sistemas.js
 */

const admin = require('firebase-admin');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId:  'ciudadela-portal-88111'
});
const db = admin.firestore();

// Mapa completo texto → código
const SYS_KEYS = {
  // D&D variantes
  'd&d 5e':            'dnd', 'd&d5e':       'dnd', 'dnd 5e':   'dnd',
  'dnd5e':             'dnd', 'dnd':          'dnd', 'd&d':      'dnd',
  'd&d 5e (2014)':     'dnd', 'dungeons and dragons': 'dnd',
  'd&d 2014':          'dnd', 'dnd 2014':     'dnd',
  // D&D 5.5 / 2024
  'd&d 5.5':           'd55', 'd&d5.5':       'd55', 'dnd 5.5':  'd55',
  'dnd5.5':            'd55', '5.5':           'd55', 'd&d 5.5e': 'd55',
  'dnd 5.5e':          'd55', 'd&d 2024':      'd55', 'dnd 2024': 'd55',
  'd&d 5e (2024)':     'd55', 'one d&d':       'd55', 'one dnd':  'd55',
  // Pathfinder
  'pathfinder':        'pf',  'pathfinder 2':  'pf',  'pathfinder 2e': 'pf',
  'pf':                'pf',  'pf2':           'pf',  'pf2e':     'pf',
  'pathfinder second edition': 'pf',
  'pathfinder 2 remastered':   'pf',
  'pathfinder 2e remastered':  'pf',
  'pathfinder remastered':     'pf',
  // Vampiro
  'vampiro':           'vam', 'vampire':       'vam', 'vam':      'vam',
  'vampiro: la mascarada': 'vam', 'vtm':        'vam',
  'vampiro la mascarada':  'vam',
  // Hombre Lobo
  'hombre lobo':       'hw',  'werewolf':      'hw',  'hw':       'hw',
  'hombre lobo: el apocalipsis': 'hw',
  'hombre lobo el apocalipsis':  'hw',
  // Mago
  'mago':              'mag', 'mage':          'mag', 'mag':      'mag',
  'mago: la ascensión':'mag', 'mago la ascension': 'mag',
  // Hunter
  'hunter':            'hun', 'hun':           'hun',
  'hunter: the reckoning': 'hun',
};

// Mapa código → nombre completo
const NOMBRES = {
  dnd: 'D&D 5e (2014)',
  d55: 'D&D 5e (2024)',
  pf:  'Pathfinder 2e',
  vam: 'Vampiro: La Mascarada',
  hw:  'Hombre Lobo: El Apocalipsis',
  mag: 'Mago: La Ascensión',
  hun: 'Hunter: The Reckoning',
  oth: 'Otro sistema',
};

function resolveSys(texto) {
  if (!texto) return null;
  const k = texto.toLowerCase().trim()
    .replace(/\s+/g, ' ')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, ''); // quitar acentos para comparar
  
  // Buscar match exacto
  for (const [key, val] of Object.entries(SYS_KEYS)) {
    const kNorm = key.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (k === kNorm) return val;
  }
  // Buscar match parcial — ordenar por longitud descendente para que las claves más específicas ganen
  const sorted = Object.entries(SYS_KEYS).sort((a, b) => b[0].length - a[0].length);
  for (const [key, val] of sorted) {
    const kNorm = key.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (k.includes(kNorm)) return val;
  }
  return null;
}

function parsearSistemaDeDescripcion(desc) {
  if (!desc) return null;
  const text = desc
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
  
  for (const line of text.split('\n')) {
    const m = line.match(/^(sistema|juego|juego de rol|game)\s*:\s*(.+)$/i);
    if (m) {
      const sys = resolveSys(m[2].trim());
      if (sys) return sys;
    }
  }
  return null;
}

function parsearSistemaDelTitulo(titulo) {
  if (!titulo) return null;
  // El sistema suele estar después del último guión: "Mesa - Sistema"
  const partes = titulo.split(/[-–—]/);
  if (partes.length >= 2) {
    const ultima = partes[partes.length - 1].trim();
    return resolveSys(ultima);
  }
  // También buscar en el título completo
  return resolveSys(titulo);
}

async function fixEventos() {
  console.log('\n=== Corrigiendo eventos ===');
  
  // Obtener todos los meses de eventos
  const mesesSnap = await db.collection('eventos').get();
  const meses = mesesSnap.docs.map(d => d.id);
  console.log(`Meses encontrados: ${meses.join(', ')}`);
  
  let total = 0, corregidos = 0;
  
  for (const mes of meses) {
    const itemsSnap = await db.collection('eventos').doc(mes).collection('items').get();
    
    for (const itemDoc of itemsSnap.docs) {
      const ev = itemDoc.data();
      total++;
      
      const sysActual = ev.sys || '';
      
      // Intentar resolver el sistema correcto
      let sysNuevo = null;
      
      // 1. Desde la descripción
      sysNuevo = parsearSistemaDeDescripcion(ev.description || ev.desc || '');
      
      // 2. Desde el campo sys si ya es un código válido
      if (!sysNuevo && NOMBRES[sysActual]) {
        sysNuevo = sysActual; // ya es correcto
      }
      
      // 3. Desde el título
      if (!sysNuevo) {
        sysNuevo = parsearSistemaDelTitulo(ev.title || ev.summary || '');
      }
      
      // 4. Default
      if (!sysNuevo) sysNuevo = 'oth';
      
      if (sysNuevo !== sysActual) {
        await itemDoc.ref.update({ sys: sysNuevo });
        console.log(`  ✓ ${mes}/${itemDoc.id.substring(0,20)}... "${ev.title||'?'}" ${sysActual} → ${sysNuevo}`);
        corregidos++;
      }
    }
  }
  
  console.log(`\nEventos: ${total} revisados, ${corregidos} corregidos`);
  return corregidos;
}

async function fixMesas() {
  console.log('\n=== Corrigiendo mesas ===');
  
  const mesasSnap = await db.collection('mesas').get();
  let total = 0, corregidas = 0;
  
  // Leer todos los eventos para mapear por título+dm
  const eventosMap = {};
  const mesesSnap = await db.collection('eventos').get();
  for (const mesDoc of mesesSnap.docs) {
    const items = await db.collection('eventos').doc(mesDoc.id).collection('items').get();
    items.docs.forEach(d => {
      const ev = d.data();
      const k  = (ev.title||'').toLowerCase().trim();
      if (k) eventosMap[k] = ev;
    });
  }
  
  const batch = db.batch();
  
  for (const mesaDoc of mesasSnap.docs) {
    const mesa = mesaDoc.data();
    total++;
    
    const sistemaActual = mesa.sistema || '';
    let sistemaNuevo = sistemaActual;
    
    // Buscar el evento correspondiente
    const nombreK = (mesa.nombre || '').toLowerCase().trim();
    const ev = eventosMap[nombreK];
    
    if (ev) {
      // Usar el sys del evento (ya corregido) para obtener el nombre completo
      const codigo = ev.sys || 'oth';
      sistemaNuevo = NOMBRES[codigo] || 'Otro sistema';
    } else {
      // Intentar detectar del nombre de la mesa
      const cod = parsearSistemaDelTitulo(mesa.nombre) || 'oth';
      sistemaNuevo = NOMBRES[cod] || 'Otro sistema';
    }
    
    if (sistemaNuevo !== sistemaActual) {
      batch.update(mesaDoc.ref, { sistema: sistemaNuevo });
      console.log(`  ✓ "${mesa.nombre}" "${sistemaActual}" → "${sistemaNuevo}"`);
      corregidas++;
    } else {
      console.log(`  - "${mesa.nombre}" "${sistemaActual}" (sin cambio)`);
    }
  }
  
  if (corregidas > 0) await batch.commit();
  console.log(`\nMesas: ${total} revisadas, ${corregidas} corregidas`);
  return corregidas;
}

async function main() {
  console.log('=== fix-sistemas.js ===');
  console.log(`Timestamp: ${new Date().toISOString()}`);
  
  try {
    const evCorr  = await fixEventos();
    const msCorr  = await fixMesas();
    
    console.log('\n=== RESUMEN ===');
    console.log(`Eventos corregidos: ${evCorr}`);
    console.log(`Mesas corregidas:   ${msCorr}`);
    process.exit(0);
  } catch(e) {
    console.error('ERROR:', e);
    process.exit(1);
  }
}

main();
