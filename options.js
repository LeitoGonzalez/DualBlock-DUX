/**
 * DualBlock — Página de opciones (options.js)
 *
 * Carga la configuración desde chrome.storage.sync, renderiza la UI
 * y persiste los cambios del usuario.
 * Las estadísticas se guardan en chrome.storage.local.
 */

'use strict';

// ─── Constantes ───────────────────────────────────────────────────────────────

const STORAGE_SETTINGS_KEY = 'settings';
const STORAGE_STATS_KEY    = 'stats';

const DEFAULT_SETTINGS = {
  enabled: true,
  sites: [],
  comparisonMode: 'exact',
  behaviorOnDuplicate: 'close',
  showNotifications: true,
};

/** Regex para validar que el dominio no contiene protocolo, path ni espacios. */
const DOMAIN_REGEX = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;

// ─── Estado local ─────────────────────────────────────────────────────────────

/** Copia local de la configuración en edición. */
let currentSettings = null;

/** ID del timeout del toast para poder cancelarlo. */
let toastTimer = null;

// ─── Selectores del DOM ───────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

const elToggleEnabled      = $('toggle-enabled');
const elToggleLabelText    = $('toggle-label-text');
const elMainToggleStatusText = $('main-toggle-status-text');
const elSiteList           = $('site-list');
const elNewSiteInput       = $('new-site-input');
const elBtnAddSite         = $('btn-add-site');
const elAddSiteError       = $('add-site-error');
const elModeExact          = $('mode-exact');
const elModeIgnore         = $('mode-ignore');
const elBehaviorClose      = $('behavior-close');
const elBehaviorWarn       = $('behavior-warn');
const elToggleNotifications = $('toggle-notifications');
const elStatBlocked        = $('stat-blocked');
const elBtnResetStats      = $('btn-reset-stats');
const elToast              = $('toast');

// ─── Utilidades ───────────────────────────────────────────────────────────────

/**
 * Muestra un mensaje de confirmación breve (toast) en la esquina inferior derecha.
 * @param {string} message
 */
function showToast(message) {
  if (toastTimer) {
    clearTimeout(toastTimer);
  }
  elToast.textContent = message;
  elToast.classList.remove('hidden');
  toastTimer = setTimeout(() => {
    elToast.classList.add('hidden');
    toastTimer = null;
  }, 2500);
}

/**
 * Muestra u oculta el mensaje de error del campo de nuevo sitio.
 * @param {string} msg - Texto del error. Si está vacío, oculta el mensaje.
 */
function setAddSiteError(msg) {
  if (msg) {
    elAddSiteError.textContent = msg;
    elAddSiteError.classList.remove('hidden');
    elNewSiteInput.classList.add('input--error');
  } else {
    elAddSiteError.textContent = '';
    elAddSiteError.classList.add('hidden');
    elNewSiteInput.classList.remove('input--error');
  }
}

// ─── Persistencia ─────────────────────────────────────────────────────────────

/**
 * Carga la configuración desde chrome.storage.sync.
 * @returns {Promise<object>}
 */
async function loadSettings() {
  const data = await chrome.storage.sync.get(STORAGE_SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(data[STORAGE_SETTINGS_KEY] ?? {}) };
}

/**
 * Guarda la configuración en chrome.storage.sync y muestra confirmación.
 * @param {object} settings
 */
async function saveSettings(settings) {
  await chrome.storage.sync.set({ [STORAGE_SETTINGS_KEY]: settings });
  showToast('✓ Configuración guardada');
}

/**
 * Carga el contador de bloqueados desde chrome.storage.local.
 * @returns {Promise<number>}
 */
async function loadBlockedCount() {
  const data = await chrome.storage.local.get(STORAGE_STATS_KEY);
  return data[STORAGE_STATS_KEY]?.blockedCount ?? 0;
}

/**
 * Restablece el contador de bloqueados a cero en chrome.storage.local.
 */
async function resetBlockedCount() {
  await chrome.storage.local.set({ [STORAGE_STATS_KEY]: { blockedCount: 0 } });
}

// ─── Render del toggle principal ──────────────────────────────────────────────

/**
 * Actualiza el texto y estado visual del toggle principal de protección.
 * @param {boolean} enabled
 */
function renderMainToggle(enabled) {
  elToggleEnabled.checked = enabled;
  if (enabled) {
    elToggleLabelText.textContent = 'ACTIVADA';
    elToggleLabelText.style.color = 'var(--color-accent)';
    elMainToggleStatusText.textContent = 'Monitoreando pestañas de los sitios protegidos.';
  } else {
    elToggleLabelText.textContent = 'DESACTIVADA';
    elToggleLabelText.style.color = 'var(--color-text-muted)';
    elMainToggleStatusText.textContent = 'La protección está desactivada. No se bloquearán duplicados.';
  }
}

// ─── Render de la lista de sitios ─────────────────────────────────────────────

/**
 * Normaliza el máximo de pestañas de un sitio (0 / inválido = sin límite).
 * @param {unknown} value
 * @returns {number}
 */
