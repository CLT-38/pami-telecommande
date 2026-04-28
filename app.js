/**
 * app.js — Télécommande PAMI Web Bluetooth
 *
 * Équivalent fonctionnel de l'application MIT App Inventor (bleble_telec).
 * Protocole : Nordic UART Service (NUS) sur BLE
 *   Service  : 6E400001-B5A3-F393-E0A9-E50E24DCCA9E
 *   RX (→ robot) : 6E400002-B5A3-F393-E0A9-E50E24DCCA9E  (WRITE / WRITE_NR)
 *   TX (← robot) : 6E400003-B5A3-F393-E0A9-E50E24DCCA9E  (NOTIFY — réservé usage futur)
 *
 * Commandes (1 octet) :
 *   0  = STOP        2  = Reculer      4  = Gauche
 *   6  = Droite      8  = Avancer     10  = Animation servo (3 s)
 *
 * Comportement équivalent MIT :
 *   - TouchDown/pointerdown → envoi immédiat + mémorisation currentCommand
 *   - TouchUp/pointerup     → envoi STOP (0) + réinitialisation
 *   - Clock 200 ms          → renvoi de currentCommand si connecté && cmd≠0
 *   - Sécurité : envoi STOP sur perte de focus / page masquée / déconnexion
 *
 * Améliorations web :
 *   - Raccourcis clavier (flèches) avec multi-touches correctement gérés
 *   - Bip audio (Web Audio API) lors de la marche arrière
 *   - Message explicite si Web Bluetooth non disponible
 */

'use strict';

/* ================================================================
   CONSTANTES
   ================================================================ */

const NUS_SERVICE_UUID    = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const NUS_RX_CHAR_UUID    = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
// const NUS_TX_CHAR_UUID = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // usage futur

/** Intervalle de renvoi de la commande courante (ms) — correspond à Clock1 MIT */
const RESEND_INTERVAL_MS    = 200;

/** Durée de l'animation servo côté firmware (ms) — SERVO_DUREE_MS */
const ANIMATION_DURATION_MS = 3000;

/** Robots préconfigurés (correspondance avec le firmware) */
const ROBOTS = {
  eve:    { label: 'Eve de Prêt', bleName: 'EVE-Pami'   },
  bobby:  { label: 'Bobby',       bleName: 'BOBBY-Pami' },
  custom: { label: 'Autre',       bleName: null         },
};

/** Codes de commande (correspondent aux case du switch piloter_telecommande) */
const CMD = Object.freeze({
  STOP:      0,
  BACK:      2,
  LEFT:      4,
  RIGHT:     6,
  FORWARD:   8,
  ANIMATION: 10,
});

/* ================================================================
   ÉTAT
   ================================================================ */

let bleDevice       = null;   // BluetoothDevice
let rxChar          = null;   // BluetoothRemoteGATTCharacteristic (RX)
let connected       = false;
let currentCommand  = 0;
let resendTimer     = null;
let animTimer       = null;

// Audio
let audioCtx        = null;
let reverseBeepTimer = null;

/* ================================================================
   COUCHE BLE
   ================================================================ */

/**
 * Lance le scan et se connecte au robot sélectionné.
 * Doit être appelée depuis un gestionnaire d'événement utilisateur
 * (exigence Web Bluetooth pour l'appel à requestDevice).
 */
async function connectBLE() {
  const robotKey = document.getElementById('robot-select').value;
  const robot    = ROBOTS[robotKey];

  // Construction des filtres de scan
  let filters;
  if (robotKey === 'custom') {
    const customName = document.getElementById('custom-name').value.trim();
    filters = customName
      ? [{ name: customName }]
      : [{ services: [NUS_SERVICE_UUID] }]; // scan large si aucun nom fourni
  } else {
    filters = [{ name: robot.bleName }];
  }

  appendLog(`Connexion à ${robot.label}…`);
  setDebug('dbg:connecting...');

  try {
    bleDevice = await navigator.bluetooth.requestDevice({
      filters,
      optionalServices: [NUS_SERVICE_UUID],
    });

    bleDevice.addEventListener('gattserverdisconnected', handleDisconnected);

    const server  = await bleDevice.gatt.connect();
    const service = await server.getPrimaryService(NUS_SERVICE_UUID);
    rxChar        = await service.getCharacteristic(NUS_RX_CHAR_UUID);

    handleConnected();

  } catch (err) {
    // NotFoundError = l'utilisateur a annulé le sélecteur → pas d'erreur à afficher
    if (err.name !== 'NotFoundError') {
      const friendly = {
        SecurityError:      'Bluetooth nécessite HTTPS ou localhost.',
        NotSupportedError:  'Service BLE non trouvé sur cet appareil.',
      }[err.name] ?? err.message;
      appendLog(`✗ Erreur connexion : ${friendly}`);
    }
    setDebug(`dbg:FAIL ${err.name}`);

    // Nettoyage si la connexion GATT a quand même été établie avant l'échec
    if (bleDevice?.gatt?.connected) bleDevice.gatt.disconnect();
    bleDevice = null;
    rxChar    = null;
  }
}

