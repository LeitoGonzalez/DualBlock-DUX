/**
 * DualBlock — Service Worker (background.js)
 *
 * Detecta pestañas duplicadas en sitios protegidos y las cierra
 * automáticamente, enfocando la pestaña original.
 *
 * Incluye además el módulo Auto-Launcher de Dux: al completar la carga
 * de `/duxnew/inicio`, abre las pestañas de trabajo fijadas y cierra
 * la pestaña de inicio. Al reiniciar Chrome cierra en silencio las
 * pestañas del workspace restauradas (MV3 no permite hacerlo al cerrar).
 *
 * Permisos utilizados:
 *   tabs          — leer URL de pestañas, cerrarlas, activarlas y consultar todas
 *   storage       — persistir configuración y estadísticas localmente
 *   notifications — mostrar aviso cuando se bloquea una pestaña duplicada
 *   windows       — enfocar la ventana que contiene la pestaña original
 */

'use strict';

// ─── Constantes ───────────────────────────────────────────────────────────────

const STORAGE_SETTINGS_KEY = 'settings';
const STORAGE_STATS_KEY    = 'stats';

/** Tiempo de espera en modo "advertencia" antes de cerrar automáticamente (ms). */
const WARN_TIMEOUT_MS = 8000;

/**
 * Fragmento de ruta que dispara el Auto-Launcher de Dux.
 * Se busca dentro del pathname (cubre query string / trailing slash).
 */
const DUX_INICIO_PATH = '/duxnew/inicio';

/** Delay entre cada pestaña abierta por el Auto-Launcher (ms). */
const DUX_LAUNCH_STAGGER_MS = 100;

/**
 * URLs que el Auto-Launcher abre (fijadas, en segundo plano)
 * tras completar la carga de `/duxnew/inicio`.
 */
const DUX_AUTO_LAUNCH_URLS = [
  'https://erp.duxsoftware.com.ar/duxnew/ventas/pos',
  'https://erp.duxsoftware.com.ar/pages/facturacion/consultas/consultaPrecioStock.faces',
  'https://docs.google.com/spreadsheets/d/1JC1Nugx6ah0XP4Q_7P_3RvTVc6t7OPWAc_-XYIkPKXo/edit?gid=1806730843#gid=1806730843',
  'https://catalogo.duxsoftware.com.ar/motos',
];

/**
 * Hosts del workspace DUX. Al arrancar Chrome se cierran pestañas fijadas
 * en estos dominios (pueden haber quedado en login tras restaurar sesión).
 */
const DUX_WORKSPACE_HOSTS = [
  'erp.duxsoftware.com.ar',
  'catalogo.duxsoftware.com.ar',
];

/** ID de la planilla de stock usada por el Auto-Launcher. */
const DUX_STOCK_SHEET_ID = '1JC1Nugx6ah0XP4Q_7P_3RvTVc6t7OPWAc_-XYIkPKXo';

/** Clave en chrome.storage.session: Auto-Launcher ya ejecutado en esta sesión. */
const DUX_LAUNCHED_SESSION_KEY = 'duxWorkspaceLaunched';

/** Clave en chrome.storage.session: ventana de limpieza post-arranque (timestamp). */
const DUX_STARTUP_CLEANUP_UNTIL_KEY = 'duxStartupCleanupUntil';

/** Duración de la ventana de limpieza al arrancar Chrome (ms). */
const DUX_STARTUP_CLEANUP_MS = 5000;

/** Claves normalizadas de las URLs del Auto-Launcher (host + path). */
const DUX_LAUNCH_URL_KEYS = new Set(
  DUX_AUTO_LAUNCH_URLS.map((u) => {
    try {
      const url = new URL(u);
      let pathname = url.pathname;
      if (pathname.length > 1 && pathname.endsWith('/')) {
        pathname = pathname.slice(0, -1);
      }
      return `${url.protocol}//${url.host}${pathname}`;
    } catch {
      return null;
    }
  }).filter(Boolean)
);
/** Configuración por defecto. Se aplica cuando no hay nada guardado en storage. */
const DEFAULT_SETTINGS = {
  enabled: true,
  sites: [],
  comparisonMode: 'exact',      // 'exact' | 'ignore-params'
  behaviorOnDuplicate: 'close', // 'close' | 'warn'
  showNotifications: true,
};

// ─── Estado en memoria ────────────────────────────────────────────────────────

/**
 * Configuración activa (cargada desde storage al iniciar el SW).
 * Se actualiza automáticamente via chrome.storage.onChanged.
 */
let settings = { ...DEFAULT_SETTINGS };

/**
 * IDs de pestañas que están siendo procesadas en este momento.
 * Evita que el evento onUpdated / onCreated que dispara el propio cierre
 * de la pestaña vuelva a iniciar la lógica de detección (bucle infinito).
 */
const processingTabs = new Set();

