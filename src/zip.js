// ZIP mínimo sin compresión (método "store"): suficiente para CSV, JSON, WebP y QR, sin dependencias.
// Se escribe por partes: cada archivo va a la respuesta apenas está listo y solo se guarda en memoria
// el directorio central (unos bytes por archivo). Así un respaldo con cientos de imágenes cabe en 512 MB.
const zlib = require('node:zlib');

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buffer) {
  if (zlib.crc32) return zlib.crc32(buffer) >>> 0; // Node 20.15+/22.2+: nativo y mucho más rápido.
  let crc = 0xFFFFFFFF;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
// Fecha y hora de Bogotá (UTC-5 fijo), no la del servidor, que en Render es UTC.
function dosTime(date) {
  const d = new Date(date.getTime() - 5 * 60 * 60 * 1000);
  return { time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
    date: ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate() };
}

function headers(name, data, offset, { time, date }) {
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); // UTF-8
  local.writeUInt16LE(0, 8); local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12);
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(0, 10); central.writeUInt16LE(time, 12); central.writeUInt16LE(date, 14);
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
  return { local, central };
}

function endRecord(count, centralSize, offset) {
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10);
  end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
  return end;
}

// Espera a que el cliente reciba lo enviado; falla si cierra la conexión antes (descarga cancelada).
function waitDrain(out) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { out.off('drain', onDrain); out.off('close', onClose); };
    const onDrain = () => { cleanup(); resolve(); };
    const onClose = () => { cleanup(); reject(new Error('La descarga se interrumpió.')); };
    out.on('drain', onDrain); out.on('close', onClose);
  });
}

const toBuffer = data => Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');

// Escritor por partes sobre un stream (la respuesta HTTP). Respeta la contrapresión: si el cliente descarga
// lento, espera a 'drain' antes de seguir leyendo de la base.
class ZipWriter {
  constructor(out, now = new Date()) { this.out = out; this.stamp = dosTime(now); this.centrals = []; this.offset = 0; this.count = 0; }
  async write(chunk) {
    if (this.out.destroyed) throw new Error('La descarga se interrumpió.');
    if (!this.out.write(chunk)) await waitDrain(this.out);
  }
  async add(fileName, content) {
    const name = Buffer.from(fileName, 'utf8'), data = toBuffer(content);
    const { local, central } = headers(name, data, this.offset, this.stamp);
    await this.write(Buffer.concat([local, name])); await this.write(data);
    this.centrals.push(central, name); this.offset += local.length + name.length + data.length; this.count++;
  }
  async end() {
    const directory = Buffer.concat(this.centrals);
    await this.write(Buffer.concat([directory, endRecord(this.count, directory.length, this.offset)]));
    this.out.end();
  }
}

// Versión en memoria, para archivos pequeños: files = [{ name, data: Buffer|string }]
function zip(files, now = new Date()) {
  const parts = [], centrals = [], stamp = dosTime(now);
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8'), data = toBuffer(file.data);
    const { local, central } = headers(name, data, offset, stamp);
    parts.push(local, name, data); centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  return Buffer.concat([...parts, directory, endRecord(files.length, directory.length, offset)]);
}

module.exports = { zip, ZipWriter, crc32, waitDrain };
