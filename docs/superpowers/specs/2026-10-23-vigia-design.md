# VigIA — vigilante de cuotas de IA

Fecha: 2026-10-23 · Estado: borrador para revisión

## 1. Intención

Gloria paga (o usa gratis) diez herramientas de IA para programar. Cada una tiene una cuota que se renueva cada cierto tiempo y lo que no se gasta se pierde. VigIA vigila esas cuotas y le avisa por Telegram para:

1. **Gastar lo que queda antes de que se pierda** ("úsalo o piérdelo").
2. **Saber cuándo vuelve a tener cuota** en algo que había agotado.
3. **Ver de un vistazo** el estado de todo (bot con comandos + página web).
4. **Detectar planes que le sobran** (historial de consumo).

Requisito transversal: **lo más automático posible**. Se aceptan métodos frágiles (endpoints internos, cookies, archivos locales), pero cuando fallen **tiene que avisar**, nunca fallar en silencio.

## 2. Objetivos, no objetivos, anti-objetivos

**Objetivos**
- Leer automáticamente consumo restante y fecha de renovación de las 10 herramientas (§5).
- Avisos por Telegram (§6) y bot con comandos (§7).
- Página de estado privada con historial (§8).

**No objetivos**
- Groq (descartado explícitamente).
- Avisos sobre ventanas de 5 horas (Codex, opencode Go, Antigravity) ni sobre la cuota diaria de Freebuff.
- Email (sustituido por Telegram).
- Multiusuario: es una herramienta personal de una sola persona.

**Anti-objetivos (sería un fracaso aunque "funcione")**
- Que una lectura **gaste cuota** (p. ej. `agy` sin `/usage` como comando, o llamar a endpoints de "consume"/"redeem").
- Que una credencial caduque y el sistema **siga sin decir nada**.
- Spam: repetir el mismo aviso cada comprobación.
- Arriesgar baneos: para Antigravity **no** se usa el OAuth de Google desde la nube.
- Tratar una compra de créditos extra como "renovación".

## 3. Decisiones tomadas

Por Gloria:
- Canal: **bot de Telegram**, con **comandos** (no solo notificaciones).
- Umbrales "úsalo o piérdelo": cuota **semanal → 1 día antes** de la renovación; **mensual → 4 días antes**. Se avisa **siempre que quede algo (>0%)**; si no queda nada, no se avisa.
- Todos los "úsalo o piérdelo" de una misma comprobación van **en un único mensaje**, ordenados por prioridad.
- Las credenciales pueden vivir en la nube cifradas como secretos.
- Antigravity se lee **en local** vía `agy -p /usage --output-format json` (verificado en su máquina: `num_turns: 0`, 0 tokens).
- Resumen semanal: **sí**, por Telegram.
- Funcionalidades extra elegidas: prioridad de uso, página de estado, historial / "¿me sobra el plan?".
- No tiene ningún equipo siempre encendido; solo su portátil Linux.

Llamadas mías (revisables):
- **Lenguaje:** TypeScript. Gestor de paquetes **pnpm**. Monorepo con workspaces.
- **Nube:** Cloudflare Workers (plan gratis): Cron Triggers, webhook de Telegram, página de estado, base de datos D1 (SQLite). Motivo: hace falta algo escuchando siempre para los comandos; GitHub Actions no sirve para eso.
- **Local:** un agente en el portátil ejecutado por un `systemd --user` timer (cada 30 min y al arrancar sesión).
- **Página de estado protegida con Cloudflare Access** (gratis, login por email de Gloria).

## 4. Arquitectura

```
 Portátil (agente local, systemd timer)          Cloudflare
 ┌──────────────────────────────┐   HTTPS   ┌──────────────────────────────────┐
 │ - agy /usage (Antigravity)   │ ───────▶  │ Worker                           │
 │ - token Cursor (state.vscdb) │  /ingest  │  - cron: lee proveedores "nube"  │
 │ - cookies navegador          │  (token   │  - /ingest: recibe snapshots     │
 │   (MiMo, opencode)           │  secreto) │    y credenciales frescas        │
 └──────────────────────────────┘           │  - motor de avisos               │
                                            │  - webhook Telegram (/comandos)  │
                                            │  - página de estado (Access)     │
                                            │  D1: snapshots, avisos, creds    │
                                            └───────────────┬──────────────────┘
                                                            ▼
                                                        Telegram
```