function normalizeMaxTabs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return 0;
  return Math.min(99, Math.floor(n));
}

/**
 * Renderiza la lista de sitios protegidos.
 * Crea un elemento <li> por cada sitio con máximo, toggle y botón de eliminar.
 * @param {Array<{domain: string, enabled: boolean, maxTabs?: number}>} sites
 */
function renderSiteList(sites) {
  elSiteList.innerHTML = '';

  if (sites.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'site-item';
    empty.style.justifyContent = 'center';
    empty.style.color = 'var(--color-text-muted)';
    empty.style.fontStyle = 'italic';
    empty.style.fontSize = 'var(--font-size-sm)';
    empty.textContent = 'No hay sitios protegidos. Agrega al menos uno.';
    elSiteList.appendChild(empty);
    return;
  }

  sites.forEach((site, index) => {
    const li = document.createElement('li');
    li.className = 'site-item';
    li.dataset.index = index;

    // Indicador visual de estado (punto verde/gris)
    const indicator = document.createElement('span');
    indicator.className = `site-indicator${site.enabled ? ' site-indicator--active' : ''}`;
    indicator.setAttribute('aria-hidden', 'true');

    // Nombre del dominio
    const domain = document.createElement('span');
    domain.className = 'site-domain';
    domain.textContent = site.domain;
    domain.title = site.domain;

    // Máximo de pestañas (0 / vacío = sin límite)
    const maxWrap = document.createElement('div');
    maxWrap.className = 'site-max-wrap';

    const maxLabel = document.createElement('label');
    maxLabel.className = 'site-max-label';
    maxLabel.htmlFor = `site-max-${index}`;
    maxLabel.textContent = 'Máx.';

    const maxInput = document.createElement('input');
    maxInput.type = 'number';
    maxInput.id = `site-max-${index}`;
    maxInput.className = 'site-max-input';
    maxInput.min = '0';
    maxInput.max = '99';
    maxInput.step = '1';
    maxInput.placeholder = '∞';
    maxInput.title = 'Máximo de pestañas para este sitio (0 o vacío = sin límite)';
    maxInput.setAttribute('aria-label', `Máximo de pestañas para ${site.domain}`);
    const maxTabs = normalizeMaxTabs(site.maxTabs);
    maxInput.value = maxTabs > 0 ? String(maxTabs) : '';
    maxInput.addEventListener('change', () => {
      currentSettings.sites[index].maxTabs = normalizeMaxTabs(maxInput.value);
      maxInput.value = currentSettings.sites[index].maxTabs > 0
        ? String(currentSettings.sites[index].maxTabs)
        : '';
      saveSettings(currentSettings);
    });

    maxWrap.appendChild(maxLabel);
    maxWrap.appendChild(maxInput);

    // Toggle pequeño para activar/desactivar el sitio individualmente
    const siteToggleLabel = document.createElement('label');
    siteToggleLabel.className = 'site-toggle';
    siteToggleLabel.title = site.enabled ? 'Desactivar este sitio' : 'Activar este sitio';
    siteToggleLabel.setAttribute('aria-label', `${site.enabled ? 'Desactivar' : 'Activar'} protección para ${site.domain}`);

    const siteToggleInput = document.createElement('input');
    siteToggleInput.type = 'checkbox';
    siteToggleInput.checked = site.enabled;
    siteToggleInput.addEventListener('change', () => {
      currentSettings.sites[index].enabled = siteToggleInput.checked;
      saveSettings(currentSettings);
      renderSiteList(currentSettings.sites);
    });

    const siteToggleTrack = document.createElement('span');
    siteToggleTrack.className = 'site-toggle-track';
    const siteToggleThumb = document.createElement('span');
    siteToggleThumb.className = 'site-toggle-thumb';
    siteToggleTrack.appendChild(siteToggleThumb);

    siteToggleLabel.appendChild(siteToggleInput);
    siteToggleLabel.appendChild(siteToggleTrack);

    // Botón de eliminar
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'site-remove-btn';
    removeBtn.innerHTML = '&times;';
    removeBtn.title = `Eliminar ${site.domain}`;
    removeBtn.setAttribute('aria-label', `Eliminar ${site.domain} de sitios protegidos`);
    removeBtn.addEventListener('click', () => {
      currentSettings.sites.splice(index, 1);
      saveSettings(currentSettings);
      renderSiteList(currentSettings.sites);
    });

    li.appendChild(indicator);
    li.appendChild(domain);
    li.appendChild(maxWrap);
    li.appendChild(siteToggleLabel);
    li.appendChild(removeBtn);
    elSiteList.appendChild(li);
  });
}

// ─── Agregar sitio ────────────────────────────────────────────────────────────

/**
 * Valida e incorpora un nuevo dominio a la lista de sitios protegidos.
 */
