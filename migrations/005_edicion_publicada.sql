-- Edición autorizada de fichas publicadas.
-- El admin autoriza al autor; el autor propone cambios que se guardan aparte (la versión pública y su QR siguen
-- funcionando sin cambios) y solo reemplazan la ficha pública cuando el admin los aprueba.
ALTER TABLE investigaciones
  ADD COLUMN edicion_autorizada_at timestamptz,
  ADD COLUMN edicion_autorizada_por bigint REFERENCES usuarios(id) ON DELETE SET NULL,
  ADD COLUMN cambios jsonb,
  ADD COLUMN cambios_imagen bytea,
  ADD COLUMN cambios_estado text CHECK (cambios_estado IN ('borrador', 'enviada', 'devuelta')),
  ADD COLUMN cambios_observaciones text,
  ADD COLUMN cambios_enviados_at timestamptz,
  ADD CONSTRAINT investigaciones_cambios_publicada CHECK (cambios IS NULL OR estado_flujo = 'publicada');