/**
 * IDs de pestañas recién creadas (aún no han recibido su primer onUpdated).
 * Permite distinguir entre:
 *   - Navegación en la misma pestaña → tab NO está en este Set → volver atrás
 *   - Nueva pestaña duplicada        → tab SÍ está en este Set → cerrar
 * Se limpia en onUpdated (tras leer el flag) y en onRemoved como safety net.
 */
const newlyCreatedTabs = new Set();

/**
 * Timers pendientes del modo "advertencia".
 * Mapa: tabId → { timerId, notifId, originalTab, url }
 * Nota: los setTimeout no sobreviven a la terminación del service worker;
 * si el SW muere mientras el timer está activo, la pestaña simplemente
 * quedará abierta (comportamiento conservador / no destructivo).
 */
const warnTimers = new Map();

/**
 * Lock del Auto-Launcher de Dux.
 * Evita re-disparos concurrentes mientras la secuencia está en curso.
 * El "ya lanzó en esta sesión" vive en chrome.storage.session.
 */
let isLaunchingDux = false;

/**
 * Hasta cuándo (Date.now) está activa la limpieza de workspace al arrancar.
 * Durante esta ventana las pestañas DUX restauradas se cierran en silencio
 * (sin pasar por la lógica anti-duplicados / notificaciones).
 */
let startupCleanupUntil = 0;

// ─── Utilidades de URL ────────────────────────────────────────────────────────

/**
 * Normaliza una URL para compararla con otras según el modo configurado.
 *
 * Modo 'exact' (predeterminado):
 *   Compara: protocolo + dominio + ruta + query string + hash
 *   Ejemplo: "…/factura.faces?id=1#top" ≠ "…/factura.faces?id=2"
 *
 * Modo 'ignore-params':
 *   Compara: protocolo + dominio + ruta (ignora query string y hash)
 *   Ejemplo: "…/factura.faces?id=1" == "…/factura.faces?id=2"
 *
 * En ambos modos se elimina el trailing slash de la ruta (salvo la raíz "/")
 * para evitar falsos negativos por ese motivo.
 *
 * @param {string} rawUrl - URL a normalizar
 * @param {'exact'|'ignore-params'} mode - Modo de comparación
 * @returns {string} Clave de comparación
 */
function normalizeUrl(rawUrl, mode) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return rawUrl; // URL inválida: usar cadena cruda como clave
  }

  // Eliminar trailing slash de la ruta (excepto si la ruta es solo "/")
  let pathname = url.pathname;
  if (pathname.length > 1 && pathname.endsWith('/')) {
    pathname = pathname.slice(0, -1);
  }

  if (mode === 'ignore-params') {
    return `${url.protocol}//${url.host}${pathname}`;
  }

  // Modo 'exact': incluir query string y hash
  return `${url.protocol}//${url.host}${pathname}${url.search}${url.hash}`;
}

/**
 * Determina si una URL pertenece a alguno de los sitios protegidos activos.
 *
 * @param {string} rawUrl
 * @returns {boolean}
 */
function isProtectedUrl(rawUrl) {
  if (!rawUrl) return false;

  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }

  // Solo HTTP y HTTPS; ignorar chrome://, file://, etc.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;

  const host = url.hostname.toLowerCase();

  return settings.sites.some((site) => {
    if (!site.enabled) return false;
    const domain = site.domain.toLowerCase().trim();
    // Coincidencia exacta o subdominio del dominio configurado
    return host === domain || host.endsWith('.' + domain);
  });
}

/**
 * Devuelve true si la URL es una URL de sistema que debemos ignorar.
 *
 * @param {string} url
 * @returns {boolean}
 */
function isSystemUrl(url) {
  if (!url) return true;
  return (
    url === 'about:blank'      ||
    url === 'about:newtab'     ||
    url.startsWith('chrome://') ||
    url.startsWith('chrome-extension://') ||
    url.startsWith('edge://')
  );
}

// ─── Lógica de detección ──────────────────────────────────────────────────────

/**
 * Busca en todas las pestañas abiertas si alguna (distinta a `newTabId`)
 * tiene la misma URL normalizada y pertenece a un sitio protegido.
 *
 * Para garantizar determinismo cuando hay múltiples candidatas, devuelve
 * la pestaña con menor ID (la más antigua).
 *
 * @param {number} newTabId - ID de la pestaña que se acaba de crear/cambiar
 * @param {string} newUrl   - URL a comparar
 * @returns {Promise<chrome.tabs.Tab|null>}
 */