- **Modelo común:** cada proveedor devuelve una lista de *cuotas* normalizadas:
  `{ proveedor, cuotaId, nombre, ventana: '5h'|'diaria'|'semanal'|'mensual', restanteFraccion | restante+total+unidad, reiniciaEn (ISO), fuente: 'nube'|'local', leidoEn }`.
  Un proveedor puede tener varias cuotas (p. ej. Antigravity: Gemini y Claude/GPT).
- **Proveedores "nube"** se ejecutan en el cron del Worker. **Proveedores "local"** los ejecuta el agente y sube el resultado a `/ingest`.
- **Credenciales en D1** (cifradas con una clave guardada como secreto del Worker), porque algunas rotan (Codex, Grok) y hay que reescribirlas en cada ejecución. Las que no rotan pueden ir como secretos del Worker.
- **Credenciales empujadas desde el portátil:** cuando la credencial vive en el portátil y se renueva sola allí (token de Cursor), el agente la sube a la nube para que el Worker siga leyendo aunque el portátil esté apagado (hasta que caduque).
- **Portátil apagado:** el Worker sigue trabajando con el último snapshot conocido y su `reiniciaEn`. Los avisos de "úsalo o piérdelo" se basan en el último dato (indicando su antigüedad). Si un proveedor local lleva >48 h sin datos, se marca como "desactualizado" en estado/resumen, sin aviso propio (llamada mía).

## 5. Proveedores

Fuentes de referencia para el código: Orca (`stablyai/orca`, `src/main/rate-limits/`, TypeScript), opencode-quota (`slkiser/opencode-quota`, TypeScript), CodexBar (`steipete/CodexBar`, docs por proveedor), Ceiling (`tsouth89/ceiling`, Rust), Pulse (`qunqin24/Pulse`, docs). Todo lo marcado "no oficial" puede romperse.

