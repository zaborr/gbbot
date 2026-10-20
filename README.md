# GB · compras grupales en Telegram

Mini App de Telegram para organizar **GB (group buys)**: cada GB tiene su catálogo, los clientes piden y pagan en cripto desde Telegram, y el organizador gestiona los pedidos y hace la compra conjunta.

## Qué hace

- **Varios GB en una misma plataforma**, cada uno con sus administradores. Pueden ser visibles, ocultos o **solo VIP**.
- **Roles**:
  - administradores de la plataforma (`ADMIN_TELEGRAM_IDS`): lo ven y lo gestionan todo;
  - organizadores: pueden crear GB (nuevos o desde una copia);
  - propietario de cada GB (quien lo creó, o a quien se lo asignes): elige sus administradores y su visibilidad, y puede duplicarlo, hacer copias y borrarlo;
  - administradores de cada GB: llevan ese GB (catálogo, pedidos, ajustes).

  Se añaden por @usuario o por ID. Quien aún no ha abierto la app queda pendiente, sin permisos, hasta su primera visita. Cada GB muestra «Organizado por» con sus administradores.
- **Club VIP**: uno general y otro por GB. Los miembros salen de grupos o canales de Telegram y de una lista de @usuarios o IDs.
- **Precio VIP** por producto (y por variante): los VIP siempre pagan ese precio, sin escalones, y solo ellos lo ven. Cada GB puede eximir a los VIP de la comisión por pedido.
- **Catálogo**: categorías, productos con variantes (talla, color…), precios por cantidad y stock.
- **Carrito y pedidos**: zonas de envío, comisión por pedido y dirección cifrada en el móvil del cliente (solo la lee el organizador).
- **Pagos en USDC / EURC** en Base, Ethereum o Solana. El cliente pega el hash de la transacción y la API la **comprueba en la blockchain** y confirma el pago automáticamente.
- **Otros métodos de pago** (Wise, Bizum, Revolut…) con instrucciones del organizador: el cliente paga, lo avisa con una referencia y el organizador lo confirma a mano.
- **Mientras el pedido está abierto**:
  - si no está pagado, el cliente puede modificarlo directamente;
  - si ya está pagado, puede pedir un cambio que el organizador aprueba;
  - hay recordatorios de pago y cancelación automática de los pedidos sin pagar.
- **Cerrar un GB**, ahora o en una fecha. Deja de admitir pedidos y queda en modo consulta para quien pidió.
- **Condiciones al entrar**: cada GB puede tener un texto que el cliente acepta antes de ver nada (se guarda quién y cuándo; el organizador decide si un cambio obliga a aceptarlo de nuevo).
- **Para el organizador**:
  - estados del pedido (pagado, enviado con seguimiento, entregado) con aviso al cliente por el bot;
  - resumen de ventas y exportación a Excel/CSV;
  - mensaje a los compradores por el bot (todos, pagados, pendientes de pago o con carrito), con registro de envíos;
  - lista de envíos descifrada en el dispositivo;
  - copiar productos de otro GB;
  - duplicar un GB entero (ajustes y catálogo, sin pedidos) para la siguiente ronda;
  - importar y exportar el catálogo en CSV (una fila por variante), con vista previa y errores por línea;
  - copia de seguridad del GB en JSON (ajustes y catálogo) para recrearlo, confirmando las direcciones de cobro al importarla.

  Los CSV y las copias se pueden importar eligiendo el archivo en la app o, más cómodo en el móvil, enviándoselo al bot: contesta con un botón que abre la importación.
- **Privacidad**: las direcciones se borran y los pedidos se anonimizan pasado un tiempo, y se eliminan los usuarios inactivos.
- **Idiomas**: español, inglés, italiano y portugués. Tema claro y oscuro. Productos y GB pueden tener título/nombre y descripción también en inglés: la app en español muestra el español; en cualquier otro idioma, el inglés (o el español si no hay).

## Estructura

```
apps/
  api/       API: Hono + Drizzle + PostgreSQL (Node 22+)
  miniapp/   Mini App: React + Vite + Telegram UI
packages/
  shared/    Esquemas zod y tipos comunes
```

## Despliegue actual

- **Mini App** en Vercel. Variable: `VITE_API_BASE_URL`.
- **API** en Render, como servicio Node. Al arrancar aplica las migraciones y registra el webhook del bot.
- **Base de datos** en Neon (Postgres).

Las variables de la API están documentadas en [`apps/api/.env.example`](apps/api/.env.example). Las imprescindibles son:
- `DATABASE_URL`, `BOT_TOKEN` y `JWT_SECRET`;
- `ADMIN_TELEGRAM_IDS`: administradores de la plataforma;
- `TELEGRAM_WEBHOOK_SECRET`: para que el bot responda;
- `CORS_ORIGIN`: la URL de la Mini App.

## Desarrollo local

```bash
npm install
docker compose up -d postgres            # Postgres local
cp apps/api/.env.example apps/api/.env   # y rellena BOT_TOKEN, etc.
npm run db:migrate --workspace apps/api
npm run db:seed --workspace apps/api     # opcional: GB de demo
npm run dev:api
npm run dev:miniapp
```

Fuera de Telegram, la Mini App arranca con un usuario de prueba (`mockEnv.ts`). La autenticación real solo funciona dentro de Telegram.

## Calidad

```bash
npm run lint && npm run typecheck && npm test
```

El test de integración (`apps/api/src/__tests__/integration.test.ts`) usa un Postgres real y se ejecuta cuando existe `TEST_DATABASE_URL`. El CI de GitHub Actions lo lanza en cada push y PR.

## Licencia

MIT. Basado en [tma-shop](https://github.com/IvanTereshin/tma-shop) © Ivan Tereshin (ver [LICENSE](./LICENSE)).
