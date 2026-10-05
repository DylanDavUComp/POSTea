const net = require('node:net');

// IP real del visitante para los límites de frecuencia y el HMAC de visitas.
// En Render la solicitud pasa por Cloudflare y por el balanceador de Render: X-Forwarded-For trae varios saltos,
// Render no limpia el valor que envía el cliente (el primero se puede falsificar) y con `trust proxy` = 1
// req.ip puede quedar con la IP de un proxy compartido por muchas personas.
// CLIENT_IP_HEADER=cf-connecting-ip usa la cabecera que Cloudflare escribe en su borde (reemplaza la del cliente).
// Sin esa variable, o si la cabecera falta o no es una IP, se usa req.ip (según `trust proxy`).
function clientIp(req) {
  const header = (process.env.CLIENT_IP_HEADER || '').trim().toLowerCase();
  if (header) {
    const value = String(req.get(header) || '').split(',')[0].trim();
    if (net.isIP(value)) return value;
  }
  return req.ip;
}

// `trust proxy`: TRUST_PROXY (número de saltos, true/false o lista de subredes); por defecto 1 en producción.
// Con 1, Express confía en X-Forwarded-Proto del balanceador: req.secure es true y la cookie `Secure` se envía.
function trustProxySetting(env = process.env) {
  const raw = (env.TRUST_PROXY || '').trim();
  if (!raw) return env.NODE_ENV === 'production' ? 1 : false;
  if (/^\d+$/.test(raw)) return Number(raw);
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return raw;
}

module.exports = { clientIp, trustProxySetting };
