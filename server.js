const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { Server } = require('socket.io');
const { calcularPuntuacion, dadosInutiles } = require('./public/puntuacion.js');

// --- Constantes del juego ---
const PUNTOS_PARA_ABRIR = 750;
const PUNTOS_PARA_GANAR = 3000;
const NUM_DADOS = 5;
const MAX_JUGADORES = 10;
const ESPERA_TRAS_PERDER_MS = 2500;   // tiempo para ver los dados antes de pasar el turno
const SALA_INACTIVA_MS = 3 * 60 * 60 * 1000;

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

function crearSala(anfitrionId) {
    const sala = {
        codigo: nuevoCodigo(),
        anfitrionId,
        fase: 'lobby',            // lobby | jugando | fin
        jugadores: [],
        turno: 0,
        dados: [],
        sel: new Array(NUM_DADOS).fill(false),
        fijos: new Array(NUM_DADOS).fill(false),
        puntosTurno: 0,
        tirada: 0,
        enBust: false,
        ganador: null,
        aviso: null,
        avisoSeq: 0,
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
        tirada: sala.tirada,
        enBust: sala.enBust,
        ganador: sala.ganador,
        aviso: sala.aviso,
        constantes: { PUNTOS_PARA_ABRIR, PUNTOS_PARA_GANAR }
    };
}

function emitir(sala) {
    io.to(sala.codigo).emit('estado', estadoPublico(sala));
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
}

function pasarTurno(sala) {
    if (sala.jugadores.length === 0) return;
    sala.turno = (sala.turno + 1) % sala.jugadores.length;
    iniciarNuevoTurno(sala);
}

function elegidos(sala) {
    return sala.dados.filter((_, i) => sala.sel[i] && !sala.fijos[i]);
}

// Devuelve un mensaje de error si la selección actual no es válida.
function validarSeleccion(seleccion) {
    if (seleccion.length === 0) return null;
    if (calcularPuntuacion(seleccion) === 0) return 'Los dados seleccionados no suman puntos.';
    if (dadosInutiles(seleccion).length > 0) return 'Seleccionaste dados que no suman puntos. Destildalos.';
    return null;
}

function lanzar(sala, jugador) {
    let calientes = false;
    if (sala.dados.length > 0) {
        const seleccion = elegidos(sala);
        if (seleccion.length === 0) return 'Debes seleccionar al menos un dado con puntos para continuar.';
        const error = validarSeleccion(seleccion);
        if (error) return error;

        sala.puntosTurno += calcularPuntuacion(seleccion);
        for (let i = 0; i < NUM_DADOS; i++) {
            if (sala.sel[i]) sala.fijos[i] = true;
        }
        if (sala.fijos.every(f => f)) {
            calientes = true;
            sala.fijos.fill(false);
        }
    }

    for (let i = 0; i < NUM_DADOS; i++) {
        if (!sala.fijos[i]) sala.dados[i] = crypto.randomInt(1, 7);
    }
    sala.sel.fill(false);
    sala.tirada++;

    const disponibles = sala.dados.filter((_, i) => !sala.fijos[i]);
    if (calcularPuntuacion(disponibles) === 0) {
        // Bust: se muestran los dados un momento y pasa el turno.
        sala.enBust = true;
        const perdidos = sala.puntosTurno;
        avisar(sala, perdidos > 0
            ? `¡Mala suerte, ${jugador.nombre}! No hay jugada posible. Pierde ${perdidos} puntos del turno.`
            : `¡Mala suerte, ${jugador.nombre}! No hay jugada posible.`, 'mal');
        const tirada = sala.tirada;
        sala.bustTimer = setTimeout(() => {
            sala.bustTimer = null;
            if (!salas.has(sala.codigo) || sala.tirada !== tirada || !sala.enBust) return;
            sala.enBust = false;
            pasarTurno(sala);
            emitir(sala);
        }, ESPERA_TRAS_PERDER_MS);
    } else if (calientes) {
        avisar(sala, `🔥 ¡Dados calientes! ${jugador.nombre} vuelve a lanzar los 5 dados con ${sala.puntosTurno} puntos acumulados.`, 'bien');
    }
    return null;
}

