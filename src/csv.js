// CSV RFC 4180 con BOM UTF-8 para que Excel muestre bien las tildes.
// Los textos que empiezan por = + - @ se prefijan con ' para evitar inyección de fórmulas en hojas de cálculo.
function cell(value) {
  if (value === null || value === undefined) return '';
  let text = value instanceof Date ? value.toISOString() : typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const BOM = '﻿';
const csvLine = values => values.map(cell).join(',') + '\r\n';

function toCsv(rows, columns = rows.length ? Object.keys(rows[0]) : []) {
  return BOM + [columns.map(cell).join(','), ...rows.map(row => columns.map(c => cell(row[c])).join(','))].join('\r\n') + '\r\n';
}

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  const input = String(text).replace(/^﻿/, '');
  // Excel en español suele guardar con punto y coma: se detecta por la primera línea.
  const header = input.split(/\r?\n/, 1)[0];
  const delimiter = header.includes(';') && !header.includes(',') ? ';' : ',';
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"' && input[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === delimiter) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && input[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.map(r => r.map(v => v.trim())).filter(r => r.some(v => v !== ''));
}

module.exports = { toCsv, parseCsv, csvLine, BOM };
