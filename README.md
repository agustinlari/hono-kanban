config/database.example.ts debe ser reemplazado por config/database.ts
cp config/env.example.ts debe ser reemplazado por config/env.ts
Rellena tus claves reales en config/database.ts y config/env.ts.

# Estructura de la Base de Datos

Esta es una descripción de las tablas principales de la base de datos del proyecto.

## Tabla: `archivos`
- **Propósito**: Almacena los metadatos de todos los archivos subidos al sistema.
- **Campos clave**:
  - `id`: PK, Serial.
  - `nombre_guardado`: El nombre único del archivo en el disco.
  - `usuario_id`: FK a la tabla `usuarios`.

## Tabla: `Inventario`
- **Propósito**: Contiene los artículos del inventario.
- **Campos clave**:
  - `"refArticulo"`: PK, Text. El identificador único del negocio.

## Tabla: `inventario_archivos`
- **Propósito**: Tabla de unión para la relación muchos-a-muchos entre `"Inventario"` y `archivos`.
- **Campos clave**:
  - `inventario_ref_articulo`: FK a `"Inventario"`.
  - `archivo_id`: FK a `archivos`.
