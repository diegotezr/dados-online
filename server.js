const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { Server } = require('socket.io');
const { calcularPuntuacion, dadosInutiles, jugadaObligatoria } = require('./public/puntuacion.js');
const almacen = require('./almacen.js');

// --- Constantes del juego ---
const PUNTOS_PARA_ABRIR = 750;
const PUNTOS_PARA_GANAR = 3000;
const NUM_DADOS = 5;
const MAX_JUGADORES = 10;
const ESPERA_TRAS_PERDER_MS = 5000;   // tiempo para ver los dados antes de pasar el turno
const SALA_INACTIVA_MS = 30 * 24 * 60 * 60 * 1000;   // una partida sin uso se borra a los 30 días
const MAX_MENSAJES = 100;
const LARGO_MENSAJE = 300;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const io = new Server(server);

// --- Salas ---
const salas = new Map();

function nuevoCodigo() {
    const letras = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    let codigo;
    do {
        codigo = Array.from({ length: 4 }, () => letras[crypto.randomInt(letras.length)]).join('');
    } while (salas.has(codigo));
    return codigo;
}

function crearSala() {
    const sala = {
        codigo: nuevoCodigo(),
        anfitrionId: null,
        fase: 'lobby',            // lobby | jugando | fin
        jugadores: [],
        turno: 0,
        dados: [],
        sel: new Array(NUM_DADOS).fill(false),
        fijos: new Array(NUM_DADOS).fill(false),
        puntosTurno: 0,
        obligatorios: [],
        jugadaObligatoria: null,
        culoArmado: false,     // el jugador pidió que el próximo tiro sea de CULO
        culo: false,           // el tiro actual fue de CULO
        caras: null,           // en un tiro de CULO, la cara de arriba de cada dado
        tirada: 0,
        enBust: false,
        ganador: null,
        aviso: null,
        avisoSeq: 0,
        chat: [],
        chatSeq: 0,
        ultimaActividad: Date.now(),
        bustTimer: null
    };
    salas.set(sala.codigo, sala);
    return sala;
}

function estadoPublico(sala) {
    return {
        codigo: sala.codigo,
        anfitrionId: sala.anfitrionId,
        fase: sala.fase,
        jugadores: sala.jugadores.map(j => ({
            id: j.id, nombre: j.nombre, puntaje: j.puntaje, haAbierto: j.haAbierto, conectado: j.conectado
        })),
        turno: sala.turno,
        dados: sala.dados,
        sel: sala.sel,
        fijos: sala.fijos,
        puntosTurno: sala.puntosTurno,
        obligatorios: sala.obligatorios,
        jugadaObligatoria: sala.jugadaObligatoria,
        culoArmado: sala.culoArmado,
        culo: sala.culo,
        caras: sala.caras,
        tirada: sala.tirada,
        enBust: sala.enBust,
        ganador: sala.ganador,
        aviso: sala.aviso,
        constantes: { PUNTOS_PARA_ABRIR, PUNTOS_PARA_GANAR }
    };
}

function emitir(sala) {
    io.to(sala.codigo).emit('estado', estadoPublico(sala));
    programarGuardado();
}

// --- Guardado de partidas ---
let guardadoProgramado = null;

function salaGuardable(sala) {
    const { bustTimer, ...datos } = sala;
    datos.jugadores = sala.jugadores.map(({ socketId, ultimoMensaje, ...j }) => ({ ...j, conectado: false }));
    return datos;
}

async function guardarAhora() {
    clearTimeout(guardadoProgramado);
    guardadoProgramado = null;
    try {
        await almacen.escribir([...salas.values()].map(salaGuardable));
    } catch (e) {
        console.error('No se pudieron guardar las partidas:', e.message);
    }
}

function programarGuardado() {
    if (!guardadoProgramado) guardadoProgramado = setTimeout(guardarAhora, 1500);
}

