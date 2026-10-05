-- Variante pequeña (máx. 1080 px) de la imagen para las tarjetas del inicio, el muro y "Conecta", y para celulares.
-- Se genera la primera vez que se pide (no hay que reprocesar nada al migrar) y se descarta sola si cambia la imagen.
ALTER TABLE investigaciones ADD COLUMN imagen_mini bytea;

CREATE FUNCTION invalidar_imagen_mini() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.imagen IS DISTINCT FROM OLD.imagen THEN
    NEW.imagen_mini := NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER investigaciones_invalidar_imagen_mini
  BEFORE UPDATE OF imagen ON investigaciones
  FOR EACH ROW EXECUTE FUNCTION invalidar_imagen_mini();

-- URL exacta que confirmó el admin para imprimir. Si BASE_URL cambia, los QR vuelven a ser provisionales.
INSERT INTO configuracion (clave, valor) VALUES ('url_qr_confirmada_para', 'null'::jsonb) ON CONFLICT (clave) DO NOTHING;
