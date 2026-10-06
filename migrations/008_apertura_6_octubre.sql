-- La convocatoria abre el 6 de octubre de 2026 (antes, 5 de octubre).
-- Solo cambia el valor inicial: si IMAGO ya ajustó la fecha desde Admin → Configuración, se respeta.
UPDATE configuracion SET valor = '"2026-10-06"'::jsonb
WHERE clave = 'fecha_apertura' AND valor = '"2026-10-05"'::jsonb;