async function cargarPartidas() {
    const guardadas = await almacen.cargar();
    for (const sala of guardadas) {
        sala.bustTimer = null;
        sala.chat = sala.chat || [];
        sala.chatSeq = sala.chatSeq || 0;
        sala.culoArmado = !!sala.culoArmado;
        sala.caras = sala.caras || null;
        sala.jugadores.forEach(j => { j.conectado = false; j.socketId = null; });
        if (sala.enBust) {
            // Se reinició el servidor justo mientras se pasaba el turno.
            sala.enBust = false;
            pasarTurno(sala);
        }
        salas.set(sala.codigo, sala);
    }
    console.log(`Partidas recuperadas: ${guardadas.length} (guardadas en ${almacen.descripcion})`);
}

function avisar(sala, texto, tipo = 'info') {
    sala.aviso = { id: ++sala.avisoSeq, texto, tipo };
}

function limpiarNombre(nombre) {
    return String(nombre || '').replace(/\s+/g, ' ').trim().slice(0, 16);
}

function nombreUnico(sala, nombre) {
    let candidato = nombre, n = 2;
    while (sala.jugadores.some(j => j.nombre.toLowerCase() === candidato.toLowerCase())) {
        candidato = `${nombre} ${n++}`;
    }
    return candidato;
}

// --- Lógica de turnos ---
function iniciarNuevoTurno(sala) {
    sala.puntosTurno = 0;
    sala.dados = [];
    sala.sel.fill(false);
    sala.fijos.fill(false);
    sala.obligatorios = [];
    sala.jugadaObligatoria = null;
    sala.culoArmado = false;
    sala.culo = false;
    sala.caras = null;
}

function pasarTurno(sala) {
    if (sala.jugadores.length === 0) return;
    sala.turno = (sala.turno + 1) % sala.jugadores.length;
    iniciarNuevoTurno(sala);
}

function elegidos(sala) {
    return sala.dados.filter((_, i) => sala.sel[i] && !sala.fijos[i]);
}

function indicesLibres(sala) {
    return sala.dados.map((_, i) => i).filter(i => !sala.fijos[i]);
}

// Detecta la combinación obligatoria de la tirada actual y la deja seleccionada.
function marcarObligatoria(sala) {
    const libres = indicesLibres(sala);
    const jugada = jugadaObligatoria(libres.map(i => sala.dados[i]));
    sala.obligatorios = jugada ? jugada.indices.map(k => libres[k]) : [];
    sala.jugadaObligatoria = jugada ? jugada.nombre : null;
    sala.obligatorios.forEach(i => { sala.sel[i] = true; });
}

// Devuelve un mensaje de error si la selección actual no es válida.
function validarSeleccion(sala, jugador) {
    const seleccion = elegidos(sala);
    if (seleccion.length === 0) return 'Debes seleccionar al menos un dado con puntos para continuar.';
    if (sala.obligatorios.some(i => !sala.sel[i])) return `La jugada "${sala.jugadaObligatoria}" es obligatoria.`;
    if (calcularPuntuacion(seleccion) === 0) return 'Los dados seleccionados no suman puntos.';
    if (dadosInutiles(seleccion).length > 0) return 'Seleccionaste dados que no suman puntos. Destildalos.';
    return null;
}

// Muestra los dados unos segundos y pasa el turno sin sumar.
function perderTurno(sala, texto) {
    sala.enBust = true;
    avisar(sala, texto, 'mal');
    const tirada = sala.tirada;
    sala.bustTimer = setTimeout(() => {
        sala.bustTimer = null;
        if (!salas.has(sala.codigo) || sala.tirada !== tirada || !sala.enBust) return;
        sala.enBust = false;
        pasarTurno(sala);
        emitir(sala);
    }, ESPERA_TRAS_PERDER_MS);
}

function mensajePasarse(puntosTurno) {
    return `Con esa selección sumás ${puntosTurno} en el turno y te pasás de ${PUNTOS_PARA_GANAR}. Elegí menos dados.`;
}

