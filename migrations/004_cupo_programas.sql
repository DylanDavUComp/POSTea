-- El cupo de cada programa limita cuántos proyectos (fichas no archivadas) puede registrar.
-- Por defecto 3; IMAGO lo amplía por solicitud interna del programa, hasta 100.
ALTER TABLE programas ADD CONSTRAINT programas_cupo_rango CHECK (cupo BETWEEN 1 AND 100);
