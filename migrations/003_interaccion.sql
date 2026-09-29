-- Fase 6: inversión simbólica, comentarios, reportes y moderación.

-- `pendiente` se usa cuando `moderacion_previa` está activa.
ALTER TABLE comentarios DROP CONSTRAINT comentarios_estado_check;
ALTER TABLE comentarios ADD CONSTRAINT comentarios_estado_check
  CHECK (estado IN ('visible', 'oculto', 'reportado', 'pendiente'));
ALTER TABLE comentarios
  ADD COLUMN moderado_at timestamptz,
  ADD COLUMN moderado_por bigint REFERENCES usuarios(id) ON DELETE SET NULL,
  ADD COLUMN operacion uuid;
CREATE INDEX comentarios_estado_fecha_idx ON comentarios(estado, created_at);

-- Token de un solo uso por formulario: un doble clic no duplica la acción.
ALTER TABLE inversiones ADD COLUMN operacion uuid;
CREATE UNIQUE INDEX inversiones_operacion_unique ON inversiones(usuario_id, operacion) WHERE operacion IS NOT NULL;
CREATE UNIQUE INDEX comentarios_operacion_unique ON comentarios(usuario_id, operacion) WHERE operacion IS NOT NULL;

CREATE TABLE reportes_comentario (
  comentario_id bigint NOT NULL REFERENCES comentarios(id) ON DELETE CASCADE,
  usuario_id bigint NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (comentario_id, usuario_id)
);

-- Lista base editable desde /admin/moderacion. Solo se llena si sigue vacía.
UPDATE configuracion SET valor = '["hijueputa","hp","gonorrea","malparido","malparida","carechimba","puta","puto","pendejo","pendeja","imbecil","estupido","estupida","mierda","verga","perra","zorra","marica","maricon"]'::jsonb
  WHERE clave = 'palabras_bloqueadas' AND valor = '[]'::jsonb;
