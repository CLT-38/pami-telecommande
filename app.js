'use strict';

// ===== State =====
const state = {
  speed: 50,
  currentCommand: null,
  connected: false,
};

// ===== DOM helpers =====
const $ = (id) => document.getElementById(id);

const statusConnection = $('status-connection');
const statusCommand = $('status-command');
const statusSpeed = $('status-speed');
const speedInput = $('speed');
const speedValue = $('speed-value');
const logList = $('log');

// ===== Logging =====
function addLog(message, isCommand = false) {
  const li = document.createElement('li');
  if (isCommand) li.classList.add('log-command');
  const time = new Date().toLocaleTimeString('fr-FR');
  li.textContent = `[${time}] ${message}`;
  logList.prepend(li);

  // Keep at most 50 entries
  while (logList.children.length > 50) {
    logList.removeChild(logList.lastChild);
  }
}

// ===== Command handling =====
const COMMANDS = {
  up: 'AVANCER',
  down: 'RECULER',
  left: 'GAUCHE',
  right: 'DROITE',
  stop: 'STOP',
};

function sendCommand(direction) {
  const label = COMMANDS[direction] ?? direction.toUpperCase();
  state.currentCommand = label;
  statusCommand.textContent = label;
  addLog(`Commande : ${label} — vitesse ${state.speed}%`, true);
}

function clearCommand() {
  state.currentCommand = null;
  statusCommand.textContent = 'Aucune';
}

// ===== Button event bindings =====
const buttonMap = {
  'btn-up': 'up',
  'btn-down': 'down',
  'btn-left': 'left',
  'btn-right': 'right',
  'btn-stop': 'stop',
};

Object.entries(buttonMap).forEach(([btnId, direction]) => {
  const btn = $(btnId);
  if (!btn) return;

  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    btn.classList.add('active');
    sendCommand(direction);
  });

  btn.addEventListener('pointerup', () => {
    btn.classList.remove('active');
    if (direction !== 'stop') clearCommand();
  });

  btn.addEventListener('pointerleave', () => {
    btn.classList.remove('active');
    if (direction !== 'stop') clearCommand();
  });
});

// ===== Keyboard support =====
const keyMap = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ' ': 'stop',
  z: 'up',
  s: 'down',
  q: 'left',
  d: 'right',
};

const pressedKeys = new Set();

document.addEventListener('keydown', (e) => {
  const direction = keyMap[e.key];
  if (!direction || pressedKeys.has(e.key)) return;
  e.preventDefault();
  pressedKeys.add(e.key);
  const btnId = Object.keys(buttonMap).find((id) => buttonMap[id] === direction);
  if (btnId) $(btnId)?.classList.add('active');
  sendCommand(direction);
});

document.addEventListener('keyup', (e) => {
  const direction = keyMap[e.key];
  if (!direction) return;
  pressedKeys.delete(e.key);
  const btnId = Object.keys(buttonMap).find((id) => buttonMap[id] === direction);
  if (btnId) $(btnId)?.classList.remove('active');
  if (direction !== 'stop') clearCommand();
});

// ===== Speed control =====
speedInput.addEventListener('input', () => {
  state.speed = Number(speedInput.value);
  speedValue.textContent = `${state.speed}%`;
  statusSpeed.textContent = `${state.speed}%`;
  addLog(`Vitesse réglée à ${state.speed}%`);
});

// ===== Init =====
addLog('Interface prête.');
