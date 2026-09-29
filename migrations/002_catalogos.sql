INSERT INTO facultades (nombre, color_hex, orden) VALUES
  ('Facultad de Ingeniería', '#E8712F', 1),
  ('Escuela de Negocios', '#1E6B2B', 2),
  ('Facultad de Ciencias Sociales y de la Educación', '#1A9FD6', 3);

INSERT INTO territorios (nombre, slug, color_hex, orden) VALUES
  ('Ciudad y Cultura', 'ciudad-y-cultura', '#9B2C8E', 1),
  ('Sostenibilidad y Territorio', 'sostenibilidad-y-territorio', '#1E6B2B', 2),
  ('Consumo y Sociedad', 'consumo-y-sociedad', '#E8712F', 3),
  ('Innovación y Tecnología', 'innovacion-y-tecnologia', '#5B2A9E', 4),
  ('Comunicación y Creatividad', 'comunicacion-y-creatividad', '#1A9FD6', 5);

INSERT INTO configuracion (clave, valor) VALUES
  ('fecha_apertura', '"2026-10-05"'::jsonb),
  ('fecha_cierre', '"2026-10-19T23:59:00-05:00"'::jsonb),
  ('fecha_exhibicion_inicio', '"2026-10-27"'::jsonb),
  ('fecha_exhibicion_fin', '"2026-10-30T23:59:00-05:00"'::jsonb),
  ('saldo_inicial_monedas', '100'::jsonb),
  ('nombre_moneda', '"Imagos"'::jsonb),
  ('inversion_activa', 'true'::jsonb),
  ('comentarios_activos', 'true'::jsonb),
  ('moderacion_previa', 'false'::jsonb),
  ('mostrar_ranking_publico', 'false'::jsonb),
  ('url_qr_confirmada', 'false'::jsonb),
  ('palabras_bloqueadas', '[]'::jsonb);