/** Déconnexion volontaire */
function disconnectBLE() {
  if (bleDevice?.gatt?.connected) {
    bleDevice.gatt.disconnect(); // déclenche 'gattserverdisconnected' → handleDisconnected
  }
}

/* ================================================================
   GESTIONNAIRES ÉTAT CONNEXION
   ================================================================ */

function handleConnected() {
  connected = true;

  const robotKey = document.getElementById('robot-select').value;
  appendLog(`✓ Connecté à ${ROBOTS[robotKey].label}`);
  appendLog('Prêt à piloter !');
  setDebug(`dbg:OK nom=${bleDevice.name}`);
  setConnectionUI(true);

  // Équivalent de Clock1 (TimerInterval=200ms)
  resendTimer = setInterval(() => {
    if (connected && currentCommand !== 0) {
      sendCmd(currentCommand);
    }
  }, RESEND_INTERVAL_MS);
}

function handleDisconnected() {
  if (!connected) {
    // Connexion jamais aboutie ou double-appel
    bleDevice = null;
    rxChar    = null;
    return;
  }

  connected      = false;
  currentCommand = 0;

  clearInterval(resendTimer);
  resendTimer = null;
  stopReverseBeep();

  appendLog('Déconnecté');
  setDebug('dbg:disconnected');
  setConnectionUI(false);
  setButtonActive(null);

  bleDevice = null;
  rxChar    = null;
}

/* ================================================================
   ENVOI DE COMMANDES
   ================================================================ */

/**
 * Écrit 1 octet sur la caractéristique RX du robot.
 * Utilise writeValueWithoutResponse (WRITE_NR) si disponible,
 * sinon repli sur writeValue (WRITE) pour les anciens navigateurs.
 */
async function sendCmd(cmd) {
  if (!connected || !rxChar) return;
  try {
    const data = new Uint8Array([cmd]);
    if (typeof rxChar.writeValueWithoutResponse === 'function') {
      await rxChar.writeValueWithoutResponse(data);
    } else {
      // Compatibilité Chrome < 85
      await rxChar.writeValue(data);
    }
  } catch (_err) {
    // Écriture échouée → connexion perdue
    if (!bleDevice?.gatt?.connected) {
      handleDisconnected();
    }
  }
}

/* ================================================================
   PRESS / RELEASE (équivalent TouchDown/TouchUp MIT)
   ================================================================ */

function pressCommand(cmd) {
  if (!connected) return;
  if (currentCommand === cmd) return; // déjà actif, évite les appels en double
  currentCommand = cmd;
  sendCmd(cmd);
  setButtonActive(cmd);

  if (cmd === CMD.BACK) {
    startReverseBeep();
  } else {
    stopReverseBeep();
  }
}

function releaseCommand() {
  if (currentCommand === 0) return; // déjà stoppé
  currentCommand = 0;
  sendCmd(CMD.STOP);
  setButtonActive(null);
  stopReverseBeep();
}

/* ================================================================
   AUDIO — BIP MARCHE ARRIÈRE (équivalent Player1 MIT)
   ================================================================ */

function ensureAudioCtx() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  // Résout le cas où le contexte a été suspendu par le navigateur
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
}

function playBeep() {
  ensureAudioCtx();
  const osc  = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.type = 'square';
  osc.frequency.value = 1100;
  gain.gain.setValueAtTime(0.12, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.13);
  osc.start(audioCtx.currentTime);
  osc.stop(audioCtx.currentTime + 0.13);
}

function startReverseBeep() {
  stopReverseBeep();
  playBeep(); // bip immédiat
  reverseBeepTimer = setInterval(playBeep, 600);
}

function stopReverseBeep() {
  clearInterval(reverseBeepTimer);
  reverseBeepTimer = null;
}

/* ================================================================
   ANIMATION (équivalent switch "Animation" MIT → sendCommand(10))
   ================================================================ */

function triggerAnimation() {
  if (!connected) return;
  sendCmd(CMD.ANIMATION);
  const btn = document.getElementById('btn-animation');
  btn.classList.add('active');
  clearTimeout(animTimer);
  // Visuel actif pendant ANIMATION_DURATION_MS (= SERVO_DUREE_MS firmware)
  animTimer = setTimeout(() => btn.classList.remove('active'), ANIMATION_DURATION_MS);
}

/* ================================================================
   CLAVIER — flèches directionnelles (amélioration web)
   ================================================================ */

const KEY_CMD_MAP = {
  ArrowUp:    CMD.FORWARD,
  ArrowDown:  CMD.BACK,
  ArrowLeft:  CMD.LEFT,
  ArrowRight: CMD.RIGHT,
};

const keysHeld = new Set();

document.addEventListener('keydown', (e) => {
  if (!KEY_CMD_MAP[e.key]) return;
  e.preventDefault();
  if (keysHeld.has(e.key)) return; // ignorer l'auto-repeat
  keysHeld.add(e.key);
  pressCommand(KEY_CMD_MAP[e.key]);
});