async function findOriginalTab(newTabId, newUrl) {
  const newKey = normalizeUrl(newUrl, settings.comparisonMode);

  let allTabs;
  try {
    allTabs = await chrome.tabs.query({});
  } catch {
    return null;
  }

  let originalTab = null;

  for (const tab of allTabs) {
    if (tab.id === newTabId) continue;
    if (!tab.url || isSystemUrl(tab.url)) continue;
    if (!isProtectedUrl(tab.url)) continue;

    const existingKey = normalizeUrl(tab.url, settings.comparisonMode);
    if (existingKey !== newKey) continue;

    // Candidata encontrada; quedarse con la de menor ID (más antigua)
    if (originalTab === null || tab.id < originalTab.id) {
      originalTab = tab;
    }
  }

  return originalTab;
}

// ─── Estadísticas ─────────────────────────────────────────────────────────────

/**
 * Incrementa el contador de duplicados bloqueados en chrome.storage.local.
 * Usa storage.local (no sync) para no sincronizar el contador entre dispositivos.
 */
async function incrementBlockedCount() {
  try {
    const data  = await chrome.storage.local.get(STORAGE_STATS_KEY);
    const stats = data[STORAGE_STATS_KEY] || { blockedCount: 0 };
    stats.blockedCount = (stats.blockedCount ?? 0) + 1;
    await chrome.storage.local.set({ [STORAGE_STATS_KEY]: stats });
  } catch {
    // No crítico; el contador puede quedar desfasado
  }
}

// ─── Notificaciones ───────────────────────────────────────────────────────────

/**
 * Muestra una notificación informando que se bloqueó una pestaña duplicada.
 * El botón "Ir a la pestaña existente" activa la pestaña original.
 *
 * @param {number} originalTabId - ID de la pestaña que se conservó
 * @param {number} originalWindowId - ID de la ventana de la pestaña original
 * @param {string} url           - URL que se consideró duplicada
 */
function showBlockedNotification(originalTabId, originalWindowId, url) {
  if (!settings.showNotifications) return;

  let path = url;
  try {
    path = new URL(url).pathname;
  } catch { /* usar url cruda */ }

  const notifId = `blocked-${Date.now()}`;

  chrome.notifications.create(notifId, {
    type: 'basic',
    iconUrl: 'icons/icon48.png',
    title: 'DualBlock',
    message: `Esta página ya está abierta en otra pestaña.\n${path}`,
    buttons: [{ title: 'Ir a la pestaña existente' }],
    priority: 1,
  }, () => {
    if (chrome.runtime.lastError) return;

    const onButton = (id, btnIndex) => {
      if (id !== notifId || btnIndex !== 0) return;
      chrome.notifications.onButtonClicked.removeListener(onButton);
      chrome.notifications.clear(notifId).catch(() => {});
      chrome.tabs.update(originalTabId, { active: true }).catch(() => {});
      chrome.windows.update(originalWindowId, { focused: true }).catch(() => {});
    };

    chrome.notifications.onButtonClicked.addListener(onButton);

    // Limpiar listener tras 60 s para no acumular listeners huérfanos
    setTimeout(() => {
      chrome.notifications.onButtonClicked.removeListener(onButton);
    }, 60_000);
  });
}

// ─── Acciones sobre pestañas ──────────────────────────────────────────────────

/**
 * Maneja la pestaña duplicada según cómo fue originada:
 *
 *   isNewTab = true  → la pestaña fue recién creada (Ctrl+click, "abrir en nueva pestaña", etc.)
 *                      → se cierra y se enfoca la original (comportamiento original).
 *
 *   isNewTab = false → una pestaña existente navegó a una URL ya abierta (click normal)
 *                      → se vuelve atrás en el historial para no perder la pestaña actual.
 *                      Si no hay historial previo (tab abierta directamente en esa URL),
 *                      goBack() no hace nada; la pestaña queda donde está.
 *
 * @param {number} duplicateTabId
 * @param {chrome.tabs.Tab} originalTab
 * @param {string} url
 * @param {boolean} isNewTab
 */
async function closeDuplicateAndFocus(duplicateTabId, originalTab, url, isNewTab) {
  if (isNewTab) {
    try {
      await chrome.tabs.remove(duplicateTabId);
    } catch {
      // La pestaña puede haberse cerrado ya; continuar de todos modos
    }
  } else {
    // Volver atrás en la pestaña que navegó al duplicado
    try {
      await chrome.tabs.goBack(duplicateTabId);
    } catch {
      // goBack puede fallar si no hay historial; la pestaña queda donde está
    }
  }

  try {
    await chrome.tabs.update(originalTab.id, { active: true });
    await chrome.windows.update(originalTab.windowId, { focused: true });
  } catch {
    // Si la pestaña original ya no existe, no hacer nada
  }

  showBlockedNotification(originalTab.id, originalTab.windowId, url);
}

/**
 * Modo "advertencia": muestra una notificación con botones y cierra
 * automáticamente tras WARN_TIMEOUT_MS si el usuario no interviene.
 *
 * @param {number} duplicateTabId
 * @param {chrome.tabs.Tab} originalTab
 * @param {string} url
 * @param {boolean} isNewTab
 */
