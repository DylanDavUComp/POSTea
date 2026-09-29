CREATE TABLE facultades (
  id bigserial PRIMARY KEY,
  nombre text NOT NULL UNIQUE,
  color_hex varchar(7) NOT NULL CHECK (color_hex ~ '^#[0-9A-Fa-f]{6}$'),
  orden integer NOT NULL DEFAULT 0
);

CREATE TABLE programas (
  id bigserial PRIMARY KEY,
  nombre text NOT NULL UNIQUE,
  facultad_id bigint NOT NULL REFERENCES facultades(id),
  es_especializacion boolean NOT NULL DEFAULT false,
  cupo integer NOT NULL DEFAULT 3 CHECK (cupo > 0),
  activo boolean NOT NULL DEFAULT true
);

CREATE TABLE territorios (
  id bigserial PRIMARY KEY,
  nombre text NOT NULL UNIQUE,
  slug text NOT NULL UNIQUE,
  color_hex varchar(7) NOT NULL CHECK (color_hex ~ '^#[0-9A-Fa-f]{6}$'),
  icono text,
  orden integer NOT NULL DEFAULT 0
);

CREATE TABLE usuarios (
  id bigserial PRIMARY KEY,
  nombre text NOT NULL,
  email text NOT NULL,
  password_hash text NOT NULL,
  rol text NOT NULL DEFAULT 'visitante' CHECK (rol IN ('visitante', 'autor', 'coordinador', 'admin')),
  estado text NOT NULL DEFAULT 'activo' CHECK (estado IN ('activo', 'pendiente', 'bloqueado')),
  tipo_persona text NOT NULL CHECK (tipo_persona IN ('estudiante', 'docente', 'investigador', 'semillero', 'proyecto de grado', 'pasante', 'administrativo', 'egresado', 'externo')),
  programa_id bigint REFERENCES programas(id),
  acepta_datos_at timestamptz NOT NULL,
  acepta_datos_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz,
  CHECK (email = lower(email))
);
CREATE UNIQUE INDEX usuarios_email_lower_unique ON usuarios (lower(email));

CREATE TABLE coordinadores_programa (
  usuario_id bigint NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  programa_id bigint NOT NULL REFERENCES programas(id) ON DELETE CASCADE,
  PRIMARY KEY (usuario_id, programa_id)
);

CREATE TABLE investigaciones (
  id bigserial PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  programa_id bigint NOT NULL REFERENCES programas(id),
  territorio_id bigint REFERENCES territorios(id),
  autor_id bigint NOT NULL REFERENCES usuarios(id),
  titulo varchar(90) NOT NULL,
  subtitulo text,
  pregunta_gancho varchar(80),
  descripcion text,
  objetivo text,
  metodologia text,
  resultados text,
  estado_investigacion text CHECK (estado_investigacion IN ('terminada', 'en_desarrollo')),
  tipo text CHECK (tipo IN ('investigacion', 'semillero', 'proyecto_grado', 'pasantia')),
  imagen bytea,
  imagen_mime text,
  imagen_credito text,
  derechos_imagen_confirmados boolean NOT NULL DEFAULT false,
  sharepoint_url text,
  estado_flujo text NOT NULL DEFAULT 'borrador' CHECK (estado_flujo IN ('borrador', 'enviada', 'seleccionada', 'devuelta', 'publicada', 'archivada')),
  observaciones_revision text,
  qr_verificado_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  publicada_at timestamptz,
  CHECK (octet_length(slug) BETWEEN 3 AND 180),
  CHECK (imagen IS NULL OR imagen_mime = 'image/webp'),
  CHECK (estado_flujo <> 'publicada' OR (territorio_id IS NOT NULL AND publicada_at IS NOT NULL))
);
CREATE INDEX investigaciones_flujo_territorio_idx ON investigaciones(estado_flujo, territorio_id);
CREATE INDEX investigaciones_programa_flujo_idx ON investigaciones(programa_id, estado_flujo);

CREATE FUNCTION bloquear_slug_publicado() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.publicada_at IS NOT NULL AND NEW.slug IS DISTINCT FROM OLD.slug THEN
    RAISE EXCEPTION 'El slug de una investigación publicada no puede cambiar';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER investigaciones_slug_publicado BEFORE UPDATE ON investigaciones
  FOR EACH ROW EXECUTE FUNCTION bloquear_slug_publicado();

CREATE TABLE investigadores (
  id bigserial PRIMARY KEY,
  investigacion_id bigint NOT NULL REFERENCES investigaciones(id) ON DELETE CASCADE,
  nombre_completo text NOT NULL,
  orden integer NOT NULL DEFAULT 0
);

CREATE TABLE inversiones (
  id bigserial PRIMARY KEY,
  usuario_id bigint NOT NULL REFERENCES usuarios(id),
  investigacion_id bigint NOT NULL REFERENCES investigaciones(id),
  monedas integer NOT NULL CHECK (monedas > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX inversiones_investigacion_idx ON inversiones(investigacion_id);
CREATE INDEX inversiones_usuario_idx ON inversiones(usuario_id);

CREATE TABLE comentarios (
  id bigserial PRIMARY KEY,
  usuario_id bigint NOT NULL REFERENCES usuarios(id),
  investigacion_id bigint NOT NULL REFERENCES investigaciones(id),
  tipo text NOT NULL CHECK (tipo IN ('pregunta', 'conexion', 'aplicacion')),
  texto varchar(500) NOT NULL CHECK (char_length(trim(texto)) BETWEEN 1 AND 500),
  estado text NOT NULL DEFAULT 'visible' CHECK (estado IN ('visible', 'oculto', 'reportado')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX comentarios_investigacion_estado_idx ON comentarios(investigacion_id, estado);
CREATE INDEX comentarios_usuario_fecha_idx ON comentarios(usuario_id, created_at);

CREATE TABLE visitas (
  id bigserial PRIMARY KEY,
  investigacion_id bigint NOT NULL REFERENCES investigaciones(id),
  usuario_id bigint REFERENCES usuarios(id),
  origen text NOT NULL CHECK (origen IN ('qr', 'web')),
  user_agent_hash text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX visitas_investigacion_fecha_idx ON visitas(investigacion_id, created_at);

CREATE TABLE configuracion (
  clave text PRIMARY KEY,
  valor jsonb NOT NULL
);

CREATE TABLE tokens_reset (
  token_hash text PRIMARY KEY,
  usuario_id bigint NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  expira_at timestamptz NOT NULL,
  usado boolean NOT NULL DEFAULT false
);

-- Tabla compatible con connect-pg-simple.
CREATE TABLE sesiones (
  sid varchar NOT NULL PRIMARY KEY,
  sess json NOT NULL,
  expire timestamp(6) NOT NULL
);
CREATE INDEX sesiones_expire_idx ON sesiones(expire);
