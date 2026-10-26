# VigIA

## Qué es

VigIA vigila las cuotas de tus herramientas de IA (Copilot, Kilo, Qoder, Freebuff, Codex, Grok, Cursor, Antigravity, MiMo y opencode) y te avisa por Telegram:

- "Úsalo o piérdelo": una cuota semanal (≤ 1 día) o mensual (≤ 5 días) a punto de renovarse con saldo sin gastar. Un único mensaje por evaluación, ordenado por prioridad.
- "Ya tienes cuota otra vez" cuando una cuota agotada se renueva.
- "No puedo leer X" cuando una herramienta falla (error de autenticación o 3 fallos seguidos) y "X vuelve a funcionar" al recuperarse.
- Resumen semanal (lunes desde las 09:00, Europe/Madrid) y "¿Me sobra el plan?" (día 1 de mes desde las 09:00); si un envío falla se reintenta en el siguiente cron del mismo día.

Todo es de solo lectura: VigIA nunca consume cuota ni canjea créditos.

## Arquitectura

- **Worker de Cloudflare** (`packages/worker`): cron cada 30 min que lee las herramientas "de nube", endpoint `/ingest` (lo usa el agente), webhook de Telegram (`/telegram`), página de estado (`/`, protegida con Cloudflare Access) y base de datos D1. Las credenciales se guardan cifradas (AES-GCM) en D1.
- **Agente del portátil** (`packages/agent`): un `systemd --user` timer (2 min tras arrancar y cada 30 min) que lee Antigravity (`agy`), MiMo y opencode (con las cookies de Brave, que no salen del portátil), sincroniza el token de Cursor y lo envía todo a `/ingest`.
- **Core** (`packages/core`): proveedores, avisos y mensajes compartidos.

## Requisitos

- Node 24 y pnpm.
- Cuenta de Cloudflare (plan gratis) y un bot de Telegram.
- Ubuntu con GNOME y Brave (perfil `Default`) con el keyring desbloqueado en la sesión.
- `sudo apt install libsecret-tools` (el agente usa `secret-tool` para descifrar las cookies de Brave).
- `agy` >= 1.1.11 en `~/.local/bin` (Antigravity).

```bash
pnpm install
```

## Puesta en marcha del Worker

Los comandos de `wrangler` se ejecutan desde `packages/worker` (`cd packages/worker`) con `pnpm exec wrangler ...`.

### 1. Bot de Telegram