async function handleWarnMode(duplicateTabId, originalTab, url, isNewTab) {
  // Sin notificaciones habilitadas, actuar directamente
  if (!settings.showNotifications) {
    await closeDuplicateAndFocus(duplicateTabId, originalTab, url, isNewTab);
    return;
  }

  let path = url;
  try {
    path = new URL(url).pathname;
  } catch { /* usar url cruda */ }

  const notifId = `warn-${duplicateTabId}-${Date.now()}`;
  const seconds = Math.round(WARN_TIMEOUT_MS / 1000);

  chrome.notifications.create(notifId, {
    type: 'basic',
    iconUrl: 'icons/icon48.png',
    title: 'DualBlock — Duplicado detectado',
    message: `Esta pantalla ya está abierta en otra pestaña:\n${path}\n\nSe cerrará en ${seconds} segundos.`,
    buttons: [
      { title: 'Cerrar ahora y volver a la original' },
      { title: 'Mantener ambas pestañas' },
    ],
    requireInteraction: false,
    priority: 2,
  }, () => {
    if (chrome.runtime.lastError) {
      // Si no se pudo crear la notificación, actuar directamente
      closeDuplicateAndFocus(duplicateTabId, originalTab, url, isNewTab);
      return;
    }
  });

  // Timer de auto-acción
  const timerId = setTimeout(async () => {
    warnTimers.delete(duplicateTabId);
    chrome.notifications.clear(notifId).catch(() => {});
    await closeDuplicateAndFocus(duplicateTabId, originalTab, url, isNewTab);
  }, WARN_TIMEOUT_MS);

  warnTimers.set(duplicateTabId, { timerId, notifId, originalTab, url, isNewTab });

  // Handler de botones de la notificación
  const onButton = async (id, btnIndex) => {
    if (id !== notifId) return;

    chrome.notifications.onButtonClicked.removeListener(onButton);
    chrome.notifications.onClosed.removeListener(onClosed);

    const entry = warnTimers.get(duplicateTabId);
    if (entry) {
      clearTimeout(entry.timerId);
      warnTimers.delete(duplicateTabId);
    }
    chrome.notifications.clear(notifId).catch(() => {});

    if (btnIndex === 0) {
      // Volver atrás o cerrar según origen
      await closeDuplicateAndFocus(duplicateTabId, originalTab, url, isNewTab);
    } else {
      // Mantener ambas; liberar el bloqueo de procesamiento
      processingTabs.delete(duplicateTabId);
    }
  };

  // Si la notificación se cierra sin clic (se descarta o expira en el centro),
  // el timer sigue corriendo y cerrará la pestaña al vencer.
  const onClosed = (id) => {
    if (id !== notifId) return;
    chrome.notifications.onClosed.removeListener(onClosed);
    chrome.notifications.onButtonClicked.removeListener(onButton);
  };

  chrome.notifications.onButtonClicked.addListener(onButton);
  chrome.notifications.onClosed.addListener(onClosed);
}

/**
 * Punto de entrada para manejar una pestaña detectada como duplicada.
 *
 * @param {number} duplicateTabId
 * @param {chrome.tabs.Tab} originalTab
 * @param {string} url
 * @param {boolean} isNewTab - true si la pestaña fue recién creada (nueva pestaña);
 *                             false si es una pestaña existente que navegó a la URL duplicada.
 */
async function handleDuplicate(duplicateTabId, originalTab, url, isNewTab) {
  processingTabs.add(duplicateTabId);

  try {
    await incrementBlockedCount();

    if (settings.behaviorOnDuplicate === 'warn') {
      await handleWarnMode(duplicateTabId, originalTab, url, isNewTab);
    } else {
      await closeDuplicateAndFocus(duplicateTabId, originalTab, url, isNewTab);
    }
  } finally {
    // Liberar el bloqueo con un pequeño retraso para absorber los eventos
    // que Chrome dispara al cerrar la propia pestaña.
    if (settings.behaviorOnDuplicate !== 'warn') {
      setTimeout(() => processingTabs.delete(duplicateTabId), 1500);
    }
  }
}

// ─── Punto de entrada: verificar una pestaña ──────────────────────────────────

/**
 * Verifica si una pestaña con una URL determinada es duplicada de otra ya abierta.
 * Llama a handleDuplicate si se confirma la duplicación.
 *
 * @param {number} tabId
 * @param {string} url
 * @param {boolean} isNewTab - true si la pestaña fue recién creada; false si navegó in-place.
 */
async function checkTab(tabId, url, isNewTab) {
  if (!settings.enabled)    return;
  if (isSystemUrl(url))     return;
  if (processingTabs.has(tabId)) return;

  // Al arrancar: el workspace restaurado se cierra en silencio, no como "duplicado".
  if (isStartupCleanupActive() && isDuxWorkspaceUrl(url, false)) {
    await closeDuxWorkspaceTab(tabId);
    return;
  }

  if (!isProtectedUrl(url)) return;

  const originalTab = await findOriginalTab(tabId, url);
  if (!originalTab) return;

  await handleDuplicate(tabId, originalTab, url, isNewTab);
}