function plantarse(sala, jugador) {
    if (sala.dados.length === 0) return 'Primero tenés que lanzar los dados.';
    const seleccion = elegidos(sala);
    const error = validarSeleccion(seleccion);
    if (error) return error;

    const puntosFinalesTurno = sala.puntosTurno + calcularPuntuacion(seleccion);
    if (puntosFinalesTurno === 0) return 'No tenés puntos para plantarte.';

    const nuevoPuntajeTotal = jugador.puntaje + puntosFinalesTurno;

    if (nuevoPuntajeTotal > PUNTOS_PARA_GANAR) {
        avisar(sala, `¡${jugador.nombre} se pasó! Tenía ${jugador.puntaje} y con ${puntosFinalesTurno} se pasaba de ${PUNTOS_PARA_GANAR}. No suma nada.`, 'mal');
    } else if (nuevoPuntajeTotal === PUNTOS_PARA_GANAR) {
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
function entrar(socket, sala, jugadorId, nombre, soloReconectar) {
    let jugador = sala.jugadores.find(j => j.id === jugadorId);
    if (!jugador) {
        if (soloReconectar) return 'No estabas en esa sala.';
        if (!nombre) return 'Escribí tu nombre.';
        if (sala.jugadores.length >= MAX_JUGADORES) return 'La sala está llena.';
        jugador = { id: jugadorId, nombre: nombreUnico(sala, nombre), puntaje: 0, haAbierto: false, conectado: true, socketId: null };
        sala.jugadores.push(jugador);
        avisar(sala, `${jugador.nombre} se unió a la partida.`);
    }

    // Si este celular estaba en otra sala, la deja.
    if (socket.data.codigo && socket.data.codigo !== sala.codigo) socket.leave(socket.data.codigo);

    jugador.conectado = true;
    jugador.socketId = socket.id;
    socket.join(sala.codigo);
    socket.data.codigo = sala.codigo;
    socket.data.jugadorId = jugadorId;
    sala.ultimaActividad = Date.now();
    return null;
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
        const sala = crearSala(jugadorId);
        const error = entrar(socket, sala, jugadorId, nombre, false);
        if (error) return cb({ error });
        sala.aviso = null;
        cb({ ok: true, codigo: sala.codigo });
        emitir(sala);
    });

    socket.on('unirse', (datos, cb) => {
        cb = respuesta(cb);
        const codigo = String(datos?.codigo || '').trim().toUpperCase();
        const jugadorId = String(datos?.jugadorId || '').slice(0, 64);
        const sala = salas.get(codigo);
        if (!sala) return cb({ error: 'No existe una sala con ese código.' });
        if (!jugadorId) return cb({ error: 'Error de identificación. Recargá la página.' });
        const error = entrar(socket, sala, jugadorId, limpiarNombre(datos?.nombre), !!datos?.soloReconectar);
        if (error) return cb({ error });
        cb({ ok: true, codigo: sala.codigo });
        emitir(sala);
    });

    // Acciones dentro de una sala
    function accion(evento, manejador) {
        socket.on(evento, (arg, cb) => {
            if (typeof arg === 'function') { cb = arg; arg = undefined; }
            cb = respuesta(cb);
            const sala = salas.get(socket.data.codigo);
            if (!sala) return cb({ error: 'No estás en ninguna sala.' });
            const jugador = sala.jugadores.find(j => j.id === socket.data.jugadorId);
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
        sala.sel[i] = !sala.sel[i];
    }));

    accion('lanzar', enSuTurno(lanzar));
    accion('plantarse', enSuTurno(plantarse));

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
        socket.data.jugadorId = null;
    });

    socket.on('disconnect', () => {
        const sala = salas.get(socket.data.codigo);
        if (!sala) return;
        const jugador = sala.jugadores.find(j => j.id === socket.data.jugadorId);
        if (jugador && jugador.socketId === socket.id) {
            jugador.conectado = false;
            emitir(sala);
        }
    });
});

// Borra salas abandonadas.
setInterval(() => {
    const ahora = Date.now();
    for (const [codigo, sala] of salas) {
        const nadie = sala.jugadores.every(j => !j.conectado);
        if (nadie && ahora - sala.ultimaActividad > SALA_INACTIVA_MS) {
            if (sala.bustTimer) clearTimeout(sala.bustTimer);
            salas.delete(codigo);
        }
    }
}, 10 * 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🎲 Juego de dados en http://localhost:${PORT}`);
    for (const lista of Object.values(os.networkInterfaces())) {
        for (const red of lista || []) {
            if (red.family === 'IPv4' && !red.internal) {
                console.log(`   Desde el celular (misma WiFi): http://${red.address}:${PORT}`);
            }
        }
    }
});
