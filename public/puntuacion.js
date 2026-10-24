// Lógica de puntuación compartida: la usa el servidor (Node) y el navegador.
(function (raiz, fabrica) {
    const modulo = fabrica();
    if (typeof module === 'object' && module.exports) module.exports = modulo;
    else raiz.Puntuacion = modulo;
})(typeof self !== 'undefined' ? self : this, function () {

    function calcularPuntuacion(dados) {
        if (!dados || dados.length === 0) return 0;
        let puntuacion = 0;
        const cuentas = {};
        dados.forEach(dado => { cuentas[dado] = (cuentas[dado] || 0) + 1; });
        const unicosOrdenados = [...new Set(dados)].sort((a, b) => a - b).join('');

        if (dados.length === 5) {
            if (Object.values(cuentas).includes(5)) return 10000; // Jackpot
            if (unicosOrdenados === '12345' || unicosOrdenados === '23456' || unicosOrdenados === '13456') {
                return 500; // Escalera
            }
            if (Object.values(cuentas).includes(4)) return 700; // Poker
            if (Object.values(cuentas).includes(3) && Object.values(cuentas).includes(2)) return 600; // Full House
        }

        let dadosRestantes = [...dados];
        for (const num in cuentas) {
            if (cuentas[num] >= 3) {
                puntuacion += (num == 1) ? 1000 : num * 100;
                // Eliminar exactamente 3 dados iguales para evaluar los restantes
                let borrados = 0;
                dadosRestantes = dadosRestantes.filter(d => {
                    if (d == num && borrados < 3) { borrados++; return false; }
                    return true;
                });
                break;
            }
        }
        dadosRestantes.forEach(dado => {
            if (dado === 1) puntuacion += 100;
            if (dado === 5) puntuacion += 50;
        });
        return puntuacion;
    }

    // Devuelve las posiciones de los dados elegidos que no aportan puntos
    // (si se quitan, la puntuación de la selección no cambia).
    function dadosInutiles(dados) {
        const total = calcularPuntuacion(dados);
        const inutiles = [];
        for (let i = 0; i < dados.length; i++) {
            const sinEste = dados.filter((_, j) => j !== i);
            if (calcularPuntuacion(sinEste) === total) inutiles.push(i);
        }
        return inutiles;
    }

    // Busca una combinación que el jugador está obligado a usar entre los dados libres:
    // generala, escalera, póker o full (los 5 dados), o una pierna (3 iguales).
    // Devuelve { nombre, indices } con las posiciones dentro de `dados`, o null.
    function jugadaObligatoria(dados) {
        const cuentas = {};
        dados.forEach(dado => { cuentas[dado] = (cuentas[dado] || 0) + 1; });
        const valores = Object.values(cuentas);

        if (dados.length === 5) {
            const todos = [0, 1, 2, 3, 4];
            const unicosOrdenados = [...new Set(dados)].sort((a, b) => a - b).join('');
            if (valores.includes(5)) return { nombre: 'Generala', indices: todos };
            if (unicosOrdenados === '12345' || unicosOrdenados === '23456' || unicosOrdenados === '13456') {
                return { nombre: 'Escalera', indices: todos };
            }
            if (valores.includes(4)) return { nombre: 'Póker', indices: todos };
            if (valores.includes(3) && valores.includes(2)) return { nombre: 'Full', indices: todos };
        }

        for (const num in cuentas) {
            if (cuentas[num] >= 3) {
                const indices = [];
                dados.forEach((d, i) => { if (d == num && indices.length < 3) indices.push(i); });
                return { nombre: `Pierna de ${num}`, indices };
            }
        }
        return null;
    }

    return { calcularPuntuacion, dadosInutiles, jugadaObligatoria };
});