// ─── Verificación inicial de pestañas existentes ──────────────────────────────

/**
 * Al instalar o arrancar Chrome, revisa las pestañas ya abiertas y cierra
 * las duplicadas de forma determinista:
 *   - Ordena por ID ascendente → el de menor ID es el más "antiguo".
 *   - Conserva el primero (menor ID) y cierra los demás duplicados.
 *
 * Si dos pestañas tienen la misma URL exacta al arrancar Chrome, se cierra
 * la de mayor ID y se conserva la de menor ID.
 */
async function checkExistingTabs() {
  if (!settings.enabled) return;

  let allTabs;
  try {
    allTabs = await chrome.tabs.query({});
  } catch {
    return;
  }

  const cleaningStartup = isStartupCleanupActive();

  // Filtrar solo pestañas de sitios protegidos con URL válida.
  // En el arranque se excluye el workspace DUX: lo limpia cleanupRestoredDuxWorkspaceTabs.
  const protectedTabs = allTabs
    .filter((t) => {
      if (!t.url || isSystemUrl(t.url) || !isProtectedUrl(t.url)) return false;
      if (cleaningStartup && isDuxWorkspaceTab(t)) return false;
      return true;
    })
    .sort((a, b) => a.id - b.id); // menor ID primero = más antiguo

  // urlMap: clave normalizada → primera pestaña encontrada (la más antigua)
  const urlMap = new Map();

  for (const tab of protectedTabs) {
    const key = normalizeUrl(tab.url, settings.comparisonMode);

    if (!urlMap.has(key)) {
      urlMap.set(key, tab);
    } else {
      // Duplicada: cerrar esta (tiene ID mayor)
      processingTabs.add(tab.id);
      try {
        await chrome.tabs.remove(tab.id);
        await incrementBlockedCount();
        const original = urlMap.get(key);
        showBlockedNotification(original.id, original.windowId, tab.url);
      } catch { /* ignorar si ya estaba cerrada */ }
      setTimeout(() => processingTabs.delete(tab.id), 1500);
    }
  }
}

// ─── Carga de configuración ───────────────────────────────────────────────────

/**
 * Carga la configuración guardada desde chrome.storage.sync.
 * Combina con DEFAULT_SETTINGS para asegurar que todos los campos existen.
 */
async function loadSettings() {
  try {
    const data = await chrome.storage.sync.get(STORAGE_SETTINGS_KEY);
    if (data[STORAGE_SETTINGS_KEY]) {
      settings = { ...DEFAULT_SETTINGS, ...data[STORAGE_SETTINGS_KEY] };
      if (!Array.isArray(settings.sites)) {
        settings.sites = DEFAULT_SETTINGS.sites;
      }
    }
  } catch {
    settings = { ...DEFAULT_SETTINGS };
  }
}

// ─── Auto-Launcher de Dux ─────────────────────────────────────────────────────

/**
 * Devuelve true si la URL corresponde a la pantalla de inicio de Dux
 * que dispara el Auto-Launcher (`/duxnew/inicio`).
 *
 * @param {string} rawUrl
 * @returns {boolean}
 */
function isDuxInicioUrl(rawUrl) {
  if (!rawUrl) return false;

  try {
    return new URL(rawUrl).pathname.includes(DUX_INICIO_PATH);
  } catch {
    return rawUrl.includes(DUX_INICIO_PATH);
  }
}

/**
 * Espera `ms` milisegundos. Usado para el stagger entre pestañas.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Normaliza una URL de launch para comparar "¿ya está abierta?".
 * Usa protocolo + host + pathname (sin trailing slash).
 *
 * @param {string} rawUrl
 * @returns {string|null}
 */
function launchUrlKey(rawUrl) {
  try {
    const url = new URL(rawUrl);
    let pathname = url.pathname;
    if (pathname.length > 1 && pathname.endsWith('/')) {
      pathname = pathname.slice(0, -1);
    }
    return `${url.protocol}//${url.host}${pathname}`;
  } catch {
    return null;
  }
}

/**
 * Devuelve true si el workspace de Dux ya fue lanzado en esta sesión
 * de navegador (sobrevive reinicios del service worker).
 *
 * @returns {Promise<boolean>}
 */
async function hasLaunchedDuxThisSession() {
  try {
    const data = await chrome.storage.session.get(DUX_LAUNCHED_SESSION_KEY);
    return data[DUX_LAUNCHED_SESSION_KEY] === true;
  } catch {
    return false;
  }
}

/**
 * Marca el Auto-Launcher como ya ejecutado en esta sesión de navegador.
 */
