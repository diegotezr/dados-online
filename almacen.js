// Guarda las partidas para que sobrevivan a reinicios del servidor.
// Con las variables UPSTASH_REDIS_REST_URL y UPSTASH_REDIS_REST_TOKEN usa Upstash Redis
// (necesario en Render, donde los archivos se borran al reiniciar); si no, un archivo local.
const fs = require('fs');
const path = require('path');

const URL_REDIS = process.env.UPSTASH_REDIS_REST_URL;
const TOKEN_REDIS = process.env.UPSTASH_REDIS_REST_TOKEN;
const CLAVE_REDIS = 'dados:salas';
const ARCHIVO = process.env.ARCHIVO_DATOS || path.join(__dirname, 'datos', 'salas.json');

async function redis(comando) {
    const respuesta = await fetch(URL_REDIS, {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN_REDIS}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(comando)
    });
    if (!respuesta.ok) throw new Error(`Redis respondió ${respuesta.status}`);
    return (await respuesta.json()).result;
}

async function cargar() {
    try {
        let texto = null;
        if (URL_REDIS) texto = await redis(['GET', CLAVE_REDIS]);
        else if (fs.existsSync(ARCHIVO)) texto = fs.readFileSync(ARCHIVO, 'utf8');
        return texto ? JSON.parse(texto) : [];
    } catch (e) {
        console.error('No se pudieron cargar las partidas guardadas:', e.message);
        return [];
    }
}

async function escribir(datos) {
    const texto = JSON.stringify(datos);
    if (URL_REDIS) {
        await redis(['SET', CLAVE_REDIS, texto]);
    } else {
        fs.mkdirSync(path.dirname(ARCHIVO), { recursive: true });
        fs.writeFileSync(ARCHIVO + '.tmp', texto);
        fs.renameSync(ARCHIVO + '.tmp', ARCHIVO);
    }
}

const descripcion = URL_REDIS ? 'Upstash Redis' : `el archivo ${ARCHIVO}`;

module.exports = { cargar, escribir, descripcion };
