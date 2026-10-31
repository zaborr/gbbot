# Despliegue en una VPS con Docker

Todo en un mismo servidor:
- **Postgres**: la base de datos, solo accesible desde la propia máquina.
- **API**: aplica las migraciones al arrancar y registra el webhook del bot.
- **Mini App**: los ficheros estáticos.
- **Caddy**: delante de todo, con HTTPS automático.

Mini App y API van en el **mismo dominio**: la API en `/api` y el webhook de Telegram en `/webhook`. Así no hay que configurar CORS ni la URL de la API.

## Requisitos

- Una VPS con Docker y el plugin Compose (`docker compose version`). Con 1 GB de RAM basta, aunque para compilar las imágenes vienen mejor 2 GB o algo de swap.
- Un dominio o subdominio con un registro DNS **A** (y AAAA si hay IPv6) apuntando a la VPS.
- Los puertos **80 y 443** abiertos.

## Primera vez

```bash
git clone https://github.com/TU_USUARIO/TU_REPO.git && cd TU_REPO
cp deploy/.env.example .env
nano .env                      # DOMAIN, POSTGRES_PASSWORD, BOT_TOKEN, JWT_SECRET…
docker compose up -d --build
docker compose logs -f api     # debe salir "Telegram webhook set to https://…"
```

Después, en **@BotFather**: *Bot Settings → Menu Button* (y la Mini App, si la tienes creada) → `https://TU_DOMINIO`.

## Actualizar

```bash
./deploy/update.sh
```

Busca cambios en GitHub y, si los hay: hace una copia de la base de datos, descarga la versión nueva, reconstruye las imágenes (de una en una, para no agotar la memoria), reinicia, comprueba que la API responde y borra las imágenes viejas. Con `--force` reconstruye aunque no haya cambios. La API aplica sola las migraciones nuevas al arrancar.

### Desde el bot: /update

Instálalo una vez en el servidor:

```bash
sudo ./deploy/auto-update/install.sh
```

Después, cualquier administrador de plataforma (`ADMIN_TELEGRAM_IDS`) puede escribir **/update** al bot. El bot contesta con lo que hay de nuevo en GitHub. Solo ofrece versiones cuyas comprobaciones (CI) han pasado y avisa si hay cambios en la base de datos. Con **Actualizar**, el servidor ejecuta `update.sh` y el mismo mensaje cambia al resultado, con las últimas líneas del registro si falla. El registro completo queda en `deploy/runtime/last-update.log`.

La API no tiene ningún permiso sobre Docker: solo deja la petición en `deploy/runtime/`. Quien actualiza es la unidad de systemd `gb-update.path`. Para desactivarlo: `sudo systemctl disable --now gb-update.path`.

## Datos

- **Copia de seguridad diaria**: `deploy/backup.sh` guarda un `pg_dump` comprimido en `backups/` y conserva 14 días. Añádelo a cron:
  ```
  15 4 * * * /ruta/a/tma-shop/deploy/backup.sh
  ```
  Fuera del servidor: ver **Copia cifrada en Backblaze B2** más abajo.
- **Restaurar una copia**:
  ```bash
  gunzip -c backups/gb-AAAAMMDD-HHMM.sql.gz | docker compose exec -T postgres psql -U gb -d gb
  ```
- **Copia cifrada en Backblaze B2** (fuera del servidor). Cada backup (el diario y el de antes de cada update) se cifra aquí con tu clave pública *age* y se sube a B2. Incluye la base de datos, el `.env` y, si Tor corre en este servidor, las claves del servicio .onion. Nadie sin tu clave privada puede leerlo: ni Backblaze, ni quien entre en el VPS. Si la subida falla, el bot avisa a los administradores de plataforma y la copia local sigue bien.

  1. **Tu clave**, en tu ordenador (no en el servidor): `age-keygen -o gb-backup-key.txt`. Muestra la clave pública (`age1…`). Guarda el archivo en dos sitios seguros, por ejemplo tu gestor de contraseñas y un USB. **Sin él no se puede abrir ninguna copia.**
  2. **En Backblaze** (cuenta gratuita, 10 GB, sin tarjeta):
     - *Buckets → Create a Bucket*: un nombre único y *Private*.
     - En el bucket, *Lifecycle Settings → Use custom lifecycle rules*: prefijo vacío, *Days till hide* **30** y *Days till delete* **1**. Así se borran solas las copias de más de 30 días.
     - *Application Keys → Add a New Application Key*: acceso solo a ese bucket y tipo **Write Only**. Desde el servidor se podrá subir, pero no borrar ni leer. Apunta el *keyID* y el *applicationKey*, que solo se muestran una vez.
  3. **En el servidor**:
     ```bash
     apt install rclone age curl
     sudo ./deploy/offsite/install.sh
     ```
     Pide la clave de B2, el bucket y tu clave pública, y hace una copia de prueba. Si con *Write Only* la prueba falla, crea la clave como *Read and Write*.
  4. **Restaurar desde B2**: descarga el archivo `gb-AAAAMMDD-HHMM.tar.age` desde la web de Backblaze y, en el servidor:
     ```bash
     mkdir restore && cd restore
     age -d -i gb-backup-key.txt gb-AAAAMMDD-HHMM.tar.age | tar -xf -
     # Base de datos:
     gunzip -c backups/gb-*.sql.gz | docker compose -f ../docker-compose.yml exec -T postgres psql -U gb -d gb
     # Si reconstruyes el servidor: el .env va a la carpeta del repo, y las claves de Tor (var/lib/tor/…)
     # a /var/lib/tor/…, con: chown -R debian-tor:debian-tor /var/lib/tor/… && chmod 700 /var/lib/tor/…
     ```
- **Pasar los datos desde Neon**:
  ```bash
  pg_dump "URL_DE_NEON" --no-owner --no-acl | docker compose exec -T postgres psql -U gb -d gb
  ```
  Hazlo antes del primer arranque de la API o con la base vacía.
- **Seguir usando Neon** en lugar del Postgres local: pon `DATABASE_URL=…` en `.env`. El contenedor `postgres` puede quedarse parado.

## Útil

```bash
docker compose ps                  # estado
docker compose logs -f api         # logs de la API
docker compose restart api         # reiniciar la API
docker compose exec postgres psql -U gb -d gb   # consola SQL
```

## Desarrollo local

Solo hace falta la base de datos: `docker compose up -d postgres`. Escucha en `127.0.0.1:5432`, usuario y base `gb`, contraseña `gb` si no hay `.env`. Después sigue los pasos del README principal.