| Proveedor | Dónde | Método | Cuotas que avisan | Credencial |
|---|---|---|---|---|
| GitHub Copilot | nube | `GET api.github.com/copilot_internal/user` → `quota_snapshots.premium_interactions` (`remaining`, `entitlement`, `percent_remaining`) + `quota_reset_date_utc`. Respaldo: API oficial de facturación `/users/{u}/settings/billing/ai_credit/usage` + asignación fija del plan, reinicio día 1 00:00 UTC | mensual | token OAuth de GitHub (no caduca) |
| Kilo Code | nube | `GET api.kilo.ai/api/trpc/kiloPass.getState` (periodo, uso, `nextBillingAt`) + `/api/profile/balance` | mensual (créditos bonus del periodo) | token de Kilo (~1 año) |
| Qoder CLI | nube | PAT → `POST openapi.qoder.sh/api/v1/jobToken/exchange` → `GET /api/v3/user/status` (`quota`, `nextResetAt`). No oficial; el SDK oficial requiere el binario `qodercli`, no viable en Worker. Si el endpoint falla, mover a local con el SDK | mensual | PAT de Qoder |
| Freebuff | nube | `GET codebuff.com/api/v1/freebuff/session` (solo GET; POST abre sesión) → `freeWindows` / `freebucks` / `subscription.renewsAt` | semanal, mensual (no diaria) | token de Freebuff |
| Codex | nube | `GET chatgpt.com/backend-api/wham/usage` (`primary_window`, `secondary_window`, `reset_at`). Refresco OAuth en `auth.openai.com/oauth/token`; **persistir el refresh token rotado en D1**. Usar un login **separado** del del portátil (`codex login --device-auth` con otro `CODEX_HOME`). Nunca llamar a `.../consume` | semanal (la de 5 h no avisa) | OAuth ChatGPT (rota) |
| Grok | nube | `POST grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig` (gRPC-web, decodificar protobuf por número de campo; ver Ceiling). Refresco en `auth.x.ai/oauth2/token`, persistir token rotado. Gloria usa el CLI `grok` en el portátil (`~/.grok`), así que la nube usa un login **separado** (`grok login` con otro `GROK_HOME`), igual que Codex. Si xAI invalida una sesión al abrir otra, Grok pasa a proveedor local (llamada mía) | semanal | OAuth del CLI `grok` (rota) |
| Cursor | nube, credencial desde local | `GET cursor.com/api/usage-summary` (`billingCycleEnd`, `individualUsage.plan.used/limit`). Cookie `WorkosCursorSessionToken` construida a partir de `cursorAuth/accessToken` en `~/.config/Cursor/User/globalStorage/state.vscdb`; el agente local la sube | mensual o semanal según plan (detectar) | JWT de Cursor (rota en local) |
| Antigravity | local | `AGY_CLI_DISABLE_AUTO_UPDATE=true agy -p /usage --output-format json --print-timeout 20s` → `command.data.groups[].buckets[]` (`remaining_fraction`, `reset_time`, `window`). Requiere `agy` ≥ 1.1.11 (tiene 1.4.2). **Nunca** añadir `--disable-slash-commands` | semanal (2 cuotas) | gestionada por `agy` |
| MiMo Code | local | `GET platform.xiaomimimo.com/api/v1/tokenPlan/usage` y `/tokenPlan/detail` (`currentPeriodEnd`). Ojo: sesión inválida = HTTP 200 con `code` 401/403 en el cuerpo | mensual | cookies `api-platform_serviceToken`, `userId` del navegador |
| opencode (Go) | local | `GET opencode.ai/console/api/go/status` con `x-org-id` (de `/console/api/orgs`) → `meters.week/month` (`usedMicroCents`, `limitMicroCents`, `resetsAt`) | semanal, mensual (5 h no avisa) | cookie `__Host-console_session` del navegador |

Cookies de navegador (MiMo, opencode): Gloria tiene la sesión en **Brave**, perfil `Default` (`~/.config/BraveSoftware/Brave-Browser/Default/Cookies`), en Ubuntu con **GNOME**. El agente local copia el SQLite de cookies (Brave lo mantiene bloqueado) y descifra los valores `v11` con la clave "Brave Safe Storage" del GNOME Keyring vía Secret Service (D-Bus de la sesión; el timer `systemd --user` corre dentro de la sesión gráfica y tiene acceso con el keyring desbloqueado). Si el keyring no está disponible, el proveedor falla con aviso "No puedo leer X". No se da soporte a otros navegadores en la primera versión. Las peticiones se pueden hacer desde local o subir la cookie a la nube; **llamada mía: hacer la petición desde local** y subir solo el snapshot (la cookie no sale del portátil).

Un proveedor puede desactivarse por configuración sin tocar código.

## 6. Avisos (Telegram)

Se evalúan después de cada ingesta o cron. Estado de deduplicación en D1, por `(proveedor, cuotaId, periodo)` donde *periodo* = `reiniciaEn` vigente.

1. **Úsalo o piérdelo**
   - Condición: `restante > 0` y `reiniciaEn - ahora ≤ 1 día` (semanal) o `≤ 4 días` (mensual).
   - Una vez por periodo y cuota.
   - Todas las cuotas que se disparan en la misma evaluación → **un solo mensaje**, ordenadas por **prioridad**: primero la que caduca antes; a igualdad, la de mayor cantidad restante en términos relativos (llamada mía; si hay dato en $ se puede usar el valor).
   - Cada línea: herramienta, cuota, % restante (y cantidad si se conoce), cuándo se renueva (fecha local Europe/Madrid y "en X h"), antigüedad del dato si >6 h.
2. **Ya tienes cuota otra vez**
   - Condición: la cuota estaba agotada (`restante == 0` en el último snapshot del periodo anterior) **y** `reiniciaEn` ha avanzado (nuevo periodo) con `restante > 0`.
   - No se usa la bajada del porcentaje gastado como señal (comprar créditos no es renovar).
   - Si el dato llega tarde (portátil apagado), se avisa igualmente al detectarlo.