function lanzar(sala, jugador) {
    let calientes = false;
    if (sala.dados.length > 0) {
        const error = validarSeleccion(sala, jugador);
        if (error) return error;
        const puntosTurno = sala.puntosTurno + calcularPuntuacion(elegidos(sala));
        if (jugador.puntaje + puntosTurno > PUNTOS_PARA_GANAR) return mensajePasarse(puntosTurno);

        sala.puntosTurno = puntosTurno;
        for (let i = 0; i < NUM_DADOS; i++) {
            if (sala.sel[i]) sala.fijos[i] = true;
        }
        if (sala.fijos.every(f => f)) {
            calientes = true;
            sala.fijos.fill(false);
        }
    }

    // Tiro de CULO (pedido antes de tirar): cada dado vale su cara de abajo (1-6, 2-5, 3-4).
    const deCulo = sala.culoArmado;
    sala.culoArmado = false;
    sala.culo = deCulo;
    sala.caras = deCulo ? new Array(NUM_DADOS).fill(null) : null;
    for (let i = 0; i < NUM_DADOS; i++) {
        if (sala.fijos[i]) continue;
        const arriba = crypto.randomInt(1, 7);
        sala.dados[i] = deCulo ? 7 - arriba : arriba;
        if (deCulo) sala.caras[i] = arriba;
    }
    sala.sel.fill(false);
    sala.obligatorios = [];
    sala.jugadaObligatoria = null;
    sala.tirada++;

    const disponibles = sala.dados.filter((_, i) => !sala.fijos[i]);
    if (disponibles.length === NUM_DADOS && new Set(disponibles).size === 1) {
        // Generala: gana la partida sin importar los puntos.
        sala.fase = 'fin';
        sala.ganador = jugador.nombre;
        marcarObligatoria(sala);
        avisar(sala, `🎲 ¡GENERALA! ${jugador.nombre} gana la partida. 🎉`, 'bien');
        return null;
    }

    const faltan = PUNTOS_PARA_GANAR - jugador.puntaje - sala.puntosTurno;
    const puntosMesa = calcularPuntuacion(disponibles);
    const comoSalio = deCulo ? ' (de culo)' : '';
    if (puntosMesa === 0) {
        const perdidos = sala.puntosTurno;
        perderTurno(sala, perdidos > 0
            ? `¡Mala suerte, ${jugador.nombre}! No hay jugada posible${comoSalio}. Pierde ${perdidos} puntos del turno.`
            : `¡Mala suerte, ${jugador.nombre}! No hay jugada posible${comoSalio}.`);
        return null;
    }
    if (puntosMesa > faltan) {
        // Los puntos de la mesa lo pasan de la meta: pierde el turno.
        perderTurno(sala, `¡${jugador.nombre} se pasó! Con ${sala.puntosTurno} del turno y ${puntosMesa} en la mesa${comoSalio} superaba los ${PUNTOS_PARA_GANAR}. Sigue con ${jugador.puntaje}.`);
        return null;
    }

    marcarObligatoria(sala);
    if (calientes) {
        avisar(sala, `🔥 ¡Dados calientes! ${jugador.nombre} vuelve a lanzar los 5 dados con ${sala.puntosTurno} puntos acumulados.`, 'bien');
    }
    return null;
}

function plantarse(sala, jugador) {
    if (sala.dados.length === 0) return 'Primero tenés que lanzar los dados.';
    const error = validarSeleccion(sala, jugador);
    if (error) return error;

    const puntosFinalesTurno = sala.puntosTurno + calcularPuntuacion(elegidos(sala));
    const nuevoPuntajeTotal = jugador.puntaje + puntosFinalesTurno;
    if (nuevoPuntajeTotal > PUNTOS_PARA_GANAR) return mensajePasarse(puntosFinalesTurno);

    if (nuevoPuntajeTotal === PUNTOS_PARA_GANAR) {
        jugador.puntaje = nuevoPuntajeTotal;
        jugador.haAbierto = true;
        sala.fase = 'fin';
        sala.ganador = jugador.nombre;
        avisar(sala, `🎉 ¡${jugador.nombre} ganó con ${PUNTOS_PARA_GANAR} puntos exactos! 🎉`, 'bien');
        return null;
    } else if (jugador.haAbierto) {
        jugador.puntaje += puntosFinalesTurno;
        avisar(sala, `${jugador.nombre} se planta y suma ${puntosFinalesTurno} puntos.`);
    } else if (puntosFinalesTurno >= PUNTOS_PARA_ABRIR) {
        jugador.haAbierto = true;
        jugador.puntaje += puntosFinalesTurno;
        avisar(sala, `¡${jugador.nombre} abrió su marcador con ${puntosFinalesTurno} puntos!`, 'bien');
    } else {
        avisar(sala, `${jugador.nombre} necesitaba ${PUNTOS_PARA_ABRIR} puntos en un turno para abrir. No suma los ${puntosFinalesTurno}.`, 'mal');
    }

    pasarTurno(sala);
    return null;
}

