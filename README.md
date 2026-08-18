# DualBlock — Corporate Edition (DUX ERP)

Extensión de Google Chrome (Manifest V3) que combina la prevención de pestañas duplicadas con un Auto-Launcher específico para DUX ERP. Evita conflictos de sesión en sitios protegidos y, al completar el ingreso a DUX, abre automáticamente el workspace de trabajo fijado.

Fork de DualBlock orientado al flujo operativo diario con DUX.

---

## ¿Qué hace?

### DualBlock Core (anti-duplicados)

Cuando se detecta una URL duplicada en un sitio protegido, la extensión reacciona de forma diferente según cómo se originó la duplicación:

| Situación | Comportamiento |
|-----------|---------------|
| **Click normal** (la pestaña actual navega a una URL ya abierta) | Vuelve atrás en el historial, preservando la pestaña actual |
| **Nueva pestaña** (Ctrl+click, click del medio, "Abrir en nueva pestaña") | Cierra la nueva pestaña y enfoca la ya existente |

En ambos casos:
- **Activa y enfoca** la pestaña original.
- **Muestra una notificación breve** con la opción "Ir a la pestaña existente".

Las pestañas con **URLs diferentes** nunca se ven afectadas.

**Ejemplo — pestañas que pueden coexistir:**
```
https://app.empresa.com/facturas
https://app.empresa.com/clientes
https://app.empresa.com/configuracion
```

**Ejemplo — duplicado bloqueado:**
```
https://app.empresa.com/facturas  ← pestaña original (se mantiene)
https://app.empresa.com/facturas  ← DUPLICADA → se cierra automáticamente
```

### DUX ERP Auto-Launcher

Cuando el usuario completa la selección de sucursal y llega a la pantalla principal (`/duxnew/inicio`), la extensión:

1. Abre automáticamente estas 4 herramientas, **fijadas** (`pinned: true`) y en segundo plano:
   - Módulo POS Ventas (`/duxnew/ventas/pos`)
   - Consulta de Precio y Stock (`/pages/facturacion/consultas/consultaPrecioStock.faces`)
   - Control de Stock en Google Sheets
   - Catálogo Web (`/motos`)
2. Cierra la pestaña de inicio (`/duxnew/inicio`) para dejar la barra limpia.
3. Evita re-ejecuciones con un lock en memoria (`isLaunchingDux`) y un flag de sesión (`chrome.storage.session`), además de comprobar si el workspace ya está abierto.

---

## Instalación (modo desarrollador)

1. Descargá o cloná este repositorio en tu equipo.
2. Abrí Chrome y navegá a `chrome://extensions`.
3. Activá el **Modo desarrollador** (switch en la esquina superior derecha).
4. Hacé clic en **"Cargar descomprimida"**.
5. Seleccioná la carpeta del proyecto.
6. El ícono de DualBlock aparece en la barra de herramientas de Chrome.

---

## Abrir la configuración

- **Clic** en el ícono de DualBlock en la barra de herramientas.
- O desde `chrome://extensions` → DualBlock → **"Detalles"** → **"Opciones de extensión"**.

---

## Configuración disponible

### Protección principal
Switch global para activar o desactivar toda la extensión. Cuando está desactivada, no se bloquea ninguna pestaña.

### Sitios protegidos
Lista de dominios donde se aplica la protección. Por defecto está vacía: el usuario agrega los dominios que necesite.

- **Agregar** un dominio: escribirlo sin protocolo (p.ej. `erp.duxsoftware.com.ar`) y hacer clic en "+ Agregar sitio".
- **Activar/desactivar** cada dominio individualmente con su switch.
- **Eliminar** un dominio con el botón ×.

La extensión también protege subdominios. Si agregás `duxsoftware.com.ar`, también cubrirá `erp.duxsoftware.com.ar`.

### Modo de detección

| Modo | Qué compara | Ejemplo |
|------|-------------|---------|
| **URL exacta** (predeterminado) | Protocolo + dominio + ruta + parámetros + hash | `?id=1` ≠ `?id=2` → NO son duplicadas |
| **Misma página ignorando parámetros** | Protocolo + dominio + ruta | `?id=1` == `?id=2` → SÍ son duplicadas |

### Al detectar un duplicado

- **Cerrar duplicada / volver atrás** (predeterminado): acción inmediata. Si la duplicación fue por nueva pestaña → se cierra; si fue por navegación in-place → vuelve atrás en el historial.
- **Mostrar advertencia antes de actuar**: notificación con botones. Si no se toma ninguna acción en 8 segundos, se aplica la acción correspondiente automáticamente.

### Notificaciones
Muestra un aviso del sistema cuando se bloquea una pestaña. El aviso incluye el botón "Ir a la pestaña existente".

### Estadísticas
Contador local de pestañas duplicadas bloqueadas. Se puede restablecer en cualquier momento.

---

## Cómo funciona internamente

La extensión escucha tres eventos de Chrome:

| Evento | Qué detecta |
|--------|-------------|
| `tabs.onCreated` | Nueva pestaña creada; se registra su ID para saber que es una tab nueva |
| `tabs.onUpdated` | Cambio de URL (anti-duplicados) y carga completa de `/duxnew/inicio` (Auto-Launcher) |
| `tabs.onRemoved` | Cierre de pestaña (para limpiar estado interno) |

**Distinción nueva pestaña vs. navegación in-place:**
Cuando `tabs.onCreated` dispara, el ID de la pestaña se guarda en un Set interno. Si el siguiente `tabs.onUpdated` para ese ID ocurre mientras aún está en el Set → es una **nueva pestaña** → se cierra. Si `tabs.onUpdated` dispara para un ID que no está en el Set → la pestaña ya existía y el usuario navegó desde ella → se vuelve atrás con `chrome.tabs.goBack()`.