3. **No puedo leer X**
   - Condición: error de autenticación (401/403, sesión caducada, `code` 401 en cuerpo de MiMo, refresh token revocado) o N fallos seguidos (llamada mía: 3).
   - Una vez hasta que se recupere; al recuperarse, un mensaje corto "X vuelve a funcionar".
   - Incluye instrucciones concretas para arreglarlo por proveedor (p. ej. "abre Cursor para que renueve el token", "inicia sesión en platform.xiaomimimo.com en el navegador").
4. **Resumen semanal**: lunes 09:00 Europe/Madrid. Estado de todas las cuotas (restante, renovación), proveedores desactualizados o con error.
5. **¿Me sobra el plan?**: mensual (día 1). Solo si hay algo que decir: herramienta de pago cuyo consumo al cierre de periodo ha sido < 40% durante los últimos 3 periodos (umbrales llamada mía, configurables).

Zona horaria para mostrar fechas: Europe/Madrid.

## 7. Bot de Telegram: comandos

Solo responde al chat ID de Gloria (lista blanca); a cualquier otro, silencio.

- `/estado` — tabla de todas las cuotas: restante, renovación, antigüedad del dato, errores.
- `/estado <herramienta>` — detalle de una.
- `/prioridad` — lo que conviene gastar ahora, en orden.
- `/historial <herramienta>` — consumo al cierre de los últimos periodos.
- `/actualizar` — fuerza una lectura de los proveedores nube (los locales no se pueden forzar desde la nube; indica la antigüedad).
- `/silenciar <herramienta> <días>` y `/activar <herramienta>` — pausar avisos de una herramienta.
- `/ayuda`.

## 8. Página de estado

- Servida por el Worker, protegida por Cloudflare Access (solo el email de Gloria).
- Muestra lo mismo que `/estado` más el historial por periodo (consumo al cierre) y la sección "¿me sobra el plan?".
- Sencilla, legible en móvil. Sin framework pesado (llamada mía).

## 9. Datos (D1)

Tablas orientativas: `snapshots` (cada lectura), `cuotas_actuales` (último estado por cuota), `cierres_periodo` (consumo final de cada periodo, alimenta historial), `avisos_enviados` (dedupe), `credenciales` (cifradas), `estado_proveedor` (fallos seguidos, último error, silenciado hasta), `config`.

Retención de snapshots crudos: 90 días; `cierres_periodo` indefinido (llamada mía).

## 10. Agente local

- Paquete Node instalado en el portátil, ejecutado por `systemd --user` timer cada 30 min y al iniciar sesión.
- Ejecuta proveedores locales, sube snapshots y credenciales frescas (Cursor) a `POST /ingest` autenticado con un token compartido (secreto).
- Si no hay red, no hace nada (la próxima ejecución lo vuelve a intentar).
- Logs en `journalctl --user`.
- Comando de instalación sencillo (`pnpm` script que instala el servicio y el timer).

## 11. Seguridad

- Repo privado. Secretos en Cloudflare (Worker secrets), nunca en el repo.
- Credenciales en D1 cifradas (AES-GCM, clave en secreto del Worker).
- Webhook de Telegram con `secret_token` verificado; lista blanca de chat ID.
- `/ingest` con token propio.
- Llamadas solo de lectura; lista explícita de endpoints prohibidos (consume/redeem resets, POST de sesión Freebuff, etc.).

## 12. Lo que queda al constructor

- Estructura del monorepo, librerías concretas (p. ej. Hono para el Worker, grammY para Telegram), testing y CI.
- Formato visual exacto de mensajes y página.
- Detalles de parseo de cada proveedor y cómo detectar el tipo de plan (Cursor mensual vs semanal, Copilot créditos vs peticiones).
- Orden de implementación (sugerencia: núcleo + Telegram + Copilot y Antigravity primero, luego el resto).
- Cómo obtener cada credencial inicial: documentarlo en un README paso a paso.