function empezar(sala) {
    if (sala.bustTimer) clearTimeout(sala.bustTimer);
    sala.bustTimer = null;
    sala.enBust = false;
    sala.jugadores.forEach(j => { j.puntaje = 0; j.haAbierto = false; });
    sala.fase = 'jugando';
    sala.ganador = null;
    sala.turno = crypto.randomInt(sala.jugadores.length);
    iniciarNuevoTurno(sala);
    avisar(sala, `¡Empieza la partida! Arranca ${sala.jugadores[sala.turno].nombre}.`, 'bien');
}

function quitarJugador(sala, jugador) {
    const idx = sala.jugadores.indexOf(jugador);
    if (idx === -1) return;
    sala.jugadores.splice(idx, 1);

    if (sala.jugadores.length === 0) {
        if (sala.bustTimer) clearTimeout(sala.bustTimer);
        salas.delete(sala.codigo);
        return;
    }
    if (sala.anfitrionId === jugador.id) {
        sala.anfitrionId = (sala.jugadores.find(j => j.conectado) || sala.jugadores[0]).id;
    }
    if (sala.fase === 'jugando') {
        if (idx < sala.turno) {
            sala.turno--;
        } else if (idx === sala.turno) {
            if (sala.bustTimer) clearTimeout(sala.bustTimer);
            sala.bustTimer = null;
            sala.enBust = false;
            sala.turno = sala.turno % sala.jugadores.length;
            iniciarNuevoTurno(sala);
        }
    }
    avisar(sala, `${jugador.nombre} salió de la partida.`);
}

// --- Conexiones ---
// Cada jugador tiene un id público (lo ven todos) y una clave secreta que guarda su
// dispositivo. Con la clave (o el link personal) puede seguir jugando desde otro equipo.
function entrar(socket, sala, clave, nombre, soloReconectar) {
    let jugador = sala.jugadores.find(j => j.secreto === clave);
    if (!jugador && !soloReconectar && nombre) {
        // Mismo nombre que un jugador desconectado: es la misma persona en otro dispositivo.
        const mismoNombre = sala.jugadores.find(j => j.nombre.toLowerCase() === nombre.toLowerCase());
        if (mismoNombre && !mismoNombre.conectado) {
            jugador = mismoNombre;
            jugador.secreto = clave;
        }
    }
    if (!jugador) {
        if (soloReconectar) return { error: 'Ya no estás en esa sala (quizás la abriste en otro dispositivo).' };
        if (!nombre) return { error: 'Escribí tu nombre.' };
        if (sala.jugadores.length >= MAX_JUGADORES) return { error: 'La sala está llena.' };
        jugador = {
            id: crypto.randomBytes(6).toString('hex'),
            secreto: clave,
            nombre: nombreUnico(sala, nombre),
            puntaje: 0,
            haAbierto: false,
            conectado: true,
            socketId: null
        };
        sala.jugadores.push(jugador);
        avisar(sala, `${jugador.nombre} se unió a la partida.`);
    }

    // Si la partida estaba abierta en otro dispositivo, ese queda afuera.
    if (jugador.socketId && jugador.socketId !== socket.id) {
        const anterior = io.sockets.sockets.get(jugador.socketId);
        if (anterior) {
            anterior.emit('reemplazado');
            anterior.leave(sala.codigo);
            anterior.data.codigo = null;
            anterior.data.clave = null;
        }
    }
    // Si este dispositivo estaba en otra sala, la deja.
    if (socket.data.codigo && socket.data.codigo !== sala.codigo) socket.leave(socket.data.codigo);

    jugador.conectado = true;
    jugador.socketId = socket.id;
    socket.join(sala.codigo);
    socket.data.codigo = sala.codigo;
    socket.data.clave = clave;
    sala.ultimaActividad = Date.now();
    return { jugador };
}

