-- Programas oficiales de pregrado de UCompensar para la convocatoria 2026 (lista entregada por IMAGO).
-- Cupo por defecto: 3 proyectos. Si un nombre ya existe (p. ej. cargado antes por CSV), no se toca.
-- Después se pueden editar, desactivar o ampliar su cupo desde Admin → Programas.
INSERT INTO programas (nombre, facultad_id, es_especializacion)
SELECT p.nombre, f.id, false
FROM (VALUES
  ('Facultad de Ingeniería', 'Ciencia de Datos'),
  ('Facultad de Ingeniería', 'Ingeniería Biomédica'),
  ('Facultad de Ingeniería', 'Ingeniería de Sistemas'),
  ('Facultad de Ingeniería', 'Ingeniería de Software'),
  ('Facultad de Ingeniería', 'Ingeniería de Telecomunicaciones'),
  ('Facultad de Ingeniería', 'Ingeniería en Tecnologías de la Información y las Comunicaciones'),
  ('Facultad de Ingeniería', 'Ingeniería Industrial'),
  ('Facultad de Ingeniería', 'Ingeniería Multimedia'),
  ('Escuela de Negocios', 'Administración de Empresas'),
  ('Escuela de Negocios', 'Administración de Servicios de Salud / Administración en Salud'),
  ('Escuela de Negocios', 'Administración Financiera'),
  ('Escuela de Negocios', 'Administración Logística'),
  ('Escuela de Negocios', 'Contaduría Pública'),
  ('Escuela de Negocios', 'Finanzas y Negocios Internacionales / Profesional en Negocios y Logística Internacional'),
  ('Escuela de Negocios', 'Mercadeo y Publicidad'),
  ('Facultad de Ciencias Sociales y de la Educación', 'Comunicación Social'),
  ('Facultad de Ciencias Sociales y de la Educación', 'Diseño Visual'),
  ('Facultad de Ciencias Sociales y de la Educación', 'Licenciatura en Bilingüismo con Énfasis en Inglés'),
  ('Facultad de Ciencias Sociales y de la Educación', 'Licenciatura en Educación Infantil'),
  ('Facultad de Ciencias Sociales y de la Educación', 'Profesional en Deporte y Actividad Física'),
  ('Facultad de Ciencias Sociales y de la Educación', 'Profesional en Lenguas'),
  ('Facultad de Ciencias Sociales y de la Educación', 'Psicología')
) AS p(facultad, nombre)
JOIN facultades f ON f.nombre = p.facultad
WHERE NOT EXISTS (SELECT 1 FROM programas x WHERE lower(x.nombre) = lower(p.nombre));