async function markDuxLaunchedThisSession() {
  try {
    await chrome.storage.session.set({ [DUX_LAUNCHED_SESSION_KEY]: true });
  } catch {
    // No crítico; el lock en memoria sigue cubriendo el disparo concurrente
  }
}

/**
 * True mientras corre la limpieza de pestañas restauradas al arrancar Chrome.
 *
 * @returns {boolean}
 */
function isStartupCleanupActive() {
  return Date.now() < startupCleanupUntil;
}

/**
 * Termina la ventana de limpieza de arranque.
 * Se llama al disparar el Auto-Launcher para no cerrar las pestañas
 * que acabamos de abrir a propósito.
 */
function endStartupCleanup() {
  startupCleanupUntil = 0;
  chrome.storage.session.remove(DUX_STARTUP_CLEANUP_UNTIL_KEY).catch(() => {});
}

/**
 * Activa la ventana de limpieza post-arranque y persiste el deadline
 * por si el service worker se reinicia durante esos segundos.
 *
 * @param {number} [durationMs]
 */
async function beginStartupCleanup(durationMs = DUX_STARTUP_CLEANUP_MS) {
  startupCleanupUntil = Date.now() + durationMs;
  try {
    await chrome.storage.session.set({
      [DUX_STARTUP_CLEANUP_UNTIL_KEY]: startupCleanupUntil,
    });
  } catch {
    // El flag en memoria alcanza si el SW no muere
  }
}

/**
 * Restaura el deadline de limpieza si el SW se reinició a mitad del arranque.
 */
async function restoreStartupCleanupDeadline() {
  if (isStartupCleanupActive()) return;
  try {
    const data = await chrome.storage.session.get(DUX_STARTUP_CLEANUP_UNTIL_KEY);
    const until = data[DUX_STARTUP_CLEANUP_UNTIL_KEY];
    if (typeof until === 'number' && Date.now() < until) {
      startupCleanupUntil = until;
    }
  } catch {
    // ignorar
  }
}

/**
 * ¿La URL pertenece al workspace del Auto-Launcher?
 *
 * @param {string} rawUrl
 * @param {boolean} treatPinnedHostAsWorkspace - si true, cualquier URL en hosts
 *   DUX / planilla cuenta (para pestañas fijadas redirigidas al login).
 * @returns {boolean}
 */
function isDuxWorkspaceUrl(rawUrl, treatPinnedHostAsWorkspace) {
  if (!rawUrl || isSystemUrl(rawUrl)) return false;

  const key = launchUrlKey(rawUrl);
  if (key && DUX_LAUNCH_URL_KEYS.has(key)) return true;

  if (!treatPinnedHostAsWorkspace) return false;

  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();

    if (DUX_WORKSPACE_HOSTS.some((h) => host === h || host.endsWith('.' + h))) {
      return true;
    }

    if (
      host === 'docs.google.com' &&
      url.pathname.includes(`/spreadsheets/d/${DUX_STOCK_SHEET_ID}`)
    ) {
      return true;
    }
  } catch {
    return false;
  }

  return false;
}

/**
 * Indica si una pestaña pertenece al workspace que abre el Auto-Launcher.
 *
 * @param {chrome.tabs.Tab} tab
 * @returns {boolean}
 */
function isDuxWorkspaceTab(tab) {
  if (!tab) return false;
  const url = tab.url || tab.pendingUrl;
  if (!url || isSystemUrl(url)) return false;

  // URLs exactas del launch: siempre (aunque Chrome ya las haya desfijado).
  if (isDuxWorkspaceUrl(url, false)) return true;

  // En hosts DUX / planilla solo si sigue fijada (caso login tras restore).
  if (tab.pinned && isDuxWorkspaceUrl(url, true)) return true;

  return false;
}

/**
 * Cierra una pestaña del workspace en silencio (sin notificación de duplicado).
 * No hace falta desfijar antes: tabs.remove funciona con pestañas fijadas.
 *
 * @param {number} tabId
 */
async function closeDuxWorkspaceTab(tabId) {
  if (processingTabs.has(tabId)) return;
  processingTabs.add(tabId);

  try {
    await chrome.tabs.remove(tabId);
  } catch {
    // Puede haberse cerrado sola durante la restauración
  }

  setTimeout(() => processingTabs.delete(tabId), 1000);
}

/**
 * Al arrancar Chrome, cierra en paralelo las pestañas del workspace DUX
 * que Chrome restauró de la sesión anterior.
 *
 * No es posible limpiarlas al cerrar el navegador (MV3 no notifica a tiempo).
 * Durante la ventana de startup también se cierran al vuelo desde onCreated/onUpdated.
 */
async function cleanupRestoredDuxWorkspaceTabs() {
  let allTabs;
  try {
    allTabs = await chrome.tabs.query({});
  } catch {
    return;
  }

  const toClose = allTabs.filter(isDuxWorkspaceTab);
  await Promise.all(toClose.map((tab) => closeDuxWorkspaceTab(tab.id)));
}

