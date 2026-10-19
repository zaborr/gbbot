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
git clone https://github.com/zaborr/tma-shop.git && cd tma-shop
cp deploy/.env.example .env
nano .env                      # DOMAIN, POSTGRES_PASSWORD, BOT_TOKEN, JWT_SECRET…
docker compose up -d --build
docker compose logs -f api     # debe salir "Telegram webhook set to https://…"
```

Después, en **@BotFather**: *Bot Settings → Menu Button* (y la Mini App, si la tienes creada) → `https://TU_DOMINIO`.

## Actualizar

```bash
git pull
docker compose up -d --build
```

La API aplica sola las migraciones nuevas al arrancar.

## Datos

- **Copia de seguridad diaria**: `deploy/backup.sh` guarda un `pg_dump` comprimido en `backups/` y conserva 14 días. Añádelo a cron:
  ```
  15 4 * * * /ruta/a/tma-shop/deploy/backup.sh
  ```
  Conviene copiar también `backups/` fuera del servidor de vez en cuando.
- **Restaurar una copia**:
  ```bash
  gunzip -c backups/gb-AAAAMMDD-HHMM.sql.gz | docker compose exec -T postgres psql -U gb -d gb
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
