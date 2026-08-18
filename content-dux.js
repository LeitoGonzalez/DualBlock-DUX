/**
 * DualBlock — Content script (DUX ERP)
 *
 * Avisa al service worker cuando la ruta es `/duxnew/inicio`.
 * Cubre el caso en que DUX llega ahí por navegación SPA tras el login
 * (sin full page load), donde tabs.onUpdated a veces no alcanza.
 */
'use strict';

const DUX_INICIO_PATH = '/duxnew/inicio';

function isDuxInicioPath() {
  try {
    return location.pathname.includes(DUX_INICIO_PATH);
  } catch {
    return false;
  }
}

function notifyInicio() {
  if (!isDuxInicioPath()) return;
  chrome.runtime.sendMessage({ type: 'dux-inicio' }).catch(() => {});
}

notifyInicio();

window.addEventListener('popstate', notifyInicio);

const origPushState = history.pushState;
history.pushState = function (...args) {
  origPushState.apply(this, args);
  notifyInicio();
};

const origReplaceState = history.replaceState;
history.replaceState = function (...args) {
  origReplaceState.apply(this, args);
  notifyInicio();
};