/**
 * Si estamos en la ventana de limpieza de arranque y la pestaña es del
 * workspace, la cierra en silencio y devuelve true (el caller no debe
 * pasar por anti-duplicados ni Auto-Launcher).
 *
 * @param {chrome.tabs.Tab} tab
 * @returns {Promise<boolean>}
 */
async function tryCleanupRestoredDuxTab(tab) {
  if (!isStartupCleanupActive()) return false;
  if (!isDuxWorkspaceTab(tab)) return false;
  await closeDuxWorkspaceTab(tab.id);
  return true;
}
/**
 * Cierra pestañas que ya tienen las URLs del Auto-Launcher.
 * Usado antes de relanzar para no quedar bloqueados por restos de otra sesión
 * (p.ej. pestañas restauradas en un perfil con "continuar donde lo dejaste").
 *
 * @param {number} [exceptTabId]
 */
async function closeExistingDuxLaunchTabs(exceptTabId) {
  let allTabs;
  try {
    allTabs = await chrome.tabs.query({});
  } catch {
    return;
  }

  const toClose = allTabs.filter((tab) => {
    if (exceptTabId != null && tab.id === exceptTabId) return false;
    const url = tab.url || tab.pendingUrl;
    return url && isDuxWorkspaceUrl(url, false);
  });

  await Promise.all(toClose.map((tab) => closeDuxWorkspaceTab(tab.id)));
}

/**
 * Abre las pestañas de trabajo de Dux (fijadas, en segundo plano) y
 * cierra la pestaña de `/duxnew/inicio` que disparó el flujo.
 *
 * Se ejecuta una sola vez por sesión de navegador:
 *   - Lock en memoria (`isLaunchingDux`) contra disparos concurrentes.
 *   - Flag en `chrome.storage.session` contra revisitas a `/duxnew/inicio`.
 *   - Si quedaron pestañas viejas del workspace, las cierra y lanza de nuevo
 *     (evita el falso “ya está abierto” tras restaurar sesión en otro perfil).
 *
 * No altera la lógica anti-duplicados: las pestañas creadas pasan por
 * los listeners normales de DualBlock.
 *
 * @param {number} triggerTabId - ID de la pestaña `/duxnew/inicio`
 */
async function launchDuxWorkspace(triggerTabId) {
  if (isLaunchingDux) return;

  // Marcar ya (antes de cualquier await) para que la limpieza de arranque
  // no mate las pestañas que vamos a crear, y para serializar reentradas.
  isLaunchingDux = true;
  endStartupCleanup();

  try {
    if (await hasLaunchedDuxThisSession()) return;

    // Restos restaurados / de otro login no deben bloquear el lanzamiento.
    await closeExistingDuxLaunchTabs(triggerTabId);

    for (let i = 0; i < DUX_AUTO_LAUNCH_URLS.length; i++) {
      if (i > 0) {
        await delay(DUX_LAUNCH_STAGGER_MS);
      }

      try {
        await chrome.tabs.create({
          url: DUX_AUTO_LAUNCH_URLS[i],
          pinned: true,
          active: false,
        });
      } catch {
        // Continuar con el resto si una pestaña falla al crearse
      }
    }

    await markDuxLaunchedThisSession();

    try {
      await chrome.tabs.remove(triggerTabId);
    } catch {
      // La pestaña de inicio puede haberse cerrado ya
    }
  } finally {
    isLaunchingDux = false;
  }
}

// ─── Listeners de Chrome ──────────────────────────────────────────────────────

/**
 * Nueva pestaña creada.
 * Se registra en newlyCreatedTabs para distinguirla de una navegación in-place.
 * A veces Chrome asigna la URL en el momento de creación (e.g. abrir enlace
 * en nueva pestaña en segundo plano). Se verifica si la URL ya está asignada.
 */
chrome.tabs.onCreated.addListener((tab) => {
  newlyCreatedTabs.add(tab.id);

  // Arranque: cerrar workspace restaurado al instante (antes del anti-duplicados).
  // No limpiar mientras el Auto-Launcher está creando pestañas a propósito.
  if (isStartupCleanupActive() && !isLaunchingDux) {
    tryCleanupRestoredDuxTab(tab).then((closed) => {
      if (closed) {
        newlyCreatedTabs.delete(tab.id);
        return;
      }
      const url = tab.url || tab.pendingUrl;
      if (url && !isSystemUrl(url)) {
        checkTab(tab.id, url, true);
      }
    });
    return;
  }

  const url = tab.url || tab.pendingUrl;
  if (url && !isSystemUrl(url)) {
    checkTab(tab.id, url, true);
  }
});