function respuesta(cb) {
    return typeof cb === 'function' ? cb : () => {};
}

io.on('connection', (socket) => {

    socket.on('crear', (datos, cb) => {
        cb = respuesta(cb);
        const jugadorId = String(datos?.jugadorId || '').slice(0, 64);
        const nombre = limpiarNombre(datos?.nombre);
        if (!jugadorId) return cb({ error: 'Error de identificación. Recargá la página.' });
        if (!nombre) return cb({ error: 'Escribí tu nombre.' });
        const sala = crearSala();
        const { jugador } = entrar(socket, sala, jugadorId, nombre, false);
        sala.anfitrionId = jugador.id;
        sala.aviso = null;
        cb({ ok: true, codigo: sala.codigo, miId: jugador.id });
        socket.emit('chatHistorial', sala.chat);
        emitir(sala);
    });

    socket.on('unirse', (datos, cb) => {
        cb = respuesta(cb);
        const codigo = String(datos?.codigo || '').trim().toUpperCase();
        const jugadorId = String(datos?.jugadorId || '').slice(0, 64);
        const sala = salas.get(codigo);
        if (!sala) return cb({ error: 'No existe una sala con ese código.' });
        if (!jugadorId) return cb({ error: 'Error de identificación. Recargá la página.' });
        const { error, jugador } = entrar(socket, sala, jugadorId, limpiarNombre(datos?.nombre), !!datos?.soloReconectar);
        if (error) return cb({ error });
        cb({ ok: true, codigo: sala.codigo, miId: jugador.id });
        socket.emit('chatHistorial', sala.chat);
        emitir(sala);
    });

    function miLugar() {
        const sala = salas.get(socket.data.codigo);
        const jugador = sala && sala.jugadores.find(j => j.secreto === socket.data.clave);
        return { sala, jugador };
    }

    // Acciones dentro de una sala
    function accion(evento, manejador) {
        socket.on(evento, (arg, cb) => {
            if (typeof arg === 'function') { cb = arg; arg = undefined; }
            cb = respuesta(cb);
            const { sala, jugador } = miLugar();
            if (!sala) return cb({ error: 'No estás en ninguna sala.' });
            if (!jugador) return cb({ error: 'No estás en esta sala.' });
            const error = manejador(sala, jugador, arg);
            sala.ultimaActividad = Date.now();
            if (error) return cb({ error });
            cb({ ok: true });
            emitir(sala);
        });
    }

    function enSuTurno(manejador) {
        return (sala, jugador, arg) => {
            if (sala.fase !== 'jugando') return 'La partida no está en curso.';
            if (sala.jugadores[sala.turno]?.id !== jugador.id) return 'No es tu turno.';
            if (sala.enBust) return 'Esperá, está pasando el turno.';
            return manejador(sala, jugador, arg);
        };
    }

    accion('empezar', (sala, jugador) => {
        if (sala.anfitrionId !== jugador.id) return 'Solo el anfitrión puede empezar la partida.';
        if (sala.fase === 'jugando') return 'La partida ya está en curso.';
        empezar(sala);
    });

    accion('tocarDado', enSuTurno((sala, jugador, i) => {
        if (!Number.isInteger(i) || i < 0 || i >= NUM_DADOS) return 'Dado inválido.';
        if (sala.dados.length === 0 || sala.fijos[i]) return 'Ese dado no se puede elegir.';
        if (sala.obligatorios.includes(i)) return `La jugada "${sala.jugadaObligatoria}" es obligatoria.`;
        sala.sel[i] = !sala.sel[i];
    }));

    accion('lanzar', enSuTurno(lanzar));
    accion('plantarse', enSuTurno(plantarse));

    // CULO se pide ANTES de tirar y vale solo para el próximo tiro.
    accion('culo', enSuTurno((sala, jugador) => {
        sala.culoArmado = !sala.culoArmado;
        avisar(sala, sala.culoArmado
            ? `🍑 ${jugador.nombre} va a tirar de CULO`
            : `${jugador.nombre} ya no tira de culo`, sala.culoArmado ? 'culo' : 'info');
    }));

    accion('saltarTurno', (sala, jugador) => {
        if (sala.anfitrionId !== jugador.id) return 'Solo el anfitrión puede saltar turnos.';
        if (sala.fase !== 'jugando') return 'La partida no está en curso.';
        if (sala.bustTimer) clearTimeout(sala.bustTimer);
        sala.bustTimer = null;
        sala.enBust = false;
        const salteado = sala.jugadores[sala.turno];
        pasarTurno(sala);
        avisar(sala, `El anfitrión saltó el turno de ${salteado.nombre}.`);
    });

    accion('salir', (sala, jugador) => {
        quitarJugador(sala, jugador);
        socket.leave(sala.codigo);
        socket.data.codigo = null;
        socket.data.clave = null;
    });

    socket.on('chat', (texto, cb) => {
        cb = respuesta(cb);
        const { sala, jugador } = miLugar();
        if (!sala || !jugador) return cb({ error: 'No estás en ninguna sala.' });
        texto = String(texto || '').trim().slice(0, LARGO_MENSAJE);
        if (!texto) return cb({ error: 'El mensaje está vacío.' });
        const ahora = Date.now();
        if (jugador.ultimoMensaje && ahora - jugador.ultimoMensaje < 400) return cb({ error: 'Más despacio 🙂' });
        jugador.ultimoMensaje = ahora;

        const mensaje = { id: ++sala.chatSeq, autor: jugador.id, nombre: jugador.nombre, texto, hora: ahora };
        sala.chat.push(mensaje);
        if (sala.chat.length > MAX_MENSAJES) sala.chat.shift();
        sala.ultimaActividad = ahora;
        io.to(sala.codigo).emit('chat', mensaje);
        programarGuardado();
        cb({ ok: true });
    });

    socket.on('disconnect', () => {
        const { sala, jugador } = miLugar();
        if (!sala) return;
        if (jugador && jugador.socketId === socket.id) {
            jugador.conectado = false;
            emitir(sala);
        }
    });
});