Al instalar la extensión o al arrancar Chrome, también revisa las pestañas ya abiertas y cierra duplicados de forma determinista: conserva la de **menor ID** (la más antigua) y cierra las demás.

**Normalización de URLs:**

```
clave = protocolo + dominio + ruta (sin trailing slash) [+ query + hash en modo exacto]
```

Los trailing slashes se normalizan: `/page/` y `/page` se tratan como la misma ruta.

**Auto-Launcher de Dux:**
Cuando `tabs.onUpdated` reporta `status === 'complete'` y la URL contiene `/duxnew/inicio`, se ejecuta `launchDuxWorkspace()`: abre las 4 URLs de trabajo fijadas (con un pequeño stagger entre cada una), marca la sesión como lanzada y cierra la pestaña de inicio. Si el workspace ya está abierto o ya se lanzó en esa sesión de navegador, no vuelve a ejecutar la secuencia.

---

## Casos de uso

- Operadores de DUX ERP que al iniciar sesión necesitan el mismo set de herramientas (POS, consulta de stock, planilla, catálogo)
- ERPs y CRMs con sesiones únicas por pantalla
- Aplicaciones de facturación o gestión donde abrir la misma pantalla dos veces genera conflictos
- Herramientas internas con flujos de trabajo críticos
- Cualquier sitio web donde querés evitar confusión entre pestañas repetidas

---

## Cómo probarlo

### Caso 1 — URLs distintas (deben convivir)
1. Abrí `https://app.empresa.com/seccion-a`
2. Abrí `https://app.empresa.com/seccion-b`
3. ✅ Ambas deben permanecer abiertas.

### Caso 2 — Duplicar una pestaña
1. Tenés una pestaña abierta con una URL de un sitio protegido.
2. Hacé clic derecho → **Duplicar** (o abrí la misma URL en una pestaña nueva).
3. ✅ La nueva pestaña se cierra y se activa la original.

### Caso 3 — Sitios no protegidos (no deben verse afectados)
1. Abrí Google, YouTube, cualquier sitio que no esté en la lista.
2. ✅ La extensión no interviene.

### Caso 4 — Desactivar protección
1. Desactivá la protección desde la configuración.
2. Abrí pestañas duplicadas de un sitio protegido.
3. ✅ Ambas quedan abiertas.

### Caso 5 — Modo "ignorar parámetros"
1. Configurá "Misma página ignorando parámetros".
2. Abrí `https://app.empresa.com/pagina?id=1` y luego `https://app.empresa.com/pagina?id=2`.
3. ✅ La segunda se detecta como duplicada y se cierra.

### Caso 6 — Reiniciar Chrome con pestañas duplicadas
1. Abrí dos pestañas duplicadas de un sitio protegido.
2. Cerrá Chrome (Chrome guarda las pestañas).
3. Volvé a abrirlo.
4. ✅ La extensión detecta y cierra el duplicado en los primeros segundos.

### Caso 7 — Auto-Launcher de Dux
1. Iniciá sesión en DUX y seleccioná sucursal hasta llegar a `/duxnew/inicio`.
2. ✅ Se abren las 4 pestañas de trabajo fijadas en segundo plano.
3. ✅ La pestaña de inicio se cierra.
4. Si volvés a `/duxnew/inicio` en la misma sesión (o con el workspace ya abierto), ✅ no se relanza el workspace.

---

## Privacidad y seguridad

- No envía datos a ningún servidor.
- No recopila historial de navegación ni URLs.
- No usa analytics ni tracking.
- No incluye código remoto ni `eval()`.
- Toda la información permanece en el navegador local.
- Compatible con las políticas de Chrome Web Store.

---

## Permisos

| Permiso | Motivo |
|---------|--------|
| `tabs` | Leer URLs de pestañas, cerrarlas, activarlas, crearlas (Auto-Launcher) y consultar todas las abiertas |
| `storage` | Persistir configuración (`storage.sync`), estadísticas (`storage.local`) y flag de sesión del Auto-Launcher (`storage.session`) |
| `notifications` | Mostrar aviso cuando se bloquea una pestaña duplicada |
| `windows` | Enfocar la ventana que contiene la pestaña original |

---

## Estructura del proyecto

```
DualBlock-DUX/
├── manifest.json      ← Configuración (Manifest V3)
├── background.js      ← Service Worker: anti-duplicados + Auto-Launcher Dux
├── options.html       ← Página de configuración
├── options.css        ← Estilos (modo claro y oscuro)
├── options.js         ← Lógica de la UI de configuración
├── icons/
│   ├── icon16.png
│   ├── icon32.png
│   ├── icon48.png
│   └── icon128.png
└── README.md
```

---

## Limitaciones conocidas de Chrome

| Limitación | Impacto |
|------------|---------|
| Chrome no permite cancelar la creación de una pestaña antes de que exista | La extensión la cierra inmediatamente después; el parpadeo es mínimo (fracción de segundo) |
| Los service workers (MV3) pueden ser terminados por Chrome en cualquier momento | Los timers del modo "advertencia" no sobreviven si el SW se reinicia; la pestaña queda abierta (comportamiento conservador) |
| `tabs.onUpdated` no captura todos los cambios SPA via `history.pushState` en todos los contextos | En apps con navegación de página completa esto no es relevante |
| Botones en notificaciones pueden no aparecer en todos los sistemas operativos | El timer de 8 segundos cierra la pestaña automáticamente de todas formas |

---

## Versión

**1.0.0** — Corporate Edition: DualBlock Core + Auto-Launcher DUX ERP