1. En Telegram habla con [@BotFather](https://t.me/BotFather), envía `/newbot` y guarda el token (`TELEGRAM_BOT_TOKEN`).
2. Escribe cualquier mensaje a tu bot nuevo y abre `https://api.telegram.org/bot<TOKEN>/getUpdates`. El número de `message.chat.id` es tu `TELEGRAM_CHAT_ID`. El bot solo responde a ese chat.

### 2. Base de datos D1

```bash
pnpm exec wrangler login
pnpm exec wrangler d1 create vigia
```

Copia el `database_id` que imprime y sustituye el valor `00000000-0000-0000-0000-000000000000` de `database_id` en `packages/worker/wrangler.toml`. Después aplica las migraciones:

```bash
pnpm exec wrangler d1 migrations apply vigia --remote
```

### 3. Secretos

Cada uno se sube con `pnpm exec wrangler secret put <NOMBRE>` (pega el valor cuando lo pida). Genera los valores aleatorios así:

| Secreto | Valor |
|---|---|
| `CREDENTIALS_KEY` | Clave de 32 bytes en base64: `openssl rand -base64 32`. Guárdala: si la pierdes hay que volver a subir todas las credenciales. |
| `INGEST_TOKEN` | `openssl rand -hex 32`. El mismo valor va en `agent.json`. |
| `TELEGRAM_BOT_TOKEN` | El token de BotFather. |
| `TELEGRAM_CHAT_ID` | El `chat.id` del paso 1. |
| `TELEGRAM_WEBHOOK_SECRET` | `openssl rand -hex 32` (solo letras, números, `_` y `-` son válidos para Telegram; hex lo cumple). |
| `ACCESS_TEAM_DOMAIN` | Dominio de equipo de Cloudflare Access (paso 6), p. ej. `miequipo.cloudflareaccess.com`. |
| `ACCESS_AUD` | "Application Audience (AUD) Tag" de la aplicación de Access (paso 6). |
| `CONFIG_JSON` (opcional) | `{"disabled":["qoder"],"surplus":{"threshold":0.4,"periods":3}}`. `disabled` desactiva proveedores (no se leen en la nube y no aparecen en `/estado`, el resumen ni la página); `surplus` ajusta "¿me sobra el plan?". |

### 4. Despliegue

```bash
pnpm exec wrangler deploy
```

Anota la URL `https://vigia.<tu-subdominio>.workers.dev`.

Tras el primer despliegue no llega ninguna ráfaga de avisos: el cron se salta las herramientas de nube sin credencial guardada, y `/estado`, el resumen semanal y la página muestran cada herramienta activa como "sin datos" (las del portátil, "sin datos del portátil") hasta que subas su credencial (ver [Credenciales por herramienta](#credenciales-por-herramienta)) o el agente envíe su primera lectura.

### 5. Webhook de Telegram

```bash
curl -sS "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  --data-urlencode "url=https://vigia.<tu-subdominio>.workers.dev/telegram" \
  --data-urlencode "secret_token=<TELEGRAM_WEBHOOK_SECRET>"
```

El Worker rechaza cualquier petición sin la cabecera `X-Telegram-Bot-Api-Secret-Token` correcta. Prueba con `/ayuda` en el chat.

### 6. Cloudflare Access sobre workers.dev

La página `/` exige un JWT de Access (sin él devuelve 403), pero `/ingest`, `/telegram` y `/health` no deben pasar por el login: tienen su propia autenticación (token Bearer, secreto del webhook). Por eso hacen falta cuatro aplicaciones, creadas en este orden.

1. En el panel de Cloudflare: **Zero Trust → Access → Applications → Add an application → Self-hosted**. Si Zero Trust te pide crear un equipo, el dominio de equipo (`<equipo>.cloudflareaccess.com`) es tu `ACCESS_TEAM_DOMAIN`.
2. Aplicación principal: dominio `vigia.<tu-subdominio>.workers.dev`, sin path (todo el hostname). Política **Allow** con *Emails* = `gloria.labory@homedoctor.es`.
3. Guarda y copia el **Application Audience (AUD) Tag** (pestaña *Overview*): es `ACCESS_AUD`.
4. Crea otras tres aplicaciones Self-hosted, una por cada path: `vigia.<tu-subdominio>.workers.dev/ingest`, `.../telegram` y `.../health`. En cada una pon una política con acción **Bypass** e *Include* = **Everyone**. Access aplica la aplicación más específica para cada ruta, así que estos tres paths quedan fuera del login y la principal protege el resto.
5. Sube los secretos `ACCESS_TEAM_DOMAIN` y `ACCESS_AUD` con `wrangler secret put` y vuelve a ejecutar `wrangler deploy`.
6. Verifica:
   - `curl https://vigia.<tu-subdominio>.workers.dev/health` responde `ok` sin pedir login.
   - Abrir `https://vigia.<tu-subdominio>.workers.dev/` en el navegador pide el login de Access (código por email) y luego muestra la página.

## Credenciales por herramienta

Las herramientas de nube se leen desde el Worker. La forma principal es que el agente obtenga la credencial y la suba él mismo, sin copiar tokens a mano:

```bash
pnpm --filter agent run login <herramienta>
pnpm --filter agent run login all
```

(`herramienta` ∈ `copilot`, `codex`, `grok`, `freebuff`, `kilo`, `qoder`; `all` las recorre en ese orden, sigue tras un fallo y muestra un resumen). Valida el formato en local, nunca imprime la credencial y solo escribe en disco los `auth.json` que gestionan Codex y Grok.

**Antes de subir credenciales** crea la configuración del agente (pasos 1 y 2 de [Instalar el agente](#instalar-el-agente)): `login` y `push-credential` la usan para saber a qué Worker enviar y con qué token.

| Herramienta | Qué hace `login` |
|---|---|
| Copilot | Flujo de dispositivo de GitHub: te muestra una URL y un código; lo introduces en el navegador. |
| Codex | Ejecuta `codex login --device-auth` con un `CODEX_HOME` propio (`~/.vigia/codex`, que crea él). No sube nada: Codex se lee desde el portátil. |
| Grok | Ejecuta `grok login` con un `GROK_HOME` propio (`~/.vigia/grok`, que crea él) y sube su `auth.json`. Si ya existe un `auth.json` válido, no vuelve a iniciar sesión. |
| Freebuff | Lee el token del llavero de GNOME (`secret-tool`, paquete `libsecret-tools`); inicia sesión antes con `freebuff`. |
| Kilo | Te pide la API key de https://app.kilo.ai/profile (la entrada no se muestra). |
| Qoder | Te pide un Personal Access Token de https://qoder.com/account/integrations (la entrada no se muestra). |

### Alternativa manual: `push-credential`

Si prefieres subir una credencial que ya tienes en un fichero:

```bash
pnpm --filter agent push-credential <id> <fichero>
```

Como `pnpm --filter` se ejecuta dentro de `packages/agent`, la ruta del fichero debe ser absoluta o empezar por `~/` (no relativa). Borra el fichero cuando termines (`shred -u <fichero>`). Formato esperado:

| Herramienta | Formato del fichero |
|---|---|
| Copilot | Token OAuth de GitHub en texto plano. |
| Kilo | Token de Kilo en texto plano. |
| Qoder | PAT en texto plano, o `{"pat":"..."}`. |
| Freebuff | Token en texto plano. |
| Codex | El `auth.json` de Codex (JSON con `tokens.refresh_token`). |
| Grok | El `auth.json` de Grok (JSON con una entrada que tenga `key` o `refresh_token`). |

Si el fichero no es válido para esa herramienta, el script lo dice sin enviar nada.

### Copilot, Kilo, Qoder, Freebuff (manual)

Cada una necesita un token estático. Dónde encontrarlo (son rutas no oficiales; si cambian, la herramienta falla con "No puedo leer X" y habrá que revisarlas):

- **Copilot**: el token OAuth de GitHub que usa el plugin de Copilot, normalmente en `~/.config/github-copilot/apps.json` (campo `oauth_token`). Si deja de funcionar, inicia sesión de nuevo con el plugin y vuelve a subir la credencial.
- **Kilo**: la API key de https://app.kilo.ai/profile.
- **Qoder**: crea un Personal Access Token en tu cuenta de Qoder.
- **Freebuff**: el token de sesión de Freebuff/Codebuff; el CLI lo guarda en el llavero de GNOME (o, si no hay llavero, en `~/.config/manicode/credentials.json`, campo `authToken`).

```bash
install -m 600 /dev/null /tmp/vigia-cred
# pega el token en /tmp/vigia-cred con tu editor
pnpm --filter agent push-credential copilot /tmp/vigia-cred
shred -u /tmp/vigia-cred
```

### Codex (se lee desde el portátil)

ChatGPT rechaza (HTTP 403) las peticiones que salen de los servidores de Cloudflare, así que Codex lo lee el agente del portátil, como Antigravity. Usa un login **separado** del tuyo (`~/.vigia/codex`) para que la renovación del token no invalide tu sesión de Codex:

```bash
pnpm --filter agent run login codex
# equivale a: mkdir -p -m 700 ~/.vigia/codex && CODEX_HOME=~/.vigia/codex codex login --device-auth
```

No borres `~/.vigia/codex`: el agente lee de ahí y guarda en ese fichero el token renovado.

### Grok (manual)

`pnpm --filter agent run login grok` crea `~/.vigia/grok` y hace todo lo siguiente. A mano, login separado del `~/.grok` del portátil:

```bash
mkdir -p -m 700 ~/.vigia/grok
GROK_HOME=~/.vigia/grok grok login
pnpm --filter agent push-credential grok ~/.vigia/grok/auth.json
```

### Cursor

Automático: el agente lee el token de `~/.config/Cursor/User/globalStorage/state.vscdb` y lo sube cuando cambia. Abre Cursor de vez en cuando para que renueve la sesión.

### Antigravity

Lo lee el agente con `agy -p /usage` (no sube nada). Necesitas `agy` >= 1.1.11 y la sesión iniciada: ejecuta `agy` una vez e inicia sesión.

### MiMo y opencode

El agente lee las cookies de Brave (perfil `Default`) y hace las peticiones desde el portátil; las cookies no salen de él. Basta con tener sesión iniciada con **Brave** en https://platform.xiaomimimo.com (MiMo) y https://opencode.ai (opencode).

## Instalar el agente

1. Crea `~/.config/vigia/agent.json`:

   ```json
   {
     "workerUrl": "https://vigia.<tu-subdominio>.workers.dev",
     "ingestToken": "<INGEST_TOKEN>",
     "disabled": []
   }
   ```

   `workerUrl` debe ser https (http solo para localhost). `disabled` acepta ids de proveedor (`"mimo"`, `"antigravity"`, ...) para que el agente no los lea.

2. Protege el fichero (el agente se niega a arrancar si otros usuarios pueden leerlo):

   ```bash
   chmod 600 ~/.config/vigia/agent.json
   ```

3. Prueba una ejecución a mano:

   ```bash
   pnpm --filter agent start
   ```

4. Instala el servicio de usuario. Primero revisa qué se va a escribir:

   ```bash
   pnpm --filter agent install-service --dry-run
   pnpm --filter agent install-service
   ```

   Esto escribe `~/.config/systemd/user/vigia-agent.{service,timer}` con rutas absolutas a `node` y a `tsx` del repositorio (no hace falta pnpm global), y ejecuta `systemctl --user daemon-reload` y `systemctl --user enable --now vigia-agent.timer`. El timer corre 2 min después de arrancar la sesión y cada 30 min. El servicio incluye `~/.local/bin` en el `PATH` para encontrar `agy`.

   Si cambias de versión de Node o mueves el repositorio, vuelve a ejecutar `install-service`.

5. Comprueba:

   ```bash
   systemctl --user list-timers vigia-agent.timer
   journalctl --user -u vigia-agent -e
   ```

## Comandos del bot

- `/estado [herramienta]`: estado de tus cuotas, o detalle de una.
- `/prioridad`: qué conviene usar primero.
- `/historial <herramienta>`: consumo al cierre de los últimos periodos.
- `/actualizar`: lee ya las herramientas de nube (las locales dependen del agente).
- `/silenciar <herramienta> <días>`: pausa los avisos de una herramienta.
- `/activar <herramienta>`: los reanuda.
- `/ayuda`: la lista.

## Qué hacer ante "No puedo leer X"

| Herramienta | Qué hacer |
|---|---|
| Cursor | Abre Cursor para que renueve la sesión; el agente sube el token nuevo en la siguiente ejecución. |
| MiMo | Inicia sesión en platform.xiaomimimo.com con Brave. |
| opencode | Inicia sesión en opencode.ai con Brave. |
| Antigravity | Ejecuta `agy` y vuelve a iniciar sesión (ver también el "latch" más abajo). |
| Codex | Repite el login: `pnpm --filter agent run login codex`. |
| Grok | Repite el login de la nube (`GROK_HOME=~/.vigia/grok grok login` y `push-credential grok ...`). |
| Copilot, Kilo, Qoder, Freebuff | Genera un token nuevo y súbelo con `push-credential`. |

Si MiMo u opencode siguen fallando con la sesión iniciada, comprueba que Brave usa el perfil `Default`, que el keyring está desbloqueado y que `secret-tool` está instalado.

### Reiniciar el "latch" de Antigravity

Por seguridad (para no gastar cuota), si una versión de `agy` responde a `/usage` como si fuera un prompt, o se queda colgada varias veces seguidas, el agente deja de ejecutarla con esa versión y avisa. Se desbloquea solo al actualizar `agy`; para forzarlo, arregla `agy` y borra las claves de `~/.config/vigia/state.json`:

```bash
# edita el fichero y elimina "antigravityModelTurn" y "antigravityTimeouts"
$EDITOR ~/.config/vigia/state.json
```

No borres `cursorTokenHash` (solo evita volver a subir el mismo token de Cursor).

## Verificar con datos reales

Los proveedores se escribieron contra respuestas documentadas; los ficheros de `packages/core/test/fixtures` son **sintéticos** hasta que los sustituyas por capturas reales. Para cada herramienta:

```bash
pnpm --filter agent capture <id> --credential-file <ruta-absoluta-o-~/-del-fichero>
# o con variable de entorno: VIGIA_CRED_<ID>=... pnpm --filter agent capture <id>
```

`id` puede ser cualquier proveedor de nube o `mimo` / `opencode` (para estos, la credencial es la cabecera `Cookie`, o `{"cookie":"..."}`). El comando hace la lectura real, guarda cada respuesta en `packages/core/test/fixtures/<id>/` con tokens, cookies, emails e identificadores censurados, e imprime las rutas.

Antes de hacer commit **revisa a mano cada fichero capturado**: la censura es automática y no infalible. Después ejecuta `pnpm test` y ajusta el proveedor si la respuesta real difiere. Antigravity no usa `capture`: guarda la salida de `agy -p /usage --output-format json` a mano, censurada.

Verificación de extremo a extremo: `/estado` en Telegram muestra las 10 herramientas (o su error), la página abre tras el login de Access y `journalctl --user -u vigia-agent` no muestra errores tras una ejecución.

## Seguridad

| Qué | Dónde |
|---|---|
| Credenciales de nube (Copilot, Kilo, Qoder, Freebuff, Grok, Cursor) | D1, cifradas con AES-GCM. La clave `CREDENTIALS_KEY` es un secreto del Worker. Nunca en el repositorio. |
| Credencial de Codex | Solo en el portátil, en `~/.vigia/codex/auth.json`; el agente la renueva localmente. |
| Cookies de Brave (MiMo, opencode) | Solo en el portátil: el agente las lee en cada ejecución y sube únicamente las cuotas. |
| Token de Cursor | Se sube a D1 (cifrado). El hash de la última versión subida está en `~/.config/vigia/state.json`. |
| `INGEST_TOKEN` | Secreto del Worker y `~/.config/vigia/agent.json` (modo 600). |
| Webhook de Telegram | Verificado con `X-Telegram-Bot-Api-Secret-Token`; el bot solo responde a `TELEGRAM_CHAT_ID`. |
| Página de estado | Detrás de Cloudflare Access (solo tu email); el Worker verifica el JWT. |
| Ficheros temporales de credencial | Bórralos con `shred -u` tras subirlos. |

Se recomienda no versionar nunca capturas sin revisar ni ficheros `auth.json`.