// Borra partidas abandonadas hace mucho (las partidas en curso quedan pendientes
// hasta que alguien toque "Salir").
setInterval(() => {
    const ahora = Date.now();
    for (const [codigo, sala] of salas) {
        const nadie = sala.jugadores.every(j => !j.conectado);
        if (nadie && ahora - sala.ultimaActividad > SALA_INACTIVA_MS) {
            if (sala.bustTimer) clearTimeout(sala.bustTimer);
            salas.delete(codigo);
            programarGuardado();
        }
    }
}, 60 * 60 * 1000);

// Antes de apagarse (por ejemplo al publicar una versión nueva), guarda todo.
for (const senal of ['SIGTERM', 'SIGINT']) {
    process.on(senal, async () => {
        await guardarAhora();
        process.exit(0);
    });
}

module.exports = { server, salas, cargarPartidas, guardarAhora };
if (require.main !== module) return;

const PORT = process.env.PORT || 3000;
cargarPartidas().then(() => server.listen(PORT, () => {
    console.log(`🎲 Juego de dados en http://localhost:${PORT}`);
    for (const lista of Object.values(os.networkInterfaces())) {
        for (const red of lista || []) {
            if (red.family === 'IPv4' && !red.internal) {
                console.log(`   Desde el celular (misma WiFi): http://${red.address}:${PORT}`);
            }
        }
    }
}));
