-- El autor elige el territorio de su ficha al registrarla (territorio_id). Si ninguno aplica, escribe uno en
-- territorio_propuesto; IMAGO lo crea como territorio al aprobar y publicar la ficha.
ALTER TABLE investigaciones
  ADD COLUMN territorio_propuesto text,
  ADD CONSTRAINT investigaciones_territorio_propuesto_largo
    CHECK (territorio_propuesto IS NULL OR char_length(territorio_propuesto) BETWEEN 3 AND 80);
