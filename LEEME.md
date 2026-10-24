# 🎲 Dados Online

Juego de dados multijugador para jugar con amigos desde el celular.

## Probar en tu PC (y en celulares en la misma WiFi)

1. Instalá Node.js (versión LTS) desde https://nodejs.org
2. Abrí la Terminal en esta carpeta y ejecutá:
   ```
   npm install
   npm start
   ```
3. Abrí http://localhost:3000 en la PC. En la terminal aparece otra dirección
   (tipo `http://192.168.x.x:3000`) para abrir desde celulares conectados a la misma WiFi.

## Publicarlo en internet (gratis, con Render)

1. Creá una cuenta en https://github.com y subí esta carpeta a un repositorio nuevo.
2. Creá una cuenta en https://render.com (podés entrar con GitHub).
3. New → Web Service → elegí el repositorio.
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Instance Type: Free
4. Render te da un link (ej. `https://dados-online.onrender.com`). Ese es el que usan tus amigos.

En el plan gratis el servidor se duerme tras ~15 min sin uso: la primera entrada tarda
unos 30–50 segundos. Si se reinicia, las partidas en curso se pierden.

## Cómo se juega online

- Uno toca **Crear partida** y recibe un código de 4 letras.
- Con **Invitar** se manda el link por WhatsApp; los demás entran con su nombre.
- El anfitrión (👑) toca **Empezar partida**. Solo el jugador de turno puede tocar los dados.
- Si alguien se cae, al volver a abrir el link vuelve a su lugar con sus puntos.
- Si alguien se va y traba la partida, el anfitrión puede **saltar su turno**.
