document.querySelectorAll('[data-counter]').forEach(field => {
  const output = document.querySelector(`output[for="${field.id}"]`);
  if (!output) return;
  const update = () => {
    const length = field.value.trim().length;
    const minimum = Number(field.dataset.minSend || 0);
    output.textContent = minimum && length < minimum
      ? `${length} / ${field.maxLength} · faltan ${minimum - length} para enviar`
      : `${length} / ${field.maxLength}`;
  };
  field.addEventListener('input', update);
  update();
});

const formError = document.querySelector('[data-form-error]');
if (formError) {
  formError.focus({ preventScroll: true });
  formError.scrollIntoView({ block: 'center' });
}

document.querySelectorAll('form[data-confirm]').forEach(form => {
  form.addEventListener('submit', event => {
    if (!window.confirm(form.dataset.confirm)) event.preventDefault();
  });
});

// Evita el doble envío: el servidor también lo impide con un token de operación.
document.querySelectorAll('form[data-once]').forEach(form => {
  form.addEventListener('submit', event => {
    if (event.defaultPrevented) return;
    if (form.dataset.sending) return event.preventDefault();
    form.dataset.sending = '1';
    form.querySelectorAll('button[type=submit]').forEach(button => {
      button.dataset.label = button.textContent; button.disabled = true; button.textContent = 'Enviando…';
    });
  });
});
// Al volver con el botón Atrás el formulario debe poder usarse otra vez.
window.addEventListener('pageshow', event => {
  if (!event.persisted) return;
  document.querySelectorAll('form[data-once]').forEach(form => {
    delete form.dataset.sending;
    form.querySelectorAll('button[data-label]').forEach(button => { button.disabled = false; button.textContent = button.dataset.label; });
  });
});

// Borrador de comentario guardado en este navegador mientras la persona crea su cuenta.
const store = {
  get(key) { try { return window.localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { window.localStorage.setItem(key, value); } catch { /* sin almacenamiento */ } },
  remove(key) { try { window.localStorage.removeItem(key); } catch { /* sin almacenamiento */ } }
};
document.querySelectorAll('textarea[data-draft-key]').forEach(field => {
  const key = field.dataset.draftKey;
  if (document.querySelector('[data-draft-sent]')) store.remove(key);
  else if (!field.value && store.get(key)) { field.value = store.get(key); field.dispatchEvent(new Event('input')); }
  field.addEventListener('input', () => { if (field.value.trim()) store.set(key, field.value); else store.remove(key); });
  // Con cuenta el texto viaja en el POST; sin cuenta queda guardado para después del registro.
  field.form?.addEventListener('submit', () => { if (field.value.trim()) store.set(key, field.value); });
});

// Importación de programas: el CSV elegido se lee en el navegador y se pega en el campo de texto.
document.querySelectorAll('input[type=file][data-csv-target]').forEach(input => {
  input.addEventListener('change', () => {
    const file = input.files && input.files[0];
    const target = document.getElementById(input.dataset.csvTarget);
    if (!file || !target) return;
    if (file.size > 200 * 1024) { window.alert('El archivo es muy grande. Usa un CSV de menos de 200 KB.'); input.value = ''; return; }
    const reader = new FileReader();
    reader.onload = () => { target.value = String(reader.result || ''); target.focus(); };
    reader.readAsText(file, 'utf-8');
  });
});

document.querySelectorAll('[data-select-all]').forEach(field => {
  field.addEventListener('focus', () => field.select());
});

document.querySelectorAll('[data-print]').forEach(button => button.addEventListener('click', () => window.print()));

// Territorio «Otro»: el campo para escribirlo solo se muestra cuando se elige esa opción.
document.querySelectorAll('select[data-other-target]').forEach(select => {
  const target = document.getElementById(select.dataset.otherTarget);
  if (!target) return;
  const update = () => { target.hidden = select.value !== 'otro'; };
  select.addEventListener('change', () => { update(); if (!target.hidden) target.querySelector('input')?.focus(); });
  update();
});