document.addEventListener('keyup', (e) => {
  if (!KEY_CMD_MAP[e.key]) return;
  e.preventDefault();
  keysHeld.delete(e.key);
  if (keysHeld.size === 0) {
    releaseCommand();
  } else {
    // S'il reste des touches appuyées, reprendre avec la dernière
    const lastKey = [...keysHeld].at(-1);
    pressCommand(KEY_CMD_MAP[lastKey]);
  }
});

/* ================================================================
   SÉCURITÉ — STOP automatique en cas de perte de focus
   ================================================================ */

/** Perte de focus de la fenêtre (alt-tab, clic ailleurs…) */
window.addEventListener('blur', releaseCommand);

/** Page cachée (onglet en arrière-plan, téléphone verrouillé…) */
document.addEventListener('visibilitychange', () => {
  if (document.hidden) releaseCommand();
});

/** Fermeture / navigation — envoi STOP synchrone best-effort */
window.addEventListener('beforeunload', () => {
  if (connected) sendCmd(CMD.STOP);
});

/* ================================================================
   UI — HELPERS
   ================================================================ */

const MAX_LOG_LINES = 60;

function appendLog(msg) {
  const log  = document.getElementById('log');
  const line = document.createElement('div');
  line.className   = 'log-line';
  const ts = new Date().toLocaleTimeString('fr-FR', {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  line.textContent = `[${ts}] ${msg}`;
  log.appendChild(line);
  // Limiter le nombre de lignes pour éviter les fuites mémoire
  while (log.childElementCount > MAX_LOG_LINES) {
    log.firstElementChild.remove();
  }
  log.scrollTop = log.scrollHeight;
}

function setDebug(msg) {
  document.getElementById('debug').textContent = msg;
}

function setConnectionUI(isConnected) {
  document.getElementById('connect-btn').disabled    =  isConnected;
  document.getElementById('disconnect-btn').disabled = !isConnected;

  const controls = document.getElementById('controls');
  controls.dataset.connected = isConnected ? 'true' : 'false';

  const dot  = document.getElementById('status-dot');
  const text = document.getElementById('status-text');
  dot.className    = `status-dot ${isConnected ? 'connected' : 'disconnected'}`;
  text.textContent = isConnected ? 'Connecté' : 'Déconnecté';
}

/** Mapping cmd → id bouton d-pad pour feedback visuel */
const CMD_BTN = {
  [CMD.FORWARD]: 'btn-forward',
  [CMD.BACK]:    'btn-back',
  [CMD.LEFT]:    'btn-left',
  [CMD.RIGHT]:   'btn-right',
};

function setButtonActive(cmd) {
  Object.values(CMD_BTN).forEach(id => {
    document.getElementById(id).classList.remove('active');
  });
  if (cmd !== null && CMD_BTN[cmd]) {
    document.getElementById(CMD_BTN[cmd]).classList.add('active');
  }
}

/* ================================================================
   SETUP BOUTONS DIRECTIONNELS
   ================================================================ */

/**
 * Configure un bouton du d-pad avec Pointer Events (cross-device :
 * fonctionne avec souris, touch et stylet).
 * setPointerCapture garantit que pointerup est reçu même si le
 * pointeur sort du bouton avant le relâchement.
 */
function setupDirBtn(btnId, cmd) {
  const btn = document.getElementById(btnId);

  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    btn.setPointerCapture(e.pointerId);
    pressCommand(cmd);
  });

  btn.addEventListener('pointerup', (e) => {
    e.preventDefault();
    releaseCommand();
  });

  btn.addEventListener('pointercancel', () => {
    releaseCommand();
  });

  // Empêche le menu contextuel sur maintien long (mobile)
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
}

/* ================================================================
   INIT
   ================================================================ */

document.addEventListener('DOMContentLoaded', () => {

  // Vérification support Web Bluetooth
  if (!navigator.bluetooth) {
    document.getElementById('ble-unsupported').hidden = false;
    document.getElementById('app').hidden = true;
    return;
  }

  // État initial
  setConnectionUI(false);
  appendLog('Appuyez sur Connecter pour démarrer…');
  setDebug('dbg:idle');

  // Connexion / Déconnexion
  document.getElementById('connect-btn').addEventListener('click', connectBLE);
  document.getElementById('disconnect-btn').addEventListener('click', disconnectBLE);

  // D-Pad
  setupDirBtn('btn-forward', CMD.FORWARD);
  setupDirBtn('btn-back',    CMD.BACK);
  setupDirBtn('btn-left',    CMD.LEFT);
  setupDirBtn('btn-right',   CMD.RIGHT);

  // Animation
  document.getElementById('btn-animation').addEventListener('click', triggerAnimation);

  // Sélection robot → afficher/cacher le champ de nom personnalisé
  const sel         = document.getElementById('robot-select');
  const customGroup = document.getElementById('custom-name-group');
  sel.addEventListener('change', () => {
    customGroup.hidden = sel.value !== 'custom';
  });

});