function addSite() {
  const rawValue = elNewSiteInput.value.trim().toLowerCase();

  if (!rawValue) {
    setAddSiteError('Escribe un dominio antes de agregar.');
    elNewSiteInput.focus();
    return;
  }

  // Si el usuario pegó una URL completa, extraer solo el hostname
  let domain = rawValue;
  if (rawValue.includes('://')) {
    try {
      domain = new URL(rawValue).hostname;
    } catch {
      setAddSiteError('Formato inválido. Escribe solo el dominio, por ejemplo: app.empresa.com');
      elNewSiteInput.focus();
      return;
    }
  }

  // Eliminar www. inicial si está presente
  if (domain.startsWith('www.')) {
    domain = domain.slice(4);
  }

  if (!DOMAIN_REGEX.test(domain)) {
    setAddSiteError('Dominio inválido. Usa el formato: dominio.com o subdominio.dominio.com');
    elNewSiteInput.focus();
    return;
  }

  const alreadyExists = currentSettings.sites.some(
    (s) => s.domain.toLowerCase() === domain
  );

  if (alreadyExists) {
    setAddSiteError(`"${domain}" ya está en la lista.`);
    elNewSiteInput.focus();
    return;
  }

  setAddSiteError('');
  currentSettings.sites.push({ domain, enabled: true, maxTabs: 0 });
  saveSettings(currentSettings);
  renderSiteList(currentSettings.sites);
  elNewSiteInput.value = '';
  elNewSiteInput.focus();
}

// ─── Render completo de la página ─────────────────────────────────────────────

/**
 * Aplica la configuración cargada a todos los controles de la UI.
 * @param {object} settings
 */
function renderAll(settings) {
  renderMainToggle(settings.enabled);
  renderSiteList(settings.sites);

  // Modo de comparación
  elModeExact.checked  = settings.comparisonMode === 'exact';
  elModeIgnore.checked = settings.comparisonMode === 'ignore-params';

  // Comportamiento al duplicado
  elBehaviorClose.checked = settings.behaviorOnDuplicate === 'close';
  elBehaviorWarn.checked  = settings.behaviorOnDuplicate === 'warn';

  // Notificaciones
  elToggleNotifications.checked = settings.showNotifications;
}

// ─── Actualización del contador ───────────────────────────────────────────────

async function refreshBlockedCount() {
  const count = await loadBlockedCount();
  elStatBlocked.textContent = count.toLocaleString('es-AR');
}

// ─── Listeners de la UI ───────────────────────────────────────────────────────

/** Toggle principal de protección */
elToggleEnabled.addEventListener('change', () => {
  currentSettings.enabled = elToggleEnabled.checked;
  renderMainToggle(currentSettings.enabled);
  saveSettings(currentSettings);
});

/** Botón de agregar sitio */
elBtnAddSite.addEventListener('click', addSite);

/** Enter en el campo de nuevo sitio */
elNewSiteInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    addSite();
  }
});

/** Limpiar error al empezar a escribir */
elNewSiteInput.addEventListener('input', () => {
  if (elAddSiteError.textContent) {
    setAddSiteError('');
  }
});

/** Modo de comparación */
elModeExact.addEventListener('change', () => {
  if (elModeExact.checked) {
    currentSettings.comparisonMode = 'exact';
    saveSettings(currentSettings);
  }
});

elModeIgnore.addEventListener('change', () => {
  if (elModeIgnore.checked) {
    currentSettings.comparisonMode = 'ignore-params';
    saveSettings(currentSettings);
  }
});

/** Comportamiento al detectar duplicado */
elBehaviorClose.addEventListener('change', () => {
  if (elBehaviorClose.checked) {
    currentSettings.behaviorOnDuplicate = 'close';
    saveSettings(currentSettings);
  }
});

elBehaviorWarn.addEventListener('change', () => {
  if (elBehaviorWarn.checked) {
    currentSettings.behaviorOnDuplicate = 'warn';
    saveSettings(currentSettings);
  }
});

/** Notificaciones */
elToggleNotifications.addEventListener('change', () => {
  currentSettings.showNotifications = elToggleNotifications.checked;
  saveSettings(currentSettings);
});

/** Restablecer contador */
elBtnResetStats.addEventListener('click', async () => {
  await resetBlockedCount();
  elStatBlocked.textContent = '0';
  showToast('Contador restablecido');
});

// ─── Inicialización ───────────────────────────────────────────────────────────

/**
 * Punto de entrada: carga configuración y estadísticas, renderiza la UI.
 */
async function init() {
  try {
    currentSettings = await loadSettings();
    renderAll(currentSettings);
    await refreshBlockedCount();

    // Actualizar el contador si el service worker lo incrementa mientras
    // la página de opciones está abierta.
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[STORAGE_STATS_KEY]) {
        const newCount = changes[STORAGE_STATS_KEY].newValue?.blockedCount ?? 0;
        elStatBlocked.textContent = newCount.toLocaleString('es-AR');
      }
    });
  } catch (err) {
    console.error('[DualBlock] Error al cargar configuración:', err);
  }
}

document.addEventListener('DOMContentLoaded', init);