/**
 * Una pestaña cambió su URL o estado.
 *
 * Rama DualBlock (changeInfo.url):
 *   Captura navegación, pegar URL, favoritos, historial, enlaces, etc.
 *   Si el tabId está en newlyCreatedTabs → tab nueva → isNewTab = true (cerrar).
 *   Si no está → navegación in-place → isNewTab = false (volver atrás).
 *
 * Rama Auto-Launcher:
 *   Dispara al detectar `/duxnew/inicio` por cambio de URL o por carga completa.
 *   (DUX a veces llega a inicio vía navegación SPA tras el login; el click en
 *   Home sí hacía full load — por eso antes solo funcionaba en el segundo caso.)
 */
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Usar changeInfo.url si tab.url aún no se actualizó (típico al restaurar sesión).
  const effectiveTab = changeInfo.url ? { ...tab, url: changeInfo.url } : tab;
  const url = effectiveTab.url || changeInfo.url;

  // Auto-Launcher de Dux — post-login (URL change o load complete)
  if (url && isDuxInicioUrl(url) && (changeInfo.url || changeInfo.status === 'complete')) {
    launchDuxWorkspace(tabId);
  }

  // Arranque: cerrar workspace apenas tenga URL (sin notificar como duplicado).
  if (
    isStartupCleanupActive() &&
    !isLaunchingDux &&
    (changeInfo.url || changeInfo.status === 'complete')
  ) {
    if (isDuxWorkspaceTab(effectiveTab)) {
      newlyCreatedTabs.delete(tabId);
      closeDuxWorkspaceTab(tabId);
      return;
    }
  }

  // DualBlock — detección de duplicados
  if (changeInfo.url) {
    const isNewTab = newlyCreatedTabs.has(tabId);
    newlyCreatedTabs.delete(tabId);
    checkTab(tabId, changeInfo.url, isNewTab);
  }
});

/**
 * Una pestaña fue cerrada.
 * Limpiar su estado de procesamiento y cancelar cualquier timer de advertencia.
 */
chrome.tabs.onRemoved.addListener((tabId) => {
  processingTabs.delete(tabId);
  newlyCreatedTabs.delete(tabId);

  const entry = warnTimers.get(tabId);
  if (entry) {
    clearTimeout(entry.timerId);
    chrome.notifications.clear(entry.notifId).catch(() => {});
    warnTimers.delete(tabId);
  }
});

/**
 * Mensaje del content script en erp.duxsoftware.com.ar:
 * la página (o el router SPA) llegó a `/duxnew/inicio`.
 */
chrome.runtime.onMessage.addListener((message, sender) => {
  if (!message || message.type !== 'dux-inicio') return;
  if (!sender.tab || sender.tab.id == null) return;
  launchDuxWorkspace(sender.tab.id);
});

/**
 * El usuario guardó nueva configuración desde la página de opciones.
 * Actualizar la configuración en memoria sin recargar el service worker.
 */
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes[STORAGE_SETTINGS_KEY]) {
    const newValue = changes[STORAGE_SETTINGS_KEY].newValue;
    if (newValue) {
      settings = { ...DEFAULT_SETTINGS, ...newValue };
      if (!Array.isArray(settings.sites)) {
        settings.sites = DEFAULT_SETTINGS.sites;
      }
    }
  }
});

/**
 * Clic en el ícono de la extensión en la barra de herramientas.
 * Abre la página de opciones.
 */
chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

/**
 * Instalación o actualización de la extensión.
 * En instalación: guardar configuración por defecto.
 * En cualquier caso: verificar pestañas existentes.
 */
chrome.runtime.onInstalled.addListener(async (details) => {
  await loadSettings();

  if (details.reason === 'install') {
    await chrome.storage.sync.set({ [STORAGE_SETTINGS_KEY]: settings });
  }

  // Pequeño delay para que Chrome termine de inicializar todas las pestañas
  setTimeout(checkExistingTabs, 600);
});

/**
 * Chrome arrancó (con la extensión ya instalada y pestañas restauradas).
 * Limpia el workspace DUX de inmediato y en paralelo; el anti-duplicados
 * espera un momento para no competir con esa limpieza.
 */
chrome.runtime.onStartup.addListener(async () => {
  await loadSettings();
  await beginStartupCleanup();
  await cleanupRestoredDuxWorkspaceTabs();

  // Segunda pasada por si Chrome restaura alguna pestaña fijada más tarde.
  setTimeout(cleanupRestoredDuxWorkspaceTabs, 600);
  setTimeout(cleanupRestoredDuxWorkspaceTabs, 1500);

  // Anti-duplicados genérico después de la limpieza inicial.
  setTimeout(checkExistingTabs, 700);
});

// Si el SW se reinicia durante el arranque, recuperar la ventana de limpieza.
restoreStartupCleanupDeadline();
// Carga inicial de settings (por si el SW se reinicia entre eventos)
loadSettings();
